// LLM calls as events (docs/design/v5-data.md §2.6, §8 step 7): the envelope an `llm.call` gets,
// the cost and usage totals read back over its partial index, and the `llm_usage` data category
// that counts and exports them. What the router and the `llm` module report from them is pinned
// in @miyoria/llm (usage-pin.test.ts) and @miyoria/memory/facts (llm-usage.test.ts).

import { type LlmCallData, LlmCallSchema } from "@miyoria/contracts/events";
import { toTimestamp } from "@miyoria/types";
import { afterEach, describe, expect, it } from "vitest";
import {
  LLM_CALL_TYPE_SQL,
  LLM_CALLS_SQL,
  LlmCall,
  resolveCategories,
  SqliteStore,
} from "../src/index.js";
import { openTestDb } from "../src/testing.js";

const T0 = Date.UTC(2026, 2, 10, 0);
const MIN = 60_000;

const stores: SqliteStore[] = [];
afterEach(async () => {
  for (const s of stores.splice(0)) await s.close();
});

async function open(): Promise<SqliteStore> {
  const store = await SqliteStore.open(":memory:");
  stores.push(store);
  return store;
}

/** A call of `model` with `prompt` / `completion` tokens costing `cost`. */
function call(id: string, model: string | null, cost: number | null): LlmCallData {
  return LlmCallSchema.parse({
    call_id: id,
    log_day: "2026-03-10",
    requested_at: toTimestamp(T0),
    purpose: "chat",
    chain: "chat",
    kind: "chat",
    module: "agent",
    label: null,
    model,
    provider: model?.split(":")[0] ?? null,
    status: cost === null ? "error" : "ok",
    error_kind: cost === null ? "timeout" : null,
    finish_reason: cost === null ? null : "stop",
    reasoning: "off",
    usage:
      cost === null
        ? null
        : {
            prompt_tokens: 100,
            completion_tokens: 10,
            cached_prompt_tokens: 40,
            reasoning_tokens: null,
          },
    cost_usd: cost,
    duration_ms: 1200,
    first_token_ms: 300,
    fallbacks: [],
    retries: 0,
    tools: [],
  });
}

function append(store: SqliteStore, id: string, ms: number, data: LlmCallData, turn?: string) {
  return store.events.appendNow({
    draft: { id, at: toTimestamp(ms), type: LlmCall.type, v: LlmCall.v, turn: turn ?? null, data },
    source: "llm",
  });
}

describe("an LLM call", () => {
  it("is for the owner, kept 90 days, under its turn, with no place", async () => {
    const store = await open();
    const e = append(store, "e1", T0, call("c1", "a:big", 0.25), "T1");
    expect(e).toMatchObject({
      type: "llm.call",
      scope: "owner",
      tier: "short",
      turn: "T1",
      session: null,
      person_id: null,
      source: "llm",
    });
  });
});

describe("the cost and usage totals", () => {
  it("sum the calls with usage since a time, per model", async () => {
    const store = await open();
    append(store, "e0", T0 - MIN, call("c0", "a:big", 9));
    append(store, "e1", T0, call("c1", "b:small", 0.5));
    append(store, "e2", T0 + MIN, call("c2", "a:big", 0.25));
    append(store, "e3", T0 + 2 * MIN, call("c3", "a:big", 0.25));
    // Failed: no usage, counts nowhere.
    append(store, "e4", T0 + 3 * MIN, call("c4", "a:big", null));
    // A model without a price costs 0 and still counts.
    append(store, "e5", T0 + 4 * MIN, call("c5", "c:free", 0));
    const tokens = (calls: number) => ({
      calls,
      prompt_tokens: 100 * calls,
      completion_tokens: 10 * calls,
      cached_prompt_tokens: 40 * calls,
    });
    expect(store.llmCalls.totalsSince(toTimestamp(T0))).toEqual([
      { model: "a:big", ...tokens(2), cost_usd: 0.5 },
      { model: "b:small", ...tokens(1), cost_usd: 0.5 },
      { model: "c:free", ...tokens(1), cost_usd: 0 },
    ]);
    expect(store.llmCalls.totalsSince(toTimestamp(T0 - MIN))[0]).toEqual({
      model: "a:big",
      ...tokens(3),
      cost_usd: 9.5,
    });
    expect(store.llmCalls.totalsSince(toTimestamp(T0 + 5 * MIN))).toEqual([]);
  });

  it("are read over the partial index of core migration 5", () => {
    const t = openTestDb();
    try {
      // The query names the index's condition word for word, or SQLite would not use it.
      expect(LLM_CALLS_SQL).toContain(`WHERE ${LLM_CALL_TYPE_SQL};`);
      const plan = (sql: string) =>
        t.db
          .all(`EXPLAIN QUERY PLAN ${sql}`, { since: 0 })
          .map((r) => String(r.detail))
          .join(" | ");
      const totals =
        "SELECT json_extract(data, '$.model') AS model, total(json_extract(data, '$.cost_usd')) " +
        `FROM events INDEXED BY events_llm_call_idx WHERE ${LLM_CALL_TYPE_SQL} AND at >= $since ` +
        "GROUP BY 1";
      expect(plan(totals)).toMatch(/^SEARCH events USING INDEX events_llm_call_idx \(at>\?\)/);
    } finally {
      t.close();
    }
  });
});

describe("the llm_usage data category", () => {
  it("counts and exports the calls, apart from the event log, and is never wiped", async () => {
    const store = await open();
    append(store, "e1", T0, call("c1", "a:big", 0.25), "T1");
    store.events.appendNow({
      draft: { id: "o1", at: toTimestamp(T0), type: "facts.thought", data: { n: 1 } },
      source: "mind",
    });
    const inventory = await store.profileData.inventory("p");
    const usage = inventory.categories.find((c) => c.id === "llm_usage");
    expect(usage?.parts.map((p) => [p.id, p.count])).toEqual([["llm_calls", 1]]);
    expect(usage?.updated_at).toBe(toTimestamp(T0));
    expect(inventory.categories.find((c) => c.id === "event_log")?.count).toBe(1);

    const backup = await store.profileData.export("p", ["llm_usage"]);
    expect(backup.parts.llm_calls).toEqual([
      {
        id: "e1",
        at: toTimestamp(T0),
        call_id: "c1",
        log_day: "2026-03-10",
        purpose: "chat",
        module: "agent",
        model: "a:big",
        provider: "a",
        status: "ok",
        error_kind: null,
        prompt_tokens: 100,
        completion_tokens: 10,
        cached_prompt_tokens: 40,
        reasoning_tokens: null,
        cost_usd: 0.25,
        duration_ms: 1200,
        turn: "T1",
        data: call("c1", "a:big", 0.25),
      },
    ]);
    expect(() => resolveCategories(["llm_usage"])).toThrow(/kept/);
    await store.profileData.wipe("p", ["event_log"]);
    expect(store.llmCalls.totalsSince(toTimestamp(T0))).toHaveLength(1);
  });
});
