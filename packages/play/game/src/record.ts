// The director's record of what she tried (docs/design/v4-plan.md §11.2 item 1): every action
// she started, how it ended, with the failure code and whether it got her anywhere. It is its
// own list, not the event feed: on 2026-11-08 the "recent" list was 12 lines of zombies, damage
// and reflexes, so the decision after `obtain bread` failed for the 20th time could not see the
// 19 failures before it. Pure; times are epoch ms.

/** How one attempt ended. */
export type AttemptResult =
  /** Done, and something changed (items, place, sight). */
  | "progress"
  /** Done, but nothing changed: not a success (§11.2 item 3). */
  | "no_progress"
  /** Failed with a code. */
  | "failed"
  /** A reflex, a death or a newer action took her body: neither success nor failure. */
  | "interrupted";

export interface Attempt {
  at: number;
  /** `obtain {"item":"bread"}`. */
  action: string;
  /** The method it was (`methodKey`). */
  method: string;
  /** The goal it was for, if any. */
  goal: string | null;
  result: AttemptResult;
  /** The task failure code (`failed`), `no_progress`, or `null`. */
  code: string | null;
  /** What the game said (first line). */
  detail: string;
}

const RESULT_TEXT: Record<AttemptResult, string> = {
  progress: "有進展",
  no_progress: "做完了但沒有進展",
  failed: "失敗",
  interrupted: "被打斷",
};

/** Attempts of one session, newest last. */
export class AttemptRecord {
  readonly #max: number;
  readonly #items: Attempt[] = [];

  constructor(max: number) {
    this.#max = Math.max(max, 1);
  }

  add(attempt: Attempt): void {
    this.#items.push(attempt);
    while (this.#items.length > this.#max) this.#items.shift();
  }

  all(): readonly Attempt[] {
    return this.#items;
  }

  /** Attempts made for goal `goal` since `since`. */
  forGoal(goal: string, since: number): Attempt[] {
    return this.#items.filter((a) => a.goal === goal && a.at >= since);
  }

  /** Prompt lines, newest last: `[35 秒前] obtain {"item":"bread"} → 失敗(precondition):…`. */
  lines(now: number): string[] {
    return this.#items.map((a) => attemptLine(a, now));
  }
}

export function attemptLine(a: Attempt, now: number): string {
  const secs = Math.max(0, Math.round((now - a.at) / 1000));
  const ago = secs < 120 ? `${secs} 秒前` : `${Math.round(secs / 60)} 分鐘前`;
  const code = a.result === "failed" && a.code !== null ? `(${a.code})` : "";
  const detail = a.detail === "" ? "" : `:${a.detail}`;
  return `[${ago}] ${a.action} → ${RESULT_TEXT[a.result]}${code}${detail}`;
}
