// `provider = "local"`: the worker, the prefixes and turning itself off. No model is downloaded:
// the runtime is a fixture with the same shape.

import { afterEach, describe, expect, it } from "vitest";
import {
  buildEmbedder,
  DEFAULT_LOCAL_MODEL,
  embeddingConfig,
  LocalEmbedder,
  modelSettings,
  prefixesOf,
  resolveRuntime,
} from "../src/index.js";

const fake = new URL("./fixtures/fake-transformers.mjs", import.meta.url).href;

const open: LocalEmbedder[] = [];
afterEach(async () => {
  for (const e of open.splice(0)) await e.close();
});

function local(overrides: Parameters<typeof embeddingConfig>[0] = {}): LocalEmbedder {
  const e = new LocalEmbedder(embeddingConfig({ provider: "local", runtime: fake, ...overrides }));
  open.push(e);
  return e;
}

describe("local embeddings", () => {
  it('are built from `[memory.embedding] provider = "local"` with the default model', () => {
    const e = buildEmbedder(embeddingConfig({ provider: "local", runtime: fake }));
    expect(e).toBeInstanceOf(LocalEmbedder);
    expect((e as LocalEmbedder).model).toBe(DEFAULT_LOCAL_MODEL);
  });

  it("use the e5 prefixes for e5 models only, unless configured", () => {
    expect(prefixesOf(embeddingConfig(), "Xenova/multilingual-e5-small")).toEqual({
      query: "query: ",
      passage: "passage: ",
    });
    expect(prefixesOf(embeddingConfig(), "Xenova/bge-m3")).toEqual({ query: "", passage: "" });
    expect(prefixesOf(embeddingConfig({ query_prefix: "q:" }), "x/bge")).toEqual({
      query: "q:",
      passage: "",
    });
  });

  it("run the model in a worker on the CPU, mean-pooled and normalized", async () => {
    const e = local({ allow_download: false });
    const stored = await e.embed(["你好", "abc"]);
    // "passage: 你好" is 11 characters.
    expect(stored).toEqual([
      [11, 0, 1, 1, 0],
      [12, 0, 1, 1, 0],
    ]);
    const asked = await e.embedQuery(["你好"]);
    expect(asked).toEqual([[9, 1, 1, 1, 0]]);
    expect(e.enabled).toBe(true);
  });

  it("splits large inputs into batches", async () => {
    const e = local({ batch_size: 2 });
    const out = await e.embed(["a", "b", "c", "d", "e"]);
    expect(out.map((v) => v[0])).toEqual([10, 10, 10, 10, 10]);
  });

  it("turn themselves off when the runtime is not installed", async () => {
    expect(resolveRuntime("@miyoria/this-package-does-not-exist")).toBeNull();
    const e = local({ runtime: "@miyoria/this-package-does-not-exist" });
    await expect(e.embed(["x"])).rejects.toThrow("not installed");
    expect(e.enabled).toBe(false);
    expect(e.broken).toContain("not installed");
  });

  it("turn themselves off when the model cannot be loaded", async () => {
    const e = local({ model: "broken/model" });
    await expect(e.embed(["x"])).rejects.toThrow("model not found");
    expect(e.enabled).toBe(false);
  });

  it("pool and prefix each known model the way its card says", () => {
    const web =
      "Instruct: Given a web search query, retrieve relevant passages that answer the query\nQuery:";
    const of = (model: string) => modelSettings(embeddingConfig(), model);
    for (const harrier of [
      "onnx-community/harrier-oss-v1-0.6b-ONNX",
      "onnx-community/harrier-oss-v1-270m-ONNX",
    ]) {
      expect(of(harrier)).toEqual({ pooling: "model", query: `${web} `, passage: "" });
    }
    expect(of("onnx-community/Qwen3-Embedding-0.6B-ONNX")).toEqual({
      pooling: "last_token",
      query: web,
      passage: "",
    });
    expect(of("Xenova/bge-m3")).toEqual({ pooling: "cls", query: "", passage: "" });
    expect(of("Xenova/multilingual-e5-small")).toEqual({
      pooling: "mean",
      query: "query: ",
      passage: "passage: ",
    });
    expect(of("intfloat/multilingual-e5-large-instruct")).toEqual({
      pooling: "mean",
      query: `${web} `,
      passage: "",
    });
    // Unknown: decided by the model's outputs when it is loaded.
    expect(of("someone/new-model")).toEqual({ pooling: "auto", query: "", passage: "" });
    // The config wins over the name.
    expect(
      modelSettings(
        embeddingConfig({ pooling: "mean", query_prefix: "", passage_prefix: "p: " }),
        "onnx-community/harrier-oss-v1-270m-ONNX",
      ),
    ).toEqual({ pooling: "mean", query: "", passage: "p: " });
  });

  it("record what changes a stored vector: model, weights, pooling, passage prefix", () => {
    const e = local({ model: "onnx-community/harrier-oss-v1-270m-ONNX", dtype: "fp16" });
    expect(e.embeddingModel).toBe("local|onnx-community/harrier-oss-v1-270m-ONNX|fp16|model|");
    expect(local({ dtype: "fp32" }).embeddingModel).toBe(
      "local|Xenova/multilingual-e5-small|fp32|mean|passage: ",
    );
    // The query prefix changes no stored vector.
    expect(
      local({ model: "onnx-community/harrier-oss-v1-270m-ONNX", dtype: "fp16", query_prefix: "" })
        .embeddingModel,
    ).toBe(e.embeddingModel);
  });

  it("read the pooled output of a model that has one (Harrier)", async () => {
    const e = local({ model: "test/pooled-harrier" });
    expect(e.pooling).toBe("model");
    const [v] = await e.embedQuery(["你好"]);
    // Tokenized and run directly, then normalised: the pipeline would have failed.
    expect(v?.slice(1, 3)).toEqual([1, 4]);
    expect(e.enabled).toBe(true);
  });

  it("pick the model's own output for an unknown model that has one", async () => {
    const e = local({ model: "someone/pooled" });
    expect(e.pooling).toBe("auto");
    expect((await e.embed(["x"]))[0]?.[2]).toBe(4);
    expect((await local({ model: "someone/plain" }).embed(["x"]))[0]?.[2]).toBe(1);
  });

  it("pad on the left for last-token pooling, and pool CLS for bge-m3", async () => {
    const qwen = local({ model: "onnx-community/Qwen3-Embedding-0.6B-ONNX" });
    expect((await qwen.embed(["x"]))[0]?.[2]).toBe(3);
    const bge = local({ model: "Xenova/bge-m3" });
    expect((await bge.embed(["x"]))[0]?.[2]).toBe(2);
  });

  it("turn themselves off once when the pooling does not fit the model's outputs", async () => {
    const e = local({ model: "test/pooled-harrier", pooling: "mean" });
    await expect(e.embed(["x"])).rejects.toThrow('set pooling = "model"');
    expect(e.enabled).toBe(false);
    // Off: later calls fail at once, with the same reason, without asking the worker.
    await expect(e.embed(["y"])).rejects.toThrow('set pooling = "model"');
    const other = local({ model: "someone/plain", pooling: "model" });
    await expect(other.embed(["x"])).rejects.toThrow("needs a sentence_embedding output");
    expect(other.enabled).toBe(false);
  });

  it("turn themselves off when the model loads but cannot embed", async () => {
    const e = local({ model: "silent/model" });
    await expect(e.embed(["x"])).rejects.toThrow("reading 'data'");
    expect(e.enabled).toBe(false);
    expect(e.broken).toContain("reading 'data'");
  });
});
