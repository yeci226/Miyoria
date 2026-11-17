// LLM calls (docs/design/v5-data.md §2.6, §8 step 7): one `llm.call` event per routed call, with
// what it was for, which model answered, its tokens, cost, duration and outcome. There is no bus
// topic for a finished call today, so the type is the design's name.
//
// Metadata only. The prompt and the response stay in the call log's daily JSONL files
// (`[llm.call_log]`, `<dir>/<log_day>.jsonl`); `call_id` is the `call.id` of the call's line
// there. The daily budget and the cost reports are sums over these events.
//
// For the owner only (`owner`), kept 90 days (`short`). The envelope's `turn` is the turn the call
// belongs to; `at` is when the call ended. No place: a call is not said anywhere.

import { z } from "zod";
import { TimestampSchema } from "../../wire/src/index.js";
import { defineEvent } from "./registry.js";

/** How a call ended: answered, failed, or cancelled by its caller. */
export const LlmCallStatusSchema = z
  .enum(["ok", "error", "aborted"])
  .meta({ id: "EventsLlmCallStatus" });

/** Tokens of a call as its provider reported them. */
export const LlmCallUsageSchema = z
  .object({
    /** Input tokens, the cached ones included. */
    prompt_tokens: z.number().int().min(0),
    completion_tokens: z.number().int().min(0),
    /** Input tokens served from the provider's prefix cache (0 when it reports none). */
    cached_prompt_tokens: z.number().int().min(0),
    /** Output tokens spent thinking (part of `completion_tokens`), when the provider reports them. */
    reasoning_tokens: z.number().int().min(0).nullable(),
  })
  .meta({ id: "EventsLlmCallUsage" });

/** A model of the chain that failed before the one that answered (never its error text). */
export const LlmCallFallbackSchema = z
  .object({ model: z.string(), kind: z.string() })
  .meta({ id: "EventsLlmCallFallback" });

/** An `llm.call` payload. */
export const LlmCallSchema = z
  .object({
    /** The call's id: `call.id` of its line in the JSONL file. */
    call_id: z.string(),
    /** The UTC day of the JSONL file its line went to; `null` when the call log is off. */
    log_day: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .nullable(),
    /** When the router was asked. */
    requested_at: TimestampSchema,
    /** As requested (`chat`, `mind`, `fast`, ...). */
    purpose: z.string(),
    /** The purpose whose chain answered (`chat` when `purpose` has none). */
    chain: z.string(),
    /** What it was for, broadly (`mind`, `chat`, `voice`, ...). */
    kind: z.string(),
    /** The module that asked, and its label for the call. */
    module: z.string().nullable(),
    label: z.string().nullable(),
    /** `provider:model` that answered (the last one tried when all failed). */
    model: z.string().nullable(),
    provider: z.string().nullable(),
    status: LlmCallStatusSchema,
    /** `timeout`, `http_5xx`, ... when it failed. */
    error_kind: z.string().nullable(),
    finish_reason: z.string().nullable(),
    /** `off`, `low`, `medium` or `high`. */
    reasoning: z.string(),
    /** `null` when the provider reported none (the call then costs nothing). */
    usage: LlmCallUsageSchema.nullable(),
    /** USD; `null` without usage, 0 for a model without a price. */
    cost_usd: z.number().min(0).nullable(),
    /** From the router being asked to the end, and to the first token. */
    duration_ms: z.number().min(0).nullable(),
    first_token_ms: z.number().min(0).nullable(),
    fallbacks: z.array(LlmCallFallbackSchema),
    /** HTTP retries of the answering request. */
    retries: z.number().int().min(0),
    /** Names of the tools offered. */
    tools: z.array(z.string()),
  })
  .meta({ id: "EventsLlmCall" });
export type LlmCallData = z.output<typeof LlmCallSchema>;

/** One routed LLM call. */
export const LlmCall = defineEvent({
  type: "llm.call",
  v: 1,
  data: LlmCallSchema,
  scope: "owner",
  tier: "short",
});

/** Where the spending stands against the budget. */
export const LlmBudgetStateSchema = z
  .enum(["ok", "degraded", "exhausted"])
  .meta({ id: "EventsLlmBudgetState" });

/** The budget state changed, or was announced at startup: `llm.budget`. */
export const LlmBudgetSchema = z
  .object({
    state: LlmBudgetStateSchema,
    spent_today_usd: z.number().min(0),
    /** The daily cap in USD; `null`: none. */
    daily_usd: z.number().nullable(),
    spent_month_usd: z.number().min(0),
    monthly_usd: z.number().nullable(),
  })
  .meta({ id: "EventsLlmBudget" });
export type LlmBudgetData = z.output<typeof LlmBudgetSchema>;

/** The LLM budget state: spending as an owner's metric (`owner`), kept 90 days (`short`). */
export const LlmBudget = defineEvent({
  type: "llm.budget",
  v: 1,
  data: LlmBudgetSchema,
  scope: "owner",
  tier: "short",
});
