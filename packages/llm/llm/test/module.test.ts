import { Supervisor } from "@miyoria/runtime/kernel";
import { type LlmCallStore, type Store, StoreKey } from "@miyoria/store";
import { describe, expect, it } from "vitest";
import {
  type ChatProvider,
  LlmConfigSchema,
  LlmModule,
  LlmRouterKey,
  MockProvider,
  type ProviderFactory,
  parseModelRef,
  userMessage,
  withLlmTag,
} from "../src/index.js";

const mockFactory = (provider: ChatProvider): ProviderFactory => ({
  kinds: ["mock"],
  build: () => provider,
});

describe("LlmModule", () => {
  it("provides the router, announces the budget and publishes every call", async () => {
    const config = LlmConfigSchema.parse({
      providers: { m: { kind: "mock", some_setting: 1 } },
      purposes: { chat: ["m:model-a"] },
      pricing: { "m:model-a": { output_per_mtok: 1_000_000 } },
      budget: { daily_usd: 100 },
      call_log: { enabled: false },
    });
    expect(config.providers.m).toEqual({
      kind: "mock",
      base_url: null,
      api_key: null,
      extra: { some_setting: 1 },
    });
    const mock = new MockProvider("m").reply("嗨");
    const llm = new LlmModule(config, [mockFactory(mock)], {
      purposeOverrides: new Map([["fast", [parseModelRef("m:model-fast")]]]),
    });
    const sup = new Supervisor();
    const asked: string[] = [];
    const calls: LlmCallStore = {
      totalsSince: (since) => {
        asked.push(since);
        return [];
      },
    };
    sup.services.provide("kernel", StoreKey, { llmCalls: calls } as unknown as Store);
    const budgetEvents = sup.bus.subscribe("llm.budget");
    const callEvents = sup.bus.subscribe("llm.call");
    await sup.register(llm, null, true);
    await sup.startAll();
    // Today's and this month's spending, read once.
    expect(asked).toHaveLength(2);

    const router = sup.services.require(LlmRouterKey);
    const reply = await withLlmTag({ module: "agent", turn: "T1", label: "reply" }, () =>
      router.complete("chat", { messages: [userMessage("hi")] }),
    );
    expect(reply.text).toBe("嗨");
    await router.complete("fast", { messages: [] });
    expect(mock.requests().map((r) => r.model)).toEqual(["model-a", "model-fast"]);

    const announced = budgetEvents.tryRecv();
    expect(announced?.source).toBe("llm");
    expect(announced).toMatchObject({
      type: "llm.budget",
      data: { state: "ok", daily_usd: 100 },
    });

    // One `llm.call` per call, under its turn: metadata and cost, never the text.
    const first = callEvents.tryRecv();
    expect(first?.source).toBe("llm");
    expect(first?.turn).toBe("T1");
    expect(first).toMatchObject({
      type: "llm.call",
      data: {
        log_day: null,
        purpose: "chat",
        chain: "chat",
        module: "agent",
        label: "reply",
        model: "m:model-a",
        provider: "m",
        status: "ok",
        error_kind: null,
        finish_reason: "stop",
        usage: {
          prompt_tokens: 10,
          completion_tokens: 5,
          cached_prompt_tokens: 0,
          reasoning_tokens: null,
        },
        cost_usd: 5,
        fallbacks: [],
        retries: 0,
      },
    });
    expect(JSON.stringify(first)).not.toContain("嗨");
    const second = callEvents.tryRecv();
    expect(second?.turn).toBeNull();
    expect(second).toMatchObject({
      data: { purpose: "fast", model: "m:model-fast", cost_usd: 0 },
    });

    // A restart keeps the spending in memory and does not read it again.
    await sup.disable("llm");
    expect(sup.services.get(LlmRouterKey)).toBeUndefined();
    await sup.enable("llm");
    expect(asked).toHaveLength(2);
    expect(sup.services.require(LlmRouterKey).costReport().today.total_usd).toBe(5);
    await sup.stopAll();
  });

  it("fails to start with an unknown provider kind", async () => {
    const config = LlmConfigSchema.parse({ providers: { x: { kind: "nope" } } });
    const sup = new Supervisor();
    await sup.register(new LlmModule(config, []), null, true);
    await sup.startAll();
    await new Promise((r) => setTimeout(r, 0));
    expect(sup.list()[0]).toMatchObject({
      state: "failed",
      reason: "start failed: provider `x`: unknown kind `nope`",
    });
    await sup.stopAll();
  });
});
