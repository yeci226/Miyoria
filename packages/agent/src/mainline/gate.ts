// Saying and doing are one decision (docs/design/v3-architecture.md §10.1).
//
// | she says      | needs                                                        |
// |---------------|--------------------------------------------------------------|
// | 「我要去做」   | an action in the same output, or a commitment                |
// | 「做好了」     | `result: done` in the log; until then the line waits         |
// | 「我在語音」   | the state really is `in`                                     |
//
// The primary check is structural: every output is compared with its actions and their results,
// and `accepted` backs nothing. Which sentence is a claim is still read off its words (claims.ts):
// no structured signal carries that, so it only ever decides what to hold, never what happened.
//
// A sentence that claims something too early is held, and so is everything after it, to keep the
// order. Once the stream ended the actions are known, and each held sentence goes one of three
// ways: out as it is, parked for its result (she says "started" meanwhile), or dropped.

import { ALL_CLAIMS, type Claim } from "../claims.js";
import type { ToolScope } from "../tool-scope.js";

/** What she says instead of a finished line while its result is out. */
export const STARTED_LINE = "開始了,等我一下。";

/** Finished work in any words, for work no entry of `CLAIMS` names. */
const FINISHED = /(?:做|弄|寫|改|搞|修|蓋|挖|裝|換|設定?)(?:好|完)了|搞定了|完成了|處理好了/;

/** A sentence and what goes with it in voice. */
export interface HeldLine {
  text: string;
  /** Her `<voice>` line for it. */
  spoken: string | null;
  emotion: string | null;
  /** It is the filtered line: moderation stopped what she meant (the rule). */
  blocked?: string | null;
}

/** A line waiting for the results of `tools`. */
export interface ParkedLine extends HeldLine {
  tools: string[];
}

/** What the gate reads of the world. */
export interface GateFacts {
  /** Her state, strictly (`strictScope`). `null`: unknown. */
  scope(): ToolScope | null;
  /** `tool` finished lately (`result: done` in the log). */
  done(tool: string): boolean;
  /** The tools of actions that are out and have no result yet. */
  pending(): readonly string[];
}

/** What became of the held lines. */
export interface Settled {
  release: HeldLine[];
  parked: ParkedLine[];
  /** Say this first: a finished line waits for its result. */
  started: boolean;
  /** Claims with no action behind them: the lines are gone. */
  dropped: Claim[];
}

/** Claims of a finished thing in `text`. */
export function finishedClaims(text: string): Claim[] {
  return ALL_CLAIMS.filter((c) => c.finished.test(text));
}

/** Claims of something she is about to do in `text`. */
export function promisedClaims(text: string): Claim[] {
  return ALL_CLAIMS.filter((c) => c.promised.test(text));
}

export function isFinished(text: string): boolean {
  return FINISHED.test(text);
}

export class LineGate {
  readonly #facts: GateFacts;
  /** Tools may still follow in this stream. */
  #streaming = true;
  #held: HeldLine[] = [];

  constructor(facts: GateFacts) {
    this.#facts = facts;
  }

  /** A claim of `claim` nothing backs yet. */
  #unbacked(claim: Claim): boolean {
    if (this.#facts.done(claim.tool)) return false;
    const scope = this.#facts.scope();
    return scope === null || !claim.holds(scope);
  }

  /** Whether `text` must wait. */
  #mustWait(text: string): boolean {
    if (finishedClaims(text).some((c) => this.#unbacked(c))) return true;
    return isFinished(text) && (this.#streaming || this.#facts.pending().length > 0);
  }

  /** Lets `line` out now, or keeps it (with everything after it). */
  pass(line: HeldLine): boolean {
    if (this.#held.length === 0 && !this.#mustWait(line.text)) return true;
    this.#held.push(line);
    return false;
  }

  /** Whether a text line must wait: it stays in the reply, nothing is kept here. */
  holds(text: string): boolean {
    return this.#mustWait(text);
  }

  /** Adds what a text reply still has to say, once the stream ended. */
  hold(line: HeldLine): void {
    this.#held.push(line);
  }

  /** The stream ended with `actions` (tool names): every held line gets its way. */
  settle(actions: readonly string[]): Settled {
    this.#streaming = false;
    const out: Settled = { release: [], parked: [], started: false, dropped: [] };
    const held = this.#held;
    this.#held = [];
    const asked = [...actions, ...this.#facts.pending()];
    for (const line of held) {
      const claims = finishedClaims(line.text).filter((c) => this.#unbacked(c));
      const missing = claims.filter((c) => !asked.includes(c.tool));
      if (missing.length > 0) {
        out.dropped.push(...missing);
        continue;
      }
      if (claims.length > 0) {
        out.parked.push({ ...line, tools: claims.map((c) => c.tool) });
        out.started = true;
        continue;
      }
      if (isFinished(line.text) && asked.length > 0) {
        out.parked.push({ ...line, tools: [...new Set(asked)] });
        out.started = true;
        continue;
      }
      out.release.push(line);
    }
    return out;
  }
}
