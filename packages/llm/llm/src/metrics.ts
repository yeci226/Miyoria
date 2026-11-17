// Prometheus metrics of the router. Labels: `model` (`provider:model` from the purpose chains),
// `purpose` (as requested), `stage` / `kind` / `type` (fixed sets below), so cardinality is
// bounded by the config.

import {
  type Counter,
  type Histogram,
  isAbortError,
  type MetricsRegistry,
  metrics,
} from "@miyoria/runtime/kernel";
import { ProviderHttpError, ProviderTimeoutError } from "./types.js";

/** Bucket bounds (seconds) of `miyoria_llm_first_token_seconds`. */
export const FIRST_TOKEN_BUCKETS: readonly number[] = [
  0.1, 0.25, 0.5, 0.75, 1, 1.5, 2, 3, 5, 8, 13, 20, 30, 60,
];

/**
 * Error classes counted by `miyoria_llm_errors_total`: `connect_timeout`, `timeout`,
 * `http_4xx`, `http_5xx`, `aborted` or `error`.
 */
export function errorKind(error: unknown): string {
  if (error instanceof ProviderTimeoutError) {
    return error.phase === "connect" ? "connect_timeout" : "timeout";
  }
  if (error instanceof ProviderHttpError) return error.status >= 500 ? "http_5xx" : "http_4xx";
  if (isTimeout(error)) return "timeout";
  if (isAbortError(error)) return "aborted";
  return "error";
}

function isTimeout(error: unknown): boolean {
  for (let e: unknown = error, depth = 0; e instanceof Error && depth < 4; depth++) {
    if (e.name === "TimeoutError") return true;
    e = e.cause;
  }
  return false;
}

/** Metric handles of the router. */
export interface LlmMetrics {
  calls: Counter;
  tokens: Counter;
  cost: Counter;
  firstToken: Histogram;
  errors: Counter;
}

export function llmMetrics(registry: MetricsRegistry = metrics): LlmMetrics {
  return {
    calls: registry.counter("miyoria_llm_calls_total", {
      help: "LLM responses that started streaming, by model and purpose.",
      labels: ["model", "purpose"],
    }),
    tokens: registry.counter("miyoria_llm_tokens_total", {
      help: "Tokens reported by providers; type is prompt, completion or cached_prompt.",
      labels: ["model", "purpose", "type"],
    }),
    cost: registry.counter("miyoria_llm_cost_usd_total", {
      help: "Estimated LLM spend in USD from [llm.pricing].",
      labels: ["model", "purpose"],
    }),
    firstToken: registry.histogram("miyoria_llm_first_token_seconds", {
      help: "Time from sending a request to the model's first text or reasoning delta.",
      labels: ["model", "purpose"],
      buckets: FIRST_TOKEN_BUCKETS,
    }),
    errors: registry.counter("miyoria_llm_errors_total", {
      help: "Failed LLM calls; stage request falls back to the next model, stream does not.",
      labels: ["model", "purpose", "stage", "kind"],
    }),
  };
}
