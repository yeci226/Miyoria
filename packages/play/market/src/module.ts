// Module `market` (docs/design/v5-play.md §4.5, §11.4): the owner of the `market` plugin's tables.
// It puts `[modules.market]` in force, per Space (`placeConfig`: channels, days, times and the
// time zone may differ per server), and provides `MarketKey` (`Markets`: each Space's
// `MarketService`, the auction, the lottery, their views and the owner's controls; `markets.ts`)
// and `SongPriorityKey` (the song priority ticket the singer asks for, the same everywhere). Coins
// go through `MarketWalletKey`, which the economy provides; without it nothing that costs anything
// goes through.
//
// It posts in Discord through the platform's `ReplySink` (the lot, the results, the lottery's week
// and its draw, each with its picture from `PicturesKey` above the text when one can be drawn),
// registers `/me auction` and `/me lottery` with the routes of those notices' buttons
// and modals, and runs one pass at start and every `TICK_MS`: what is due opens, closes, is drawn
// or is settled then, from the times in its tables. What she calls a winner of a name lot is the
// heart's `call_name`; her pick of the week's lot is one small model call (`LlmRouterKey`), and
// without a model the rotation picks. She hears of a lot won and of a draw as a note she may react
// to, like the cards' notes.

import { CommandMount, type CommandReply, ReplySinkKey } from "@miyoria/commands";
import {
  BLOCKED_TAG,
  checkCallName,
  hasTag,
  heartTables,
  labelOf,
  PeopleDirectoryKey,
  UNFIT_CALL_NAME,
} from "@miyoria/heart/person";
import { LlmRouterKey } from "@miyoria/llm/llm";
import {
  defineManifest,
  errorMessage,
  interval,
  type Module,
  type ModuleCard,
  type ModuleContext,
  placeConfig,
} from "@miyoria/runtime/kernel";
import { StoreKey } from "@miyoria/store";
import {
  CharacterKey,
  type Clock,
  type ContextKey,
  CurrencyKey,
  DEFAULT_CHARACTER,
  DEFAULT_CURRENCY,
  EventLogKey,
  HandleDirectoryKey,
  MarketWalletKey,
  ModerationKey,
  type PersonId,
  PicturesKey,
  PlacesKey,
  SongPriorityKey,
  SongTicketsKey,
  type SpaceRef,
  serviceKey,
} from "@miyoria/types";
import { marketCard } from "./card.js";
import { registerCommands, unregisterCommands } from "./commands.js";
import { MarketConfigSchema } from "./config.js";
import { LlmLotPicker } from "./lots.js";
import { MarketRegistry, type Markets, type SharedMarketDeps } from "./markets.js";
import type { CallNames } from "./service.js";
import { marketTables } from "./store.js";

/** The market of each Space (`Markets.of(space)`), and the song priority ticket. */
export const MarketKey = serviceKey<Markets>("Market");

/** How often the pass runs. */
export const TICK_MS = 30_000;
/** Longest wait for her pick of the week's lot. */
const PICK_TIMEOUT_MS = 20_000;
/** Her working-context bucket for the market, and how many notes it keeps. */
const WRITER = "market";
const MAX_ENTRIES = 4;

export interface MarketModuleOptions {
  /** Replaces the module context's clock (tests). */
  clock?: Clock;
  /** Replaces the system CSPRNG (tests). */
  randomInt?: (n: number) => number;
  /** How often the pass runs; default `TICK_MS`. */
  tickMs?: number;
}

export class MarketModule implements Module {
  static readonly ID = "market";
  readonly manifest = defineManifest(MarketModule.ID, "Market", {
    icon: "gavel",
    category: "play",
    description:
      "The weekly market: the song priority ticket, a weekly auction of one lot in a channel, and a weekly lottery",
    optional: ["economy", "heart", "commands", "moderation"],
    configSchema: MarketConfigSchema,
  });
  readonly #options: MarketModuleOptions;
  #mount: CommandMount | null = null;
  /** The running markets and their clock, for the card on the panel. */
  #running: { markets: MarketRegistry; clock: Clock } | null = null;

  constructor(options: MarketModuleOptions = {}) {
    this.#options = options;
  }

  async start(ctx: ModuleContext): Promise<void> {
    const placed = placeConfig(ctx, MarketConfigSchema);
    const config = placed.base();
    const store = ctx.services.get(StoreKey);
    if (store === undefined) {
      ctx.log.warn("no store: no market");
      return;
    }
    const tables = store.plugin(marketTables);
    const places = ctx.services.get(PlacesKey) ?? null;
    const heart = store.plugin(heartTables).people;
    const clock = this.#options.clock ?? ctx.clock;
    const names: CallNames = {
      get: (person) => heart.get(person)?.call_name ?? null,
      set: (person, name) => {
        heart.edit(person, { call_name: name }, { now: clock.now() });
      },
      refuses: (person) => {
        const row = heart.get(person);
        return row !== null && (hasTag(row, BLOCKED_TAG) || labelOf(row) === "很討厭");
      },
    };
    const shared: SharedMarketDeps = {
      wallet: () => ctx.services.get(MarketWalletKey) ?? null,
      now: () => clock.now(),
      isSelf: (account) => ctx.services.get(PeopleDirectoryKey)?.isSelf(account) ?? false,
      names,
      screenName: async (name) => {
        const shape = checkCallName(name);
        if (shape !== null) return shape;
        const moderation = ctx.services.get(ModerationKey);
        if (!moderation) return null;
        try {
          const verdict = await moderation.screenAsync({ path: "other", visible: name });
          return verdict.ok ? null : UNFIT_CALL_NAME;
        } catch {
          return UNFIT_CALL_NAME;
        }
      },
      picker: new LlmLotPicker(
        () => ctx.services.get(LlmRouterKey) ?? null,
        config.auction_purpose,
        PICK_TIMEOUT_MS,
        () => ctx.services.get(CurrencyKey) ?? DEFAULT_CURRENCY,
      ),
      tell: (summary, key, person) => tell(ctx, summary, key, person),
      log: ctx.log,
      pictures: () => ctx.services.get(PicturesKey) ?? null,
      songTickets: () => ctx.services.get(SongTicketsKey) ?? null,
      ...(this.#options.randomInt === undefined ? {} : { randomInt: this.#options.randomInt }),
    };
    const markets = new MarketRegistry({
      shared,
      store: tables,
      config: placed,
      places,
      post: (space, channel, reply) => post(ctx, space, channel, reply),
    });
    ctx.provide(MarketKey, markets);
    ctx.provide(SongPriorityKey, markets.songPriority);
    this.#running = { markets, clock };
    this.#mount = new CommandMount(
      "market",
      (registry) =>
        registerCommands(
          registry,
          (context) => markets.at(context),
          ctx.services.get(CurrencyKey) ?? DEFAULT_CURRENCY,
          (ctx.services.get(CharacterKey) ?? DEFAULT_CHARACTER).pronoun,
        ),
      unregisterCommands,
    );
    this.#mount.attach(ctx);
    const every = this.#options.tickMs ?? TICK_MS;
    ctx.spawn("pass", async (signal) => {
      const pass = async () => {
        try {
          await markets.tick(signal);
        } catch (error) {
          ctx.log.warn({ err: errorMessage(error) }, "market: the pass failed");
        }
      };
      await pass();
      for await (const _ of interval(every, signal)) await pass();
    });
  }

  /** The primary Space's auction and lottery this week (`card.ts`); nothing without a store. */
  async card(): Promise<ModuleCard> {
    const running = this.#running;
    if (running === null) return { facts: [] };
    const { markets, clock } = running;
    const service = markets.of(null);
    if (service === null) return { facts: [] };
    const [auction, lottery] = await Promise.all([
      service.auctionView(null),
      service.lotteryView(null),
    ]);
    return marketCard(auction, lottery, clock.now());
  }

  async stop(): Promise<void> {
    this.#running = null;
    this.#mount?.detach();
    this.#mount = null;
  }
}

/**
 * Posts a notice in a channel of `space`, through its platform's sink; its message id, or `null`
 * (logged) when it could not. Without a Space (no identity) the one server's channel, on the
 * platform the sink is.
 */
async function post(
  ctx: ModuleContext,
  space: SpaceRef | null,
  channel: string,
  reply: CommandReply,
): Promise<string | null> {
  const sink = ctx.services.get(ReplySinkKey);
  if (!sink?.sendCard) {
    ctx.log.info({ channel }, "market: no platform to post in");
    return null;
  }
  const context: ContextKey =
    space === null
      ? { platform: sink.platform, scope: null, channel, kind: "channel" }
      : { platform: space.platform, scope: space.external_id, channel, kind: "channel" };
  if (sink.platform !== context.platform) {
    ctx.log.info({ channel, platform: context.platform }, "market: no sink for that platform");
    return null;
  }
  try {
    const sent = await sink.sendCard(context, reply);
    return sent.id;
  } catch (error) {
    ctx.log.warn({ err: errorMessage(error), channel }, "market: cannot post a notice");
    return null;
  }
}

/** Something she hears, as a note she may react to: an observation, not silent, once per key. */
function tell(ctx: ModuleContext, summary: string, key: string, person: PersonId | null): void {
  const handle =
    person === null ? null : (ctx.services.get(HandleDirectoryKey)?.ofPerson(person) ?? null);
  ctx.services.get(EventLogKey)?.observe(
    {
      source: "market",
      silent: false,
      salience: "notable",
      attention_key: key,
      revision: 1,
      summary,
      addressed_to_her: false,
      from: handle,
      context: null,
    },
    {
      buckets: [
        {
          op: "append-self",
          writer: WRITER,
          owner: MarketModule.ID,
          untrusted: true,
          max_entries: MAX_ENTRIES,
        },
      ],
      person: handle,
    },
  );
}
