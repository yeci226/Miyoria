// The `llm.call` event of a finished call (docs/design/v5-data.md §2.6, §8 step 7): what it was
// for, the model, tokens, cost, duration and outcome, taken from the call's record. Never the
// prompt, the response or an error's text: those stay in the call log's JSONL files, and
// `log_day` with `call_id` point at the call's line there.
//
// The `llm` module publishes it on the bus as each call ends; the facts module writes it to the
// event log with everything else from the bus. Cost reports and the budget are rebuilt from these
// events at start (`CostTracker.restore`).

import type { LlmCallData } from "@miyoria/store";
import type { LlmCallRecord } from "./calls.js";

/** The `llm.call` payload of a finished call; `logDay`: the UTC day of its JSONL line, if any. */
export function llmCallPayload(record: LlmCallRecord, logDay: string | null): LlmCallData {
  return {
    call_id: record.id,
    log_day: logDay,
    requested_at: record.at,
    purpose: record.purpose,
    chain: record.chain,
    kind: record.kind,
    module: record.module,
    label: record.label,
    model: record.model,
    provider: record.provider,
    // A finished call is never still streaming; a record that says so was cut off.
    status: record.status === "streaming" ? "aborted" : record.status,
    error_kind: record.error_kind,
    finish_reason: record.finish_reason,
    reasoning: record.reasoning,
    usage: record.usage === null ? null : { ...record.usage },
    cost_usd: record.cost_usd,
    duration_ms: record.total_ms,
    first_token_ms: record.first_token_ms,
    fallbacks: record.fallbacks.map((f) => ({ model: f.model, kind: f.kind })),
    retries: record.retries.length,
    tools: [...record.tools],
  };
}
