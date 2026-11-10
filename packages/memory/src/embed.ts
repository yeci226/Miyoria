// Text embeddings. Optional: the default provider is `NoEmbedder`.

import { inspect } from "node:util";
import type { EmbeddingConfig } from "./config.js";
import { LocalEmbedder } from "./local-embed.js";

export interface Embedder {
  /** Provider name for logs, e.g. `"openai-compatible"`. */
  readonly name: string;
  /** `false` when this embedder never produces vectors. */
  readonly enabled: boolean;
  /** One vector per input text, in order. */
  embed(texts: readonly string[], signal?: AbortSignal): Promise<number[][]>;
  /**
   * The same for search queries, for models trained with different prefixes for queries and
   * passages (e5: `query: ` / `passage: `). Absent: `embed`.
   */
  embedQuery?(texts: readonly string[], signal?: AbortSignal): Promise<number[][]>;
}

export class EmbeddingError extends Error {
  override readonly name = "EmbeddingError";

  constructor(
    message: string,
    readonly status: number | null = null,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

/** No embeddings; retrieval falls back to full text, recency and importance. */
export class NoEmbedder implements Embedder {
  readonly name = "none";
  readonly enabled = false;

  async embed(): Promise<number[][]> {
    return [];
  }
}

/**
 * `POST {base_url}/embeddings` in the OpenAI format (OpenAI, Ollama, LM Studio, SiliconFlow,
 * vLLM, ...).
 */
export class OpenAiCompatibleEmbedder implements Embedder {
  readonly name = "openai-compatible";
  readonly enabled = true;
  readonly url: string;
  readonly model: string;
  readonly dimensions: number | null;
  readonly batchSize: number;
  readonly timeoutMs: number;
  readonly #apiKey: string | null;

  constructor(config: EmbeddingConfig) {
    if (config.base_url.trim() === "") {
      throw new EmbeddingError("[memory.embedding] base_url is required for `openai-compatible`");
    }
    if (config.model.trim() === "") {
      throw new EmbeddingError("[memory.embedding] model is required for `openai-compatible`");
    }
    this.url = `${config.base_url.replace(/\/+$/, "")}/embeddings`;
    this.#apiKey = config.api_key ? config.api_key : null;
    this.model = config.model;
    this.dimensions = config.dimensions;
    this.batchSize = Math.max(1, config.batch_size);
    this.timeoutMs = Math.max(1, config.timeout_secs) * 1000;
  }

  async embed(texts: readonly string[], signal?: AbortSignal): Promise<number[][]> {
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += this.batchSize) {
      out.push(...(await this.#embedBatch(texts.slice(i, i + this.batchSize), signal)));
    }
    return out;
  }

  async #embedBatch(texts: readonly string[], signal?: AbortSignal): Promise<number[][]> {
    const body: Record<string, unknown> = { model: this.model, input: texts };
    if (this.dimensions !== null) body.dimensions = this.dimensions;
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.#apiKey !== null) headers.authorization = `Bearer ${this.#apiKey}`;
    const timeout = AbortSignal.timeout(this.timeoutMs);
    let response: Response;
    try {
      response = await fetch(this.url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new EmbeddingError("embedding request failed", null, { cause: error });
    }
    if (!response.ok) {
      const text = [...(await response.text().catch(() => ""))].slice(0, 300).join("");
      throw new EmbeddingError(
        `embedding request failed with ${response.status} ${response.statusText}: ${text}`,
        response.status,
      );
    }
    let parsed: unknown;
    try {
      parsed = await response.json();
    } catch (error) {
      throw new EmbeddingError("invalid embedding response", null, { cause: error });
    }
    const data = (parsed as { data?: unknown } | null)?.data;
    if (!Array.isArray(data)) throw new EmbeddingError("invalid embedding response");
    if (data.length !== texts.length) {
      throw new EmbeddingError(
        `embedding response has ${data.length} vectors for ${texts.length} inputs`,
      );
    }
    const out: number[][] = texts.map(() => []);
    data.forEach((item: unknown, pos) => {
      const obj = item as { index?: unknown; embedding?: unknown } | null;
      if (!obj || !Array.isArray(obj.embedding)) {
        throw new EmbeddingError("invalid embedding response");
      }
      const index = typeof obj.index === "number" ? obj.index : pos;
      if (!Number.isInteger(index) || index < 0 || index >= out.length) {
        throw new EmbeddingError(`embedding index ${index} out of range`);
      }
      out[index] = obj.embedding.map((x: unknown) => (typeof x === "number" ? x : Number.NaN));
    });
    if (out.some((v) => v.length === 0 || v.some((x) => !Number.isFinite(x)))) {
      throw new EmbeddingError("embedding response contains an empty or invalid vector");
    }
    return out;
  }

  toJSON(): Record<string, unknown> {
    return { name: this.name, url: this.url, model: this.model, dimensions: this.dimensions };
  }

  [inspect.custom](): string {
    return `OpenAiCompatibleEmbedder ${JSON.stringify(this.toJSON())}`;
  }
}

/** Builds the embedder selected by `[memory.embedding] provider`. */
export function buildEmbedder(config: EmbeddingConfig): Embedder {
  const provider = config.provider.trim();
  switch (provider) {
    case "":
    case "none":
      return new NoEmbedder();
    case "local":
      return new LocalEmbedder(config);
    case "openai-compatible":
    case "openai":
    case "ollama":
      return new OpenAiCompatibleEmbedder(config);
    default:
      throw new EmbeddingError(
        `unknown [memory.embedding] provider \`${provider}\` (expected \`none\`, \`local\` or \`openai-compatible\`)`,
      );
  }
}

/** Cosine similarity; 0 for empty or mismatched vectors. */
export function cosine(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] as number;
    const y = b[i] as number;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  return na === 0 || nb === 0 ? 0 : dot / (Math.sqrt(na) * Math.sqrt(nb));
}
