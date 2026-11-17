// Multimodal content: the wire format of image parts, flattening for text-only models and the
// router's fallback when a provider refuses images. No network: providers are scripted.

import { describe, expect, it } from "vitest";
import {
  type ChatProvider,
  type ChatRequest,
  type ChatStream,
  contentText,
  hasImages,
  LlmConfigSchema,
  LlmRouter,
  MockProvider,
  OpenAiConfig,
  ProviderConfigSchema,
  ProviderHttpError,
  parseModelRef,
  textOnlyRequest,
  userMessage,
} from "../src/index.js";
import { wireBody } from "./support.js";

const IMAGE = "data:image/png;base64,iVBORw0KGgo=";

function withImage(): ChatRequest {
  return {
    messages: [
      userMessage([
        { type: "text", text: "Owen: 看這個" },
        { type: "image_url", image_url: { url: IMAGE, detail: "low" }, alt: "[圖片: cat.png]" },
      ]),
    ],
  };
}

/** Fails with `status` while the request has image parts, then answers. */
class PickyProvider implements ChatProvider {
  readonly requests: ChatRequest[] = [];

  constructor(
    readonly name: string,
    readonly status: number,
  ) {}

  async stream(request: ChatRequest): Promise<ChatStream> {
    this.requests.push(structuredClone(request));
    if (hasImages(request.messages)) {
      throw new ProviderHttpError(`HTTP ${this.status}: image_url is not supported`, this.status);
    }
    return (async function* (): ChatStream {
      yield { type: "text_delta", text: "ok" };
      yield { type: "done", finish_reason: "stop", usage: null };
    })();
  }
}

function router(providers: [string, ChatProvider][], imageInput = new Map<string, boolean>()) {
  const chain = providers.map(([name]) => parseModelRef(`${name}:m`));
  return new LlmRouter(new Map(providers), new Map([["chat", chain]]), { imageInput });
}

describe("multimodal content", () => {
  it("serializes_image_parts_without_alt", async () => {
    const expected = [
      {
        role: "user",
        content: [
          { type: "text", text: "Owen: 看這個" },
          { type: "image_url", image_url: { url: IMAGE, detail: "low" } },
        ],
      },
    ];
    const request = { ...withImage(), model: "deepseek-v4.1-flash" };
    expect((await wireBody(request)).messages).toEqual(expected);
    const deepseek = OpenAiConfig.fromProviderConfig(
      ProviderConfigSchema.parse({ kind: "opencode", api_key: "k" }),
    );
    expect((await wireBody(request, deepseek)).messages).toEqual(expected);
  });

  it("image_urls_are_sent_as_they_are_each_with_its_detail", async () => {
    const urls = ["https://cdn.example/a.jpg?size=512", "https://cdn.example/b", IMAGE];
    const request: ChatRequest = {
      model: "m",
      messages: [
        userMessage([
          { type: "image_url", image_url: { url: urls[0] as string, detail: "high" } },
          { type: "text", text: "和" },
          { type: "image_url", image_url: { url: urls[1] as string, detail: "auto" } },
        ]),
        userMessage([{ type: "image_url", image_url: { url: IMAGE, detail: "low" } }]),
      ],
    };
    const images = (body: Awaited<ReturnType<typeof wireBody>>) =>
      (body.messages as { content: { type: string; image_url?: unknown }[] }[]).flatMap((m) =>
        m.content.filter((p) => p.type === "image_url").map((p) => p.image_url),
      );
    const expected = [
      { url: urls[0], detail: "high" },
      { url: urls[1], detail: "auto" },
      { url: IMAGE, detail: "low" },
    ];
    expect(images(await wireBody(request))).toEqual(expected);
    const deepseek = OpenAiConfig.fromProviderConfig(
      ProviderConfigSchema.parse({ kind: "deepseek" }),
    );
    expect(images(await wireBody(request, deepseek))).toEqual(expected);
  });

  it("flattens_to_text_for_text_only_models", () => {
    const req = withImage();
    expect(hasImages(req.messages)).toBe(true);
    const flat = textOnlyRequest(req);
    expect(flat.messages[0]?.content).toBe("Owen: 看這個\n[圖片: cat.png]");
    expect(hasImages(flat.messages)).toBe(false);
    // The original is untouched; images without alt get a placeholder.
    expect(hasImages(req.messages)).toBe(true);
    expect(contentText([{ type: "image_url", image_url: { url: IMAGE, detail: "auto" } }])).toBe(
      "[圖片]",
    );
    expect(contentText("純文字")).toBe("純文字");
  });

  it("models_marked_text_only_get_text", async () => {
    const mock = new MockProvider("local").reply("好");
    const r = router([["local", mock]], new Map([["local", false]]));
    expect(r.takesImages("chat")).toBe(false);
    await r.complete("chat", withImage());
    expect(mock.requests()[0]?.messages[0]?.content).toBe("Owen: 看這個\n[圖片: cat.png]");
    // A model entry wins over its provider's.
    const r2 = router(
      [["local", mock]],
      new Map([
        ["local", false],
        ["local:m", true],
      ]),
    );
    expect(r2.takesImages("chat")).toBe(true);
  });

  it("vision_models_get_the_parts", async () => {
    const mock = new MockProvider("deepseek").reply("好可愛");
    const r = router([["deepseek", mock]]);
    expect(r.takesImages("chat")).toBe(true);
    expect((await r.complete("chat", withImage())).text).toBe("好可愛");
    expect(hasImages(mock.requests()[0]?.messages ?? [])).toBe(true);
  });

  it("a_provider_refusing_images_is_retried_as_text_and_remembered", async () => {
    const picky = new PickyProvider("opencode", 400);
    const r = router([["opencode", picky]]);
    expect((await r.complete("chat", withImage())).text).toBe("ok");
    expect(picky.requests.map((q) => hasImages(q.messages))).toEqual([true, false]);
    expect(r.takesImages("chat")).toBe(false);
    // Later requests go out as text right away.
    await r.complete("chat", withImage());
    expect(picky.requests.map((q) => hasImages(q.messages))).toEqual([true, false, false]);
  });

  it("other_failures_fall_back_to_the_next_model_without_flattening", async () => {
    const down = new PickyProvider("a", 503);
    const next = new MockProvider("b").reply("b");
    const r = router([
      ["a", down],
      ["b", next],
    ]);
    expect((await r.complete("chat", withImage())).text).toBe("b");
    expect(down.requests).toHaveLength(1);
    expect(hasImages(next.requests()[0]?.messages ?? [])).toBe(true);
    // A 503 says nothing about images.
    expect(r.modelTakesImages(parseModelRef("a:m"))).toBe(true);
  });

  it("text_requests_are_never_retried", async () => {
    const picky = new PickyProvider("p", 400);
    const r = router([["p", picky]]);
    const plain = await r.complete("chat", { messages: [userMessage("嗨")] });
    expect(plain.text).toBe("ok");
    expect(picky.requests).toHaveLength(1);
  });

  it("config_section", () => {
    expect(LlmConfigSchema.parse({}).image_input).toEqual({});
    expect(
      LlmConfigSchema.parse({ image_input: { ollama: false, "opencode:x": true } }).image_input,
    ).toEqual({ ollama: false, "opencode:x": true });
  });
});
