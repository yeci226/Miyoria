import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { ContextKey, ContextKind } from "@miyoria/types";
import { describe, expect, it } from "vitest";
import {
  type ChatStream,
  collectResponse,
  contextHash,
  contextSession,
  MIYORIA_VERSION,
  MockProvider,
  modelRefString,
  parseModelRef,
  type StreamEvent,
  sessionId,
  tryParseModelRef,
  userMessage,
} from "../src/index.js";

async function* stream(events: StreamEvent[]): ChatStream {
  yield* events;
}

describe("types", () => {
  it("collects text, reasoning and tool call fragments", async () => {
    const resp = await collectResponse(
      stream([
        { type: "reasoning_delta", text: "hm" },
        { type: "text_delta", text: "a" },
        { type: "tool_call_delta", index: 1, id: "c2", name: "wea", arguments: "{" },
        { type: "tool_call_delta", index: 0, id: "c1", name: "roll", arguments: "{}" },
        { type: "tool_call_delta", index: 1, id: null, name: "ther", arguments: "}" },
        { type: "text_delta", text: "b" },
        { type: "done", finish_reason: "tool_calls", usage: null },
      ]),
    );
    expect(resp).toEqual({
      text: "ab",
      reasoning: "hm",
      tool_calls: [
        { id: "c1", name: "roll", arguments: "{}" },
        { id: "c2", name: "weather", arguments: "{}" },
      ],
      finish_reason: "tool_calls",
      usage: null,
    });
  });

  it("model references split at the first colon", () => {
    expect(parseModelRef("ollama:qwen3:8b")).toEqual({ provider: "ollama", model: "qwen3:8b" });
    expect(modelRefString(parseModelRef("a:b"))).toBe("a:b");
    for (const bad of ["", "x", ":m", "p:"]) expect(tryParseModelRef(bad)).toBeNull();
    expect(() => parseModelRef("x")).toThrow("model reference `x` must look like `provider:model`");
  });

  it("mock provider streams sentence chunks, repeats the last reply and records requests", async () => {
    const mock = new MockProvider("m").fail("down").reply("你好。今天呢?嗯");
    await expect(mock.stream({ messages: [] })).rejects.toThrow("down");
    const events: StreamEvent[] = [];
    for await (const ev of await mock.stream({ messages: [userMessage("hi")] })) events.push(ev);
    expect(
      events.filter((e) => e.type === "text_delta").map((e) => e.type === "text_delta" && e.text),
    ).toEqual(["你好。", "今天呢?", "嗯"]);
    expect(events.at(-1)).toEqual({
      type: "done",
      finish_reason: "stop",
      usage: { prompt_tokens: 10, completion_tokens: 5, cached_prompt_tokens: null },
    });
    expect((await collectResponse(await mock.stream({ messages: [] }))).text).toBe(
      "你好。今天呢?嗯",
    );
    expect(mock.requests()).toHaveLength(3);
    await expect(new MockProvider("e").stream({ messages: [] })).rejects.toThrow(
      /no scripted reply/,
    );
  });

  it("version matches package.json", () => {
    const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
    expect(MIYORIA_VERSION).toBe(pkg.version);
  });
});

describe("session", () => {
  const key = (channel: string, kind: ContextKind): ContextKey => ({
    platform: "discord",
    scope: "guild-123",
    channel,
    kind,
  });

  it("context_ids_are_stable_distinct_and_opaque", () => {
    const a = contextSession("deepseek-chan", key("chan-1", "channel"));
    expect(a).toBe(contextSession("deepseek-chan", key("chan-1", "channel")));
    expect(a).not.toBe(contextSession("deepseek-chan", key("chan-2", "channel")));
    expect(a).not.toBe(contextSession("deepseek-chan", key("chan-1", "thread")));
    expect(a.startsWith("miyoria-deepseek-chan-")).toBe(true);
    expect(a).toHaveLength("miyoria-deepseek-chan-".length + 16);
    expect(a.includes("123") || a.includes("chan-1")).toBe(false);
  });

  it("hashes exactly what the Rust version hashed", () => {
    // `format!("{context}|{:?}", context.kind)`
    const expected = createHash("sha256")
      .update("discord:guild-123:voice:chan-1|Voice")
      .digest("hex")
      .slice(0, 16);
    expect(contextHash(key("chan-1", "voice"))).toBe(expected);
  });

  it("profile_is_made_header_safe", () => {
    expect(sessionId("a b/é", "x")).toBe("miyoria-a_b__-x");
  });
});
