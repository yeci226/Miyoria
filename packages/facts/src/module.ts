// Module `facts`: runs the fact layer beside V2 (docs/design/v3-architecture.md §21). It listens to
// the whole bus and nothing in V2 waits for it: a turn never calls in here, and every write stays
// in memory until the flush task picks it up, so a broken log costs the log, not a turn.

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
} from "@miyoria/kernel";
import type { EventLogStore, Store } from "@miyoria/store";
import {
  ActivityRecoveryKey,
  DeliveryLedgerKey,
  type Envelope,
  EventLogKey,
  type JsonValue,
  type LogEvent,
  type Observation,
  type ObservationBody,
  type ProfileId,
  pipelineOf,
  type RestoredGame,
  toTimestamp,
  WorkingContextKey,
} from "@miyoria/types";
import { BusFacts } from "./bus.js";
import { type FactsConfig, FactsConfigSchema } from "./config.js";
import { WorkingContextView } from "./context.js";
import { DeliveryLedgerView } from "./delivery.js";
import { EventLogService } from "./log.js";
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
    description: "The EventLog and what is built on it: Working Context, the DeliveryLedger",
    configSchema: FactsConfigSchema,
  });
  readonly #events: EventLogStore | null;
  readonly #profile: ProfileId;
  readonly #names: readonly string[];
  #running: Running | null = null;

  constructor(
    store: Pick<Store, "events"> | null,
    profile: ProfileId,
    options: FactsModuleOptions = {},
  ) {
    this.#events = store?.events ?? null;
    this.#profile = profile;
    this.#names = options.names ?? [];
  }

  async start(ctx: ModuleContext): Promise<void> {
    const config = ctx.config(FactsConfigSchema);
    if (!this.#events) ctx.log.warn("this store has no event log: it stays in memory");
    const log = new EventLogService({
      profile: this.#profile,
      store: this.#events,
      clock: ctx.clock,
      hotEvents: config.hot_events,
      maxBuffer: config.max_buffer,
    });
    // Subscribed before anything is read: nothing published meanwhile is lost.
    const sub = ctx.subscribe("*");
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
      ledger,
      revisions,
      config,
      names: this.#names,
      services: ctx.services,
      ownLines: pipelineOf(ctx.services) === "v3",
    });
    ctx.spawn("observe", async () => {
      for await (const env of sub) this.#take(ctx, bus, env);
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
    this.#running = { log, sub, bus };
  }

  /** One bad event costs that event. */
  #take(ctx: ModuleContext, bus: BusFacts, env: Envelope): void {
    try {
      bus.handle(env);
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
    const policy = {
      fold_before: toTimestamp(now - config.fold_after_days * DAY_MS),
      expire_before:
        config.retain_days === 0 ? null : toTimestamp(now - config.retain_days * DAY_MS),
      max_rows: config.compact_max_rows,
    };
    try {
      let folded = 0;
      let expired = 0;
      for (let pass = 0; pass < MAX_COMPACT_PASSES; pass++) {
        const result = await events.compact(this.#profile, policy);
        folded += result.folded;
        expired += result.expired;
        if (!result.more) break;
        await sleep(COMPACT_PAUSE_MS, signal);
      }
      if (folded + expired > 0) ctx.log.info({ folded, expired }, "compacted the event log");
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
        running.bus.handle(env);
      } catch {
        // The log is going down with the rest; one line more or less changes nothing.
      }
    }
    await running.log.flush();
  }

  async health(): Promise<Health> {
    if (this.#running?.log.failing) {
      return { status: "degraded", reason: "the event log cannot reach its store" };
    }
    return HEALTHY;
  }
}
