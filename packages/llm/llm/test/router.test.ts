import { MetricsRegistry } from "@miyoria/runtime/kernel";
import type { LlmCallStore, LlmModelTotals } from "@miyoria/store";
import { type Clock, type JsonValue, type Timestamp, toTimestamp } from "@miyoria/types";
import { describe, expect, it } from "vitest";
import {
  type BudgetConfig,
  budgetConfig,
  type ChatProvider,
  type ChatRequest,
  CostTracker,
  callCost,
  collectResponse,
  errorKind,
  LlmConfigSchema,
  LlmError,
  LlmRouter,
  llmMetrics,
  MockProvider,
  ProviderHttpError,
  ProviderTimeoutError,
  parseModelRef,
  periodStarts,
  pricing,
  type StreamEvent,
  userMessage,
} from "../src/index.js";

const req = (): ChatRequest => ({ messages: [userMessage("hi")] });

describe("LlmRouter", () => {
  function router(primary: MockProvider): LlmRouter {
    const providers = new Map<string, ChatProvider>([
      ["a", primary],
      ["b", new MockProvider("b").reply("from b")],
    ]);
    const purposes = new Map([["chat", [parseModelRef("a:m1"), parseModelRef("b:m2")]]]);
    return new LlmRouter(providers, purposes);
  }

  it("uses_first_model_and_falls_back_on_error", async () => {
    let r = router(new MockProvider("a").reply("from a"));
    expect((await r.complete("fast", req())).text).toBe("from a");

    r = router(new MockProvider("a").fail("down"));
    expect((await r.complete("chat", req())).text).toBe("from b");
    expect(r.usage().get("b:m2")?.calls).toBe(1);
  });

  it("falls back on a stream that fails before its first event, not after", async () => {
    const failing = (): AsyncIterable<never> => ({
      [Symbol.asyncIterator]: () => ({
        next: () => Promise.reject(new Error("first event failed")),
      }),
    });
    async function* late() {
      yield { type: "text_delta" as const, text: "partial" };
      throw new Error("mid-stream");
    }
    const early: ChatProvider = { name: "a", stream: async () => failing() };
    const r1 = new LlmRouter(
      new Map<string, ChatProvider>([
        ["a", early],
        ["b", new MockProvider("b").reply("from b")],
      ]),
      new Map([["chat", [parseModelRef("a:x"), parseModelRef("b:y")]]]),
    );
    expect((await r1.complete("chat", req())).text).toBe("from b");

    const midway: ChatProvider = { name: "a", stream: async () => late() };
    const r2 = new LlmRouter(
      new Map<string, ChatProvider>([
        ["a", midway],
        ["b", new MockProvider("b").reply("from b")],
      ]),
      new Map([["chat", [parseModelRef("a:x"), parseModelRef("b:y")]]]),
    );
    await expect(r2.complete("chat", req())).rejects.toThrow("mid-stream");
  });

  it("reports missing purposes and unknown providers", async () => {
    const empty = new LlmRouter(new Map(), new Map());
    await expect(empty.complete("chat", req())).rejects.toThrow(/no model configured/);
    expect(empty.hasPurpose("chat")).toBe(false);
    const unknown = new LlmRouter(new Map(), new Map([["chat", [parseModelRef("x:y")]]]));
    await expect(unknown.complete("chat", req())).rejects.toThrow("unknown provider `x`");
  });
});

// ---- cost tests ----------------------------------------------------------------------------

function at(y: number, mo: number, d: number, h: number): number {
  return Date.UTC(y, mo - 1, d, h, 0, 0);
}

/** One USD per completion token, so a call with `n` completion tokens costs `n` USD. */
function dollarPricing() {
  const p = pricing({ output_per_mtok: 1_000_000 });
  return new Map([
    ["a:m1", p],
    ["b:cheap", p],
  ]);
}

function provider(name: string, completionTokens: number): MockProvider {
  return new MockProvider(name).events([
    { type: "text_delta", text: `from ${name}` },
    {
      type: "done",
      finish_reason: "stop",
      usage: { prompt_tokens: 10, completion_tokens: completionTokens, cached_prompt_tokens: null },
    },
  ]);
}

function budget(daily: number): BudgetConfig {
  return budgetConfig({ daily_usd: daily });
}

interface Setup {
  router: LlmRouter;
  a: MockProvider;
  b: MockProvider;
  clock: Clock & { set(ms: number): void };
  events: Record<string, JsonValue>[];
}

/**
 * Router with `a:m1` (costs `cost` USD per call, used by `chat` and `fast`) and `b:cheap`, a
 * fake clock and a recorder for `llm.budget` events.
 */
function setup(cost: number, cfg: BudgetConfig, start: number): Setup {
  const a = provider("a", cost);
  const b = provider("b", 1);
  let now = start;
  const clock = {
    now: () => now,
    set: (ms: number) => {
      now = ms;
    },
  };
  const tracker = new CostTracker(dollarPricing(), cfg, clock);
  const router = new LlmRouter(
    new Map<string, ChatProvider>([
      ["a", a],
      ["b", b],
    ]),
    new Map([
      ["chat", [parseModelRef("a:m1")]],
      ["fast", [parseModelRef("a:m1")]],
    ]),
    { tracker },
  );
  const events: Record<string, JsonValue>[] = [];
  router.setEventSink((definition, data, ..._meta) => {
    expect(definition.type).toBe("llm.budget");
    events.push(data as Record<string, JsonValue>);
  });
  return { router, a, b, clock, events };
}

const states = (events: Record<string, JsonValue>[]) => events.map((p) => p.state);

describe("cost", () => {
  it("pricing_math_with_cached_tokens", () => {
    const p = pricing({ input_per_mtok: 3, cached_input_per_mtok: 0.3, output_per_mtok: 15 });
    const usage = {
      prompt_tokens: 1_000_000,
      completion_tokens: 100_000,
      cached_prompt_tokens: 400_000,
    };
    // 600k * 3 + 400k * 0.3 + 100k * 15, per million.
    expect(callCost(p, usage)).toBeCloseTo(3.42, 9);

    // Without a cached price the input price applies; over-reported cached tokens are clamped.
    const p2 = pricing({ input_per_mtok: 2, output_per_mtok: 0 });
    const u2 = { prompt_tokens: 500_000, completion_tokens: 0, cached_prompt_tokens: 900_000 };
    expect(callCost(p2, u2)).toBeCloseTo(1, 9);
  });

  it("tracks_cost_per_model_and_ignores_unpriced_models", async () => {
    const s = setup(3, budgetConfig(), at(2026, 3, 10, 0));
    await s.router.complete("chat", req());
    await s.router.complete("chat", req());
    const report = s.router.costReport();
    expect(report.today.period).toBe("2026-03-10");
    expect(report.month.period).toBe("2026-03");
    expect(report.today.total_usd).toBeCloseTo(6, 9);
    expect(report.today.models["a:m1"]?.calls).toBe(2);
    expect(report.month.models["a:m1"]?.completion_tokens).toBe(6);
    expect(s.router.usage().get("a:m1")?.calls).toBe(2);
    expect(report.state).toBe("ok");

    // A model without pricing costs 0 and is only warned about once.
    const t = new CostTracker();
    const u = { prompt_tokens: 100, completion_tokens: 100, cached_prompt_tokens: null };
    t.record("x:y", u);
    t.record("x:y", u);
    const r = t.report();
    expect(r.today.total_usd).toBe(0);
    expect(r.today.models["x:y"]?.calls).toBe(2);
    expect(t.unpricedLogged.size).toBe(1);
  });

  it("degrades_then_exhausts_and_stops", async () => {
    const cfg = budget(10);
    cfg.budget_exempt_purposes = ["fast"];
    const s = setup(4, cfg, at(2026, 3, 10, 0));
    const r = s.router;

    await r.complete("chat", req()); // 4
    expect(r.budgetState()).toBe("ok");
    expect(s.events).toHaveLength(0);

    await r.complete("chat", req()); // 8 = 80%
    expect(r.budgetState()).toBe("degraded");
    await r.complete("chat", req()); // 12
    expect(r.budgetState()).toBe("exhausted");
    expect(states(s.events)).toEqual(["degraded", "exhausted"]);

    const last = s.events.at(-1);
    expect(last?.daily_usd).toBe(10);
    expect(last?.monthly_usd).toBeNull();
    expect(last?.spent_today_usd).toBe(12);
    expect(last?.spent_month_usd).toBe(12);

    await expect(r.complete("chat", req())).rejects.toThrow(/^budget exhausted$/);
    await expect(r.stream("nonexistent", req())).rejects.toThrow(/^budget exhausted$/);
    // Exempt purposes keep working.
    expect((await r.complete("fast", req())).text).toBe("from a");
    // No duplicate events for an unchanged state.
    expect(s.events).toHaveLength(2);
  });

  it("monthly_limit_counts_too", async () => {
    const s = setup(9, budgetConfig({ monthly_usd: 10 }), at(2026, 3, 10, 0));
    const r = s.router;
    await r.complete("chat", req());
    expect(r.budgetState()).toBe("degraded");
    // The next day the daily total resets but the month does not.
    s.clock.set(at(2026, 3, 11, 0));
    await r.complete("chat", req());
    expect(r.budgetState()).toBe("exhausted");
    const report = r.costReport();
    expect(report.today.total_usd).toBeCloseTo(9, 9);
    expect(report.month.total_usd).toBeCloseTo(18, 9);
    expect(states(s.events)).toContain("exhausted");
  });

  it("rollover_restores_ok_and_uses_timezone", async () => {
    // 2026-03-10 17:00 UTC is already 03-11 in UTC+8.
    const s = setup(12, budget(10), at(2026, 3, 10, 17));
    const r = s.router;
    await r.complete("chat", req());
    expect(r.costReport().today.period).toBe("2026-03-11");
    expect(r.budgetState()).toBe("exhausted");
    await expect(r.stream("chat", req())).rejects.toThrow();

    // 15:00 UTC the next day is still 03-11 locally; 16:00 UTC is 03-12.
    s.clock.set(at(2026, 3, 11, 15));
    expect(r.budgetState()).toBe("exhausted");
    s.clock.set(at(2026, 3, 11, 16));
    expect(r.budgetState()).toBe("ok");
    expect(states(s.events)).toEqual(["exhausted", "ok"]);
    await r.complete("chat", req());

    let report = r.costReport();
    expect(report.today.period).toBe("2026-03-12");
    expect(report.today.total_usd).toBeCloseTo(12, 9);
    expect(report.month.total_usd).toBeCloseTo(24, 9);

    // Month rollover clears the month totals.
    s.clock.set(at(2026, 3, 31, 16));
    report = r.costReport();
    expect(report.month.period).toBe("2026-04");
    expect(report.month.total_usd).toBe(0);
    expect(report.today.total_usd).toBe(0);
  });

  it("period_starts_follow_the_timezone", () => {
    // 2026-03-10 17:00 UTC is 03-11 01:00 in UTC+8: the day began at 03-10 16:00 UTC.
    expect(periodStarts(at(2026, 3, 10, 17), 8)).toEqual([
      at(2026, 3, 10, 16),
      at(2026, 2, 28, 16),
    ]);
    expect(periodStarts(at(2026, 3, 1, 3), 0)).toEqual([at(2026, 3, 1, 0), at(2026, 3, 1, 0)]);
    expect(periodStarts(at(2026, 1, 1, 2), -5)).toEqual([at(2025, 12, 31, 5), at(2025, 12, 1, 5)]);
    // Out of range: UTC.
    expect(periodStarts(at(2026, 3, 10, 17), 30)).toEqual([at(2026, 3, 10, 0), at(2026, 3, 1, 0)]);
  });

  it("restores_spending_from_the_event_log", async () => {
    const totals = (calls: number): LlmModelTotals => ({
      model: "a:m1",
      calls,
      prompt_tokens: 10 * calls,
      completion_tokens: 3 * calls,
      cached_prompt_tokens: 0,
      cost_usd: 3 * calls,
    });
    const asked: Timestamp[] = [];
    const calls: LlmCallStore = {
      totalsSince: (since) => {
        asked.push(since);
        // Two calls today, five this month.
        return [totals(since === toTimestamp(at(2026, 3, 9, 16)) ? 2 : 5)];
      },
    };
    const s = setup(3, budget(7), at(2026, 3, 10, 5));
    await s.router.restoreUsage(calls);
    // Since the start of the day and of the month in UTC+8.
    expect(asked).toEqual([toTimestamp(at(2026, 3, 9, 16)), toTimestamp(at(2026, 2, 28, 16))]);
    const report = s.router.costReport();
    expect(report.today).toEqual({
      period: "2026-03-10",
      total_usd: 6,
      calls: 2,
      models: {
        "a:m1": {
          calls: 2,
          prompt_tokens: 20,
          completion_tokens: 6,
          cached_prompt_tokens: 0,
          cost_usd: 6,
        },
      },
    });
    expect(report.month.total_usd).toBe(15);
    // 6 of 7 is above the 80% line: the restored state was published.
    expect(report.state).toBe("degraded");
    expect(states(s.events)).toEqual(["degraded"]);
    // Calls of this run add to it; usage since startup does not include earlier runs.
    await s.router.complete("chat", req());
    expect(s.router.costReport().today).toMatchObject({ total_usd: 9, calls: 3 });
    expect(s.router.usage().get("a:m1")?.calls).toBe(1);
  });

  it("fallback_chain_used_while_degraded", async () => {
    const cfg = budget(20);
    cfg.fallback.chat = [parseModelRef("b:cheap")];
    const s = setup(17, cfg, at(2026, 3, 10, 0));
    const r = s.router;
    expect((await r.complete("chat", req())).text).toBe("from a");
    expect(r.budgetState()).toBe("degraded");

    // Chat is switched to the cheap model; `fast` has no fallback entry.
    expect((await r.complete("chat", req())).text).toBe("from b");
    expect((await r.complete("unknown", req())).text).toBe("from b");
    expect((await r.complete("fast", req())).text).toBe("from a");
    expect(s.a.requests()).toHaveLength(2);
    expect(s.b.requests()).toHaveLength(2);
    expect(s.b.requests()[0]?.model).toBe("cheap");
  });

  it("on_exhausted_fallback_keeps_running_on_fallback_models", async () => {
    const cfg = budget(10);
    cfg.on_exhausted = "fallback";
    cfg.fallback.chat = [parseModelRef("b:cheap")];
    const s = setup(12, cfg, at(2026, 3, 10, 0));
    const r = s.router;
    await r.complete("chat", req());
    expect(r.budgetState()).toBe("exhausted");
    expect((await r.complete("chat", req())).text).toBe("from b");
    // No fallback configured for `fast`: it keeps its normal chain.
    expect((await r.complete("fast", req())).text).toBe("from a");
  });

  it("config_parses_pricing_and_budget", () => {
    const cfg = LlmConfigSchema.parse({
      pricing: {
        "deepseek:deepseek-chat": {
          input_per_mtok: 0.27,
          cached_input_per_mtok: 0.07,
          output_per_mtok: 1.1,
        },
      },
      budget: {
        daily_usd: 2.0,
        on_exhausted: "fallback",
        fallback: { chat: ["deepseek:cheap"] },
        budget_exempt_purposes: ["fast"],
      },
    });
    expect(cfg.budget.on_exhausted).toBe("fallback");
    expect(cfg.budget.degrade_at).toBe(0.8);
    expect(cfg.budget.timezone_offset_hours).toBe(8);
    expect(cfg.budget.fallback.chat).toEqual([{ provider: "deepseek", model: "cheap" }]);
    expect(cfg.pricing["deepseek:deepseek-chat"]?.cached_input_per_mtok).toBe(0.07);
    expect(cfg.budget.monthly_usd).toBeNull();
    // Defaults for a missing section, and a bad model reference is rejected.
    expect(LlmConfigSchema.parse({}).budget.degrade_at).toBe(0.8);
    expect(() => LlmConfigSchema.parse({ purposes: { chat: ["no-colon"] } })).toThrow(
      /provider:model/,
    );
  });
});

describe("LlmRouter metrics", () => {
  /** A clock the test moves; providers advance it to simulate latency. */
  function manualClock(): Clock & { t: number } {
    return {
      t: 0,
      now() {
        return this.t;
      },
    };
  }

  /** A provider whose headers take `connectMs` and whose events take `eventMs` each. */
  function timed(
    name: string,
    clock: { t: number },
    connectMs: number,
    eventMs: number,
    events: StreamEvent[],
  ): ChatProvider {
    return {
      name,
      stream: async () => {
        clock.t += connectMs;
        return (async function* () {
          for (const ev of events) {
            clock.t += eventMs;
            yield ev;
          }
        })();
      },
    };
  }

  const usage = { prompt_tokens: 1000, completion_tokens: 200, cached_prompt_tokens: 400 };

  it("measures the first text or reasoning delta and counts calls, tokens and cost", async () => {
    const clock = manualClock();
    const registry = new MetricsRegistry();
    const events: StreamEvent[] = [
      { type: "tool_call_delta", index: 0, id: "c", name: "f", arguments: "" },
      { type: "reasoning_delta", text: "hmm" },
      { type: "text_delta", text: "hi" },
      { type: "done", finish_reason: "stop", usage },
    ];
    const r = new LlmRouter(
      new Map([["a", timed("a", clock, 100, 50, events)]]),
      new Map([["chat", [parseModelRef("a:m")]]]),
      {
        metrics: registry,
        clock,
        pricing: new Map([["a:m", pricing({ input_per_mtok: 1, output_per_mtok: 2 })]]),
      },
    );
    const stream = await r.stream("game", req());
    expect(stream.model).toBe("a:m");
    expect((await collectResponse(stream)).text).toBe("hi");
    // 100 ms to the headers, the tool call delta, then the reasoning delta.
    expect(stream.firstTokenMs).toBe(200);

    const m = llmMetrics(registry);
    const labels = { model: "a:m", purpose: "game" };
    expect(m.calls.get(labels)).toBe(1);
    expect(m.tokens.get({ ...labels, type: "prompt" })).toBe(1000);
    expect(m.tokens.get({ ...labels, type: "completion" })).toBe(200);
    expect(m.tokens.get({ ...labels, type: "cached_prompt" })).toBe(400);
    expect(m.cost.get(labels)).toBeCloseTo(
      callCost(pricing({ input_per_mtok: 1, output_per_mtok: 2 }), usage),
    );
    const text = registry.render();
    expect(text).toContain(
      'miyoria_llm_first_token_seconds_bucket{model="a:m",purpose="game",le="0.25"} 1',
    );
    expect(text).toContain('miyoria_llm_first_token_seconds_sum{model="a:m",purpose="game"} 0.2');
  });

  it("first token of a fallback includes the failed model for the caller, not the histogram", async () => {
    const clock = manualClock();
    const registry = new MetricsRegistry();
    const down: ChatProvider = {
      name: "a",
      stream: async () => {
        clock.t += 1000;
        throw new ProviderHttpError("a: HTTP 503 Service Unavailable: busy", 503);
      },
    };
    const r = new LlmRouter(
      new Map<string, ChatProvider>([
        ["a", down],
        ["b", timed("b", clock, 100, 0, [{ type: "text_delta", text: "x" }])],
      ]),
      new Map([["chat", [parseModelRef("a:m"), parseModelRef("b:m")]]]),
      { metrics: registry, clock },
    );
    const stream = await r.stream("chat", req());
    await collectResponse(stream).catch(() => undefined);
    expect(stream.firstTokenMs).toBe(1100);
    const m = llmMetrics(registry);
    expect(
      m.errors.get({ model: "a:m", purpose: "chat", stage: "request", kind: "http_5xx" }),
    ).toBe(1);
    expect(registry.render()).toContain(
      'miyoria_llm_first_token_seconds_sum{model="b:m",purpose="chat"} 0.1',
    );
  });

  it("counts mid-stream errors but not caller aborts; no first token without text", async () => {
    const registry = new MetricsRegistry();
    async function* broken() {
      yield { type: "tool_call_delta" as const, index: 0, id: null, name: "f", arguments: "" };
      throw new LlmError("a: stream interrupted: reset");
    }
    const r = new LlmRouter(
      new Map<string, ChatProvider>([["a", { name: "a", stream: async () => broken() }]]),
      new Map([["chat", [parseModelRef("a:m")]]]),
      { metrics: registry },
    );
    const stream = await r.stream("chat", req());
    await expect(collectResponse(stream)).rejects.toThrow(/stream interrupted/);
    expect(stream.firstTokenMs).toBeNull();
    const m = llmMetrics(registry);
    expect(m.errors.get({ model: "a:m", purpose: "chat", stage: "stream", kind: "error" })).toBe(1);
    expect(m.firstToken.count({ model: "a:m", purpose: "chat" })).toBe(0);

    const controller = new AbortController();
    controller.abort();
    const aborting: ChatProvider = {
      name: "a",
      stream: async (_r, signal) => {
        signal?.throwIfAborted();
        return broken();
      },
    };
    const r2 = new LlmRouter(
      new Map([["a", aborting]]),
      new Map([["chat", [parseModelRef("a:m")]]]),
      { metrics: registry },
    );
    await expect(r2.stream("chat", req(), controller.signal)).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(m.errors.get({ model: "a:m", purpose: "chat", stage: "request", kind: "aborted" })).toBe(
      0,
    );
  });

  it("classifies errors with bounded kinds", () => {
    expect(errorKind(new ProviderTimeoutError("x", "connect"))).toBe("connect_timeout");
    expect(errorKind(new ProviderTimeoutError("x", "idle"))).toBe("timeout");
    expect(errorKind(new ProviderHttpError("x", 429))).toBe("http_4xx");
    expect(errorKind(new ProviderHttpError("x", 500))).toBe("http_5xx");
    const idle = new DOMException("no data for 5 ms", "TimeoutError");
    expect(errorKind(new LlmError("request failed", { cause: idle }))).toBe("timeout");
    expect(errorKind(new DOMException("stop", "AbortError"))).toBe("aborted");
    expect(errorKind("weird")).toBe("error");
  });
});
