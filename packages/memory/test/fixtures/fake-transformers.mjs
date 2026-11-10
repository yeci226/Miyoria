// Stands in for `@huggingface/transformers` in the local embedder's tests: the same `pipeline` and
// `env` shape, no model, no download. A vector says how long the text was and whether it carried
// the query prefix, so the tests can see what reached the model.

export const env = { allowRemoteModels: true, localModelPath: "", cacheDir: "" };

export async function pipeline(task, model, options) {
  if (task !== "feature-extraction") throw new Error(`unexpected task ${task}`);
  if (model === "broken/model") throw new Error("model not found");
  return async (texts, opts) => ({
    tolist: () =>
      texts.map((t) => [
        t.length,
        t.startsWith("query: ") ? 1 : 0,
        opts.pooling === "mean" && opts.normalize ? 1 : 0,
        options.device === "cpu" ? 1 : 0,
        env.allowRemoteModels ? 1 : 0,
      ]),
  });
}
