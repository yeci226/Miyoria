// The Core's own state: its modules, why she did or did not reply, what the LLM calls cost, and
// the live event stream.

import { eventIterator } from "@orpc/contract";
import { z } from "zod";
import { BusEnvelopeSchema } from "../../events/src/envelope.js";
import { ContextKeySchema, JsonObjectSchema, TimestampSchema } from "../../wire/src/index.js";
import { route } from "./route.js";
import { DigitsQuery, FlagQuery, UsizeQuery } from "./shared.js";

export const ModuleStateKindSchema = z
  .enum(["disabled", "starting", "running", "degraded", "stopping", "stopped", "failed"])
  .meta({ id: "ApiModuleStateKind" });
export type ModuleStateKind = z.output<typeof ModuleStateKindSchema>;

/**
 * What a module tells the system page about itself (docs/design/v5-settings.md §3): at most four
 * facts, the next scheduled thing, its last error, at most two quick actions.
 */
export const ModuleCardSchema = z
  .object({
    facts: z
      .array(
        z.object({
          label: z.string(),
          value: z.union([z.string(), z.number()]),
          unit: z.string().optional(),
        }),
      )
      .max(4),
    next: z.object({ label: z.string(), at: TimestampSchema }).optional(),
    last_error: z.object({ at: TimestampSchema, message: z.string() }).optional(),
    actions: z
      .array(
        z.object({
          id: z.string(),
          label: z.string(),
          /** Ask this first. */
          confirm: z.string().optional(),
          /** Run through the actuator gate as the panel. */
          capability: z.string().optional(),
          args: JsonObjectSchema.optional(),
        }),
      )
      .max(2)
      .optional(),
  })
  .meta({ id: "ApiModuleCard" });
export type ModuleCard = z.output<typeof ModuleCardSchema>;

/** The sections of the system page. */
export const ModuleCategorySchema = z
  .enum(["her", "platform", "play", "system"])
  .meta({ id: "ApiModuleCategory" });
export type ModuleCategory = z.output<typeof ModuleCategorySchema>;

/**
 * One module as the supervisor reports it. `GET /api/modules` adds what the system page draws the
 * module's card with (`icon` .. `pending`); the answer of an action leaves those out.
 */
export const ModuleInfoSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    description: z.string(),
    enabled: z.boolean(),
    state: ModuleStateKindSchema,
    /** Why it is not running, when it is not. */
    reason: z.string().nullable(),
    /** Restarts in the recent window. */
    recent_restarts: z.number(),
    /** A lucide icon name the module chose (`null`: the panel's default). */
    icon: z.string().nullable().optional(),
    category: ModuleCategorySchema.optional(),
    /** It has fields the panel may change. */
    settings: z.boolean().optional(),
    /** Its card; `null` when it has none or did not answer in time. */
    card: ModuleCardSchema.nullable().optional(),
    /** A saved change waits for this guarded state (`singing`, `live`). */
    pending: z.string().nullable().optional(),
  })
  .meta({ id: "ApiModuleInfo" });
export type ModuleInfo = z.output<typeof ModuleInfoSchema>;

/** One attention decision: why she did or did not reply. */
export const DecisionTraceSchema = z
  .object({
    turn: z.string(),
    context: ContextKeySchema,
    respond: z.boolean(),
    score: z.number(),
    reasons: z.array(z.string()),
  })
  .meta({ id: "ApiDecisionTrace" });
export type DecisionTrace = z.output<typeof DecisionTraceSchema>;

export const DecisionRecordSchema = z
  .object({
    id: z.string(),
    profile: z.string(),
    ts: TimestampSchema,
    trace: DecisionTraceSchema,
  })
  .meta({ id: "ApiDecisionRecord" });
export type DecisionRecord = z.output<typeof DecisionRecordSchema>;

/** Token usage of one `provider:model` since the Core started. */
export const UsageInfoSchema = z
  .object({
    calls: z.number(),
    prompt_tokens: z.number(),
    completion_tokens: z.number(),
    cached_prompt_tokens: z.number(),
  })
  .meta({ id: "ApiUsageInfo" });
export type UsageInfo = z.output<typeof UsageInfoSchema>;

/** `GET /api/llm/usage`: by `provider:model`, keys ascending. */
export const UsageMapSchema = z.record(z.string(), UsageInfoSchema).meta({ id: "ApiUsageMap" });
export type UsageMap = z.output<typeof UsageMapSchema>;

export const BudgetStateSchema = z.enum(["ok", "degraded", "exhausted"]).meta({
  id: "ApiBudgetState",
});
export type BudgetState = z.output<typeof BudgetStateSchema>;

/** Usage and cost of one model within one period. */
export const ModelUsageSchema = z
  .object({
    calls: z.number(),
    prompt_tokens: z.number(),
    completion_tokens: z.number(),
    cached_prompt_tokens: z.number(),
    cost_usd: z.number(),
  })
  .meta({ id: "ApiModelUsage" });
export type ModelUsage = z.output<typeof ModelUsageSchema>;

export const PeriodReportSchema = z
  .object({
    /** `2026-11-01` for a day, `2026-11` for a month. */
    period: z.string(),
    total_usd: z.number(),
    calls: z.number(),
    /** Per `provider:model`, in key order. */
    models: z.record(z.string(), ModelUsageSchema),
  })
  .meta({ id: "ApiPeriodReport" });
export type PeriodReport = z.output<typeof PeriodReportSchema>;

/** `GET /api/llm/cost`: spend today and this month, and the budget's state. */
export const CostReportSchema = z
  .object({
    state: BudgetStateSchema,
    /** The daily budget in USD; `null`: none. */
    daily_usd: z.number().nullable(),
    monthly_usd: z.number().nullable(),
    /** The fraction of a budget at which the router degrades, e.g. `0.8`. */
    degrade_at: z.number(),
    today: PeriodReportSchema,
    month: PeriodReportSchema,
  })
  .meta({ id: "ApiCostReport" });
export type CostReport = z.output<typeof CostReportSchema>;

export const modules = {
  list: route
    .meta({ audience: "admin", permission: null })
    .route({ method: "GET", path: "/api/modules" })
    .output(z.array(ModuleInfoSchema)),
  /**
   * Enables, disables or restarts a module and answers its status afterwards. `action` is a string
   * here and the server checks it (`enable`, `disable` or `restart`; another is a 404). `409`
   * when the module cannot be stopped, or is the API itself.
   */
  action: route
    .meta({ audience: "admin", permission: null })
    .route({ method: "POST", path: "/api/modules/{id}/{action}" })
    .input(z.object({ params: z.object({ id: z.string(), action: z.string() }) }))
    .output(ModuleInfoSchema),
};

/**
 * `GET /api/decisions`: the newest attention decisions, newest first. `limit` defaults to 50 and is
 * capped at 1000; `context` is a JSON-encoded context key (`{"platform":...}`) that the server
 * decodes (not JSON: 400).
 */
export const decisions = route
  .meta({ audience: "admin", permission: null })
  .route({ method: "GET", path: "/api/decisions" })
  .input(
    z.object({ query: z.object({ limit: UsizeQuery.optional(), context: z.string().optional() }) }),
  )
  .output(z.array(DecisionRecordSchema));

/**
 * `GET /api/events`: the bus as Server-Sent Events, one bus envelope per event (`id:` is the
 * envelope's id), from the moment the stream opens; nothing is replayed, so `Last-Event-ID` is
 * not read. `topics` is a comma-separated list of topic patterns (`platform.*,agent.turn.completed`);
 * none or empty: everything. A comment line comes after 15 s without an event. A reader that falls
 * far behind skips the oldest events; the stream ends when the API module stops, and when the
 * caller no longer may (checked again every 30 s: the session, the token, the lockout). `HEAD`
 * answers the headers without subscribing.
 */
export const events = route
  .meta({ audience: "admin", permission: null })
  .route({ method: "GET", path: "/api/events" })
  .input(z.object({ query: z.object({ topics: z.string().optional() }) }))
  .output(eventIterator(BusEnvelopeSchema));

/** What a call was for, broadly: her inner thoughts, a text or voice reply, and so on. */
export const LlmCallKindSchema = z
  .enum(["mind", "chat", "voice", "attention", "memory", "learning", "social", "other"])
  .meta({ id: "ApiLlmCallKind" });
export type LlmCallKind = z.output<typeof LlmCallKindSchema>;

export const LlmCallStatusSchema = z
  .enum(["streaming", "ok", "error", "aborted"])
  .meta({ id: "ApiLlmCallStatus" });
export type LlmCallStatus = z.output<typeof LlmCallStatusSchema>;

/** What a model costs per million tokens (`[llm.pricing]`). */
export const LlmPricingSchema = z
  .object({
    input_per_mtok: z.number(),
    cached_input_per_mtok: z.number().nullable(),
    output_per_mtok: z.number(),
  })
  .meta({ id: "ApiLlmPricing" });
export type LlmPricing = z.output<typeof LlmPricingSchema>;

/** One routed call, as the call inspector lists it. */
export const LlmCallRecordSchema = z
  .object({
    id: z.string(),
    at: TimestampSchema,
    /** As requested (`chat`, `mind`, `fast`, ...). */
    purpose: z.string(),
    /** The purpose whose chain answered. */
    chain: z.string(),
    kind: LlmCallKindSchema,
    /** `provider:model` that answered (the last one tried when all failed). */
    model: z.string().nullable(),
    provider: z.string().nullable(),
    status: LlmCallStatusSchema,
    /** Earlier models of the chain that failed first. */
    fallbacks: z.array(z.object({ model: z.string(), error: z.string(), kind: z.string() })),
    /** HTTP retries of the answering request. */
    retries: z.array(z.string()),
    thinking: z.boolean(),
    /** The reasoning level the request was sent with (`off` when it did not think). */
    reasoning: z.enum(["off", "low", "medium", "high"]),
    json_mode: z.boolean(),
    tools: z.array(z.string()),
    max_tokens: z.number().nullable(),
    temperature: z.number().nullable(),
    messages: z.number(),
    images: z.number(),
    usage: z
      .object({
        prompt_tokens: z.number(),
        completion_tokens: z.number(),
        cached_prompt_tokens: z.number(),
        reasoning_tokens: z.number().nullable(),
      })
      .nullable(),
    first_token_ms: z.number().nullable(),
    total_ms: z.number().nullable(),
    cost_usd: z.number().nullable(),
    /** The price the cost was computed with; `null` when the model has no `[llm.pricing]`. */
    pricing: LlmPricingSchema.nullable(),
    finish_reason: z.string().nullable(),
    error: z.string().nullable(),
    error_kind: z.string().nullable(),
    module: z.string().nullable(),
    turn: z.string().nullable(),
    thought: z.string().nullable(),
    label: z.string().nullable(),
    repair: z.number().nullable(),
    /** Characters of the response text, reasoning and tool calls. */
    text_chars: z.number(),
    reasoning_chars: z.number(),
    tool_calls: z.number(),
    /** The request and response are still kept. */
    has_detail: z.boolean(),
  })
  .meta({ id: "ApiLlmCallRecord" });
export type LlmCallRecord = z.output<typeof LlmCallRecordSchema>;

export const LlmToolCallSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    /** Raw JSON arguments as the model produced them. */
    arguments: z.string(),
  })
  .meta({ id: "ApiLlmToolCall" });
export type LlmToolCall = z.output<typeof LlmToolCallSchema>;

/** The request and response of one call, with secrets redacted. */
export const LlmCallDetailSchema = z
  .object({
    messages: z.array(
      z.object({
        role: z.string(),
        name: z.string().nullable(),
        content: z.string(),
        /** Characters cut from the middle. */
        cut: z.number(),
        tool_calls: z.array(LlmToolCallSchema),
        tool_call_id: z.string().nullable(),
      }),
    ),
    tools: z.array(z.string()),
    response: z.object({
      text: z.string(),
      reasoning: z.string(),
      tool_calls: z.array(LlmToolCallSchema),
      cut: z.number(),
    }),
  })
  .meta({ id: "ApiLlmCallDetail" });
export type LlmCallDetail = z.output<typeof LlmCallDetailSchema>;

/** `GET /api/llm/calls/{id}`. `detail` is `null` once the request and response were dropped. */
export const LlmCallWithDetailSchema = z
  .object({ call: LlmCallRecordSchema, detail: LlmCallDetailSchema.nullable() })
  .meta({ id: "ApiLlmCallWithDetail" });
export type LlmCallWithDetail = z.output<typeof LlmCallWithDetailSchema>;

/** `GET /api/llm/calls`: newest first; `before` is the last id shown. */
export const LlmCallsPageSchema = z
  .object({
    items: z.array(LlmCallRecordSchema),
    next_cursor: z.string().nullable(),
    /** Calls that match the filter. */
    matched: z.number(),
    /** Calls kept at all; older ones are gone from the ring. */
    kept: z.number(),
  })
  .meta({ id: "ApiLlmCallsPage" });
export type LlmCallsPage = z.output<typeof LlmCallsPageSchema>;

/** A call with its chain of thought and answer. */
export const LlmThinkingSchema = z
  .object({
    call: LlmCallRecordSchema,
    /** `null` once dropped from the ring (or before the call ends). */
    reasoning: z.string().nullable(),
    answer: z.string().nullable(),
    /** Names of the tools it called. */
    tool_calls: z.array(z.string()),
    /** Characters cut from the reasoning and the answer. */
    cut: z.number(),
  })
  .meta({ id: "ApiLlmThinking" });
export type LlmThinking = z.output<typeof LlmThinkingSchema>;

/** `GET /api/llm/thinking`. */
export const LlmThinkingPageSchema = z
  .object({
    items: z.array(LlmThinkingSchema),
    next_cursor: z.string().nullable(),
    matched: z.number(),
    /** Calls per kind under the same filter (without the kind), and how many of them reasoned. */
    by_kind: z.array(
      z.object({ kind: LlmCallKindSchema, calls: z.number(), reasoned: z.number() }),
    ),
    kept: z.number(),
  })
  .meta({ id: "ApiLlmThinkingPage" });
export type LlmThinkingPage = z.output<typeof LlmThinkingPageSchema>;

export const LlmGroupStatsSchema = z
  .object({
    key: z.string(),
    calls: z.number(),
    errors: z.number(),
    prompt_tokens: z.number(),
    cached_prompt_tokens: z.number(),
    completion_tokens: z.number(),
    reasoning_tokens: z.number(),
    cost_usd: z.number(),
    /** First-token latency (ms) of the successful calls. */
    p50_ms: z.number().nullable(),
    p95_ms: z.number().nullable(),
    /** Total time (ms) of the successful calls. */
    total_p50_ms: z.number().nullable(),
  })
  .meta({ id: "ApiLlmGroupStats" });
export type LlmGroupStats = z.output<typeof LlmGroupStatsSchema>;

export const LlmHourStatsSchema = z
  .object({
    /** Start of the hour. */
    hour: TimestampSchema,
    calls: z.number(),
    errors: z.number(),
    prompt_tokens: z.number(),
    cached_prompt_tokens: z.number(),
    completion_tokens: z.number(),
    cost_usd: z.number(),
    /** Cost per purpose. */
    by_purpose: z.record(z.string(), z.number()),
  })
  .meta({ id: "ApiLlmHourStats" });
export type LlmHourStats = z.output<typeof LlmHourStatsSchema>;

/** `GET /api/llm/stats`: breakdowns of the calls in the window, with the prices in force. */
export const LlmCallStatsSchema = z
  .object({
    since: TimestampSchema.nullable(),
    total: LlmGroupStatsSchema,
    by_purpose: z.array(LlmGroupStatsSchema),
    by_model: z.array(LlmGroupStatsSchema),
    by_module: z.array(LlmGroupStatsSchema),
    by_hour: z.array(LlmHourStatsSchema),
    /** First-token latency (ms) of successful calls, by bucket upper bound. */
    latency: z.array(z.object({ le_ms: z.number(), count: z.number() })),
    /** Error kinds by count. */
    errors: z.array(z.object({ kind: z.string(), count: z.number() })),
    finish_reasons: z.array(z.object({ reason: z.string(), count: z.number() })),
    expensive: z.array(LlmCallRecordSchema),
    slowest: z.array(LlmCallRecordSchema),
    /** The calls kept; older ones are gone from the ring. */
    kept: z.number(),
    oldest: TimestampSchema.nullable(),
    /** Every `[llm.pricing]` entry, by `provider:model`. */
    prices: z.record(z.string(), LlmPricingSchema),
  })
  .meta({ id: "ApiLlmCallStats" });
export type LlmCallStats = z.output<typeof LlmCallStatsSchema>;

/** `limit` is held to 1..500 (default 100), a bad one is a 400; a blank filter is no filter. */
const CallsQuery = z.object({
  purpose: z.string().optional(),
  model: z.string().optional(),
  module: z.string().optional(),
  status: LlmCallStatusSchema.optional(),
  trouble: FlagQuery.optional(),
  thought: z.string().optional(),
  turn: z.string().optional(),
  since: z.string().optional(),
  until: z.string().optional(),
  q: z.string().optional(),
  limit: DigitsQuery.optional(),
  before: z.string().optional(),
});

/** `limit` is held to 1..200 (default 30). */
const ThinkingQuery = z.object({
  kind: LlmCallKindSchema.optional(),
  reasoned: FlagQuery.optional(),
  since: z.string().optional(),
  q: z.string().optional(),
  limit: DigitsQuery.optional(),
  before: z.string().optional(),
});

/** `minutes`: only the last so many minutes (`0` or none: everything kept). */
const StatsQuery = z.object({
  minutes: DigitsQuery.optional(),
  purpose: z.string().optional(),
  model: z.string().optional(),
});

export const llm = {
  usage: route
    .meta({ audience: "admin", permission: null })
    .route({ method: "GET", path: "/api/llm/usage" })
    .output(UsageMapSchema),
  cost: route
    .meta({ audience: "admin", permission: null })
    .route({ method: "GET", path: "/api/llm/cost" })
    .output(CostReportSchema),
  /** The call inspector's list, newest first. */
  calls: route
    .meta({ audience: "admin", permission: null })
    .route({ method: "GET", path: "/api/llm/calls" })
    .input(z.object({ query: CallsQuery }))
    .output(LlmCallsPageSchema),
  /** One call with its request and response; `404` once it is older than the ring. */
  callDetail: route
    .meta({ audience: "admin", permission: null })
    .route({ method: "GET", path: "/api/llm/calls/{id}" })
    .input(z.object({ params: z.object({ id: z.string() }) }))
    .output(LlmCallWithDetailSchema),
  /** Calls with their chain of thought and answer, newest first. */
  thinking: route
    .meta({ audience: "admin", permission: null })
    .route({ method: "GET", path: "/api/llm/thinking" })
    .input(z.object({ query: ThinkingQuery }))
    .output(LlmThinkingPageSchema),
  stats: route
    .meta({ audience: "admin", permission: null })
    .route({ method: "GET", path: "/api/llm/stats" })
    .input(z.object({ query: StatsQuery }))
    .output(LlmCallStatsSchema),
};
