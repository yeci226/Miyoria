// Pins of what a restart keeps of LLM usage, cost and the budget: the `llm` module beside the
// facts module on one store, stopped and started again as Core does (both services the app
// provides, facts first so it stops last). Written as literals against the totals as they were
// kept before LLM calls became events (docs/design/v5-data.md §8 step 7), so the step keeps
// every number. Only `Date` is faked: the modules' timers run.

import {
  type ChatProvider,
  LlmConfigSchema,
  LlmModule,
  type LlmRouter,
  LlmRouterKey,
  MockProvider,
  type ProviderFactory,
  userMessage,
} from "@miyoria/llm/llm";
import { Supervisor } from "@miyoria/runtime/kernel";
import { openStore, SettingsStoreKey, type Store, StoreKey } from "@miyoria/store";
import { Events, is, type JsonValue, PlatformSinks, PlatformSinksKey } from "@miyoria/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FactsModule } from "../src/module.js";

const FACTS = { flush_ms: 5 };

/** `m:big` costs 3.25 USD a call, `m:small` 0.5. */
const CONFIG = LlmConfigSchema.parse({
  providers: { m: { kind: "mock" } },
  purposes: { chat: ["m:big"], fast: ["m:small"] },
  pricing: {
    "m:big": { input_per_mtok: 2, cached_input_per_mtok: 0.5, output_per_mtok: 8 },
    "m:small": { input_per_mtok: 1, output_per_mtok: 1 },
  },
  budget: { daily_usd: 10 },
  call_log: { enabled: false },
});

/** Answers per model, with the usage that gives the prices above. */
const provider: ChatProvider = {
  name: "m",
  async stream(request) {
    const big = request.model === "big";
    const usage = big
      ? { prompt_tokens: 1_000_000, completion_tokens: 250_000, cached_prompt_tokens: 500_000 }
      : { prompt_tokens: 250_000, completion_tokens: 250_000, cached_prompt_tokens: null };
    return new MockProvider("m")
      .events([
        { type: "text_delta", text: "ok" },
        { type: "done", finish_reason: "stop", usage },
      ])
      .stream(request);
  },
};
const factory: ProviderFactory = { kinds: ["mock"], build: () => provider };

const BIG = (calls: number) => ({
  calls,
  prompt_tokens: 1_000_000 * calls,
  completion_tokens: 250_000 * calls,
  cached_prompt_tokens: 500_000 * calls,
  cost_usd: 3.25 * calls,
});
const SMALL = (calls: number) => ({
  calls,
  prompt_tokens: 250_000 * calls,
  completion_tokens: 250_000 * calls,
  cached_prompt_tokens: 0,
  cost_usd: 0.5 * calls,
});

interface Run {
  supervisor: Supervisor;
  router: LlmRouter;
  /** Payloads of the `llm.budget` events published while it started. */
  announced: Record<string, JsonValue>[];
}

let store: Store;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  store = await openStore("memory://");
});

afterEach(async () => {
  await store.close();
  vi.useRealTimers();
});

/** Core's two modules on `store`, started at `now`. */
async function start(now: string): Promise<Run> {
  vi.setSystemTime(Date.parse(now));
  const supervisor = new Supervisor();
  supervisor.services.provide("kernel", PlatformSinksKey, new PlatformSinks());
  supervisor.services.provide("kernel", StoreKey, store);
  supervisor.services.provide("kernel", SettingsStoreKey, store.settings);
  const budget = supervisor.bus.subscribe("llm.budget");
  await supervisor.register(new FactsModule(store, "p"), FACTS as unknown as JsonValue, true);
  await supervisor.register(new LlmModule(CONFIG, [factory]), null, true);
  await supervisor.startAll();
  const announced: Record<string, JsonValue>[] = [];
  for (let env = budget.tryRecv(); env !== null; env = budget.tryRecv()) {
    if (is(Events.LlmBudget, env)) announced.push(env.data as never);
  }
  budget.close();
  return { supervisor, router: supervisor.services.require(LlmRouterKey), announced };
}

const ask = (router: LlmRouter, purpose: string) =>
  router.complete(purpose, { messages: [userMessage("hi")] });

describe("what a restart keeps of LLM usage (pinned)", () => {
  it("keeps today's and this month's totals per model, and the budget state", async () => {
    let run = await start("2026-03-10T00:00:00Z");
    await ask(run.router, "chat");
    await ask(run.router, "chat");
    await ask(run.router, "fast");
    const before = run.router.costReport();
    expect(before).toEqual({
      state: "ok",
      daily_usd: 10,
      monthly_usd: null,
      degrade_at: 0.8,
      today: {
        period: "2026-03-10",
        total_usd: 7,
        calls: 3,
        models: { "m:big": BIG(2), "m:small": SMALL(1) },
      },
      month: {
        period: "2026-03",
        total_usd: 7,
        calls: 3,
        models: { "m:big": BIG(2), "m:small": SMALL(1) },
      },
    });
    await run.supervisor.stopAll();

    // Later the same day.
    run = await start("2026-03-10T05:00:00Z");
    expect(run.router.costReport()).toEqual(before);
    // Usage since startup starts again.
    expect([...run.router.usage()]).toEqual([]);
    expect(run.announced.at(-1)).toEqual({
      state: "ok",
      spent_today_usd: 7,
      daily_usd: 10,
      spent_month_usd: 7,
      monthly_usd: null,
    });
    // 10.25: past the limit.
    await ask(run.router, "chat");
    expect(run.router.budgetState()).toBe("exhausted");
    await run.supervisor.stopAll();

    // Still exhausted after a restart: the first call is refused.
    run = await start("2026-03-10T06:00:00Z");
    expect(run.router.budgetState()).toBe("exhausted");
    expect(run.announced.at(-1)).toEqual({
      state: "exhausted",
      spent_today_usd: 10.25,
      daily_usd: 10,
      spent_month_usd: 10.25,
      monthly_usd: null,
    });
    await expect(ask(run.router, "chat")).rejects.toThrow(/^budget exhausted$/);
    expect(run.router.costReport().today.models).toEqual({ "m:big": BIG(3), "m:small": SMALL(1) });
    await run.supervisor.stopAll();

    // The next day in UTC+8 (16:00 UTC): today is empty, the month is kept.
    run = await start("2026-03-10T16:00:00Z");
    expect(run.router.costReport()).toEqual({
      state: "ok",
      daily_usd: 10,
      monthly_usd: null,
      degrade_at: 0.8,
      today: { period: "2026-03-11", total_usd: 0, calls: 0, models: {} },
      month: {
        period: "2026-03",
        total_usd: 10.25,
        calls: 4,
        models: { "m:big": BIG(3), "m:small": SMALL(1) },
      },
    });
    await ask(run.router, "fast");
    await run.supervisor.stopAll();

    // Two days on: the month holds both days.
    run = await start("2026-03-12T01:00:00Z");
    expect(run.router.costReport().month).toEqual({
      period: "2026-03",
      total_usd: 10.75,
      calls: 5,
      models: { "m:big": BIG(3), "m:small": SMALL(2) },
    });
    await run.supervisor.stopAll();

    // The next month starts empty.
    run = await start("2026-03-31T16:00:00Z");
    expect(run.router.costReport()).toMatchObject({
      today: { period: "2026-04-01", total_usd: 0, calls: 0, models: {} },
      month: { period: "2026-04", total_usd: 0, calls: 0, models: {} },
    });
    await run.supervisor.stopAll();
  });

  it("keeps the totals when only the llm module restarts", async () => {
    const run = await start("2026-03-10T00:00:00Z");
    await ask(run.router, "chat");
    await run.supervisor.disable("llm");
    await run.supervisor.enable("llm");
    const router = run.supervisor.services.require(LlmRouterKey);
    expect(router.costReport().today).toEqual({
      period: "2026-03-10",
      total_usd: 3.25,
      calls: 1,
      models: { "m:big": BIG(1) },
    });
    await ask(router, "fast");
    expect(router.costReport().today.total_usd).toBe(3.75);
    await run.supervisor.stopAll();
  });
});
