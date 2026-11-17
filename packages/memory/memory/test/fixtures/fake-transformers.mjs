// Stands in for `@huggingface/transformers` in the local embedder's tests: the same `pipeline` and
// `env` shape, no model, no download. A vector says how long the text was, whether it carried
// the query prefix, how it was pooled (mean 1, cls 2, last token 3 padded left / -3 padded right,
// the model's own output 4), whether it ran on the CPU and whether downloads were on, so the tests
// can see what reached the model.
//
// Models: `broken/model` fails to load; a name with `pooled` has only a `sentence_embedding`
// output (as Harrier) and fails through the pipeline as the real one does; `silent/model` has no
// output list and fails on every text.

export const env = { allowRemoteModels: true, localModelPath: "", cacheDir: "" };

const POOLING = { mean: 1, cls: 2, first_token: 2, last_token: 3, eos: 3 };

export async function pipeline(task, model, options) {
  if (task !== "feature-extraction") throw new Error(`unexpected task ${task}`);
  if (model === "broken/model") throw new Error("model not found");
  const pooled = model.includes("pooled");
  const silent = model === "silent/model";
  const tokenizer = (texts) => ({ texts });
  tokenizer.padding_side = "right";
  const row = (t, code) => [
    t.length,
    t.startsWith("query: ") || t.startsWith("Instruct: ") ? 1 : 0,
    code,
    options.device === "cpu" ? 1 : 0,
    env.allowRemoteModels ? 1 : 0,
  ];
  const extractor = async (texts, opts) => {
    if (pooled || silent) throw new Error("Cannot read properties of undefined (reading 'data')");
    let code = opts.normalize ? (POOLING[opts.pooling] ?? 0) : 0;
    if (code === 3 && tokenizer.padding_side !== "left") code = -3;
    return { tolist: () => texts.map((t) => row(t, code)) };
  };
  extractor.tokenizer = tokenizer;
  extractor.model = async (inputs) =>
    pooled
      ? {
          sentence_embedding: {
            normalize: (p, dim) => ({
              tolist: () => inputs.texts.map((t) => row(t, p === 2 && dim === -1 ? 4 : 0)),
            }),
          },
        }
      : { last_hidden_state: {} };
  if (!silent) {
    extractor.model.sessions = {
      model: { outputNames: pooled ? ["sentence_embedding"] : ["last_hidden_state"] },
    };
  }
  return extractor;
}
