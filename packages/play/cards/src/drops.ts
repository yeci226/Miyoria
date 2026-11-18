// When she drops a card in a channel (docs/design/v5-play.md §6.2): a channel that opted in
// (`drop_channels`) is lively when, within `drop_window_mins`, at least `drop_min_people` people
// said `drop_min_lines` lines together (her own and bots' lines do not count). A lively channel
// gets one roll of `drop_chance` per window, and only while it has had fewer than
// `drops_per_channel_day` drops today and the last one is `drop_gap_mins` behind; a hit appears
// after a random delay (`drop_delay_min_secs` to `drop_delay_max_secs`), so nobody can time it,
// and is gone after `drop_expire_mins`. Who may pick it up is the service's (`claimDrop`).
//
// The day's drops and their times are in the table, so a restart does not reset the limits; the
// lines seen are only in memory (a restart starts the window again). Nothing here is a command:
// the card is posted through the platform's `ReplySink` with one button, which `/me card` routes.

import {
  CARD_DROP_ROUTE,
  type CommandReply,
  cardReply,
  componentId,
  ReplySinkKey,
} from "@miyoria/commands";
import { PeopleDirectoryKey } from "@miyoria/heart/person";
import { errorMessage, type ModuleContext, sleep } from "@miyoria/runtime/kernel";
import {
  accountRefString,
  type ContextKey,
  contextKeyString,
  Events,
  is,
  newId,
} from "@miyoria/types";
import type { CardsConfig } from "./config.js";
import type { Random } from "./draw.js";
import { dayStart } from "./service.js";
import type { CardStore } from "./store.js";

const MINUTE_MS = 60_000;

/** The button of a dropped card: `/me card` declares the route (`mi:cards:drop:<id>`). */
export const DROP_ROUTE = CARD_DROP_ROUTE;

/** What she posts when she drops a card: a neutral notice with one button. */
export function dropCard(id: string): CommandReply {
  return cardReply(
    [
      { type: "text", text: "她在這裡丟了一張卡,第一個撿起來的人拿走。" },
      { type: "muted", text: "一人一天最多撿一張,過一陣子沒人撿就會飄走。" },
      {
        type: "buttons",
        buttons: [{ id: componentId(DROP_ROUTE, id), label: "撿起來", style: "primary" }],
      },
    ],
    { accent: "neutral", title: "掉落的卡" },
  );
}

/** One line said in a channel. */
export interface ChannelLine {
  context: ContextKey;
  /** Whoever said it (an account's text form), to count the people. */
  who: string;
  /** Epoch ms. */
  at: number;
}

export interface DropWatchOptions {
  config: CardsConfig;
  store: CardStore;
  random: Random;
  /** Runs `fn` after `ms` (the module's spawn, so a stop cancels it). */
  later: (ms: number, fn: () => Promise<void>) => void;
  /** Posts drop `id` in `context`; whether it reached the channel. */
  post: (context: ContextKey, id: string) => Promise<boolean>;
  now: () => number;
}

interface Channel {
  lines: { at: number; who: string }[];
  /** When the chance was last rolled (epoch ms). */
  rolled: number;
  /** A drop is waiting for its delay. */
  waiting: boolean;
}

export class DropWatch {
  readonly #o: DropWatchOptions;
  readonly #channels = new Map<string, Channel>();
  readonly #open: ReadonlySet<string>;

  constructor(options: DropWatchOptions) {
    this.#o = options;
    this.#open = new Set(options.config.drop_channels);
  }

  /** Whether drops are on in `context` (a channel of a server that opted in, never a DM). */
  open(context: ContextKey): boolean {
    return this.#o.config.drops && context.scope !== null && this.#open.has(context.channel);
  }

  /** Counts `line`; a lively channel may get a drop. */
  heard(line: ChannelLine): void {
    if (!this.open(line.context)) return;
    const { config } = this.#o;
    const key = contextKeyString(line.context);
    const channel = this.#channels.get(key) ?? { lines: [], rolled: 0, waiting: false };
    this.#channels.set(key, channel);
    const window = config.drop_window_mins * MINUTE_MS;
    channel.lines.push({ at: line.at, who: line.who });
    channel.lines = channel.lines.filter((l) => l.at > line.at - window);
    if (channel.waiting || line.at - channel.rolled < window) return;
    const people = new Set(channel.lines.map((l) => l.who)).size;
    if (people < config.drop_min_people || channel.lines.length < config.drop_min_lines) return;
    if (!this.#allowed(key, line.at)) return;
    channel.rolled = line.at;
    if (this.#o.random() >= config.drop_chance) return;
    channel.waiting = true;
    const min = config.drop_delay_min_secs;
    const max = Math.max(config.drop_delay_max_secs, min);
    const delay = (min + this.#o.random() * (max - min)) * 1000;
    this.#o.later(delay, async () => {
      try {
        await this.#drop(line.context, key);
      } finally {
        channel.waiting = false;
      }
    });
  }

  /** Under the channel's day and gap, at `now`. */
  #allowed(key: string, now: number): boolean {
    const { config, store } = this.#o;
    const since = dayStart(now, config.utc_offset_minutes);
    const { count, last } = store.dropsSince(key, since);
    if (count >= config.drops_per_channel_day) return false;
    return last === null || now - Date.parse(last) >= config.drop_gap_mins * MINUTE_MS;
  }

  /** Drops a card in `context` now, if the channel's limits still allow it. */
  async #drop(context: ContextKey, key: string): Promise<void> {
    const { config, store } = this.#o;
    const now = this.#o.now();
    // The limits again: the delay may have let another drop in, or the day turn.
    if (!this.#allowed(key, now)) return;
    const id = newId();
    store.addDrop(id, key, now, now + config.drop_expire_mins * MINUTE_MS);
    let posted = false;
    try {
      posted = await this.#o.post(context, id);
    } finally {
      if (!posted) store.removeDrop(id);
    }
  }
}

/**
 * Starts watching the channels for module `cards` when drops are on: the lines of the platform's
 * messages (not hers, not a bot's, not a card), and a drop posted through `ReplySinkKey`. Without
 * the people directory her own lines cannot be told apart, so nothing counts until it is there.
 */
export function watchDrops(
  ctx: ModuleContext,
  config: CardsConfig,
  store: CardStore,
  random: Random,
  now: () => number,
): void {
  if (!config.drops || config.drop_channels.length === 0) return;
  const watch = new DropWatch({
    config,
    store,
    random,
    now,
    later: (ms, fn) =>
      ctx.spawn("drop", async (signal) => {
        try {
          await sleep(ms, signal);
          await fn();
        } catch (error) {
          if (!signal.aborted) ctx.log.warn({ err: errorMessage(error) }, "cards: a drop failed");
        }
      }),
    post: async (context, id) => {
      const sink = ctx.services.get(ReplySinkKey);
      if (!sink?.sendCard || sink.platform !== context.platform) return false;
      await sink.sendCard(context, dropCard(id));
      ctx.log.info({ drop: id, channel: contextKeyString(context) }, "cards: dropped a card");
      return true;
    },
  });
  const sub = ctx.subscribe([Events.PlatformMessageCreated.type]);
  ctx.spawn("drops", async () => {
    for await (const env of sub) {
      if (!is(Events.PlatformMessageCreated, env)) continue;
      const m = env.data;
      const people = ctx.services.get(PeopleDirectoryKey);
      if (m.author.is_bot || m.card === true || people === undefined) continue;
      if (people.isSelf(m.author.account) || people.isBot(m.author.account)) continue;
      watch.heard({ context: m.id.context, who: accountRefString(m.author.account), at: now() });
    }
  });
}
