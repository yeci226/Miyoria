// `provider = "local"`: embeddings computed on this machine, on the CPU, in a worker thread (v4
// §5.4, §16 row 5: what members say must not leave this machine, and the GPU belongs to voice).
//
// The model runs through `@huggingface/transformers` (ONNX runtime, CPU). That package is not a
// dependency of this one: it is large and only the owner's machine needs it. When it cannot be
// found, or the model cannot be loaded or cannot embed, the embedder turns itself off once (with a
// warning) and retrieval goes on without vectors, as with `provider = "none"`.
//
// How a vector is made depends on the model (`modelSettings`): models whose ONNX graph pools
// itself (Harrier) give a `sentence_embedding` output, read directly; the others give the hidden
// states of every token, pooled here (mean for e5, the first token for bge-m3, the last one for
// Qwen3-Embedding). Every vector is L2-normalised. Some models want an instruction before a query
// (Harrier, Qwen3) or a prefix before both (e5).
//
// The worker is started on the first text, loads the model once and embeds one short text before
// answering anything: a model that cannot embed (wrong pooling for its outputs, a broken file) is
// found there, once, and turns the embedder off. Its code is inline (no file to resolve under tsx
// or from `dist`), and it imports the runtime by the URL resolved here.

import { createRequire } from "node:module";
import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { getLogger } from "@miyoria/runtime/kernel";
import { DEFAULT_LOCAL_MODEL, type EmbeddingConfig, type Pooling } from "./config.js";
import { type Embedder, EmbeddingError } from "./embed.js";

const log = getLogger("memory.embed");

/**
 * The worker: loads the pipeline once, checks the model's outputs against the pooling, embeds one
 * text, then answers `{id, texts}` with `{id, vectors}` or `{id, error}`. A failure before that
 * (`fatal`) turns the embedder off.
 */
const WORKER = `
const { parentPort, workerData } = require("node:worker_threads");
const HIDDEN = ["last_hidden_state", "logits", "token_embeddings"];
let embed = null;
const ready = (async () => {
  const lib = await import(workerData.runtime);
  const env = lib.env;
  if (env) {
    if (workerData.modelsDir) {
      env.localModelPath = workerData.modelsDir;
      env.cacheDir = workerData.modelsDir;
    }
    env.allowRemoteModels = workerData.allowDownload;
  }
  const options = { device: "cpu", dtype: workerData.dtype };
  if (workerData.threads > 0) {
    options.session_options = { intraOpNumThreads: workerData.threads, interOpNumThreads: 1 };
  }
  const extractor = await lib.pipeline("feature-extraction", workerData.model, options);
  const session = extractor.model && extractor.model.sessions ? extractor.model.sessions.model : undefined;
  const outputs = session && Array.isArray(session.outputNames) ? session.outputNames : null;
  let pooling = workerData.pooling;
  if (pooling === "auto") {
    pooling = outputs !== null && outputs.includes("sentence_embedding") ? "model" : "mean";
  }
  if (outputs !== null) {
    if (pooling === "model" && !outputs.includes("sentence_embedding")) {
      throw new Error('pooling "model" needs a sentence_embedding output; the model has ' + outputs.join(", ") + ': set pooling = "mean", "cls" or "last_token"');
    }
    if (pooling !== "model" && !outputs.some((o) => HIDDEN.includes(o))) {
      throw new Error('pooling "' + pooling + '" needs the hidden states (last_hidden_state); the model has ' + outputs.join(", ") + (outputs.includes("sentence_embedding") ? ': set pooling = "model"' : ""));
    }
  }
  // The pipeline takes the last position: right for every text only when padding is on the left.
  if (pooling === "last_token") extractor.tokenizer.padding_side = "left";
  const run = pooling === "model"
    ? async (texts) => {
        const inputs = extractor.tokenizer(texts, { padding: true, truncation: true });
        const out = await extractor.model(inputs);
        if (!out || !out.sentence_embedding) throw new Error("the model gave no sentence_embedding");
        return out.sentence_embedding.normalize(2, -1).tolist();
      }
    : async (texts) => (await extractor(texts, { pooling, normalize: true })).tolist();
  const probe = await run(["ok"]);
  const first = Array.isArray(probe) ? probe[0] : undefined;
  if (!Array.isArray(first) || first.length === 0 || !first.every(Number.isFinite)) {
    throw new Error("the model gave no usable vector");
  }
  embed = run;
  parentPort.postMessage({ ready: true, pooling, dims: first.length });
})();
ready.catch(() => {});
parentPort.on("message", async (msg) => {
  try {
    await ready;
    const vectors = await embed(msg.texts);
    parentPort.postMessage({ id: msg.id, vectors });
  } catch (error) {
    parentPort.postMessage({ id: msg.id, error: String((error && error.message) || error), fatal: embed === null });
  }
});
`;

/** What a model needs: how its vectors are pooled and what goes before queries and passages. */
export interface ModelSettings {
  /** `auto`: the model's own output when it has one, otherwise `mean` (decided at load). */
  pooling: Pooling | "auto";
  query: string;
  passage: string;
}

/** The instruction Harrier and Qwen3-Embedding were trained with for search queries. */
const WEB_SEARCH = "Given a web search query, retrieve relevant passages that answer the query";

/**
 * Models whose model card asks for something else than mean pooling without prefixes, by name.
 * The first that matches wins. Documents get no prefix unless listed.
 */
const KNOWN: readonly { test: RegExp; settings: ModelSettings }[] = [
  // Microsoft Harrier-OSS-v1 (0.6B, 270M): the ONNX graph pools (`sentence_embedding`).
  {
    test: /harrier/i,
    settings: { pooling: "model", query: `Instruct: ${WEB_SEARCH}\nQuery: `, passage: "" },
  },
  // Qwen3-Embedding: last token (its tokenizer pads on the left), instruction without a space.
  {
    test: /qwen3-embedding/i,
    settings: { pooling: "last_token", query: `Instruct: ${WEB_SEARCH}\nQuery:`, passage: "" },
  },
  // BAAI bge-m3: the CLS token, no prefixes.
  { test: /bge-m3/i, settings: { pooling: "cls", query: "", passage: "" } },
  // multilingual-e5-*-instruct: an instruction before queries, nothing before passages.
  {
    test: /(^|[/_-])e5[_-].*instruct/i,
    settings: { pooling: "mean", query: `Instruct: ${WEB_SEARCH}\nQuery: `, passage: "" },
  },
  // multilingual-e5-*: mean, `query: ` / `passage: `.
  {
    test: /(^|[/_-])e5([_-]|$)/i,
    settings: { pooling: "mean", query: "query: ", passage: "passage: " },
  },
];

/**
 * The pooling and prefixes of `model`: what `[memory.embedding]` sets, the rest by model name
 * (`KNOWN`); an unknown model gets `auto` and no prefixes.
 */
export function modelSettings(config: EmbeddingConfig, model: string): ModelSettings {
  const known = KNOWN.find((k) => k.test.test(model))?.settings ?? {
    pooling: "auto",
    query: "",
    passage: "",
  };
  return {
    pooling: config.pooling === "" ? known.pooling : config.pooling,
    query: config.query_prefix ?? known.query,
    passage: config.passage_prefix ?? known.passage,
  };
}

/** The query and passage prefixes of `model` (`modelSettings`). */
export function prefixesOf(
  config: EmbeddingConfig,
  model: string,
): { query: string; passage: string } {
  const { query, passage } = modelSettings(config, model);
  return { query, passage };
}

/** The URL the worker imports the runtime from, or `null` when it is not installed. */
export function resolveRuntime(runtime: string): string | null {
  if (runtime.startsWith("file:")) return runtime;
  if (isAbsolute(runtime)) return pathToFileURL(runtime).href;
  try {
    return pathToFileURL(createRequire(import.meta.url).resolve(runtime)).href;
  } catch {
    return null;
  }
}

interface Pending {
  resolve: (v: number[][]) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface WorkerReply {
  id?: number;
  vectors?: unknown;
  error?: string;
  fatal?: boolean;
  ready?: boolean;
  pooling?: string;
  dims?: number;
}

export class LocalEmbedder implements Embedder {
  readonly name = "local";
  readonly model: string;
  /** How vectors are pooled (`auto`: decided when the model is loaded). */
  readonly pooling: Pooling | "auto";
  readonly embeddingModel: string;
  readonly #config: EmbeddingConfig;
  readonly #prefix: { query: string; passage: string };
  readonly #timeoutMs: number;
  readonly #batch: number;
  #worker: Worker | null = null;
  #broken: string | null = null;
  #next = 0;
  readonly #pending = new Map<number, Pending>();

  constructor(config: EmbeddingConfig) {
    this.#config = config;
    this.model = config.model.trim() === "" ? DEFAULT_LOCAL_MODEL : config.model.trim();
    const settings = modelSettings(config, this.model);
    this.pooling = settings.pooling;
    this.#prefix = { query: settings.query, passage: settings.passage };
    // What changes a stored vector: the model, its weights, the pooling, the passage prefix.
    this.embeddingModel = [
      "local",
      this.model,
      config.dtype,
      settings.pooling,
      settings.passage,
    ].join("|");
    // The first call waits for the model to load.
    this.#timeoutMs = Math.max(1, config.timeout_secs) * 1000;
    this.#batch = Math.max(1, config.batch_size);
  }

  /** Off once the runtime or the model could not be loaded, or the model could not embed. */
  get enabled(): boolean {
    return this.#broken === null;
  }

  /** Why it turned itself off. */
  get broken(): string | null {
    return this.#broken;
  }

  embed(texts: readonly string[], signal?: AbortSignal): Promise<number[][]> {
    return this.#all(
      texts.map((t) => `${this.#prefix.passage}${t}`),
      signal,
    );
  }

  embedQuery(texts: readonly string[], signal?: AbortSignal): Promise<number[][]> {
    return this.#all(
      texts.map((t) => `${this.#prefix.query}${t}`),
      signal,
    );
  }

  async #all(texts: readonly string[], signal?: AbortSignal): Promise<number[][]> {
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += this.#batch) {
      out.push(...(await this.#ask(texts.slice(i, i + this.#batch), signal)));
    }
    return out;
  }

  #start(): Worker {
    if (this.#worker !== null) return this.#worker;
    const runtime = resolveRuntime(this.#config.runtime);
    if (runtime === null) {
      this.#off(`\`${this.#config.runtime}\` is not installed`);
      throw new EmbeddingError(this.#broken ?? "local embeddings are off");
    }
    const worker = new Worker(WORKER, {
      eval: true,
      workerData: {
        runtime,
        model: this.model,
        dtype: this.#config.dtype,
        pooling: this.pooling,
        threads: this.#config.threads,
        modelsDir: this.#config.models_dir,
        allowDownload: this.#config.allow_download,
      },
    });
    worker.unref();
    worker.on("message", (msg: WorkerReply) => {
      if (msg.ready) {
        log.info(
          { model: this.model, dtype: this.#config.dtype, pooling: msg.pooling, dims: msg.dims },
          "local embeddings ready",
        );
        return;
      }
      const pending = msg.id === undefined ? undefined : this.#pending.get(msg.id);
      if (!pending || msg.id === undefined) return;
      this.#pending.delete(msg.id);
      clearTimeout(pending.timer);
      if (msg.error !== undefined) {
        if (msg.fatal) this.#off(msg.error);
        pending.reject(new EmbeddingError(`local embedding failed: ${msg.error}`));
        return;
      }
      const vectors = msg.vectors;
      if (
        !Array.isArray(vectors) ||
        !vectors.every((v) => Array.isArray(v) && v.every(Number.isFinite))
      ) {
        pending.reject(new EmbeddingError("local embedding returned no vectors"));
        return;
      }
      pending.resolve(vectors as number[][]);
    });
    worker.on("error", (error) => {
      this.#off(error.message);
      this.#failAll(error.message);
    });
    worker.on("exit", () => {
      this.#worker = null;
      this.#failAll("the embedding worker stopped");
    });
    this.#worker = worker;
    return worker;
  }

  #ask(texts: readonly string[], signal?: AbortSignal): Promise<number[][]> {
    if (this.#broken !== null) return Promise.reject(new EmbeddingError(this.#broken));
    const worker = this.#start();
    signal?.throwIfAborted();
    const id = this.#next++;
    return new Promise<number[][]>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new EmbeddingError(`local embedding timed out after ${this.#timeoutMs} ms`));
      }, this.#timeoutMs);
      this.#pending.set(id, { resolve, reject, timer });
      signal?.addEventListener(
        "abort",
        () => {
          if (!this.#pending.delete(id)) return;
          clearTimeout(timer);
          reject(signal.reason instanceof Error ? signal.reason : new Error("aborted"));
        },
        { once: true },
      );
      worker.postMessage({ id, texts: [...texts] });
    });
  }

  #off(reason: string): void {
    if (this.#broken !== null) return;
    this.#broken = reason;
    log.warn(
      { model: this.model, reason },
      "local embeddings are off: retrieval goes on without vectors",
    );
  }

  #failAll(reason: string): void {
    for (const [id, p] of this.#pending) {
      clearTimeout(p.timer);
      p.reject(new EmbeddingError(reason));
      this.#pending.delete(id);
    }
  }

  /** Stops the worker (module stop). */
  async close(): Promise<void> {
    const worker = this.#worker;
    this.#worker = null;
    this.#failAll("closed");
    if (worker !== null) await worker.terminate();
  }

  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      model: this.model,
      dtype: this.#config.dtype,
      pooling: this.pooling,
      runtime: this.#config.runtime,
    };
  }
}
