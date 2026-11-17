// A gag that feeds on itself: "白飯" was in 60 memories and 4 documents, so every recall pulled
// several of them, she said it again, and the new line made another memory about it. The
// engine remembers the last N recalled items; a candidate that says (nearly) the same thing as
// more than `allowed` of them is down-weighted per extra appearance, so one joke cannot fill
// every recall.

import type { RepeatConfig } from "./config.js";

/** Share of the smaller token set found in the other one. */
function overlap(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  const small = a.size <= b.size ? a : b;
  const large = a.size <= b.size ? b : a;
  if (small.size === 0) return 0;
  let shared = 0;
  for (const t of small) if (large.has(t)) shared += 1;
  return shared / small.size;
}

/** Fewer tokens than this say too little to be "the same gag". */
const MIN_TOKENS = 2;

function tokenSet(tokens: string): Set<string> {
  return new Set(tokens.split(/\s+/).filter((t) => t !== ""));
}

export class RepeatDamper {
  readonly #config: RepeatConfig;
  readonly #recent: Set<string>[] = [];

  constructor(config: RepeatConfig) {
    this.#config = config;
  }

  /** How many of the recent items say the same thing as `tokens`. */
  count(tokens: string): number {
    const set = tokenSet(tokens);
    if (set.size < MIN_TOKENS) return 0;
    let n = 0;
    for (const other of this.#recent) {
      if (other.size >= MIN_TOKENS && overlap(set, other) >= this.#config.similarity) n += 1;
    }
    return n;
  }

  /** The factor for a candidate with `tokens`: 1 up to `allowed` appearances, less after. */
  factor(tokens: string): number {
    const c = this.#config;
    if (c.window === 0) return 1;
    const extra = this.count(tokens) - c.allowed;
    return extra <= 0 ? 1 : Math.max(c.floor, 1 - c.penalty * extra);
  }

  /** Records what was just recalled. */
  note(items: readonly string[]): void {
    const c = this.#config;
    if (c.window === 0) return;
    for (const tokens of items) this.#recent.push(tokenSet(tokens));
    if (this.#recent.length > c.window) this.#recent.splice(0, this.#recent.length - c.window);
  }
}
