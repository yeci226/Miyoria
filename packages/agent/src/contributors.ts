// Per-turn context from other modules: every registered `PromptContributor` is asked
// concurrently, each with a time limit, and the sections of those that answered in time are
// handed to the prompt compiler (compiler.ts), which budgets them into the data message. In voice
// some are kept warm instead (`Warm`, below).

import { errorMessage, getLogger } from "@miyoria/kernel";
import type {
  Pinned,
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

/** The two sets of `gathered` as one (sections and the decision trace's lists). */
export function mergeGathered(...gathered: readonly (Gathered | undefined)[]): Gathered {
  const out = new Gathered();
  for (const g of gathered) {
    if (g === undefined) continue;
    out.sections.push(...g.sections);
    out.answered.push(...g.answered);
    out.skipped.push(...g.skipped);
  }
  return out;
}

// ---- kept warm (voice) ----------------------------------------------------------------------
//
// v4 §7.5 item 3. In voice the memory reads and the contributors were on the critical path, each
// with an 800 ms timeout, two of them one after the other. What does not depend on the line she
// answers (her skills and notebook index, the just-now timeline, the other places, pinned memory,
// the profiles of the people here) is kept per voice channel: a turn reads the last value without
// waiting and starts a refresh for the next one. A value is only reused for the same people
// (`key`): what the other places may show depends on who listens, so a stale view never reaches
// a new listener. What does depend on the line (retrieval for it) runs beside it with a short
// deadline and is left out when late.

/** One value kept per voice channel, keyed by what it was made for. */
export class Warm<T> {
  #kept: { key: string; at: number; value: T } | null = null;
  #loading: { key: string; promise: Promise<T> } | null = null;

  /** The value made for `key`, unless it is older than `maxAgeMs`. */
  peek(key: string, now: number, maxAgeMs: number): T | undefined {
    const kept = this.#kept;
    if (kept === null || kept.key !== key || now - kept.at > maxAgeMs) return undefined;
    return kept.value;
  }

  /** Loads the value for `key` (one load at a time per key) and keeps it once it is there. */
  refresh(key: string, now: () => number, load: () => Promise<T>): Promise<T> {
    const loading = this.#loading;
    if (loading !== null && loading.key === key) return loading.promise;
    const promise = load().then((value) => {
      this.#kept = { key, at: now(), value };
      return value;
    });
    const entry = { key, promise };
    this.#loading = entry;
    const done = () => {
      if (this.#loading === entry) this.#loading = null;
    };
    promise.then(done, done);
    return promise;
  }
}

export interface WarmRead {
  now: () => number;
  /** Older values are not used. */
  maxAgeMs: number;
  /** Without a value for this key, the fresh load is waited for this long. */
  waitMs: number;
  /** The turn's: aborting it stops the wait, never the load (the next turn wants it). */
  signal: AbortSignal;
}

/**
 * The value kept for `key`, without waiting, and a refresh for the next turn; when none is kept
 * (the first turn, other people), the load itself, waited for at most `waitMs`. `undefined`: late
 * or failed (the load goes on and is kept when it comes).
 */
export async function readWarm<T>(
  warm: Warm<T>,
  key: string,
  read: WarmRead,
  load: () => Promise<T>,
): Promise<T | undefined> {
  const kept = warm.peek(key, read.now(), read.maxAgeMs);
  const loading = warm.refresh(key, read.now, load);
  loading.catch(() => undefined);
  if (kept !== undefined) return kept;
  try {
    return await timeout(read.waitMs, read.signal, () => loading);
  } catch (error) {
    if (read.signal.aborted) throw error;
    return undefined;
  }
}

/** The values kept for one voice channel. */
export class WarmContext {
  readonly contributors = new Warm<Gathered>();
  readonly skills = new Warm<string | null>();
  readonly pinned = new Warm<Pinned>();
  readonly people = new Warm<string | null>();
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
