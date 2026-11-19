// Module `karaoke` (docs/design/karaoke.md 「做了什麼(第一步)」): the owner of the `karaoke`
// plugin's tables. It puts `[modules.karaoke]` in force and provides `KaraokeKey`
// (`KaraokeService`), which the member routes of `packages/api` call. Songs are prepared on the
// song workers through `KaraokeWorkerKey` (the singing module's); without it nothing new is
// prepared, and the songs already on Core can still be sung.
//
// She hears of each finished song as a note she may react to (an observation, like the cards'
// and the market's notes), in the comment channel when one is set; her next turn there is kept as
// her comment on that result. Singing counts as `played_together` for the heart. No model is
// called here, and no coins move. On Discord it registers `/me play karaoke` (`commands.ts`) and
// posts a room's notice in the comment channel through the platform's `ReplySink`.

import { resolve } from "node:path";
import { CommandMount, ReplySinkKey } from "@miyoria/commands";
import {
  defineManifest,
  errorMessage,
  interval,
  type Module,
  type ModuleCard,
  type ModuleContext,
} from "@miyoria/runtime/kernel";
import { StoreKey } from "@miyoria/store";
import {
  type Clock,
  contextKeyString,
  EventLogKey,
  Events,
  HandleDirectoryKey,
  HeartKey,
  is,
  KaraokeWalletKey,
  KaraokeWorkerKey,
  SocialSignalsKey,
  serviceKey,
  VoicePlayerKey,
} from "@miyoria/types";
import { karaokeCard } from "./card.js";
import { registerCommands, roomNotice, unregisterCommands } from "./commands.js";
import { commentContext, type KaraokeConfig, KaraokeConfigSchema } from "./config.js";
import { type RoomChannel, RoomDesk, type RoomNotice } from "./rooms.js";
import { type KaraokeNote, KaraokeService } from "./service.js";
import { karaokeTables } from "./store.js";

export const KaraokeKey = serviceKey<KaraokeService>("Karaoke");
/** The rooms (step 4), which the member routes of `packages/api` call. */
export const KaraokeRoomsKey = serviceKey<RoomDesk>("KaraokeRooms");

/** How often the jobs being prepared are looked at. */
export const TICK_MS = 3_000;
/** How often the rooms are looked at (countdowns, the relay, the board). */
export const ROOM_TICK_MS = 250;
/** Every this many looks at the rooms, what is owed is paid again (a wallet that was away). */
const MONEY_EVERY = 40;
/** Every this many looks, the upkeep (old tracks, idle files, comments not made). */
const UPKEEP_EVERY = 20;
/** Her working-context bucket for karaoke, and how many notes it keeps. */
const WRITER = "karaoke";
const MAX_ENTRIES = 4;

export interface KaraokeModuleOptions {
  /** What a relative `cache_dir` is relative to (the directory of `miyoria.toml`). */
  baseDir?: string;
  /** Replaces the module context's clock (tests). */
  clock?: Clock;
  tickMs?: number;
  roomTickMs?: number;
}

export class KaraokeModule implements Module {
  static readonly ID = "karaoke";
  readonly manifest = defineManifest(KaraokeModule.ID, "Karaoke", {
    icon: "mic-vocal",
    category: "play",
    description:
      "Karaoke on the member page: songs prepared by the song worker, sung in the browser, scored by Core, and her comment",
    optional: ["sing", "heart", "api", "commands"],
    configSchema: KaraokeConfigSchema,
  });
  readonly #options: KaraokeModuleOptions;
  #running: KaraokeService | null = null;
  #rooms: RoomDesk | null = null;
  #mount: CommandMount | null = null;

  constructor(options: KaraokeModuleOptions = {}) {
    this.#options = options;
  }

  async start(ctx: ModuleContext): Promise<void> {
    const config = ctx.config(KaraokeConfigSchema);
    const store = ctx.services.get(StoreKey);
    if (store === undefined) {
      ctx.log.warn("no store: no karaoke");
      return;
    }
    const clock = this.#options.clock ?? ctx.clock;
    const service = new KaraokeService({
      config,
      store: store.plugin(karaokeTables),
      worker: () => ctx.services.get(KaraokeWorkerKey) ?? null,
      now: () => clock.now(),
      cacheDir: resolve(this.#options.baseDir ?? process.cwd(), config.cache_dir),
      who: (account) => {
        const attitude = ctx.services.get(SocialSignalsKey)?.attitude(account) ?? null;
        return { person: attitude?.person ?? null, blocked: attitude?.blocked ?? false };
      },
      tell: (note) => tell(ctx, note),
      together: (person, detail, at, session) => {
        try {
          ctx.services.get(HeartKey)?.evidence?.({
            person,
            kind: "played_together",
            detail,
            weight: null,
            at,
            session: `karaoke:${session}`,
          });
        } catch (error) {
          ctx.log.warn({ err: errorMessage(error) }, "karaoke: cannot record singing together");
        }
      },
      log: ctx.log,
    });
    ctx.provide(KaraokeKey, service);
    this.#running = service;

    // Rooms (step 4): only while she is in a voice channel. Where she is comes from the voice
    // events; before any arrives (Core started while she was in one), the voice node is asked
    // about the comment channel's server.
    const voices = new Set<string>();
    const inVoice = () => {
      if (voices.size > 0) return true;
      const guild = commentContext(config.comment_channel)?.scope ?? null;
      return guild !== null && (ctx.services.get(VoicePlayerKey)?.channel(guild) ?? null) !== null;
    };
    const rooms = new RoomDesk({
      config,
      store: store.plugin(karaokeTables),
      service,
      worker: () => ctx.services.get(KaraokeWorkerKey) ?? null,
      wallet: () => ctx.services.get(KaraokeWalletKey) ?? null,
      inVoice,
      who: (account) => {
        const attitude = ctx.services.get(SocialSignalsKey)?.attitude(account) ?? null;
        return { person: attitude?.person ?? null, blocked: attitude?.blocked ?? false };
      },
      tell: (note) => tell(ctx, note),
      together: (person, detail, at, session) => {
        try {
          ctx.services.get(HeartKey)?.evidence?.({
            person,
            kind: "played_together",
            detail,
            weight: null,
            at,
            session: `karaoke:${session}`,
          });
        } catch (error) {
          ctx.log.warn({ err: errorMessage(error) }, "karaoke: cannot record singing together");
        }
      },
      now: () => clock.now(),
      log: ctx.log,
      // Her stream's karaoke scene (step 5): the stage link passes these on to the stage node.
      stage: {
        scene: (scene) => ctx.publish(Events.KaraokeStage, scene),
        lyrics: (lyrics) => ctx.publish(Events.KaraokeStageLyrics, lyrics),
        voice: (voice) => ctx.publish(Events.KaraokeStageVoice, voice),
      },
      // The room notices in the comment channel, through the platform's sink.
      announce: {
        post: (channel, notice) => postNotice(ctx, config, channel, notice),
        edit: (channel, message, notice) => editNotice(ctx, config, channel, message, notice),
      },
    });
    service.attachRooms(rooms);
    // Rooms the last run left open are closed, and what they owe is paid, before any is served.
    await rooms.recover();
    ctx.provide(KaraokeRoomsKey, rooms);
    this.#rooms = rooms;
    // `/me play karaoke`: where karaoke is, the rooms open now, the caller's coins.
    this.#mount = new CommandMount(
      "karaoke",
      (registry) =>
        registerCommands(
          registry,
          () => this.#rooms,
          () => config,
          () => this.#running,
        ),
      unregisterCommands,
    );
    this.#mount.attach(ctx);
    const voice = ctx.subscribe([Events.VoiceJoined.type, Events.VoiceLeft.type]);
    ctx.spawn("voice", async () => {
      for await (const env of voice) {
        if (is(Events.VoiceJoined, env)) voices.add(contextKeyString(env.data.context));
        else if (is(Events.VoiceLeft, env)) voices.delete(contextKeyString(env.data.context));
      }
    });
    ctx.spawn("rooms", async (signal) => {
      let n = 0;
      for await (const _ of interval(this.#options.roomTickMs ?? ROOM_TICK_MS, signal)) {
        try {
          await rooms.tick();
          if (++n % MONEY_EVERY === 0) await rooms.settleMoney();
        } catch (error) {
          ctx.log.warn({ err: errorMessage(error) }, "karaoke: the rooms' pass failed");
        }
      }
    });

    // Her turns in the comment channel: the first after a note is her comment on it.
    const turns = ctx.subscribe([Events.AgentTurnCompleted.type]);
    ctx.spawn("comments", async () => {
      for await (const env of turns) {
        if (!is(Events.AgentTurnCompleted, env)) continue;
        try {
          service.heard(env.data.context, env.data.text);
        } catch (error) {
          ctx.log.warn({ err: errorMessage(error) }, "karaoke: cannot keep her comment");
        }
      }
    });
    const every = this.#options.tickMs ?? TICK_MS;
    ctx.spawn("pass", async (signal) => {
      let n = 0;
      const pass = async () => {
        try {
          await service.tick(signal, n++ % UPKEEP_EVERY === 0);
        } catch (error) {
          ctx.log.warn({ err: errorMessage(error) }, "karaoke: the pass failed");
        }
      };
      await pass();
      for await (const _ of interval(every, signal)) await pass();
    });
  }

  async card(): Promise<ModuleCard> {
    const service = this.#running;
    if (service === null) return { facts: [] };
    const cfg = service.config;
    return karaokeCard({
      open: cfg.open,
      ...service.counts(),
      worker: service.hasWorker(),
      comments: cfg.comment && commentContext(cfg.comment_channel) !== null,
      rooms: this.#rooms?.counts().rooms ?? 0,
    });
  }

  async stop(): Promise<void> {
    // Open rooms stay open in the store: the next start closes them and pays what they owe. The
    // stream's scene ends now.
    this.#rooms?.endScene();
    this.#running?.attachRooms(null);
    this.#running = null;
    this.#rooms = null;
    this.#mount?.detach();
    this.#mount = null;
  }
}

/** A room's notice in the comment channel: its message id, `null` when there is no Discord. */
async function postNotice(
  ctx: ModuleContext,
  config: KaraokeConfig,
  channel: RoomChannel,
  notice: RoomNotice,
): Promise<string | null> {
  const sink = ctx.services.get(ReplySinkKey);
  if (!sink?.sendCard || sink.platform !== channel.platform) return null;
  const sent = await sink.sendCard(channel, roomNotice(config, notice));
  return sent.id;
}

/** The notice of a room that closed: 「已結束」. */
async function editNotice(
  ctx: ModuleContext,
  config: KaraokeConfig,
  channel: RoomChannel,
  message: string,
  notice: RoomNotice,
): Promise<void> {
  const sink = ctx.services.get(ReplySinkKey);
  if (!sink?.editCard || sink.platform !== channel.platform) return;
  await sink.editCard({ context: channel, id: message }, roomNotice(config, notice));
}

/** A finished song she hears of: may speak in the comment channel, else only knows. */
function tell(ctx: ModuleContext, note: KaraokeNote): void {
  const handle =
    note.person === null
      ? null
      : (ctx.services.get(HandleDirectoryKey)?.ofPerson(note.person) ?? null);
  ctx.services.get(EventLogKey)?.observe(
    {
      source: "game.karaoke",
      silent: note.context === null,
      salience: "notable",
      attention_key: note.key,
      revision: 1,
      summary: note.summary,
      addressed_to_her: false,
      from: handle,
      context: note.context,
    },
    {
      buckets: [
        {
          op: "append-self",
          writer: WRITER,
          owner: KaraokeModule.ID,
          untrusted: true,
          max_entries: MAX_ENTRIES,
        },
      ],
      person: handle,
    },
  );
}
