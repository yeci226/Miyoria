// The suite `memory`: the recall harness on a labelled set, with the embedder the config names,
// against the memory records or (`--memory-target notes`) her notes. A run against the notes is
// recorded as `memory-notes`, so its numbers are not drawn on the records' trend. It calls no
// chat model, so the subject, the judge and the budget play no part in it.

import { buildEmbedder, EmbeddingConfigSchema } from "@miyoria/memory/memory";
import { Config, loadDotenv } from "@miyoria/runtime/kernel";
import { memorySuite, type RecallTarget } from "../../recall/index.js";
import type { SuiteRunner } from "../suite.js";

export interface MemorySuiteSource {
  /** The labelled set (JSON, `recall/set.ts`). */
  setPath: string;
  /** `miyoria.toml`: its `[memory.embedding]` picks the embedder. */
  configPath: string;
  /** Default `records`. */
  target?: RecallTarget;
}

/** The runner of the suite `memory` for one set and one config. */
export function memoryRunner(source: MemorySuiteSource): SuiteRunner {
  return async (ctx) => {
    loadDotenv(source.configPath);
    const config = await Config.load(source.configPath);
    const embedding = config.get("memory.embedding", EmbeddingConfigSchema);
    const target = source.target ?? "records";
    ctx.log(`memory: ${source.setPath}, ${target}, embedding provider ${embedding.provider}`);
    const embedder = buildEmbedder(embedding);
    const result = await memorySuite({ setPath: source.setPath, embedder, target }).finally(() =>
      (embedder as { close?: () => Promise<void> }).close?.(),
    );
    const detail = result.detail as { per_query?: unknown[] };
    return {
      suite: target === "notes" ? "memory-notes" : "memory",
      headline: result.headline,
      items: detail.per_query ?? [],
      unsupported: [],
    };
  };
}
