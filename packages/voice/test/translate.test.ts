// Spoken lines without a `<voice>` part are translated on the conversation's LLM session.

import type { Logger } from "@miyoria/kernel";
import type { ChatRequest, LlmRouter } from "@miyoria/llm";
import { describe, expect, it } from "vitest";
import { SpeechTranslator } from "../src/translate.js";

function translator(requests: ChatRequest[]): SpeechTranslator {
  const router = {
    complete: async (_purpose: string, request: ChatRequest) => {
      requests.push(request);
      return { text: "やっほー" };
    },
  } as unknown as LlmRouter;
  return new SpeechTranslator(router, "fast", "Japanese", {
    warn() {},
    debug() {},
  } as unknown as Logger);
}

describe("SpeechTranslator", () => {
  it("translates on the session it is given", async () => {
    const requests: ChatRequest[] = [];
    expect(await translator(requests).translate("嗨", undefined, "s1")).toBe("やっほー");
    expect(requests[0]?.session).toBe("s1");
  });

  it("a line prepared early keeps its session", async () => {
    const requests: ChatRequest[] = [];
    const t = translator(requests);
    t.prepare("嗨", "s1");
    await t.translate("嗨");
    expect(requests.map((r) => r.session)).toEqual(["s1"]);
  });

  it("a spoken line in the wrong language is translated on the same session", async () => {
    const requests: ChatRequest[] = [];
    const t = translator(requests);
    t.provide("嗨", "你好", "s1");
    expect(await t.translate("嗨")).toBe("やっほー");
    expect(requests.map((r) => r.session)).toEqual(["s1"]);
  });
});
