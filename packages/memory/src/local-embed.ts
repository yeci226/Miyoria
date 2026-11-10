// `provider = "local"`: embeddings computed on this machine, on the CPU, in a worker thread (v4
// §5.4, §16 row 5: what members say must not leave this machine, and the GPU belongs to voice).
//
// The model runs through `@huggingface/transformers` (ONNX runtime, CPU). That package is not a
// dependency of this one: it is large and only the owner's machine needs it. When it cannot be
// found, or the model cannot be loaded, the embedder turns itself off once (with a warning) and
// retrieval goes on without vectors, as with `provider = "none"`.
//
// The worker is started on the first text and loads the model once. Its code is inline (no file
// to resolve under tsx or from `dist`), and it imports the runtime by the URL resolved here.

import { createRequire } from "node:module";
import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { getLogger } from "@miyoria/kernel";
import { DEFAULT_LOCAL_MODEL, type EmbeddingConfig } from "./config.js";
import { type Embedder, EmbeddingError } from "./embed.js";

const log = getLogger("memory.embed");

/** The worker: loads the pipeline once, answers `{id, texts}` with `{id, vectors}` or `{id, error}`. */
const WORKER = `
const { parentPort, workerData } = require("node:worker_threads");
let extractor = null;
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
  extractor = await lib.pipeline("feature-extraction", workerData.model, options);
})();
ready.catch(() => {});
parentPort.on("message", async (msg) => {
  try {
    await ready;
    const out = await extractor(msg.texts, { pooling: "mean", normalize: true });
    const vectors = typeof out.tolist === "function" ? out.tolist() : out;
    parentPort.postMessage({ id: msg.id, vectors });
  } catch (error) {
    parentPort.postMessage({ id: msg.id, error: String((error && error.message) || error), fatal: extractor === null });
  }
});
`;

/** `query: ` / `passage: ` for e5 models, nothing for others, unless configured. */
export function prefixesOf(
  config: EmbeddingConfig,
  model: string,
): { query: string; passage: string } {
  const e5 = /(^|[/_-])e5([_-]|$)/i.test(model);
  return {
    query: config.query_prefix ?? (e5 ? "query: " : ""),
    passage: config.passage_prefix ?? (e5 ? "passage: " : ""),
  };
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

export class LocalEmbedder implements Embedder {
  readonly name = "local";
  readonly model: string;
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
    this.#prefix = prefixesOf(config, this.model);
    // The first call waits for the model to load.
    this.#timeoutMs = Math.max(1, config.timeout_secs) * 1000;
    this.#batch = Math.max(1, config.batch_size);
  }

  /** Off once the runtime or the model could not be loaded. */
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
        threads: this.#config.threads,
        modelsDir: this.#config.models_dir,
        allowDownload: this.#config.allow_download,
      },
    });
    worker.unref();
    worker.on(
      "message",
      (msg: { id: number; vectors?: unknown; error?: string; fatal?: boolean }) => {
        const pending = this.#pending.get(msg.id);
        if (!pending) return;
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
      },
    );
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
    return { name: this.name, model: this.model, runtime: this.#config.runtime };
  }
}
