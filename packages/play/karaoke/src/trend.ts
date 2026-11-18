// What a singer of a room is told about themselves while they sing (docs/design/karaoke.md
// 「做了什麼第四步」): only a direction, as a KTV machine shows it (上升中 / 下降中), never their
// rank or anyone's score. It comes from their place and their running total over the last few
// seconds, with hysteresis so it does not flicker: a new direction must hold for a few looks in a
// row before it is shown, and going back to "holding" takes a few more.

export type Trend = "rising" | "dropping" | "holding";

/** How far back a look compares with (ms). */
export const TREND_WINDOW_MS = 6_000;
/** A comparison needs at least this much history (ms). */
const MIN_SPAN_MS = 3_000;
/** Points of running total that count as a move by themselves. */
const POINTS = 1.5;
/** Looks in a row a new direction needs before it is shown. */
const TO_MOVE = 2;
/** Looks in a row "holding" needs before it replaces a direction. */
const TO_HOLD = 3;

interface Look {
  at: number;
  rank: number;
  total: number;
}

export class TrendTracker {
  readonly #looks: Look[] = [];
  #shown: Trend = "holding";
  #candidate: Trend = "holding";
  #count = 0;

  get trend(): Trend {
    return this.#shown;
  }

  /** One look (about once a second): the singer's place (1 = first) and running total now. */
  push(at: number, rank: number, total: number): Trend {
    this.#looks.push({ at, rank, total });
    while (this.#looks.length > 2 && (this.#looks[1] as Look).at <= at - TREND_WINDOW_MS) {
      this.#looks.shift();
    }
    const base = this.#looks[0] as Look;
    let raw: Trend = "holding";
    if (at - base.at >= MIN_SPAN_MS) {
      const places = base.rank - rank; // positive: moved up
      const points = total - base.total;
      if (places > 0) raw = "rising";
      else if (places < 0) raw = "dropping";
      else if (points >= POINTS) raw = "rising";
      else if (points <= -POINTS) raw = "dropping";
    }
    if (raw === this.#shown) {
      this.#candidate = raw;
      this.#count = 0;
      return this.#shown;
    }
    if (raw === this.#candidate) this.#count++;
    else {
      this.#candidate = raw;
      this.#count = 1;
    }
    if (this.#count >= (raw === "holding" ? TO_HOLD : TO_MOVE)) {
      this.#shown = raw;
      this.#count = 0;
    }
    return this.#shown;
  }
}
