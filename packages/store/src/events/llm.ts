// LLM calls on the event log (docs/design/v5-data.md §2.6, §8 step 7): one `llm.call` event per
// routed call, metadata and cost only (the prompt and the response stay in the call log's JSONL
// files). The facts module writes them from the bus, buffered like every write from the bus to
// the log; this reads them back as cost and usage totals per model since a time, which is what
// the `llm` module rebuilds today's and this month's spending (and so the budget) from at start.

import { LlmCall } from "@miyoria/contracts/events";
import type { Timestamp } from "@miyoria/types";
import { StoreError, toMicros } from "../common.js";
import type { Db, Row } from "../db.js";
import type { Awaitable } from "./log.js";

export { LlmCall, type LlmCallData } from "@miyoria/contracts/events";

/** The LLM calls, as the partial index of core migration 5 names them. */
export const LLM_CALL_TYPE_SQL = `type = '${LlmCall.type}'`;

/** The usage and cost of one model's calls. */
export interface LlmModelTotals {
  /** `provider:model`. */
  model: string;
  calls: number;
  prompt_tokens: number;
  completion_tokens: number;
  cached_prompt_tokens: number;
  cost_usd: number;
}

/** What the `llm` module reads of its calls. Implementations may answer at once. */
export interface LlmCallStore {
  /**
   * The calls that ended at or after `since` and reported usage, per model in model order. A call
   * without usage (it failed, or its provider reported none) counts nowhere, as in the budget.
   */
  totalsSince(since: Timestamp): Awaitable<LlmModelTotals[]>;
}

// A fixed statement text: `Db` prepares it once. `INDEXED BY` names the partial index: without
// statistics the planner prefers the `(type, seq)` range of every call ever and filters it by
// time. Grouping a day's or a month's calls by model sorts only those.
const TOTALS_SINCE =
  "SELECT json_extract(data, '$.model') AS model, count(*) AS calls, " +
  "sum(json_extract(data, '$.usage.prompt_tokens')) AS prompt_tokens, " +
  "sum(json_extract(data, '$.usage.completion_tokens')) AS completion_tokens, " +
  "sum(json_extract(data, '$.usage.cached_prompt_tokens')) AS cached_prompt_tokens, " +
  "total(json_extract(data, '$.cost_usd')) AS cost_usd " +
  `FROM events INDEXED BY events_llm_call_idx WHERE ${LLM_CALL_TYPE_SQL} AND at >= $since ` +
  "AND json_type(data, '$.usage') = 'object' AND json_type(data, '$.model') = 'text' " +
  "GROUP BY 1 ORDER BY 1";

function num(row: Row, column: string): number {
  const v = row[column];
  if (v === null || v === undefined) return 0;
  if (typeof v === "number") return v;
  if (typeof v === "bigint") return Number(v);
  throw new StoreError(`llm call totals: \`${column}\` is not a number`);
}

/** The LLM calls of one database (one character). */
export class LlmCallTotals implements LlmCallStore {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  totalsSince(since: Timestamp): LlmModelTotals[] {
    return this.#db.all(TOTALS_SINCE, { since: toMicros(since) }).map((row) => ({
      model: String(row.model),
      calls: num(row, "calls"),
      prompt_tokens: num(row, "prompt_tokens"),
      completion_tokens: num(row, "completion_tokens"),
      cached_prompt_tokens: num(row, "cached_prompt_tokens"),
      cost_usd: num(row, "cost_usd"),
    }));
  }
}
