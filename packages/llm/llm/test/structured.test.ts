import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  type ChatProvider,
  type ChatRequest,
  type ChatStream,
  completeJson,
  extractJsonObject,
  LlmRouter,
  MockProvider,
  ProviderHttpError,
  parseModelRef,
  StructuredOutputError,
  userMessage,
} from "../src/index.js";

const Schema = z.object({ recap: z.string().min(1), count: z.number().int() });

function router(provider: ChatProvider): LlmRouter {
  return new LlmRouter(
    new Map([["p", provider]]),
    new Map([["summarizer", [parseModelRef("p:m")]]]),
  );
}

const request = (): ChatRequest => ({ messages: [userMessage("整理")], json_mode: true });

/** A provider without JSON mode: refuses `json_mode` like an API without `response_format`. */
class NoJsonMode implements ChatProvider {
  readonly name = "nojson";
  readonly seen: ChatRequest[] = [];
  readonly #inner = new MockProvider("inner");

  constructor(text: string) {
    this.#inner.reply(text);
  }

  async stream(req: ChatRequest, signal?: AbortSignal): Promise<ChatStream> {
    this.seen.push(structuredClone(req));
    if (req.json_mode) throw new ProviderHttpError("response_format is not supported", 400);
    signal?.throwIfAborted();
    return this.#inner.stream(req);
  }
}

describe("extractJsonObject", () => {
  it("finds the object in plain JSON, fences and prose", () => {
    expect(extractJsonObject('{"a": 1}')).toEqual({ a: 1 });
    expect(extractJsonObject('好的,這是結果:\n```json\n{"a": 2}\n```\n希望有幫助')).toEqual({
      a: 2,
    });
    expect(extractJsonObject('我想想…{"a": {"b": "有 } 括號"}} 就這樣 {"c": 3}')).toEqual({
      a: { b: "有 } 括號" },
    });
    expect(extractJsonObject("沒有 JSON")).toBeNull();
    expect(extractJsonObject('[{"a": 1}]')).toEqual({ a: 1 });
  });
});

describe("completeJson", () => {
  it("accepts JSON wrapped in prose", async () => {
    const p = new MockProvider("p").reply('當然!\n{"recap": "大家在聊海豚", "count": 3}\n以上。');
    const out = await completeJson(router(p), "summarizer", request(), Schema);
    expect(out.value).toEqual({ recap: "大家在聊海豚", count: 3 });
    expect(out.attempts).toBe(1);
    expect(p.requests()[0]?.json_mode).toBe(true);
  });

  it("retries once with the concrete problems, then uses the fixed reply", async () => {
    const p = new MockProvider("p")
      .reply('{"recap": "", "count": "三"}')
      .reply('{"recap": "大家在聊海豚", "count": 3}');
    const out = await completeJson(router(p), "summarizer", request(), Schema);
    expect(out.value.count).toBe(3);
    expect(out.attempts).toBe(2);
    const retry = p.requests()[1];
    const feedback = retry?.messages.at(-1)?.content as string;
    expect(retry?.messages.at(-2)?.role).toBe("assistant");
    expect(feedback).toContain("recap");
    expect(feedback).toContain("count");
  });

  it("gives up after one repair without returning anything", async () => {
    const p = new MockProvider("p").reply("{not json").reply("still {broken");
    await expect(completeJson(router(p), "summarizer", request(), Schema)).rejects.toBeInstanceOf(
      StructuredOutputError,
    );
    expect(p.requests()).toHaveLength(2);
  });

  it("asks a cut-off reply again with twice the budget, without feeding the fragment back", async () => {
    const cut = (text: string) =>
      new MockProvider("p").events([
        { type: "text_delta", text },
        { type: "done", finish_reason: "length", usage: null },
      ]);
    // The inner object of a cut-off reply must not be taken for the answer.
    const p = cut('{"recap": "大家在聊海豚", "notes": {"topic": "海豚"}, "cou').reply(
      '{"recap": "大家在聊海豚", "count": 3}',
    );
    const out = await completeJson(
      router(p),
      "summarizer",
      { ...request(), max_tokens: 500 },
      Schema,
    );
    expect(out.value.count).toBe(3);
    const [first, retry] = p.requests();
    expect(first?.max_tokens).toBe(500);
    expect(retry?.max_tokens).toBe(1000);
    expect(retry?.messages.some((m) => m.role === "assistant")).toBe(false);
    expect(retry?.messages.at(-1)?.content as string).toContain("截斷");
  });

  it("names the budget when a reply is still cut off after the repair", async () => {
    const p = new MockProvider("p");
    for (let i = 0; i < 2; i++) {
      p.events([
        { type: "text_delta", text: '{"recap": "很長' },
        { type: "done", finish_reason: "length", usage: null },
      ]);
    }
    await expect(
      completeJson(router(p), "summarizer", { ...request(), max_tokens: 500 }, Schema),
    ).rejects.toThrow(/截斷.*max_tokens=1000/);
  });

  it("asks a provider without JSON mode again without the hint", async () => {
    const p = new NoJsonMode('結果如下 {"recap": "沒問題", "count": 1}');
    const out = await completeJson(router(p), "summarizer", request(), Schema);
    expect(out.value.recap).toBe("沒問題");
    expect(p.seen.map((r) => r.json_mode)).toEqual([true, false]);
  });
});
