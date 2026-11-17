import { describe, expect, it } from "vitest";
import {
  collectResponse,
  LlmRouter,
  MockProvider,
  OpenAiConfig,
  ProviderConfigSchema,
  parseModelRef,
  userMessage,
} from "../src/index.js";
import { wireBody } from "./support.js";

const request = () => ({ messages: [userMessage("hi")] });

describe("thinking switch", () => {
  it("router_turns_thinking_off_unless_the_purpose_enables_it", async () => {
    const provider = new MockProvider("p").reply("a").reply("b").reply("c");
    const chain = [parseModelRef("p:m")];
    const router = new LlmRouter(
      new Map([["p", provider]]),
      new Map([
        ["chat", chain],
        ["fast", chain],
      ]),
      { reasoning: new Map([["chat", "medium" as const]]) },
    );
    await collectResponse(await router.stream("fast", request()));
    await collectResponse(await router.stream("chat", request()));
    // An explicit request value wins over the purpose setting.
    await collectResponse(await router.stream("chat", { ...request(), thinking: false }));
    expect(provider.requests().map((r) => r.thinking)).toStrictEqual([false, true, false]);
  });

  it("deepseek_and_opencode_send_their_switch_only_when_off", async () => {
    const cfg = (raw: Record<string, unknown>) =>
      OpenAiConfig.fromProviderConfig(ProviderConfigSchema.parse(raw));
    const opencode = cfg({ kind: "opencode", api_key: "k" });
    expect(opencode.thinkingOff).toStrictEqual({ thinking: { type: "disabled" } });
    expect(cfg({ kind: "deepseek" }).thinkingOff).toStrictEqual({ thinking: { type: "disabled" } });
    // Generic endpoints send nothing unless told what to send.
    expect(cfg({ kind: "openai-compatible", base_url: "http://x" }).thinkingOff).toBeNull();
    expect(
      cfg({
        kind: "openai-compatible",
        base_url: "http://x",
        thinking_off: { chat_template_kwargs: { enable_thinking: false } },
      }).thinkingOff,
    ).toStrictEqual({ chat_template_kwargs: { enable_thinking: false } });
    expect(cfg({ kind: "deepseek", thinking_off: {} }).thinkingOff).toBeNull();

    expect((await wireBody({ ...request(), thinking: false }, opencode)).thinking).toStrictEqual({
      type: "disabled",
    });
    expect((await wireBody({ ...request(), thinking: true }, opencode)).thinking).toBeUndefined();
    const generic = cfg({ kind: "openai-compatible", base_url: "http://x" });
    expect((await wireBody({ ...request(), thinking: false }, generic)).thinking).toBeUndefined();
  });

  it("configured_thinking_off_fields_are_merged_into_the_body_of_every_kind", async () => {
    const cfg = (raw: Record<string, unknown>) =>
      OpenAiConfig.fromProviderConfig(ProviderConfigSchema.parse(raw));
    const off = { chat_template_kwargs: { enable_thinking: false } };
    for (const kind of ["openai-compatible", "deepseek"]) {
      const config = cfg({ kind, base_url: "http://x", thinking_off: off });
      const body = await wireBody({ ...request(), thinking: false, temperature: 0.7 }, config);
      expect(body.chat_template_kwargs, kind).toStrictEqual({ enable_thinking: false });
      expect(body.thinking, kind).toBeUndefined();
      expect(body.temperature, kind).toBe(0.7);
      const on = await wireBody({ ...request(), thinking: true, temperature: 0.7 }, config);
      expect(on.chat_template_kwargs, kind).toBeUndefined();
      // The sampling temperature is sent whether or not the model thinks.
      expect(on.temperature, kind).toBe(0.7);
    }
  });
});
