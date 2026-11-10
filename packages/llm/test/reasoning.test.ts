// `[llm.reasoning]` levels (docs/design/v2-architecture.md §3.10): per reasoning purpose,
// falling back to the legacy `[llm.thinking]` switch and the defaults, and how a level reaches
// the wire (an effort parameter, or on / off plus a `max_tokens` cap).

import type { ReasoningLevel } from "@miyoria/types";
import { describe, expect, it } from "vitest";
import {
  type ChatRequest,
  collectResponse,
  LlmConfigSchema,
  LlmRouter,
  MockProvider,
  OpenAiConfig,
  ProviderConfigSchema,
  parseModelRef,
  userMessage,
} from "../src/index.js";
import { requestBody } from "../src/openai/wire.js";

const request = (): ChatRequest => ({ messages: [userMessage("hi")] });

function router(
  reasoning: Map<string, ReasoningLevel>,
  thinking: Map<string, boolean> = new Map(),
): [LlmRouter, MockProvider] {
  const provider = new MockProvider("p").reply("a");
  const chain = [parseModelRef("p:m")];
  const purposes = new Map([
    ["chat", chain],
    ["fast", chain],
    ["mind", chain],
  ]);
  return [new LlmRouter(new Map([["p", provider]]), purposes, { reasoning, thinking }), provider];
}

describe("reasoning levels", () => {
  it("resolve_per_reasoning_purpose_then_legacy_then_defaults", async () => {
    const [r, provider] = router(
      new Map<string, ReasoningLevel>([["chat_text", "low"]]),
      new Map([
        ["chat", true],
        ["mind", true],
      ]),
    );
    const sent: [string, Partial<ChatRequest>][] = [
      // Configured level for the reasoning purpose.
      ["chat", { reasoning_purpose: "chat_text" }],
      // Unlisted reasoning purposes: their defaults (voice replies never think).
      ["chat", { reasoning_purpose: "chat_voice" }],
      ["chat", { reasoning_purpose: "chat_intent" }],
      // Legacy `[llm.thinking] mind = true` = medium; `fast` defaults to off.
      ["mind", {}],
      ["fast", {}],
      // Explicit values win.
      ["chat", { reasoning_purpose: "chat_text", thinking: false }],
      ["chat", { reasoning_purpose: "chat_voice", thinking: true }],
      ["chat", { reasoning: "high", reasoning_purpose: "chat_voice" }],
    ];
    for (const [purpose, extra] of sent) {
      await collectResponse(await r.stream(purpose, { ...request(), ...extra }));
    }
    const got = provider.requests().map((q) => [q.reasoning, q.thinking]);
    expect(got).toStrictEqual([
      ["low", true],
      ["off", false],
      ["low", true],
      ["medium", true],
      ["off", false],
      ["off", false],
      ["medium", true],
      ["high", true],
    ]);
    const calls = r.calls.list().items;
    expect(calls[0]?.reasoning).toBe("high");
    expect(calls.at(-1)?.reasoning).toBe("low");
  });

  it("chat_replies_do_not_reason_by_default_even_with_legacy_chat_thinking", () => {
    const [r] = router(new Map(), new Map([["chat", true]]));
    expect(r.reasoningFor("chat", { ...request(), reasoning_purpose: "chat_text" })).toBe("off");
    // Callers without a reasoning purpose keep the legacy switch.
    expect(r.reasoningFor("chat", request())).toBe("medium");
    expect(r.reasoningFor("review", request())).toBe("medium");
    expect(r.reasoningFor("plan_daily", request())).toBe("high");
    expect(r.reasoningFor("game", request())).toBe("off");
  });

  it("config_section_parses_levels", () => {
    const cfg = LlmConfigSchema.parse({ reasoning: { chat_text: "off", plan: "high" } });
    expect(cfg.reasoning).toStrictEqual({ chat_text: "off", plan: "high" });
    expect(() => LlmConfigSchema.parse({ reasoning: { plan: "deep" } })).toThrow();
    expect(LlmConfigSchema.parse({}).reasoning).toStrictEqual({});
  });

  it("levels_map_onto_effort_or_a_max_tokens_cap", () => {
    const cfg = (raw: Record<string, unknown>) =>
      OpenAiConfig.fromProviderConfig(ProviderConfigSchema.parse(raw));
    const deepseek = cfg({ kind: "deepseek" });
    expect(deepseek.reasoning.effort).toBe(false);
    expect(cfg({ kind: "openai" }).reasoning.effort).toBe(true);
    const body = (level: ReasoningLevel, max: number | null, c = deepseek) =>
      requestBody(
        { ...request(), reasoning: level, thinking: level !== "off", max_tokens: max },
        c.thinkingOff,
        c.reasoning,
      );
    // On / off providers: thinking on, length capped per level, a smaller max kept.
    expect(body("low", null).max_tokens).toBe(2048);
    expect(body("low", 500).max_tokens).toBe(500);
    expect(body("medium", null).max_tokens).toBe(8192);
    expect(body("high", null).max_tokens).toBeUndefined();
    expect(body("low", null).reasoning_effort).toBeUndefined();
    expect(body("off", null).thinking).toStrictEqual({ type: "disabled" });
    expect(body("off", null).max_tokens).toBeUndefined();
    // Effort providers get the level itself.
    const effort = cfg({ kind: "deepseek", reasoning_effort: true });
    expect(body("medium", null, effort).reasoning_effort).toBe("medium");
    expect(body("medium", null, effort).max_tokens).toBeUndefined();
    expect(body("off", null, effort).reasoning_effort).toBeUndefined();
    // Caps are configurable.
    const capped = cfg({ kind: "deepseek", reasoning_max_tokens: { low: 1000, high: 20000 } });
    expect(body("low", null, capped).max_tokens).toBe(1000);
    expect(body("high", null, capped).max_tokens).toBe(20000);
    expect(body("medium", null, capped).max_tokens).toBe(8192);
  });
});
