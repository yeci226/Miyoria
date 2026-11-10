// Module `memory`.

import { CommandRegistryKey } from "@miyoria/commands";
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
} from "@miyoria/kernel";
import { LlmRouterKey } from "@miyoria/llm";
import {
  type MemoryRecordStore,
  MemoryRecordStoreKey,
  MessageLogKey,
  PeopleStoreKey,
  SettingsStoreKey,
  StoreKey,
} from "@miyoria/store";
import { type ToolRegistry, ToolRegistryKey } from "@miyoria/tools";
import {
  CONVERSATION_FOLDED_TOPIC,
  type ContextKey,
  contextKeyString,
  type Envelope,
  FollowupSourceKey,
  isJsonObject,
  type JsonValue,
  MemoryCuratorKey,
  MemoryRetrievalKey,
  PersonNoteWriterKey,
  PinnedMemoryKey,
  type ProfileId,
  type PromptContributors,
  PromptContributorsKey,
  toTimestamp,
} from "@miyoria/types";
import { MemoryCommands } from "./commands.js";
import {
  type EmbeddingConfig,
  embeddingConfig,
  type MemoryConfig,
  MemoryConfigSchema,
} from "./config.js";
import { CONTRIBUTOR_KEY, MemoryContributor } from "./contributor.js";
import { Curator } from "./curate.js";
import { buildEmbedder, type Embedder } from "./embed.js";
import { MemoryEngine, MemoryEngineKey } from "./engine.js";
import { PersonNotes } from "./person-note.js";
import { PinnedReader } from "./pinned.js";
import { MemoryRetriever } from "./retrieval.js";
import { RECALL, REMEMBER, RecallTool, RememberTool } from "./tools.js";

/** Delay before the first maintenance check, and the interval of later checks. */
const MAINTENANCE_FIRST_MS = 60_000;
const MAINTENANCE_CHECK_MS = 600_000;
const HOUR_MS = 3_600_000;

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
 * Services used: `LlmRouterKey`, `MemoryRecordStoreKey` (else `StoreKey.memories`), and
 * optionally `MessageLogKey`, `PeopleStoreKey`, `SettingsStoreKey` (each else the `Store`
 * field), `PromptContributorsKey`, `ToolRegistryKey`, `CommandRegistryKey`, and for
 * `/admin memory wipe` `ProfileDataStoreKey`, `SupervisorKey` and `AuditLogKey`.
 *
 * Provides `MemoryEngineKey` and `FollowupSourceKey`; registers the prompt contributor `memory`,
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
    const records = this.#records ?? services.get(MemoryRecordStoreKey) ?? store?.memories;
    if (!records) {
      throw new MemoryModuleError("no memory record store (`dyn MemoryRecordStore`)");
    }
    const messages = services.get(MessageLogKey) ?? store?.messages ?? null;
    const people = services.get(PeopleStoreKey) ?? store?.people ?? null;
    const settings = services.get(SettingsStoreKey) ?? store?.settings ?? null;
    const embedder = this.#embedder ?? buildEmbedder(this.embedding);
    this.#degraded = messages === null ? "no message log: consolidation is off" : null;

    const engine = new MemoryEngine(this.profile, config, records, {
      embedder,
      people,
      messages,
      settings,
      router,
      clock: ctx.clock,
    });
    this.#engine = engine;
    engine.attach(services);
    ctx.provide(MemoryEngineKey, engine);
    ctx.provide(PinnedMemoryKey, new PinnedReader(engine, ctx.clock));
    ctx.provide(MemoryRetrievalKey, new MemoryRetriever(engine));
    ctx.provide(FollowupSourceKey, engine);
    ctx.provide(MemoryCuratorKey, new Curator(engine));
    ctx.provide(PersonNoteWriterKey, new PersonNotes(engine));
    this.#installer.install(ctx, engine);
    ctx.log.info({ embedder: embedder.name }, "memory started");

    // Subscribe before returning so no message published after start is missed.
    // A fold of the conversation (module `conversation`) consolidates its context right away,
    // so no line is past `max_lines_per_batch` before it is consolidated.
    const sub = ctx.subscribe([
      "platform.message.created",
      "voice.utterance",
      CONVERSATION_FOLDED_TOPIC,
    ]);
    const installer = this.#installer;
    ctx.spawn("consolidate", (signal) => consolidationLoop(ctx, engine, installer, sub, signal));
    if (config.forgetting.enabled) {
      ctx.spawn("forget", (signal) => maintenanceLoop(ctx, engine, signal));
    }
  }

  async stop(): Promise<void> {
    this.#installer.uninstall();
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
  readonly #commands = new MemoryCommands();

  install(ctx: ModuleContext, engine: MemoryEngine): void {
    const services = ctx.services;
    engine.attach(services);
    const contributors = services.get(PromptContributorsKey);
    if (contributors && contributors !== this.#contributors) {
      this.#contributors?.unregister(CONTRIBUTOR_KEY);
      contributors.register(new MemoryContributor(engine));
      this.#contributors = contributors;
    }
    const tools = services.get(ToolRegistryKey);
    if (tools && tools !== this.#tools) {
      if (this.#tools) {
        this.#tools.unregister(REMEMBER);
        this.#tools.unregister(RECALL);
        this.#tools = null;
      }
      try {
        tools.register(new RememberTool(engine, ctx.clock));
        tools.register(new RecallTool(engine, ctx.clock));
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

  uninstall(): void {
    this.#contributors?.unregister(CONTRIBUTOR_KEY);
    this.#contributors = null;
    if (this.#tools) {
      this.#tools.unregister(REMEMBER);
      this.#tools.unregister(RECALL);
      this.#tools = null;
    }
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
  // Like a tokio interval: the first tick fires right away. The pending `recv` is kept across
  // ticks, so events that arrive during a consolidation are handled after it (none are lost).
  let event: Promise<Wake> = sub.recv().then((env): Wake => ({ kind: "event", env }));
  let tick = nextTick(0);
  for (;;) {
    const wake = await Promise.race([event, tick, aborted]);
    if (wake.kind === "abort" || signal.aborted) return;
    if (wake.kind === "event") {
      const env = wake.env;
      if (env === null) return;
      const nowMs = ctx.clock.now();
      if (env.event.type === "platform_message_created") {
        tracker.message(env.event.data.id.context, nowMs);
      } else if (env.event.type === "voice_utterance") {
        tracker.message(env.event.data.context, nowMs);
      } else if (
        env.event.type === "custom" &&
        env.event.data.topic === CONVERSATION_FOLDED_TOPIC &&
        isJsonObject(env.event.data.payload)
      ) {
        const c = parseFolded(env.event.data.payload.context);
        if (c) tracker.force(c, nowMs);
      }
      event = sub.recv().then((e): Wake => ({ kind: "event", env: e }));
      continue;
    }

    installer.install(ctx, engine);
    if (engine.canConsolidate) {
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

function parseFolded(value: JsonValue | undefined): ContextKey | null {
  if (!isJsonObject(value)) return null;
  const { platform, scope, channel, kind } = value;
  if (typeof platform !== "string" || typeof channel !== "string") return null;
  if (kind !== "channel" && kind !== "thread" && kind !== "dm" && kind !== "voice") return null;
  return { platform, scope: typeof scope === "string" ? scope : null, channel, kind };
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
