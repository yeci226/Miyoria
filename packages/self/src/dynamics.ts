// The dynamics of her emotions that make them behave (docs/design/v2-architecture.md §3.6):
//
// * habituation: the same cause again within two hours is worth `0.5ⁿ` (n = how many times it
//   already counted), so the tenth song does not make her as proud as the first;
// * mutual inhibition: stirring one emotion pushes its opposites down by half of the stir;
// * a stir budget: all emotions together may be stirred only so much in any ten minutes, so
//   a burst of events cannot fill every emotion at once.
//
// Pure data structures; `now` (epoch ms) is passed in.

import type { EmotionName, PersonEmotionName } from "@miyoria/types";

export const HABITUATION_WINDOW_MS = 2 * 60 * 60_000;
export const BUDGET_WINDOW_MS = 10 * 60_000;

/** Suppression of the opposite is this share of the stir ("half of the excitation"). */
export const INHIBITION_SHARE = 0.5;

/** What can push other emotions down. `companionship` is being with someone (not an emotion). */
export type Inhibitor = EmotionName | "companionship";

/** What an inhibitor pushes down: her own emotions, and emotions toward the person. */
export interface Inhibits {
  own: readonly EmotionName[];
  toward: readonly PersonEmotionName[];
}

/** joy ⊣ sorrow / lonely, pride ⊣ guilt, gratitude ⊣ resentment, companionship ⊣ lonely. */
export const INHIBITS: Readonly<Partial<Record<Inhibitor, Inhibits>>> = {
  joy: { own: ["sorrow", "lonely"], toward: [] },
  pride: { own: ["guilt"], toward: [] },
  // Resentment toward someone is also (part of) her anger.
  gratitude: { own: ["anger"], toward: ["resentment"] },
  companionship: { own: ["lonely"], toward: [] },
};

/** `0.5ⁿ` for the n-th repeat (n = 0 is the first time: 1). */
export function habituationFactor(prior: number): number {
  return 0.5 ** Math.max(prior, 0);
}

/** When each cause counted, to know how many times it already did within the window. */
export class Habituation {
  readonly #seen = new Map<string, number[]>();

  constructor(private readonly windowMs = HABITUATION_WINDOW_MS) {}

  /** How many times `key` counted within the window ending at `now`. */
  count(key: string, now: number): number {
    const times = this.#seen.get(key);
    if (!times) return 0;
    return times.filter((t) => now - t < this.windowMs && t <= now).length;
  }

  /** `key` counted at `now`. */
  record(key: string, now: number): void {
    const times = (this.#seen.get(key) ?? []).filter((t) => now - t < this.windowMs);
    times.push(now);
    this.#seen.set(key, times);
    if (this.#seen.size > 512) this.prune(now);
  }

  /** Forgets causes whose last count left the window. */
  prune(now: number): void {
    for (const [key, times] of this.#seen) {
      if (!times.some((t) => now - t < this.windowMs)) this.#seen.delete(key);
    }
  }

  toJson(now: number): Record<string, number[]> {
    this.prune(now);
    return Object.fromEntries(
      [...this.#seen].map(([k, v]) => [k, v.filter((t) => now - t < this.windowMs)]),
    );
  }

  restore(value: unknown, now: number): void {
    this.#seen.clear();
    if (typeof value !== "object" || value === null) return;
    for (const [key, raw] of Object.entries(value)) {
      if (!Array.isArray(raw)) continue;
      const times = raw.filter(
        (t): t is number => typeof t === "number" && Number.isFinite(t) && now - t < this.windowMs,
      );
      if (times.length > 0) this.#seen.set(key, times.slice(-32));
    }
  }
}

/** The total stir allowed within the last ten minutes. */
export class StirBudget {
  #taken: [number, number][] = [];

  constructor(
    /** Total stir allowed per window (0 or less: unlimited). */
    private readonly cap: number,
    private readonly windowMs = BUDGET_WINDOW_MS,
  ) {}

  #prune(now: number): void {
    this.#taken = this.#taken.filter(([t]) => now - t < this.windowMs && t <= now);
  }

  /** Stir still allowed at `now`. */
  room(now: number): number {
    if (this.cap <= 0) return Number.POSITIVE_INFINITY;
    this.#prune(now);
    const used = this.#taken.reduce((a, [, v]) => a + v, 0);
    return Math.max(this.cap - used, 0);
  }

  /** Books a stir of `amount` at `now`. */
  take(now: number, amount: number): void {
    this.#prune(now);
    if (amount > 0) this.#taken.push([now, amount]);
  }

  /** Stir used within the window ending at `now`. */
  used(now: number): number {
    this.#prune(now);
    return this.#taken.reduce((a, [, v]) => a + v, 0);
  }

  toJson(now: number): [number, number][] {
    this.#prune(now);
    return this.#taken.map(([t, v]) => [t, v]);
  }

  restore(value: unknown, now: number): void {
    this.#taken = [];
    if (!Array.isArray(value)) return;
    for (const row of value) {
      if (!Array.isArray(row) || typeof row[0] !== "number" || typeof row[1] !== "number") continue;
      if (Number.isFinite(row[0]) && Number.isFinite(row[1])) this.#taken.push([row[0], row[1]]);
    }
    this.#prune(now);
  }
}
