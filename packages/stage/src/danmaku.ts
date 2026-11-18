// Danmaku on the stage node (docs/design/v5-play.md §11.6): which overlay pages show them, and how
// each line ended, for Core to keep or give back its price.
//
// A page whose danmaku layer is on says so (`danmaku_ready`) after it connects; only those pages
// are waited for. A line goes to every page; it is `shown` as soon as one page says it entered
// the screen. Otherwise it ends when every page it went to has dropped it (with the last page's
// reason) or left (`lost`), or when its deadline passes (`lost`): its longest wait plus a grace
// for the frame loop and the socket. With no page to show it, it ends at once (`no_overlay`).
// Each line ends once; a second answer, or one for a line it does not know, is nothing.

import type { DanmakuOutcome } from "@miyoria/contracts/stage-link";

export type { DanmakuOutcome };

/** How a line ended, for Core (`danmaku_done`). */
export interface DanmakuDone {
  id: string;
  outcome: DanmakuOutcome;
}

/** On top of a line's longest wait: how long a page may take to answer. */
export const ANSWER_GRACE_MS = 30_000;
/** Lines waited for at once; past this the oldest is given up (`lost`). */
const MAX_PENDING = 1_000;
/** Ids of lines that ended, remembered so a late or repeated line is not taken again. */
const MAX_ENDED = 2_000;

interface Pending {
  /** Pages it went to that have not answered. */
  waiting: Set<number>;
  deadline: number;
  /** The reason of the last page that dropped it. */
  last: DanmakuOutcome;
}

export class DanmakuRelay {
  readonly #ready = new Set<number>();
  readonly #pending = new Map<string, Pending>();
  readonly #ended = new Set<string>();

  constructor(private readonly now: () => number = Date.now) {}

  /** Pages whose danmaku layer is on. */
  get pages(): number {
    return this.#ready.size;
  }

  /** Lines waiting for an answer. */
  get pending(): number {
    return this.#pending.size;
  }

  /** Page `page` shows danmaku. */
  ready(page: number): void {
    this.#ready.add(page);
  }

  /** Page `page` went away: the lines only it was showing are lost. */
  leave(page: number): DanmakuDone[] {
    this.#ready.delete(page);
    const out: DanmakuDone[] = [];
    for (const [id, p] of this.#pending) {
      if (!p.waiting.delete(page)) continue;
      if (p.waiting.size === 0) out.push(this.#end(id, "lost"));
    }
    return out;
  }

  /**
   * A line from Core. `send`: give it to the pages; `done`: lines that ended now (this one at once
   * when no page shows danmaku, or the oldest one when too many wait).
   */
  line(id: string, maxWaitMs: number): { send: boolean; done: DanmakuDone[] } {
    if (this.#pending.has(id) || this.#ended.has(id)) return { send: false, done: [] };
    if (this.#ready.size === 0) return { send: false, done: [this.#end(id, "no_overlay")] };
    const done: DanmakuDone[] = [];
    if (this.#pending.size >= MAX_PENDING) {
      const oldest = this.#pending.keys().next().value;
      if (oldest !== undefined) done.push(this.#end(oldest, "lost"));
    }
    this.#pending.set(id, {
      waiting: new Set(this.#ready),
      deadline: this.now() + Math.max(maxWaitMs, 0) + ANSWER_GRACE_MS,
      last: "lost",
    });
    return { send: true, done };
  }

  /** Page `page` says line `id` entered the screen. */
  shown(page: number, id: string): DanmakuDone[] {
    const p = this.#pending.get(id);
    if (!p?.waiting.has(page)) return [];
    return [this.#end(id, "shown")];
  }

  /** Page `page` will never show line `id`. */
  dropped(page: number, id: string, reason: DanmakuOutcome): DanmakuDone[] {
    const p = this.#pending.get(id);
    if (!p?.waiting.delete(page)) return [];
    p.last = reason;
    return p.waiting.size === 0 ? [this.#end(id, reason)] : [];
  }

  /** Lines whose deadline passed: lost. */
  expire(): DanmakuDone[] {
    const now = this.now();
    const out: DanmakuDone[] = [];
    for (const [id, p] of this.#pending) if (now >= p.deadline) out.push(this.#end(id, "lost"));
    return out;
  }

  #end(id: string, outcome: DanmakuOutcome): DanmakuDone {
    this.#pending.delete(id);
    this.#ended.add(id);
    if (this.#ended.size > MAX_ENDED) {
      const first = this.#ended.values().next().value;
      if (first !== undefined) this.#ended.delete(first);
    }
    return { id, outcome };
  }
}

/**
 * Answers waiting for Core: kept while the node is not connected, sent when it is again. Past
 * `max` the oldest are dropped (Core gives those lines back by itself after a while).
 */
export class DanmakuOutbox {
  readonly #queue: DanmakuDone[] = [];

  constructor(private readonly max = 1_000) {}

  get size(): number {
    return this.#queue.length;
  }

  push(done: DanmakuDone): void {
    this.#queue.push(done);
    if (this.#queue.length > this.max) this.#queue.shift();
  }

  /** Everything kept, oldest first; the box is empty after. */
  take(): DanmakuDone[] {
    return this.#queue.splice(0);
  }

  /** Puts back answers that could not be sent, in front of the newer ones. */
  restore(done: readonly DanmakuDone[]): void {
    this.#queue.unshift(...done);
    if (this.#queue.length > this.max) this.#queue.splice(0, this.#queue.length - this.max);
  }
}
