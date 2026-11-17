// Who an LLM call is for, carried along the async call chain: callers wrap their requests in
// `withLlmTag({ module, turn, thought })` and the router stamps the tag on the call it records
// (`LlmCallLog`). Providers report HTTP retries of the request being sent with
// `noteProviderRetry`.

import { AsyncLocalStorage } from "node:async_hooks";

/** What a call belongs to. Every field is optional; inner tags extend outer ones. */
export interface LlmCallTag {
  /** Module that asked (`agent`, `mind`, `memory`, ...). */
  module?: string | null;
  /** The agent turn. */
  turn?: string | null;
  /** Her journal entry (`mind`). */
  thought?: string | null;
  /** What the call is for within the module (`reply`, `attention`, `appraisal`, ...). */
  label?: string | null;
  /** Repair attempt of a structured reply (1 = the first retry). */
  repair?: number | null;
  /** Called once the call is recorded and again when it ends. */
  onCall?: ((call: { id: string; cost_usd: number | null; status: string }) => void) | null;
}

const tags = new AsyncLocalStorage<LlmCallTag>();
const traces = new AsyncLocalStorage<string[]>();

/** Runs `fn` with `tag` added to the current one (inner fields win). */
export function withLlmTag<T>(tag: LlmCallTag, fn: () => T): T {
  const outer = tags.getStore();
  return tags.run(outer ? { ...outer, ...tag } : tag, fn);
}

/** The tag of the current async context. */
export function currentLlmTag(): LlmCallTag | undefined {
  return tags.getStore();
}

/** Called by providers before they retry a request; the router counts these per call. */
export function noteProviderRetry(reason: string): void {
  traces.getStore()?.push(reason);
}

/** Runs `fn`, collecting provider retries into `into`. */
export function collectRetries<T>(into: string[], fn: () => T): T {
  return traces.run(into, fn);
}
