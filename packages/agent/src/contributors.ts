// Per-turn context from other modules: every registered `PromptContributor` is asked
// concurrently, each with a time limit, and the sections of those that answered in time are
// handed to the prompt compiler (compiler.ts), which budgets them into the data message.

import { errorMessage, getLogger } from "@miyoria/kernel";
import type {
  PromptContributor,
  PromptContributors,
  PromptRequest,
  PromptSection,
} from "@miyoria/types";
import { TimeoutError, timeout } from "./util.js";

const log = getLogger("agent.contributors");

/** What the contributors returned. */
export class Gathered {
  sections: PromptSection[] = [];
  /** Keys of the contributors that answered in time. */
  answered: string[] = [];
  /** `"{key} (timed out)"` / `"{key} (failed)"`. */
  skipped: string[] = [];

  /** Lines for the decision trace. */
  reasons(): string[] {
    const out: string[] = [];
    if (this.answered.length > 0) out.push(`context from: ${this.answered.join(", ")}`);
    if (this.skipped.length > 0) out.push(`context skipped: ${this.skipped.join(", ")}`);
    return out;
  }
}

/** Asks every contributor of `registry` at once; slow or failing ones are skipped (warned). */
export async function gather(
  registry: PromptContributors,
  request: PromptRequest,
  timeoutMs: number,
  signal: AbortSignal,
  /** Contributors not to ask: the main line reads what they would say from elsewhere. */
  skip: readonly string[] = [],
): Promise<Gathered> {
  const contributors = registry.all().filter((c) => !skip.includes(c.key));
  const out = new Gathered();
  if (contributors.length === 0) return out;
  const results = await Promise.all(contributors.map((c) => ask(c, request, timeoutMs, signal)));
  signal.throwIfAborted();
  contributors.forEach((contributor, i) => {
    const result = results[i] as PromptSection[] | string;
    if (typeof result === "string") {
      out.skipped.push(`${contributor.key} (${result})`);
    } else {
      out.sections.push(...result);
      out.answered.push(contributor.key);
    }
  });
  return out;
}

/** The sections, or why there are none (`"failed"` / `"timed out"`). */
async function ask(
  contributor: PromptContributor,
  request: PromptRequest,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<PromptSection[] | string> {
  const key = contributor.key;
  try {
    return await timeout(timeoutMs, signal, (s) => contributor.contribute(request, s));
  } catch (error) {
    if (signal.aborted) return "failed";
    if (error instanceof TimeoutError) {
      log.warn({ contributor: key, timeout_ms: timeoutMs }, "prompt contributor timed out");
      return "timed out";
    }
    log.warn({ contributor: key, error: errorMessage(error) }, "prompt contributor failed");
    return "failed";
  }
}
