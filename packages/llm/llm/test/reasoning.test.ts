// `[llm.reasoning]` levels (docs/design/v2-architecture.md §3.10): per reasoning purpose,
// falling back to the defaults, and how a level reaches
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
  OpenAiProvider,
  ProviderConfigSchema,
  parseModelRef,
  userMessage,
} from "../src/index.js";
import { wireBody } from "./support.js";

const request = (): ChatRequest => ({ messages: [userMessage("hi")] });

function router(reasoning: Map<string, ReasoningLevel>): [LlmRouter, MockProvider] {
  const provider = new MockProvider("p").reply("a");
  const chain = [parseModelRef("p:m")];
  const purposes = new Map([
    ["chat", chain],
    ["fast", chain],
    ["mind", chain],
  ]);
  return [new LlmRouter(new Map([["p", provider]]), purposes, { reasoning }), provider];
}

describe("reasoning levels", () => {
  it("resolve_per_reasoning_purpose_then_defaults", async () => {
    const [r, provider] = router(new Map<string, ReasoningLevel>([["chat_text", "low"]]));
    const sent: [string, Partial<ChatRequest>][] = [
      // Configured level for the reasoning purpose.
      ["chat", { reasoning_purpose: "chat_text" }],
      // Unlisted reasoning purposes: their defaults (voice replies never think).
      ["chat", { reasoning_purpose: "chat_voice" }],
      ["chat", { reasoning_purpose: "reflect" }],
      // Purposes nobody lists do not reason; `fast` defaults to off.
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
      ["high", true],
      ["off", false],
      ["off", false],
      ["off", false],
      ["medium", true],
      ["high", true],
    ]);
    const calls = r.calls.list().items;
    expect(calls[0]?.reasoning).toBe("high");
    expect(calls.at(-1)?.reasoning).toBe("low");
  });

  it("chat_replies_do_not_reason_by_default", () => {
    const [r] = router(new Map());
    expect(r.reasoningFor("chat", { ...request(), reasoning_purpose: "chat_text" })).toBe("off");
    expect(r.reasoningFor("chat", request())).toBe("off");
    expect(r.reasoningFor("review", request())).toBe("medium");
    expect(r.reasoningFor("reflect", request())).toBe("high");
    expect(r.reasoningFor("game", request())).toBe("off");
  });

  it("config_section_parses_levels", () => {
    const cfg = LlmConfigSchema.parse({ reasoning: { chat_text: "off", plan: "high" } });
    expect(cfg.reasoning).toStrictEqual({ chat_text: "off", plan: "high" });
    expect(() => LlmConfigSchema.parse({ reasoning: { plan: "deep" } })).toThrow();
    expect(LlmConfigSchema.parse({}).reasoning).toStrictEqual({});
  });

  it("levels_map_onto_effort_or_a_max_tokens_cap", async () => {
    const cfg = (raw: Record<string, unknown>) =>
      OpenAiConfig.fromProviderConfig(ProviderConfigSchema.parse(raw));
    const deepseek = cfg({ kind: "deepseek" });
    expect(deepseek.reasoning.effort).toBe(false);
    expect(cfg({ kind: "openai" }).reasoning.effort).toBe(true);
    const body = (level: ReasoningLevel, max: number | null, c = deepseek) =>
      wireBody({ ...request(), reasoning: level, thinking: level !== "off", max_tokens: max }, c);
    // On / off providers: thinking on, length capped per level, a smaller max kept.
    expect((await body("low", null)).max_tokens).toBe(2048);
    expect((await body("low", 500)).max_tokens).toBe(500);
    expect((await body("medium", null)).max_tokens).toBe(8192);
    expect((await body("high", null)).max_tokens).toBeUndefined();
    expect((await body("low", null)).reasoning_effort).toBeUndefined();
    expect((await body("off", null)).thinking).toStrictEqual({ type: "disabled" });
    expect((await body("off", null)).max_tokens).toBeUndefined();
    // Effort providers get the level: DeepSeek has no `medium` and takes it as `high`.
    const effort = cfg({ kind: "deepseek", reasoning_effort: true });
    expect((await body("low", null, effort)).reasoning_effort).toBe("low");
    expect((await body("medium", null, effort)).reasoning_effort).toBe("high");
    expect((await body("high", null, effort)).reasoning_effort).toBe("high");
    expect((await body("medium", null, effort)).max_tokens).toBeUndefined();
    expect((await body("off", null, effort)).reasoning_effort).toBeUndefined();
    // The other kinds send the level itself.
    const openai = cfg({ kind: "openai", api_key: "k" });
    expect((await body("medium", null, openai)).reasoning_effort).toBe("medium");
    // Caps are configurable.
    const capped = cfg({ kind: "deepseek", reasoning_max_tokens: { low: 1000, high: 20000 } });
    expect((await body("low", null, capped)).max_tokens).toBe(1000);
    expect((await body("high", null, capped)).max_tokens).toBe(20000);
    expect((await body("medium", null, capped)).max_tokens).toBe(8192);
  });

  it("opencode_sends_reasoning_effort_and_never_caps_the_answer", async () => {
    const cfg = (raw: Record<string, unknown>) =>
      OpenAiConfig.fromProviderConfig(ProviderConfigSchema.parse({ api_key: "k", ...raw }));
    const opencode = cfg({ kind: "opencode" });
    expect(opencode.reasoning.effort).toBe(true);
    const body = (level: ReasoningLevel, max: number | null, c = opencode) =>
      wireBody({ ...request(), reasoning: level, thinking: level !== "off", max_tokens: max }, c);
    expect((await body("low", null)).reasoning_effort).toBe("low");
    expect((await body("low", null)).max_tokens).toBeUndefined();
    expect((await body("low", null)).thinking).toBeUndefined();
    expect((await body("high", null)).reasoning_effort).toBe("high");
    // A caller's own limit is kept as it is, not lowered to a level cap.
    expect((await body("low", 6000)).max_tokens).toBe(6000);
    // Off: the switch alone, no effort.
    expect((await body("off", null)).thinking).toStrictEqual({ type: "disabled" });
    expect((await body("off", null)).reasoning_effort).toBeUndefined();
    // Opting out restores the old on / off behaviour with caps.
    const capped = cfg({ kind: "opencode", reasoning_effort: false });
    expect((await body("low", null, capped)).max_tokens).toBe(2048);
    expect((await body("low", null, capped)).reasoning_effort).toBeUndefined();
    // Other kinds keep their defaults.
    expect(cfg({ kind: "deepseek" }).reasoning.effort).toBe(false);
    expect(cfg({ kind: "openai-compatible", base_url: "http://x" }).reasoning.effort).toBe(false);
  });

  it("opencode_bodies_per_purpose_through_the_router", async () => {
    const bodies: Record<string, unknown>[] = [];
    const fakeFetch: typeof fetch = async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      const sse =
        'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';
      return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
    };
    const provider = new OpenAiProvider(
      "deepseek",
      OpenAiConfig.fromProviderConfig(
        ProviderConfigSchema.parse({ kind: "opencode", api_key: "k" }),
      ),
      { fetch: fakeFetch },
    );
    const chain = [parseModelRef("deepseek:deepseek-v4.1-flash")];
    const r = new LlmRouter(
      new Map([["deepseek", provider]]),
      new Map([
        ["chat", chain],
        ["mind", chain],
      ]),
      {
        reasoning: new Map<string, ReasoningLevel>([
          ["chat_voice", "off"],
          ["chat_text", "low"],
          ["reflect", "high"],
        ]),
      },
    );
    const sent: [string, Partial<ChatRequest>][] = [
      ["chat", { reasoning_purpose: "chat_voice" }],
      ["chat", { reasoning_purpose: "chat_text" }],
      ["chat", { reasoning_purpose: "work" }],
      ["mind", { reasoning_purpose: "reflect", max_tokens: 6000 }],
      ["chat", { thinking: false, max_tokens: 400 }],
    ];
    for (const [purpose, extra] of sent) {
      await collectResponse(await r.stream(purpose, { ...request(), ...extra }));
    }
    const pick = (b: Record<string, unknown>) => ({
      thinking: b.thinking,
      reasoning_effort: b.reasoning_effort,
      max_tokens: b.max_tokens,
    });
    expect(bodies.map(pick)).toStrictEqual([
      { thinking: { type: "disabled" }, reasoning_effort: undefined, max_tokens: undefined },
      { thinking: undefined, reasoning_effort: "low", max_tokens: undefined },
      { thinking: undefined, reasoning_effort: "high", max_tokens: undefined },
      { thinking: undefined, reasoning_effort: "high", max_tokens: 6000 },
      { thinking: { type: "disabled" }, reasoning_effort: undefined, max_tokens: 400 },
    ]);
  });
});
