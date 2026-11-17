// Pins of what the router reports about usage, cost and the budget: per model, per purpose and
// per day, and the budget check below, at and above its lines. Written as literals against the
// totals as they were kept before LLM calls became events (docs/design/v5-data.md §8 step 7), so
// the step keeps every number. Prices and token counts are chosen so every cost is exact in
// binary floating point.

import type { Clock, JsonValue } from "@miyoria/types";
import { describe, expect, it } from "vitest";
import {
  type BudgetConfig,
  budgetConfig,
  type ChatProvider,
  type ChatRequest,
  CostTracker,
  LlmError,
  LlmRouter,
  MockProvider,
  parseModelRef,
  pricing,
  type StreamEvent,
  type Usage,
  userMessage,
} from "../src/index.js";

const req = (): ChatRequest => ({ messages: [userMessage("hi")] });

const at = (iso: string): number => Date.parse(iso);

/** `a:big` costs 3.25 USD a call, `b:small` 0.5; `c:free` has no price. */
const PRICES = new Map([
  ["a:big", pricing({ input_per_mtok: 2, cached_input_per_mtok: 0.5, output_per_mtok: 8 })],
  ["b:small", pricing({ input_per_mtok: 1, output_per_mtok: 1 })],
]);

const BIG: Usage = {
  prompt_tokens: 1_000_000,
  completion_tokens: 250_000,
  cached_prompt_tokens: 500_000,
  reasoning_tokens: 50_000,
};
const SMALL: Usage = {
  prompt_tokens: 250_000,
  completion_tokens: 250_000,
  cached_prompt_tokens: null,
};
const FREE: Usage = { prompt_tokens: 100, completion_tokens: 20, cached_prompt_tokens: null };

function answer(text: string, usage: Usage | null): StreamEvent[] {
  return [
    { type: "text_delta", text },
    { type: "done", finish_reason: "stop", usage },
  ];
}

/** A provider that answers with `usage`, answers without usage, or fails, as set. */
class Model implements ChatProvider {
  readonly name: string;
  mode: "ok" | "no_usage" | "fail" = "ok";
  readonly #usage: Usage;

  constructor(name: string, usage: Usage) {
    this.name = name;
    this.#usage = usage;
  }

  async stream() {
    if (this.mode === "fail") throw new LlmError(`${this.name} is down`);
    const usage = this.mode === "ok" ? this.#usage : null;
    return new MockProvider(this.name).events(answer(`from ${this.name}`, usage)).stream(req());
  }
}

interface Rig {
  router: LlmRouter;
  a: Model;
  b: Model;
  c: Model;
  clock: Clock & { set(ms: number): void };
  budget: Record<string, JsonValue>[];
}

/**
 * `chat` is `a:big` then `b:small`, `fast` is `b:small`, `vision` is `c:free`; a fake clock;
 * the `llm.budget` events as they are published.
 */
function rig(cfg: BudgetConfig, start: string): Rig {
  const a = new Model("a", BIG);
  const b = new Model("b", SMALL);
  const c = new Model("c", FREE);
  let now = at(start);
  const clock = {
    now: () => now,
    set: (ms: number) => {
      now = ms;
    },
  };
  const router = new LlmRouter(
    new Map<string, ChatProvider>([
      ["a", a],
      ["b", b],
      ["c", c],
    ]),
    new Map([
      ["chat", [parseModelRef("a:big"), parseModelRef("b:small")]],
      ["fast", [parseModelRef("b:small")]],
      ["vision", [parseModelRef("c:free")]],
    ]),
    { tracker: new CostTracker(PRICES, cfg, clock), clock },
  );
  const budget: Record<string, JsonValue>[] = [];
  router.setEventSink((definition, data, ..._meta) => {
    if (definition.type === "llm.budget") budget.push(data as Record<string, JsonValue>);
  });
  return { router, a, b, c, clock, budget };
}

/** The totals of `stats` groups, without the latencies. */
function groups(list: { key: string; calls: number; errors: number; cost_usd: number }[]) {
  return list.map(({ key, calls, errors, cost_usd }) => ({ key, calls, errors, cost_usd }));
}

describe("usage and cost (pinned)", () => {
  it("per model, per purpose and per day", async () => {
    const s = rig(budgetConfig(), "2026-03-10T00:00:00Z");
    const r = s.router;
    await r.complete("chat", req());
    await r.complete("chat", req());
    await r.complete("fast", req());
    await r.complete("vision", req());
    // `a` fails: the chain falls back to `b`.
    s.a.mode = "fail";
    await r.complete("chat", req());
    // A call whose model reports no usage is not counted.
    s.c.mode = "no_usage";
    await r.complete("vision", req());
    // A call that fails everywhere is not counted either.
    s.b.mode = "fail";
    await expect(r.complete("chat", req())).rejects.toThrow("b is down");

    expect([...r.usage()]).toEqual([
      [
        "a:big",
        {
          calls: 2,
          prompt_tokens: 2_000_000,
          completion_tokens: 500_000,
          cached_prompt_tokens: 1_000_000,
        },
      ],
      [
        "b:small",
        { calls: 2, prompt_tokens: 500_000, completion_tokens: 500_000, cached_prompt_tokens: 0 },
      ],
      ["c:free", { calls: 1, prompt_tokens: 100, completion_tokens: 20, cached_prompt_tokens: 0 }],
    ]);
    const models = {
      "a:big": {
        calls: 2,
        prompt_tokens: 2_000_000,
        completion_tokens: 500_000,
        cached_prompt_tokens: 1_000_000,
        cost_usd: 6.5,
      },
      "b:small": {
        calls: 2,
        prompt_tokens: 500_000,
        completion_tokens: 500_000,
        cached_prompt_tokens: 0,
        cost_usd: 1,
      },
      "c:free": {
        calls: 1,
        prompt_tokens: 100,
        completion_tokens: 20,
        cached_prompt_tokens: 0,
        cost_usd: 0,
      },
    };
    expect(r.costReport()).toEqual({
      state: "ok",
      daily_usd: null,
      monthly_usd: null,
      degrade_at: 0.8,
      today: { period: "2026-03-10", total_usd: 7.5, calls: 5, models },
      month: { period: "2026-03", total_usd: 7.5, calls: 5, models },
    });

    // The call inspector, per purpose and per model (every finished call, failures included).
    const stats = r.calls.stats();
    expect(groups(stats.by_purpose)).toEqual([
      { key: "chat", calls: 4, errors: 1, cost_usd: 7 },
      { key: "fast", calls: 1, errors: 0, cost_usd: 0.5 },
      { key: "vision", calls: 2, errors: 0, cost_usd: 0 },
    ]);
    expect(groups(stats.by_model)).toEqual([
      { key: "a:big", calls: 2, errors: 0, cost_usd: 6.5 },
      { key: "b:small", calls: 3, errors: 1, cost_usd: 1 },
      { key: "c:free", calls: 2, errors: 0, cost_usd: 0 },
    ]);
    expect(stats.total).toMatchObject({
      calls: 7,
      errors: 1,
      prompt_tokens: 2_500_100,
      completion_tokens: 1_000_020,
      cached_prompt_tokens: 1_000_000,
      reasoning_tokens: 100_000,
      cost_usd: 7.5,
    });

    // 16:00 UTC is midnight in UTC+8: a new day, the same month.
    s.clock.set(at("2026-03-10T16:00:00Z"));
    s.b.mode = "ok";
    await r.complete("fast", req());
    const next = r.costReport();
    expect(next.today).toEqual({
      period: "2026-03-11",
      total_usd: 0.5,
      calls: 1,
      models: {
        "b:small": {
          calls: 1,
          prompt_tokens: 250_000,
          completion_tokens: 250_000,
          cached_prompt_tokens: 0,
          cost_usd: 0.5,
        },
      },
    });
    expect(next.month).toMatchObject({ period: "2026-03", total_usd: 8, calls: 6 });
    expect(next.month.models["b:small"]).toMatchObject({ calls: 3, cost_usd: 1.5 });
    // Usage since startup does not care about days.
    expect(r.usage().get("b:small")?.calls).toBe(3);

    // The next month starts empty.
    s.clock.set(at("2026-03-31T16:00:00Z"));
    expect(r.costReport()).toMatchObject({
      today: { period: "2026-04-01", total_usd: 0, calls: 0, models: {} },
      month: { period: "2026-04", total_usd: 0, calls: 0, models: {} },
    });
  });

  it("the daily budget below, at and above its lines", async () => {
    // 2.5 a day, degraded from 2.0; `fast` (0.5 a call) is exempt.
    const s = rig(
      budgetConfig({ daily_usd: 2.5, budget_exempt_purposes: ["fast"] }),
      "2026-03-10T00:00:00Z",
    );
    const r = s.router;
    // `chat` answered by `b` only: `a` keeps failing.
    s.a.mode = "fail";
    for (let i = 0; i < 3; i++) await r.complete("chat", req());
    // 1.5: below the degrade line.
    expect(r.budgetState()).toBe("ok");
    expect(s.budget).toEqual([]);

    await r.complete("chat", req());
    // 2.0: at the degrade line.
    expect(r.budgetState()).toBe("degraded");
    await r.complete("chat", req());
    // 2.5: at the limit.
    expect(r.budgetState()).toBe("exhausted");
    expect(s.budget).toEqual([
      {
        state: "degraded",
        spent_today_usd: 2,
        daily_usd: 2.5,
        spent_month_usd: 2,
        monthly_usd: null,
      },
      {
        state: "exhausted",
        spent_today_usd: 2.5,
        daily_usd: 2.5,
        spent_month_usd: 2.5,
        monthly_usd: null,
      },
    ]);
    await expect(r.complete("chat", req())).rejects.toThrow(/^budget exhausted$/);
    expect(r.calls.list({ status: "error" }).items[0]).toMatchObject({
      purpose: "chat",
      error: "budget exhausted",
      error_kind: "error",
      model: null,
    });

    // An exempt purpose still runs: 3.0, above the limit.
    await r.complete("fast", req());
    expect(r.costReport()).toMatchObject({
      state: "exhausted",
      daily_usd: 2.5,
      today: { total_usd: 3, calls: 6 },
    });
    expect(s.budget).toHaveLength(2);

    // A new day in UTC+8 lifts it.
    s.clock.set(at("2026-03-10T16:00:00Z"));
    expect(r.budgetState()).toBe("ok");
    expect(s.budget.at(-1)).toEqual({
      state: "ok",
      spent_today_usd: 0,
      daily_usd: 2.5,
      spent_month_usd: 3,
      monthly_usd: null,
    });
  });

  it("the monthly budget across days", async () => {
    const s = rig(budgetConfig({ monthly_usd: 1.25 }), "2026-03-10T00:00:00Z");
    const r = s.router;
    await r.complete("fast", req());
    // 0.5 of 1.25.
    expect(r.budgetState()).toBe("ok");
    s.clock.set(at("2026-03-12T00:00:00Z"));
    await r.complete("fast", req());
    // 1.0: past 80 %.
    expect(r.budgetState()).toBe("degraded");
    s.clock.set(at("2026-03-20T00:00:00Z"));
    await r.complete("fast", req());
    // 1.5: past the limit, on a day that alone spent 0.5.
    expect(r.costReport()).toMatchObject({
      state: "exhausted",
      today: { period: "2026-03-20", total_usd: 0.5 },
      month: { period: "2026-03", total_usd: 1.5, calls: 3 },
    });
    await expect(r.complete("fast", req())).rejects.toThrow(/^budget exhausted$/);
  });
});
