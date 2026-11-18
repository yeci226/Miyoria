// The llm module's card on the panel: today's spending against the daily budget and today's calls
// from the cost tracker, the share of today's calls that failed only when the call inspector kept
// all of them, and the budget's state once it is not ok.

import { CARD_MAX_FACTS, Supervisor } from "@miyoria/runtime/kernel";
import { afterEach, describe, expect, it } from "vitest";
import {
  type ChatProvider,
  LlmCallLog,
  LlmConfigSchema,
  LlmModule,
  LlmRouterKey,
  MockProvider,
  type ProviderFactory,
  userMessage,
} from "../src/index.js";

const mockFactory = (provider: ChatProvider): ProviderFactory => ({
  kinds: ["mock"],
  build: () => provider,
});

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f();
});

/** A module whose model costs 5 USD a reply (5 output tokens at 1 USD each). */
async function start(budget: Record<string, number>) {
  const config = LlmConfigSchema.parse({
    providers: { m: { kind: "mock" } },
    purposes: { chat: ["m:model-a"] },
    pricing: { "m:model-a": { output_per_mtok: 1_000_000 } },
    budget,
    call_log: { enabled: false },
  });
  const mock = new MockProvider("m").reply("嗨");
  const module = new LlmModule(config, [mockFactory(mock)]);
  const sup = new Supervisor();
  cleanup.push(() => sup.stopAll());
  await sup.register(module, null, true);
  await sup.startAll();
  const router = sup.services.require(LlmRouterKey);
  const ask = () => router.complete("chat", { messages: [userMessage("hi")] });
  return { module, ask };
}

describe("llm card", () => {
  it("shows today's spending against the budget and today's calls", async () => {
    const { module, ask } = await start({ daily_usd: 100 });
    expect((await module.card()).facts).toEqual([
      { label: "今天花費", value: "0.00 / 100.00", unit: "USD" },
      { label: "今天呼叫", value: 0, unit: "次" },
    ]);
    await ask();
    await ask();
    const card = await module.card();
    expect(card.facts.length).toBeLessThanOrEqual(CARD_MAX_FACTS);
    // The inspector holds no call from before today (it started now): no failure rate.
    expect(card.facts).toEqual([
      { label: "今天花費", value: "10.00 / 100.00", unit: "USD" },
      { label: "今天呼叫", value: 2, unit: "次" },
    ]);
  });

  it("says when the budget runs low or out, and shows the spending alone without a cap", async () => {
    const low = await start({ daily_usd: 6 });
    await low.ask();
    expect((await low.module.card()).facts.at(-1)).toEqual({ label: "預算", value: "快用完" });
    await low.ask();
    expect((await low.module.card()).facts.at(-1)).toEqual({ label: "預算", value: "用完了" });
    const free = await start({});
    await free.ask();
    expect((await free.module.card()).facts[0]).toEqual({
      label: "今天花費",
      value: "5.00",
      unit: "USD",
    });
  });

  it("has nothing to show before it runs", async () => {
    const module = new LlmModule(LlmConfigSchema.parse({}), []);
    expect(await module.card()).toEqual({ facts: [] });
  });
});

describe("call log outcomes", () => {
  function call(log: LlmCallLog, id: string, at: string, status: "ok" | "error" | "aborted") {
    log.open(id, at, "chat", "chat", { messages: [] }, false, undefined);
    const record = log.get(id);
    if (record) record.status = status;
  }

  it("counts the finished calls of the span and whether the ring holds all of it", () => {
    const log = new LlmCallLog();
    call(log, "a", "2026-11-16T15:00:00.000Z", "error");
    call(log, "b", "2026-11-16T17:00:00.000Z", "ok");
    call(log, "c", "2026-11-16T18:00:00.000Z", "error");
    call(log, "d", "2026-11-16T19:00:00.000Z", "aborted");
    log.open("e", "2026-11-16T20:00:00.000Z", "chat", "chat", { messages: [] }, false, undefined);
    expect(log.outcomes("2026-11-16T16:00:00.000Z")).toEqual({
      finished: 2,
      errors: 1,
      whole: true,
    });
    // Nothing kept from before the span: some of it may be missing.
    expect(log.outcomes("2026-11-16T14:00:00.000Z")).toEqual({
      finished: 3,
      errors: 2,
      whole: false,
    });
  });
});
