// The overlay's gift line: gifts within a window are merged into one line, and the line fades
// after a while. Pure (times are passed in); the OverlayHub owns the timer.

/** Gifts of one item that are this close to the first one of their group are merged (ms). */
export const GIFT_MERGE_MS = 60_000;
/** How long the line stays after the latest gift (ms). */
export const GIFT_SHOW_MS = 8_000;

export interface Gift {
  name: string;
  item: string;
  count: number;
  label: string;
}

interface Group {
  item: string;
  label: string;
  startedAt: number;
  names: string[];
  count: number;
}

/** Items that are fed; the rest are handed over (a letter, an expression). */
const FED = new Set(["rice", "big_bowl", "dessert"]);

const isControl = (ch: string): boolean => {
  const c = ch.charCodeAt(0);
  return c < 32 || c === 127;
};

/** One line of text: control characters and runs of whitespace become one space, capped. */
const clean = (s: string, max: number): string =>
  [...s]
    .map((ch) => (isControl(ch) ? " " : ch))
    .join("")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);

/**
 * "一碗白飯" → "5 碗白飯": a leading 一 and its measure word take the count. A label without that
 * shape keeps itself and gets the count after it.
 */
export function countedLabel(label: string, count: number): string {
  const m = /^一(.)(.+)$/u.exec(label);
  if (m) return `${count} ${m[1]}${m[2]}`;
  return count === 1 ? label : `${label} x${count}`;
}

/** The line: 「Owen 餵了她一碗白飯」, or 「Owen 和另外 3 人餵了她 5 碗白飯」. */
export function giftLine(
  names: readonly string[],
  item: string,
  label: string,
  count: number,
): string {
  // A name is set off by a space ("Owen 餵了她…"); "3 人" already ends in one.
  const who =
    names.length <= 1 ? `${names[0] ?? ""} ` : `${names[0]} 和另外 ${names.length - 1} 人`;
  const verb = FED.has(item) ? "餵了她" : "送了她";
  const what = count === 1 ? label : countedLabel(label, count);
  // A single thing reads as is ("一碗白飯"); more as "5 碗白飯" after a space.
  return count === 1 ? `${who}${verb}${what}` : `${who}${verb} ${what}`;
}

export class GiftMerger {
  readonly #groups = new Map<string, Group>();
  #shown: { line: string; until: number } | null = null;

  /** Adds a gift; returns the line to show now (`null`: the gift is unusable). */
  add(gift: Gift, now: number): string | null {
    const name = clean(gift.name, 32);
    const label = clean(gift.label, 24);
    if (name === "" || label === "" || !Number.isFinite(gift.count) || gift.count < 1) return null;
    const count = Math.min(Math.floor(gift.count), 99);
    let g = this.#groups.get(gift.item);
    if (!g || now - g.startedAt >= GIFT_MERGE_MS) {
      g = { item: gift.item, label, startedAt: now, names: [], count: 0 };
      this.#groups.set(gift.item, g);
    }
    if (!g.names.includes(name)) g.names.push(name);
    g.count += count;
    const line = giftLine(g.names, g.item, g.label, g.count);
    this.#shown = { line, until: now + GIFT_SHOW_MS };
    return line;
  }

  /** The line still showing at `now`, if any. */
  current(now: number): string | null {
    const s = this.#shown;
    return s !== null && now < s.until ? s.line : null;
  }

  /** When the current line fades (ms), or `null`. */
  deadline(): number | null {
    return this.#shown?.until ?? null;
  }

  /** Takes the line down (its time is up). */
  endLine(): void {
    this.#shown = null;
  }

  /** Forgets groups past their window and a line past its time; true when the line went away. */
  expire(now: number): boolean {
    for (const [item, g] of this.#groups) {
      if (now - g.startedAt >= GIFT_MERGE_MS) this.#groups.delete(item);
    }
    if (this.#shown !== null && now >= this.#shown.until) {
      this.#shown = null;
      return true;
    }
    return false;
  }
}
