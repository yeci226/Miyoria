// Module `facts`: runs the fact layer (docs/design/v3-architecture.md §21). It listens to the whole
// bus and provides the log and the delivery ledger the main line writes her lines to; every write
// stays in memory until the flush task picks it up, so a broken log costs the log, not a turn.
//
// It is also the one writer of the raw record from the bus (docs/design/v5-data.md §2.3): every
// chat line goes to the store's chat events as it arrives (`record.ts`), her decisions and each
// turn's outcome are lines of the log stored under their bus topics (`envelope.ts`), and each LLM
// call's `llm.call`, each `eval.run` and each `artifact.shared` go through the log's buffer as they
// are (`record.ts`).
//
// The store's daily upkeep runs here too, beside the event log's compaction: the artifact store's
// sweep (expired artifacts, their shares, blobs nothing uses), once every `artifact_sweep_hours`.

import {
  defineManifest,
  errorMessage,
  HEALTHY,
  type Health,
  interval,
  type Module,
  type ModuleContext,
  type Subscription,
  sleep,
} from "@miyoria/runtime/kernel";
import {
  ArtifactSweepSchedule,
  type EventCompaction,
  type EventLogStore,
  type Store,
  type Sweepable,
} from "@miyoria/store";
import {
  ActivityRecoveryKey,
  type BusEnvelope,
  DeliveryLedgerKey,
  EventLogKey,
  type JsonValue,
  type LogEvent,
  type Observation,
  type ObservationBody,
  type ProfileId,
  type RestoredGame,
  toTimestamp,
  WorkingContextKey,
} from "@miyoria/types";
import { TranscriptSweepSchedule } from "../../transcript/src/schedule.js";
import { type TranscriptStore, transcriptTables } from "../../transcript/src/store.js";
import { BusFacts } from "./bus.js";
import { type FactsConfig, FactsConfigSchema } from "./config.js";
import { WorkingContextView } from "./context.js";
import { DeliveryLedgerView } from "./delivery.js";
import { EventLogService } from "./log.js";
import { CHAT_RECORD_TOPICS, type ChatRecordStore, recordChat, recordedWrite } from "./record.js";
import { BOOT_KEY, GAME_SESSION_SOURCE, LIFECYCLE_SOURCE, recoverGame } from "./recovery.js";
import { RevisionBook } from "./revisions.js";

const DAY_MS = 86_400_000;
/** How long to wait between compaction passes, so nothing else stalls behind them. */
const COMPACT_PAUSE_MS = 1_000;
/** Compaction passes per run (the rest waits for the next run). */
const MAX_COMPACT_PASSES = 500;
/** Lines read back to find the last run's end: more than a run writes of them. */
const RECOVERY_LINES = 500;
/** How often lines without an answer are looked for. */
const LINE_SWEEP_MS = 30_000;

export interface FactsModuleOptions {
  /** Her names, for "said her name". */
  names?: readonly string[];
}

interface Running {
  log: EventLogService;
  sub: Subscription;
  bus: BusFacts;
}

export class FactsModule implements Module {
  static readonly ID = "facts";
  readonly manifest = defineManifest(FactsModule.ID, "Facts", {
    icon: "book-open",
    category: "her",
    description: "The EventLog and what is built on it: Working Context, the DeliveryLedger",
    configSchema: FactsConfigSchema,
  });
  readonly #events: EventLogStore | null;
  readonly #chat: ChatRecordStore | null;
  readonly #artifacts: Sweepable | null;
  readonly #plugin: Store["plugin"] | null;
  readonly #profile: ProfileId;
  readonly #names: readonly string[];
  #running: Running | null = null;

  /**
   * `store`: its event log, and where chat lines go (`chat`, or `messages` for a store without
   * chat events). `profile` only names a message log's entries: one database belongs to one
   * character (v5-data decision D6). `artifacts`: the artifact store, swept once a day.
   */
  constructor(
    store:
      | (Pick<Store, "events"> &
          ChatRecordStore & { artifacts?: Sweepable | null; plugin?: Store["plugin"] })
      | null,
    profile: ProfileId,
    options: FactsModuleOptions = {},
  ) {
    this.#events = store?.events ?? null;
    this.#plugin = store?.plugin?.bind(store) ?? null;
    this.#chat = store?.chat || store?.messages ? store : null;
    this.#artifacts = store?.artifacts ?? null;
    this.#profile = profile;
    this.#names = options.names ?? [];
  }

  async start(ctx: ModuleContext): Promise<void> {
    const config = ctx.config(FactsConfigSchema);
    if (!this.#events) ctx.log.warn("this store has no event log: it stays in memory");
    const log = new EventLogService({
      store: this.#events,
      clock: ctx.clock,
      hotEvents: config.hot_events,
      maxBuffer: config.max_buffer,
    });
    // Subscribed before anything is read: nothing published meanwhile is lost.
    const sub = ctx.subscribe("*");
    const chat = this.#chat;
    if (chat) {
      const lines = ctx.subscribe([...CHAT_RECORD_TOPICS]);
      ctx.spawn("record", () => recordChat(ctx, chat, this.#profile, lines));
    }
    const restoring = await this.#lastRun(log);
    const revisions = new RevisionBook();
    const context = new WorkingContextView({
      maxEntries: config.bucket_entries,
      maxChars: config.bucket_chars,
    });
    const ledger = new DeliveryLedgerView(log, {
      answerWindowMs: config.answer_window_secs * 1000,
      clock: ctx.clock,
    });
    const since = toTimestamp(ctx.clock.now() - config.rebuild_days * DAY_MS);
    for (const projection of [revisions, context, ledger]) {
      await log.project(projection, { since });
    }
    // Nobody is left to answer for a line the last run had in flight.
    ledger.expire(0, "the core restarted");
    const boot: Observation = {
      source: LIFECYCLE_SOURCE,
      silent: true,
      salience: "ambient",
      attention_key: BOOT_KEY,
      revision: 1,
      summary: "核心啟動了",
      addressed_to_her: false,
      from: null,
      context: null,
    };
    const body: ObservationBody & { restoring: RestoredGame | null } = {
      observation: boot,
      buckets: [{ op: "boot" }],
      speech: false,
      origin: null,
      restoring,
    };
    log.append({
      kind: "observation",
      source: LIFECYCLE_SOURCE,
      body: body as unknown as JsonValue,
    });
    ctx.provide(EventLogKey, log);
    ctx.provide(WorkingContextKey, context);
    ctx.provide(DeliveryLedgerKey, ledger);
    ctx.provide(ActivityRecoveryKey, { game: () => restoring });

    const bus = new BusFacts({
      log,
      revisions,
      config,
      names: this.#names,
      services: ctx.services,
    });
    ctx.spawn("observe", async () => {
      for await (const env of sub) this.#take(ctx, log, bus, env);
    });
    ctx.spawn("flush", async (signal) => {
      for await (const _ of interval(config.flush_ms, signal)) await log.flush();
    });
    ctx.spawn("lines", async (signal) => {
      for await (const _ of interval(LINE_SWEEP_MS, signal)) {
        ledger.expire(config.line_ack_timeout_secs * 1000, "no ack");
      }
    });
    const events = this.#events;
    if (events) {
      ctx.spawn("compact", async (signal) => {
        for await (const _ of interval(config.compact_every_mins * 60_000, signal)) {
          await this.#compact(ctx, events, config, signal);
        }
      });
    }
    const artifacts = this.#artifacts;
    if (artifacts) {
      const schedule = new ArtifactSweepSchedule(artifacts, ctx.clock, {
        everyMs: config.artifact_sweep_hours * 3_600_000,
      });
      ctx.spawn("artifacts", async (signal) => {
        for await (const _ of interval(schedule.checkMs, signal)) {
          await this.#sweepArtifacts(ctx, schedule, signal);
        }
      });
    }
    const transcripts = config.transcript_sweep_hours > 0 ? this.#transcripts(ctx) : null;
    if (transcripts) {
      const schedule = new TranscriptSweepSchedule(transcripts, ctx.clock, {
        everyMs: config.transcript_sweep_hours * 3_600_000,
        retention: {
          coveredDays: config.transcript_covered_days,
          idleDays: config.transcript_idle_days,
        },
      });
      ctx.spawn("transcripts", async (signal) => {
        for await (const _ of interval(schedule.checkMs, signal)) {
          try {
            const result = schedule.tick();
            if (result !== null && (result.entries > 0 || result.sessions > 0)) {
              ctx.log.info({ ...result }, "swept the transcripts");
            }
          } catch (error) {
            if (signal.aborted) return;
            ctx.log.warn({ err: errorMessage(error) }, "cannot sweep the transcripts");
          }
        }
      });
    }
    this.#running = { log, sub, bus };
  }

  /** The store's transcripts, where it has them. */
  #transcripts(ctx: ModuleContext): TranscriptStore | null {
    try {
      return this.#plugin?.(transcriptTables) ?? null;
    } catch (error) {
      ctx.log.warn({ err: errorMessage(error) }, "no transcripts to sweep");
      return null;
    }
  }

  /**
   * An LLM call, an evaluation run and a shared artifact go to the store as they are; everything
   * else to the bus facts.
   */
  static #route(log: EventLogService, bus: BusFacts, env: BusEnvelope): void {
    const write = recordedWrite(env);
    if (write !== null) log.record(write);
    else bus.handle(env);
  }

  /** One check of the artifact sweep's schedule; a failed sweep is tried again a day later. */
  async #sweepArtifacts(
    ctx: ModuleContext,
    schedule: ArtifactSweepSchedule,
    signal: AbortSignal,
  ): Promise<void> {
    try {
      const result = await schedule.tick();
      if (result === null) return;
      const removed =
        result.expired +
        result.rows_removed +
        result.blobs_removed +
        result.orphan_files_removed +
        result.temp_files_removed;
      if (removed > 0 || result.missing_blobs > 0) {
        ctx.log.info({ ...result }, "swept the artifact store");
      }
    } catch (error) {
      if (signal.aborted) return;
      ctx.log.warn({ err: errorMessage(error) }, "cannot sweep the artifact store");
    }
  }

  /** One bad event costs that event. */
  #take(ctx: ModuleContext, log: EventLogService, bus: BusFacts, env: BusEnvelope): void {
    try {
      FactsModule.#route(log, bus, env);
    } catch (error) {
      ctx.log.warn({ err: errorMessage(error), event: env.id }, "cannot log a bus event");
    }
  }

  /** The session the last run left open. */
  async #lastRun(log: EventLogService): Promise<RestoredGame | null> {
    const lines: LogEvent[] = await log.query({
      sources: [LIFECYCLE_SOURCE, GAME_SESSION_SOURCE],
      limit: RECOVERY_LINES,
    });
    return recoverGame(lines);
  }

  async #compact(
    ctx: ModuleContext,
    events: EventLogStore,
    config: FactsConfig,
    signal: AbortSignal,
  ): Promise<void> {
    const now = ctx.clock.now();
    const before = (days: number) => (days === 0 ? null : toTimestamp(now - days * DAY_MS));
    const policy: EventCompaction = {
      before: {
        ambient: before(config.fold_after_days),
        short: before(config.short_days),
        long: before(config.long_days),
      },
      maxRows: config.compact_max_rows,
    };
    try {
      const removed = { ambient: 0, short: 0, long: 0 };
      for (let pass = 0; pass < MAX_COMPACT_PASSES; pass++) {
        const result = await events.compact(policy);
        removed.ambient += result.removed.ambient;
        removed.short += result.removed.short;
        removed.long += result.removed.long;
        if (!result.more) break;
        await sleep(COMPACT_PAUSE_MS, signal);
      }
      if (removed.ambient + removed.short + removed.long > 0) {
        ctx.log.info(removed, "compacted the event log");
      }
    } catch (error) {
      if (signal.aborted) return;
      ctx.log.warn({ err: errorMessage(error) }, "cannot compact the event log");
    }
  }

  async stop(): Promise<void> {
    const running = this.#running;
    this.#running = null;
    if (!running) return;
    // What the other modules said on their way down still belongs to this run.
    for (let env = running.sub.tryRecv(); env !== null; env = running.sub.tryRecv()) {
      try {
        FactsModule.#route(running.log, running.bus, env);
      } catch {
        // The log is going down with the rest; one line more or less changes nothing.
      }
    }
    await running.log.flush();
    running.log.close();
  }

  async health(): Promise<Health> {
    if (this.#running?.log.failing) {
      return { status: "degraded", reason: "the event log cannot reach its store" };
    }
    return HEALTHY;
  }
}
