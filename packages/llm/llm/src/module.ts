import { resolve } from "node:path";
import {
  defineManifest,
  errorMessage,
  interval,
  type Module,
  type ModuleCard,
  type ModuleCardFact,
  type ModuleContext,
} from "@miyoria/runtime/kernel";
import { StoreKey } from "@miyoria/store";
import {
  type Clock,
  Events,
  type JsonValue,
  REASONING_LEVELS,
  serviceKey,
  toTimestamp,
} from "@miyoria/types";
import { z } from "zod";
import { llmCallPayload } from "./call-event.js";
import {
  CALL_LOG_PRUNE_INTERVAL_MS,
  CallLogConfigSchema,
  type LlmCallSink,
  LlmCallWriter,
  utcDay,
} from "./call-writer.js";
import { LlmCallLog, MAX_CALLS } from "./calls.js";
import { BudgetConfigSchema, CostTracker, PricingSchema, periodStarts } from "./cost.js";
import { LlmRouter } from "./router.js";
import { type ChatProvider, LlmError, type ModelRef, ModelRefSchema } from "./types.js";

/**
 * `[llm.providers.<name>]`: `kind` picks the factory; `base_url` and `api_key` are common;
 * every other key is provider-specific (`extra`).
 */
export interface ProviderConfig {
  kind: string;
  base_url: string | null;
  api_key: string | null;
  extra: Record<string, JsonValue>;
}

export const ProviderConfigSchema = z
  .looseObject({
    kind: z.string(),
    base_url: z.string().nullable().optional(),
    api_key: z.string().nullable().optional(),
  })
  .transform(
    ({ kind, base_url, api_key, ...extra }): ProviderConfig => ({
      kind,
      base_url: base_url ?? null,
      api_key: api_key ?? null,
      extra: extra as Record<string, JsonValue>,
    }),
  );

/**
 * The top-level `[llm]` section (not `[modules.llm]`).
 *
 * ```toml
 * [llm.providers.deepseek]
 * kind = "deepseek"
 * api_key = "${DEEPSEEK_API_KEY}"
 *
 * [llm.purposes]
 * chat = ["deepseek:deepseek-chat"]
 *
 * [llm.pricing."deepseek:deepseek-chat"]   # USD per million tokens
 * input_per_mtok = 0.27
 * cached_input_per_mtok = 0.07
 * output_per_mtok = 1.10
 *
 * [llm.budget]
 * daily_usd = 2.0
 *
 * [llm.reasoning]  # off | low | medium | high, per reasoning purpose (defaults: §3.10)
 * chat_text = "off"
 * plan = "medium"
 *
 * [llm.image_input]   # which models take images; unlisted: yes
 * "ollama" = false
 *
 * [llm.call_log]      # every routed call, one JSONL line, <dir>/<UTC day>.jsonl
 * enabled = true
 * dir = "data/llm-calls"
 * keep_days = 14
 * max_mb_per_day = 512
 * bodies = true
 * ```
 */
export const LlmConfigSchema = z.object({
  providers: z.record(z.string(), ProviderConfigSchema).default({}),
  purposes: z.record(z.string(), z.array(ModelRefSchema)).default({}),
  /** Prices keyed by `provider:model`; unpriced models cost 0. */
  pricing: z.record(z.string(), PricingSchema).default({}),
  budget: BudgetConfigSchema.prefault({}),
  /**
   * How deeply reasoning models think, per reasoning purpose (see `REASONING_PURPOSES`, or any
   * model purpose). Unlisted ones use the defaults (`DEFAULT_REASONING`). Thinking adds seconds
   * before the first word, which matters more for her than depth, so chat defaults to off.
   */
  reasoning: z.record(z.string(), z.enum(REASONING_LEVELS)).default({}),
  /**
   * Whether a model takes image parts, keyed by `provider:model` or `provider` (the model entry
   * wins). Unlisted models do; a model that refuses them gets text from then on anyway.
   */
  image_input: z.record(z.string(), z.boolean()).default({}),
  /**
   * Every routed call written to `<dir>/<UTC day>.jsonl` (relative to the config file's
   * directory), with the request and response unless `bodies = false` or the day passed
   * `max_mb_per_day`. Holds what people said, so it stays on this machine; `keep_days` of files
   * are kept.
   */
  call_log: CallLogConfigSchema.prefault({}),
});
export type LlmConfig = z.output<typeof LlmConfigSchema>;

/** Builds providers of some `kind`s. Provider packages export one; the app passes them in. */
export interface ProviderFactory {
  readonly kinds: readonly string[];
  /** Throws on invalid settings (the module then fails to start). */
  build(name: string, config: ProviderConfig): ChatProvider;
}

export const LlmRouterKey = serviceKey<LlmRouter>("LlmRouter");

export interface LlmModuleOptions {
  /** Purpose overrides from the active profile (`profile.toml` `[llm.purposes]`). */
  purposeOverrides?: ReadonlyMap<string, ModelRef[]>;
  /** Base directory of a relative `[llm.call_log] dir` (the config file's directory). */
  baseDir?: string;
}

/**
 * Module `llm`: builds providers from `[llm]` and provides the `LlmRouter`.
 *
 * Every finished call goes to the call log's JSONL file (prompt and response) and, as an
 * `llm.call` event with its metadata and cost, onto the bus, from where the facts module writes it
 * to the event log. Spending is a running total in memory: rebuilt from those events at the first
 * start of the process, and kept across restarts of the module, so calls whose events have not
 * reached the database yet still count.
 */
export class LlmModule implements Module {
  static readonly ID = "llm";
  readonly manifest = defineManifest(LlmModule.ID, "LLM", {
    icon: "cpu",
    category: "system",
    description: "Model providers and purpose-based routing",
  });
  readonly #config: LlmConfig;
  readonly #factories: readonly ProviderFactory[];
  readonly #overrides: ReadonlyMap<string, ModelRef[]>;
  /** The call inspector's log; outlives restarts of the module. */
  readonly #calls = new LlmCallLog();
  readonly #baseDir: string;
  /** The on-disk call log of the running module, closed on stop. */
  #writer: LlmCallWriter | undefined;
  /** Today's calls from before this process were loaded into `#calls` (once per process). */
  #preloaded = false;
  /** Spending today and this month; outlives restarts of the module. */
  #tracker: CostTracker | undefined;
  /** The running router and its clock, for the card on the panel. */
  #running: { router: LlmRouter; clock: Clock } | null = null;

  constructor(
    config: LlmConfig,
    factories: readonly ProviderFactory[],
    options: LlmModuleOptions = {},
  ) {
    this.#config = config;
    this.#factories = factories;
    this.#overrides = options.purposeOverrides ?? new Map();
    this.#baseDir = options.baseDir ?? process.cwd();
  }

  /**
   * The router; `sink` receives every finished call (the running module's on-disk log and bus),
   * `tracker` keeps its spending (default: a new one from `[llm.pricing]` and `[llm.budget]`).
   */
  buildRouter(sink?: LlmCallSink, tracker?: CostTracker): LlmRouter {
    const providers = new Map<string, ChatProvider>();
    for (const [name, cfg] of Object.entries(this.#config.providers)) {
      const factory = this.#factories.find((f) => f.kinds.includes(cfg.kind));
      if (!factory) throw new LlmError(`provider \`${name}\`: unknown kind \`${cfg.kind}\``);
      providers.set(name, factory.build(name, cfg));
    }
    const router = new LlmRouter(providers, new Map(Object.entries(this.#config.purposes)), {
      pricing: new Map(Object.entries(this.#config.pricing)),
      budget: this.#config.budget,
      reasoning: new Map(Object.entries(this.#config.reasoning)),
      imageInput: new Map(Object.entries(this.#config.image_input)),
      calls: this.#calls,
      ...(sink ? { sink } : {}),
      ...(tracker ? { tracker } : {}),
    });
    router.setPurposes(this.#overrides);
    return router;
  }

  async start(ctx: ModuleContext): Promise<void> {
    const cfg = this.#config.call_log;
    const writer = cfg.enabled
      ? new LlmCallWriter({
          dir: resolve(this.#baseDir, cfg.dir),
          keepDays: cfg.keep_days,
          maxBytesPerDay: cfg.max_mb_per_day * 1024 * 1024,
          bodies: cfg.bodies,
          clock: ctx.clock,
        })
      : undefined;
    // Every finished call: its line in the JSONL file, and its `llm.call` event on the bus.
    const sink: LlmCallSink = {
      write: (call) => {
        writer?.write(call);
        try {
          const day = writer ? utcDay(ctx.clock.now()) : null;
          ctx.publish(Events.LlmCall, llmCallPayload(call.record, day), {
            turn: call.record.turn,
          });
        } catch (error) {
          ctx.log.warn({ err: errorMessage(error) }, "cannot publish an LLM call");
        }
      },
    };
    const fresh = this.#tracker === undefined;
    this.#tracker ??= new CostTracker(
      new Map(Object.entries(this.#config.pricing)),
      this.#config.budget,
      ctx.clock,
    );
    const router = this.buildRouter(sink, this.#tracker);
    router.setEventSink(ctx.publisher);
    const calls = ctx.services.get(StoreKey)?.llmCalls;
    if (fresh && calls) {
      try {
        await router.restoreUsage(calls);
      } catch (error) {
        ctx.log.warn(
          { err: errorMessage(error) },
          "could not load LLM usage from the event log, starting from zero",
        );
      }
    }
    if (writer) {
      this.#writer = writer;
      ctx.spawn("call-log", async (signal) => {
        await writer.prune();
        if (!this.#preloaded) {
          this.#preloaded = true;
          const restored = this.#calls.restore(await writer.recent(MAX_CALLS));
          if (restored > 0) ctx.log.info({ calls: restored }, "loaded today's LLM calls from disk");
        }
        for await (const _ of interval(CALL_LOG_PRUNE_INTERVAL_MS, signal)) await writer.prune();
      });
    }
    router.announceBudget();
    ctx.provide(LlmRouterKey, router);
    this.#running = { router, clock: ctx.clock };
  }

  /**
   * Today's spending against the daily budget and today's calls (the cost tracker's, by
   * `[llm.budget] timezone_offset_hours`), the share of today's finished calls that failed when the
   * call inspector kept all of them, and the budget's state once it is not `ok`.
   */
  async card(): Promise<ModuleCard> {
    const running = this.#running;
    if (running === null) return { facts: [] };
    const report = running.router.costReport();
    const spent = report.today.total_usd.toFixed(2);
    const facts: ModuleCardFact[] = [
      {
        label: "今天花費",
        value: report.daily_usd === null ? spent : `${spent} / ${report.daily_usd.toFixed(2)}`,
        unit: "USD",
      },
      { label: "今天呼叫", value: report.today.calls, unit: "次" },
    ];
    const [dayStart] = periodStarts(running.clock.now(), this.#config.budget.timezone_offset_hours);
    const day = this.#calls.outcomes(toTimestamp(dayStart));
    if (day.whole && day.finished > 0) {
      facts.push({
        label: "今天失敗率",
        value: Math.round((day.errors / day.finished) * 1000) / 10,
        unit: "%",
      });
    }
    if (report.state !== "ok") {
      facts.push({ label: "預算", value: report.state === "degraded" ? "快用完" : "用完了" });
    }
    return { facts };
  }

  async stop(): Promise<void> {
    this.#running = null;
    const writer = this.#writer;
    this.#writer = undefined;
    await writer?.close();
  }
}
