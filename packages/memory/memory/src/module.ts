// Module `memory`.

import { CommandRegistryKey } from "@miyoria/commands";
import { LlmRouterKey } from "@miyoria/llm/llm";
import { type ToolRegistry, ToolRegistryKey } from "@miyoria/llm/tools";
import {
  defineManifest,
  errorMessage,
  HEALTHY,
  type Health,
  type Module,
  type ModuleContext,
  type ModuleManifest,
  type Subscription,
  sleep,
} from "@miyoria/runtime/kernel";
import {
  type MemoryRecordStore,
  MemoryRecordStoreKey,
  MessageLogKey,
  PeopleStoreKey,
  SettingsStoreKey,
  StoreKey,
} from "@miyoria/store";
import {
  type AccountRef,
  CONVERSATION_FOLDED_TOPIC,
  type ContextKey,
  contextKeyString,
  type Envelope,
  Events,
  FollowupSourceKey,
  is,
  isJsonObject,
  type JsonValue,
  MESSAGE_EXCLUDED_TOPIC,
  MemoryCuratorKey,
  MemoryRetrievalKey,
  type MessageExcluded,
  PersonNoteWriterKey,
  PinnedMemoryKey,
  type ProfileId,
  PromiseBookKey,
  type PromptContributors,
  PromptContributorsKey,
  SegmentFlushKey,
  toTimestamp,
} from "@miyoria/types";
import { memoryEpisodeSink } from "../../notes/src/episodes.js";
import { importLegacyOnce } from "../../notes/src/legacy.js";
import { type LiveSegmentConfig, LiveSegments } from "../../notes/src/live.js";
import { NotesNotebook } from "../../notes/src/notebook.js";
import { commitmentLedger } from "../../notes/src/promises.js";
import { rankingOf } from "../../notes/src/rank.js";
import { notesTables } from "../../notes/src/store.js";
import { NotesIndex, NotesSearch, NotesSearchKey } from "../../notes/src/vectors.js";
import { transcriptTables } from "../../transcript/src/store.js";
import { MemoryCommands } from "./commands.js";
import {
  type EmbeddingConfig,
  embeddingConfig,
  type MemoryConfig,
  MemoryConfigSchema,
} from "./config.js";
import { CONTRIBUTOR_KEY, MemoryContributor } from "./contributor.js";
import { Curator } from "./curate.js";
import {
  DateBook,
  DateGreeter,
  FORGET_DATE,
  ForgetDateTool,
  REMEMBER_DATE,
  RememberDateTool,
} from "./dates.js";
import { buildEmbedder, type Embedder } from "./embed.js";
import { MemoryEngine, MemoryEngineKey } from "./engine.js";
import { NotesRecall, NotesSourceState } from "./notes-recall.js";
import { PersonNotes } from "./person-note.js";
import { PinnedReader } from "./pinned.js";
import { RecentPast } from "./recent-install.js";
import { MemoryRetriever } from "./retrieval.js";
import { memoryTables } from "./tables.js";
import { RECALL, REMEMBER, RecallTool, RememberTool } from "./tools.js";

/** Delay before the first maintenance check, and the interval of later checks. */
const MAINTENANCE_FIRST_MS = 60_000;
const MAINTENANCE_CHECK_MS = 600_000;
const HOUR_MS = 3_600_000;
/** How often records without a vector are given one, and how many at a time. */
const BACKFILL_MS = 120_000;
const BACKFILL_BATCH = 32;

export class MemoryModuleError extends Error {
  override readonly name = "MemoryModuleError";
}

export interface MemoryModuleOptions {
  /** Uses this embedder instead of building one from config. */
  embedder?: Embedder;
  /** Uses this record store instead of looking one up. */
  records?: MemoryRecordStore;
}

/**
 * Module `memory` (requires `llm`, optional `commands`).
 *
 * Services used: `LlmRouterKey`, `MemoryRecordStoreKey` (else the `StoreKey` store's
 * `memoryTables`), and
 * optionally `MessageLogKey`, `PeopleStoreKey`, `SettingsStoreKey` (each else the `Store`
 * field), `PromptContributorsKey`, `ToolRegistryKey`, `CommandRegistryKey`, and for
 * `/admin memory wipe` `ProfileDataStoreKey`, `SupervisorKey` and `AuditLogKey`.
 *
 * Provides `MemoryEngineKey`, `FollowupSourceKey` and, over a store with the notes, `NotesSearchKey`
 * (her documents searched by words, and by meaning with embeddings on), `SegmentFlushKey` (the
 * live segment pass, which replaces consolidation once `miyoria memory rebuild` has finished) and
 * a `MemoryRetrievalKey` that reads the notes from then on; registers the prompt
 * contributor `memory`,
 * the tools `remember` / `recall` and the `memory` commands (re-checked periodically, so start
 * order does not matter).
 */
export class MemoryModule implements Module {
  static readonly ID = "memory";

  readonly manifest: ModuleManifest = defineManifest(MemoryModule.ID, "Memory", {
    description: "Long-term memory: consolidation, recall, followups",
    requires: ["llm"],
    optional: ["commands"],
    configSchema: MemoryConfigSchema,
  });

  readonly profile: ProfileId;
  readonly embedding: EmbeddingConfig;
  readonly #embedder: Embedder | undefined;
  readonly #records: MemoryRecordStore | undefined;
  readonly #installer = new Installer();
  #engine: MemoryEngine | null = null;
  #embedderInUse: Embedder | null = null;
  #notesIndex: NotesIndex | null = null;
  #degraded: string | null = null;

  /** `embedding` is the top-level `[memory.embedding]` section. */
  constructor(
    profile: ProfileId,
    embedding: EmbeddingConfig = embeddingConfig(),
    options: MemoryModuleOptions = {},
  ) {
    this.profile = profile;
    this.embedding = embedding;
    this.#embedder = options.embedder;
    this.#records = options.records;
  }

  async start(ctx: ModuleContext): Promise<void> {
    const config = ctx.config(MemoryConfigSchema);
    const services = ctx.services;
    const store = services.get(StoreKey);
    const router = services.require(LlmRouterKey);
    const records =
      this.#records ?? services.get(MemoryRecordStoreKey) ?? store?.plugin(memoryTables);
    if (!records) {
      throw new MemoryModuleError("no memory record store (`dyn MemoryRecordStore`)");
    }
    const messages = services.get(MessageLogKey) ?? store?.messages ?? null;
    const people = services.get(PeopleStoreKey) ?? store?.people ?? null;
    const settings = services.get(SettingsStoreKey) ?? store?.settings ?? null;
    const chat = store?.chat ?? null;
    const embedder = this.#embedder ?? buildEmbedder(this.embedding);
    this.#degraded = messages === null ? "no message log: consolidation is off" : null;

    const engine = new MemoryEngine(this.profile, config, records, {
      embedder,
      people,
      messages,
      settings,
      router,
      chat,
      clock: ctx.clock,
    });
    this.#engine = engine;
    this.#embedderInUse = embedder;
    engine.attach(services);
    const notes = store?.plugin(notesTables) ?? null;
    // Whether the notes are her memory's source yet (`notes/src/switch.ts`).
    const source = new NotesSourceState(settings, this.profile);
    try {
      await source.refresh();
    } catch (error) {
      ctx.log.warn({ error: errorMessage(error) }, "cannot read the rebuild's state");
    }
    const notebook =
      notes === null
        ? null
        : new NotesNotebook({
            notes,
            resolver: notes.resolver(),
            config: () => engine.config.notebook,
            handles: () => engine.handles,
            clock: ctx.clock,
          });
    // Her documents' lines get vectors from the same embedder (`notes/src/vectors.ts`).
    const notesIndex =
      notes !== null && embedder.enabled ? new NotesIndex({ notes, embedder }) : null;
    this.#notesIndex = notesIndex;
    let recall: NotesRecall | null = null;
    let live: LiveSegments | null = null;
    if (notes !== null) {
      const search = new NotesSearch({
        notes,
        index: notesIndex,
        ranking: () => rankingOf(engine.config),
        wait: () => ({
          text: engine.config.notes_vector_wait_ms,
          voice: engine.config.notes_vector_voice_wait_ms,
        }),
      });
      ctx.provide(NotesSearchKey, search);
      recall = new NotesRecall({ engine, notes, search, source });
      const cursors = notes.cursors();
      if (store && cursors !== null) {
        const transcripts = store.plugin(transcriptTables);
        const resolver = notes.resolver();
        live = new LiveSegments({
          transcripts,
          notes,
          search,
          episodes: memoryEpisodeSink(engine, {
            resolver,
            contextOf: (session) => transcripts.contextOf(session),
          }),
          // The agent's book, looked up on each use: the agent may start after this module.
          promises: commitmentLedger(() => services.get(PromiseBookKey) ?? null, {
            now: () => ctx.clock.now(),
            handleOf: (person) => engine.handles?.ofPerson(person) ?? null,
          }),
          cursor: cursors,
          router,
          resolver,
          nameOf: (person) => engine.handles?.ofPerson(person) ?? null,
          now: () => ctx.clock.now(),
          config: () => liveSegmentConfig(engine.config),
          state: () => source.state,
        });
        ctx.provide(SegmentFlushKey, live);
      }
    }
    this.#installer.recall = recall;
    const recent = new RecentPast(engine, services, ctx.clock, notebook, recall);
    try {
      await recent.notebook.load();
    } catch (error) {
      ctx.log.warn({ error: errorMessage(error) }, "cannot load her notebook: it starts empty");
    }
    if (notes !== null && settings !== null) {
      try {
        const report = await importLegacyOnce({
          notes,
          resolver: notes.resolver(),
          settings,
          profile: this.profile,
          clock: ctx.clock,
        });
        if (report !== null) {
          ctx.log.info(
            { documents: report.documents, added: report.added, unmapped: report.unmapped.length },
            "notebook and knowledge moved into the notes",
          );
        }
      } catch (error) {
        ctx.log.warn({ error: errorMessage(error) }, "cannot move the old notebook into the notes");
      }
    }
    recent.provide((key, value) => ctx.provide(key, value));
    ctx.provide(MemoryEngineKey, engine);
    ctx.provide(PinnedMemoryKey, new PinnedReader(engine, ctx.clock));
    ctx.provide(MemoryRetrievalKey, recall ?? new MemoryRetriever(engine));
    ctx.provide(FollowupSourceKey, engine);
    ctx.provide(MemoryCuratorKey, new Curator(engine));
    ctx.provide(PersonNoteWriterKey, new PersonNotes(engine));
    this.#installer.recent = recent;
    const book = new DateBook(settings, this.profile);
    this.#installer.book = book;
    const greeter = new DateGreeter(book, engine, people, () => config.dates);
    this.#installer.install(ctx, engine);
    ctx.log.info({ embedder: embedder.name }, "memory started");

    // Subscribe before returning so no message published after start is missed.
    // A fold of the conversation (module `conversation`) consolidates its context right away,
    // so no line is past `max_lines_per_batch` before it is consolidated.
    const sub = ctx.subscribe([
      Events.PlatformMessageCreated.type,
      Events.VoiceUtteranceEvent.type,
      CONVERSATION_FOLDED_TOPIC,
      MESSAGE_EXCLUDED_TOPIC,
    ]);
    const installer = this.#installer;
    const seen = (account: AccountRef, context: ContextKey, nowMs: number): void => {
      greeter.seen(account, context, nowMs).catch((error: unknown) => {
        ctx.log.warn({ error: errorMessage(error) }, "cannot check today's dates");
      });
    };
    if (live !== null && source.switched && !live.running) warnSegmentOff(ctx);
    // Once the notes are the source and the segment pass runs, it writes her memory and
    // consolidation stops. With the pass off, consolidation goes on: nothing else writes.
    ctx.spawn("consolidate", (signal) =>
      consolidationLoop(
        ctx,
        engine,
        installer,
        sub,
        signal,
        () => recent.log.invalidate(),
        seen,
        () => live?.running ?? false,
      ),
    );
    const segments = live;
    if (segments !== null) {
      ctx.spawn("segment", (signal) => segmentLoop(ctx, engine, segments, source, signal));
    }
    if (config.forgetting.enabled) {
      ctx.spawn("forget", (signal) => maintenanceLoop(ctx, engine, signal));
    }
    if (embedder.enabled) {
      ctx.spawn("embed", (signal) => backfillLoop(ctx, engine, signal, notesIndex));
    }
  }

  async stop(): Promise<void> {
    this.#installer.uninstall();
    this.#notesIndex?.close();
    this.#notesIndex = null;
    const embedder = this.#embedderInUse as (Embedder & { close?: () => Promise<void> }) | null;
    this.#embedderInUse = null;
    await embedder?.close?.();
  }

  async health(): Promise<Health> {
    if (this.#degraded !== null) return { status: "degraded", reason: this.#degraded };
    if (this.#engine !== null && this.#engine.events === null) {
      return {
        status: "degraded",
        reason: "no EventLog: evidence falls back to chat lines and `forget` cannot follow events",
      };
    }
    return HEALTHY;
  }
}

/** Registers the contributor, tools and commands into whatever registries exist now; idempotent. */
class Installer {
  #contributors: PromptContributors | null = null;
  #tools: ToolRegistry | null = null;
  /** The v4 readers' contributors and tools, registered beside the memory ones. */
  recent: RecentPast | null = null;
  #recentContributors: string[] = [];
  #recentTools: string[] = [];
  /** The dates book of `remember_date` / `forget_date` (set at start). */
  book: DateBook | null = null;
  /** What `recall` reads once the notes are the source (set at start; `null`: no notes). */
  recall: NotesRecall | null = null;
  readonly #commands = new MemoryCommands();

  install(ctx: ModuleContext, engine: MemoryEngine): void {
    const services = ctx.services;
    engine.attach(services);
    const contributors = services.get(PromptContributorsKey);
    if (contributors && contributors !== this.#contributors) {
      this.#contributors?.unregister(CONTRIBUTOR_KEY);
      for (const key of this.#recentContributors) this.#contributors?.unregister(key);
      contributors.register(new MemoryContributor(engine));
      this.#recentContributors = this.recent?.register(contributors, engine) ?? [];
      this.#contributors = contributors;
    }
    const tools = services.get(ToolRegistryKey);
    if (tools && tools !== this.#tools) {
      if (this.#tools) this.#unregisterTools(this.#tools);
      try {
        tools.register(new RememberTool(engine, ctx.clock));
        tools.register(new RecallTool(engine, ctx.clock, this.recall));
        if (this.book !== null) {
          tools.register(new RememberDateTool(this.book, engine, ctx.clock));
          tools.register(new ForgetDateTool(this.book, engine));
        }
        this.#recentTools = this.recent?.registerTools(tools, engine) ?? [];
        this.#tools = tools;
      } catch (error) {
        ctx.log.warn({ error: errorMessage(error) }, "could not register memory tools");
      }
    }
    const commands = services.get(CommandRegistryKey);
    if (commands) {
      this.#commands.install(commands, engine, { services: ctx.services, clock: ctx.clock });
    }
  }

  #unregisterTools(tools: ToolRegistry): void {
    tools.unregister(REMEMBER);
    tools.unregister(RECALL);
    tools.unregister(REMEMBER_DATE);
    tools.unregister(FORGET_DATE);
    for (const name of this.#recentTools) tools.unregister(name);
    this.#recentTools = [];
    this.#tools = null;
  }

  uninstall(): void {
    this.#contributors?.unregister(CONTRIBUTOR_KEY);
    for (const key of this.#recentContributors) this.#contributors?.unregister(key);
    this.#recentContributors = [];
    this.#contributors = null;
    if (this.#tools) this.#unregisterTools(this.#tools);
    this.#commands.uninstall();
  }
}

/** Per-context activity since the last consolidation (times in epoch ms). */
export interface Activity {
  context: ContextKey;
  pending: number;
  lastMs: number;
  retryAtMs: number | null;
  /** Consolidate at the next tick regardless of the thresholds. */
  forced?: boolean;
}

function activityKey(context: ContextKey): string {
  return `${contextKeyString(context)}\u0000${context.kind}`;
}

/** Decides which contexts to consolidate. */
export class ActivityTracker {
  readonly #contexts = new Map<string, Activity>();

  message(context: ContextKey, atMs: number): void {
    const key = activityKey(context);
    let a = this.#contexts.get(key);
    if (!a) {
      a = { context, pending: 0, lastMs: atMs, retryAtMs: null };
      this.#contexts.set(key, a);
    }
    a.pending += 1;
    a.lastMs = Math.max(a.lastMs, atMs);
  }

  /** A conversation was folded: consolidate it at the next tick. */
  force(context: ContextKey, atMs: number): void {
    const key = activityKey(context);
    let a = this.#contexts.get(key);
    if (!a) {
      a = { context, pending: 1, lastMs: atMs, retryAtMs: null };
      this.#contexts.set(key, a);
    }
    a.pending = Math.max(a.pending, 1);
    a.forced = true;
  }

  /** A context that may have unconsolidated lines from before a restart. */
  maybePending(context: ContextKey): void {
    const key = activityKey(context);
    if (!this.#contexts.has(key)) {
      this.#contexts.set(key, { context, pending: 1, lastMs: 0, retryAtMs: null });
    }
  }

  /** Contexts idle for `consolidate_idle_secs` or with `consolidate_every_messages` pending lines. */
  due(nowMs: number, config: MemoryConfig): ContextKey[] {
    const idleMs = config.consolidate_idle_secs * 1000;
    const every = Math.max(1, config.consolidate_every_messages);
    const out: ContextKey[] = [];
    for (const a of this.#contexts.values()) {
      if (
        a.pending > 0 &&
        (a.retryAtMs === null || nowMs >= a.retryAtMs) &&
        (a.forced === true || a.pending >= every || nowMs - a.lastMs >= idleMs)
      ) {
        out.push(a.context);
      }
    }
    return out;
  }

  done(context: ContextKey): void {
    this.#contexts.delete(activityKey(context));
  }

  failed(context: ContextKey, retryAtMs: number): void {
    const a = this.#contexts.get(activityKey(context));
    if (a) a.retryAtMs = retryAtMs;
  }

  pending(context: ContextKey): number {
    return this.#contexts.get(activityKey(context))?.pending ?? 0;
  }
}

type Wake = { kind: "event"; env: Envelope | null } | { kind: "tick" } | { kind: "abort" };

async function consolidationLoop(
  ctx: ModuleContext,
  engine: MemoryEngine,
  installer: Installer,
  sub: Subscription,
  signal: AbortSignal,
  excluded: () => void = () => {},
  /** Someone spoke (birthdays and other dates of theirs are checked). */
  seen: (account: AccountRef, context: ContextKey, nowMs: number) => void = () => undefined,
  /**
   * Whether the segment pass writes her memory (the notes are the source): then no context is
   * consolidated and nothing is written to the memory records from the conversation here.
   */
  replaced: () => boolean = () => false,
): Promise<void> {
  const config = engine.config;
  const tracker = new ActivityTracker();
  for (const context of await engine.watermarkedContexts()) tracker.maybePending(context);
  const tickMs = Math.max(1, config.tick_secs) * 1000;
  const aborted = new Promise<Wake>((resolve) => {
    if (signal.aborted) resolve({ kind: "abort" });
    else signal.addEventListener("abort", () => resolve({ kind: "abort" }), { once: true });
  });
  const nextTick = (ms: number): Promise<Wake> =>
    sleep(ms, signal).then(
      (): Wake => ({ kind: "tick" }),
      (): Wake => ({ kind: "abort" }),
    );
  // Like an interval timer, except that the first tick fires right away. The pending `recv` is
  // kept across ticks, so events that arrive during a consolidation are handled after it (none are lost).
  let event: Promise<Wake> = sub.recv().then((env): Wake => ({ kind: "event", env }));
  let tick = nextTick(0);
  for (;;) {
    const wake = await Promise.race([event, tick, aborted]);
    if (wake.kind === "abort" || signal.aborted) return;
    if (wake.kind === "event") {
      const env = wake.env;
      if (env === null) return;
      const nowMs = ctx.clock.now();
      const tracking = !replaced();
      if (is(Events.PlatformMessageCreated, env)) {
        const data = env.data;
        if (tracking) tracker.message(data.id.context, nowMs);
        if (!data.author.is_bot) seen(data.author.account, data.id.context, nowMs);
      } else if (is(Events.VoiceUtteranceEvent, env)) {
        const data = env.data;
        if (tracking) tracker.message(data.context, nowMs);
        if (!data.speaker.is_bot) seen(data.speaker.account, data.context, nowMs);
      } else if (env.type === MESSAGE_EXCLUDED_TOPIC) {
        const body = parseExcluded(env.data as JsonValue);
        if (body !== null) {
          try {
            const gone = await engine.excludeMessage(body);
            excluded();
            ctx.log.info(gone, "a message she was asked not to remember was taken out");
          } catch (error) {
            ctx.log.warn({ error: errorMessage(error) }, "cannot take out an excluded message");
          }
        }
      } else if (env.type === CONVERSATION_FOLDED_TOPIC) {
        const payload = env.data as JsonValue;
        const c = isJsonObject(payload) ? parseFolded(payload.context) : null;
        if (c && tracking) tracker.force(c, nowMs);
      }
      event = sub.recv().then((e): Wake => ({ kind: "event", env: e }));
      continue;
    }

    installer.install(ctx, engine);
    if (engine.canConsolidate && !replaced()) {
      const nowMs = ctx.clock.now();
      for (const context of tracker.due(nowMs, config)) {
        if (signal.aborted) return;
        try {
          const report = await engine.consolidate(context, toTimestamp(nowMs), signal);
          if (report.inserted + report.reinforced + report.superseded > 0) {
            ctx.log.info({ context: contextKeyString(context), report }, "memories consolidated");
          }
          tracker.done(context);
        } catch (error) {
          if (signal.aborted) return;
          ctx.log.warn(
            { context: contextKeyString(context), error: errorMessage(error) },
            "consolidation failed, will retry",
          );
          tracker.failed(context, nowMs + config.retry_secs * 1000);
        }
      }
    }
    tick = nextTick(tickMs);
  }
}

/** The payload of `agent.message.excluded`, when it has the parts used here. */
function parseExcluded(value: JsonValue | undefined): MessageExcluded | null {
  if (!isJsonObject(value) || !isJsonObject(value.message) || !isJsonObject(value.context)) {
    return null;
  }
  const message = value.message;
  const context = parseFolded(value.context);
  const messageContext = parseFolded(message.context);
  if (context === null || messageContext === null || typeof message.id !== "string") return null;
  return value as unknown as MessageExcluded;
}

function parseFolded(value: JsonValue | undefined): ContextKey | null {
  if (!isJsonObject(value)) return null;
  const { platform, scope, channel, kind } = value;
  if (typeof platform !== "string" || typeof channel !== "string") return null;
  if (kind !== "channel" && kind !== "thread" && kind !== "dm" && kind !== "voice") return null;
  return { platform, scope: typeof scope === "string" ? scope : null, channel, kind };
}

/** `[modules.memory.segment]` as the live pass reads it. */
export function liveSegmentConfig(config: MemoryConfig): LiveSegmentConfig {
  const s = config.segment;
  return {
    enabled: s.enabled,
    idleMs: s.idle_secs * 1000,
    maxLines: s.max_lines,
    compactionWaitMs: s.compaction_wait_ms,
    retryMs: s.retry_secs * 1000,
    retryMaxMs: s.retry_max_secs * 1000,
    abandonLimit: s.abandon_limit,
    perTick: s.per_tick,
    purpose: config.purpose,
  };
}

function warnSegmentOff(ctx: ModuleContext): void {
  ctx.log.warn(
    "the notes are her memory's source but [modules.memory.segment] is disabled: the segment pass does not write her memory, so the old consolidation keeps running",
  );
}

/**
 * Reads the rebuild's state and passes the segments that have ended, every `tick_secs`. A tick
 * that throws is logged; the next one tries again.
 */
async function segmentLoop(
  ctx: ModuleContext,
  engine: MemoryEngine,
  live: LiveSegments,
  source: NotesSourceState,
  signal: AbortSignal,
): Promise<void> {
  for (;;) {
    try {
      await sleep(Math.max(1, engine.config.segment.tick_secs) * 1000, signal);
    } catch {
      return;
    }
    try {
      const was = source.switched;
      await source.refresh();
      if (!was && source.switched) {
        if (live.running) {
          ctx.log.info("the notes are her memory's source now: the segment pass runs live");
        } else warnSegmentOff(ctx);
      }
      await live.tick(signal);
    } catch (error) {
      if (signal.aborted) return;
      ctx.log.warn({ error: errorMessage(error) }, "segment pass tick failed");
    }
  }
}

async function maintenanceLoop(
  ctx: ModuleContext,
  engine: MemoryEngine,
  signal: AbortSignal,
): Promise<void> {
  const everyMs = Math.max(1, engine.config.forgetting.interval_hours) * HOUR_MS;
  let wait = MAINTENANCE_FIRST_MS;
  for (;;) {
    try {
      await sleep(wait, signal);
    } catch {
      return;
    }
    wait = MAINTENANCE_CHECK_MS;
    const nowMs = ctx.clock.now();
    const last = await engine.lastMaintenanceRun();
    if (last !== null && nowMs - Date.parse(last) < everyMs) continue;
    try {
      const report = await engine.maintain(toTimestamp(nowMs));
      ctx.log.info({ report }, "memory maintenance done");
    } catch (error) {
      ctx.log.warn({ error: errorMessage(error) }, "memory maintenance failed");
    }
  }
}

/**
 * Gives vectors to records stored without one, and to lines of her documents without one, a
 * batch at a time, while the embedder is on.
 */
async function backfillLoop(
  ctx: ModuleContext,
  engine: MemoryEngine,
  signal: AbortSignal,
  notes: NotesIndex | null = null,
): Promise<void> {
  for (;;) {
    try {
      await sleep(BACKFILL_MS, signal);
    } catch {
      return;
    }
    if (!engine.embedder.enabled) return;
    try {
      const n = await engine.backfillEmbeddings(BACKFILL_BATCH, signal);
      if (n > 0) ctx.log.info({ records: n }, "memories given vectors");
    } catch (error) {
      if (signal.aborted) return;
      ctx.log.warn({ error: errorMessage(error) }, "embedding backfill failed");
    }
    if (notes === null) continue;
    try {
      const n = await notes.backfill(BACKFILL_BATCH, signal);
      if (n > 0) ctx.log.info({ lines: n }, "note lines given vectors");
    } catch (error) {
      if (signal.aborted) return;
      ctx.log.warn({ error: errorMessage(error) }, "notes embedding backfill failed");
    }
  }
}
