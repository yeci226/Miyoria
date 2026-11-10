// `provider = "local"`: the worker, the prefixes and turning itself off. No model is downloaded:
// the runtime is a fixture with the same shape.

import { afterEach, describe, expect, it } from "vitest";
import {
  buildEmbedder,
  DEFAULT_LOCAL_MODEL,
  embeddingConfig,
  LocalEmbedder,
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
});
