// The call inspector's log: every routed call with who asked, the model that answered, tokens,
// latency, cost with the price used, fallbacks, and (for recent calls) the redacted messages.

import { describe, expect, it } from "vitest";
import {
  LlmCallLog,
  LlmRouter,
  MockProvider,
  pricing,
  redactSecrets,
  systemMessage,
  userMessage,
  withLlmTag,
} from "../src/index.js";

function router(...providers: MockProvider[]) {
  const chain = providers.map((p) => ({ provider: p.name, model: "m" }));
  return new LlmRouter(new Map(providers.map((p) => [p.name, p])), new Map([["chat", chain]]), {
    pricing: new Map([["b:m", pricing({ input_per_mtok: 0.15, output_per_mtok: 0.6 })]]),
  });
}

describe("call log", () => {
  it("records who asked, the answering model, tokens, cost with its price, and the fallback", async () => {
    const a = new MockProvider("a").fail("down");
    const b = new MockProvider("b").events([
      { type: "reasoning_delta", text: "想一下" },
      { type: "text_delta", text: "好。" },
      {
        type: "done",
        finish_reason: "stop",
        usage: {
          prompt_tokens: 1000,
          completion_tokens: 200,
          cached_prompt_tokens: 400,
          reasoning_tokens: 50,
        },
      },
    ]);
    const r = router(a, b);
    const seen: string[] = [];
    const reply = await withLlmTag(
      { module: "mind", thought: "t1", onCall: (c) => seen.push(c.status) },
      () =>
        r.complete("mind", {
          messages: [
            systemMessage("你是她。"),
            userMessage("api_key=sk-abcdefghijklmnop1234 在嗎"),
          ],
        }),
    );
    expect(reply.text).toBe("好。");
    const [call] = r.calls.list().items;
    expect(call).toMatchObject({
      purpose: "mind",
      chain: "chat",
      model: "b:m",
      provider: "b",
      status: "ok",
      module: "mind",
      thought: "t1",
      finish_reason: "stop",
      usage: {
        prompt_tokens: 1000,
        cached_prompt_tokens: 400,
        completion_tokens: 200,
        reasoning_tokens: 50,
      },
      pricing: { input_per_mtok: 0.15, output_per_mtok: 0.6 },
      fallbacks: [{ model: "a:m", error: "down" }],
      reasoning_chars: 3,
    });
    // 1000 prompt (cached priced as input without a cached price) + 200 completion.
    expect(call?.cost_usd).toBeCloseTo((1000 * 0.15 + 200 * 0.6) / 1e6, 12);
    expect(seen).toEqual(["streaming", "ok"]);

    const detail = r.calls.detail(call?.id ?? "");
    expect(detail?.messages[1]?.content).toBe("api_key=[已遮蔽] 在嗎");
    expect(detail?.response).toMatchObject({ text: "好。", reasoning: "想一下" });
    expect(r.calls.list({ thought: "t1" }).matched).toBe(1);
    expect(r.calls.list({ module: "agent" }).matched).toBe(0);
  });

  it("records calls where every model failed", async () => {
    const r = router(new MockProvider("a").fail("down"), new MockProvider("b").fail("also down"));
    await expect(r.complete("chat", { messages: [userMessage("x")] })).rejects.toThrow("also down");
    const [call] = r.calls.list().items;
    expect(call).toMatchObject({
      status: "error",
      error: "also down",
      model: "b:m",
      fallbacks: [{ model: "a:m" }],
    });
    expect(r.calls.list({ status: "error" }).matched).toBe(1);
    expect(r.calls.stats().total).toMatchObject({ calls: 1, errors: 1 });
  });

  it("breaks the kept calls down by purpose, model and hour", async () => {
    const r = router(new MockProvider("b").reply("嗨。"));
    await r.complete("chat", { messages: [userMessage("1")] });
    await withLlmTag({ module: "memory" }, () =>
      r.complete("summarizer", { messages: [userMessage("2")] }),
    );
    const s = r.calls.stats();
    expect(s.total.calls).toBe(2);
    expect(s.by_purpose.map((g) => g.key).sort()).toEqual(["chat", "summarizer"]);
    expect(s.by_module.map((g) => g.key).sort()).toEqual(["memory", "—"]);
    expect(s.by_hour).toHaveLength(1);
    expect(s.expensive.length).toBe(2);
  });

  it("is bounded and drops the oldest request bodies first", () => {
    const log = new LlmCallLog(3, 2, 1_000_000);
    for (let i = 0; i < 5; i++) {
      log.open(
        `c${i}`,
        new Date(1_000 + i).toISOString(),
        "chat",
        "chat",
        { messages: [userMessage(`m${i}`)] },
        false,
        undefined,
      );
    }
    expect(log.size).toBe(3);
    expect(log.list().items.map((c) => [c.id, c.has_detail])).toEqual([
      ["c4", true],
      ["c3", true],
      ["c2", false],
    ]);
    expect(log.detail("c2")).toBeNull();
    const page = log.list({}, 2);
    expect(page.next_cursor).toBe("c3");
    expect(log.list({}, 2, page.next_cursor ?? undefined).items.map((c) => c.id)).toEqual(["c2"]);
  });
});

describe("chain of thought", () => {
  it("keeps each call's reasoning after its request is dropped, by kind of call", () => {
    const log = new LlmCallLog(10, 1, 1_000_000);
    const calls: [string, { module: string; label?: string }, string][] = [
      ["c0", { module: "mind", label: "plan" }, "想一下今天做什麼"],
      ["c1", { module: "agent", label: "reply" }, "回他一句"],
      ["c2", { module: "agent", label: "voice" }, "語音要短"],
      ["c3", { module: "social", label: "appraisal" }, ""],
    ];
    for (const [i, [id, tag, reasoning]] of calls.entries()) {
      log.open(id, new Date(1_000 + i).toISOString(), "chat", "chat", { messages: [] }, true, tag);
      log.respond(id, `answer ${id} sk-abcdefghijklmnop1234`, reasoning, []);
    }
    expect(log.get("c0")?.kind).toBe("mind");
    expect(log.detail("c0")).toBeNull();

    const all = log.thinking({ reasoned: true });
    expect(all.items.map((t) => [t.call.id, t.call.kind, t.reasoning])).toEqual([
      ["c2", "voice", "語音要短"],
      ["c1", "chat", "回他一句"],
      ["c0", "mind", "想一下今天做什麼"],
    ]);
    expect(all.items[0]?.answer).not.toContain("abcdefghijklmnop");
    expect(all.by_kind).toEqual([
      { kind: "mind", calls: 1, reasoned: 1 },
      { kind: "chat", calls: 1, reasoned: 1 },
      { kind: "voice", calls: 1, reasoned: 1 },
      { kind: "social", calls: 1, reasoned: 0 },
    ]);
    expect(log.thinking({ kind: "voice" }).items.map((t) => t.call.id)).toEqual(["c2"]);
    expect(log.thinking({ q: "今天" }).items.map((t) => t.call.id)).toEqual(["c0"]);
  });
});

describe("redactSecrets", () => {
  it("hides keys, tokens and image bytes and keeps the words", () => {
    const text = [
      "Authorization: Bearer abcdefghijklmnopqrstuvwxyz",
      "sk-proj-AAAAAAAAAAAAAAAAAAAAAAAA",
      'password: "hunter2hunter2"',
      `data:image/png;base64,${"A".repeat(400)}`,
      "今天天氣很好",
    ].join("\n");
    const out = redactSecrets(text);
    expect(out).not.toContain("abcdefghijklmnop");
    expect(out).not.toContain("AAAAAAAAAAAAAAAA");
    expect(out).not.toContain("hunter2");
    expect(out).toContain("[圖片 0 KB 已省略]");
    expect(out).toContain("今天天氣很好");
  });
});

describe("which model answered", () => {
  it("the stream says when a fallback model is answering", async () => {
    const healthy = router(
      new MockProvider("a").reply("嗨。"),
      new MockProvider("b").reply("嗨。"),
    );
    expect((await healthy.stream("chat", { messages: [] })).fallback).toBe(false);
    const broken = router(new MockProvider("a").fail("down"), new MockProvider("b").reply("嗨。"));
    const stream = await broken.stream("chat", { messages: [] });
    expect(stream.model).toContain("b");
    expect(stream.fallback).toBe(true);
  });
});
