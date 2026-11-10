// When she plans: the adaptive heartbeat and the rate caps. Pure; `now` is epoch ms.
//
// Heartbeat (§3.7 "很主動"): about every `heartbeat_mins` (15) when nothing goes on, faster
// the more she is bored or a need is unmet (down to `min_heartbeat_mins`, ~4). Every Plan run
// that changed nothing and did nothing makes the next one 1.5× sparser (up to 4 times); the
// Arbiter's quiet hours and a degraded LLM budget make it 3× sparser each. Always between
// `min_heartbeat_mins` (and `min_interval_secs`) and `max_heartbeat_mins`; none while the
// budget is exhausted. Her feelings lean it a little (`AffectBiases.initiative`): sooner in a
// good mood, later in a bad one, inside the same limits. Goal triggers, activity ends and salient
// changes wake Plan on their own, so the heartbeat is only the fallback for "nothing happened, but
// maybe I want something".

import type { Drives } from "@miyoria/types";
import type { MindConfig } from "./config.js";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
/** Empty runs in a row that still lengthen the heartbeat. */
const MAX_EMPTY_STEPS = 4;

export type BudgetState = "ok" | "degraded" | "exhausted";

/** What the heartbeat depends on. */
export interface Pace {
  /** 0..1: how much she wants something to happen (`urgeOf`). */
  urge: number;
  /** Plan runs in a row that changed no goal and produced no impulse. */
  emptyStreak: number;
  /** Quiet hours apply now (the Arbiter's ledger limits). */
  quiet: boolean;
  budget: BudgetState;
  /** How much her feelings want her to start things (-1..1, `AffectBiases.initiative`). */
  initiative?: number;
}

/** The share of the heartbeat one unit of `initiative` takes away. */
const INITIATIVE_PACE = 0.5;

const clamp01 = (v: number) => Math.min(Math.max(v, 0), 1);
const above = (v: number, level: number) => (v > level ? (v - level) / (1 - level) : 0);

/**
 * 0..1 from her boredom and the gaps of the drives that want something to happen (social,
 * play, attention, curiosity): 0 up to 0.3, then linear to 1.
 */
export function urgeOf(boredom: number, drives: Partial<Drives>): number {
  const gap = Math.max(
    boredom,
    drives.social ?? 0,
    drives.play ?? 0,
    drives.attention ?? 0,
    drives.curiosity ?? 0,
  );
  return clamp01(above(clamp01(gap), 0.3));
}

/** Time until her next Plan heartbeat (ms), or `null` for none. */
export function heartbeatMs(pace: Pace, config: MindConfig): number | null {
  if (pace.budget === "exhausted") return null;
  let mins = config.heartbeat_mins * (1 - 0.75 * clamp01(pace.urge));
  mins *= 1.5 ** Math.min(Math.max(pace.emptyStreak, 0), MAX_EMPTY_STEPS);
  const lean = pace.initiative ?? 0;
  if (Number.isFinite(lean)) mins *= 1 - INITIATIVE_PACE * Math.min(Math.max(lean, -1), 1);
  if (pace.quiet) mins *= 3;
  if (pace.budget === "degraded") mins *= 3;
  const min = Math.max(config.min_heartbeat_mins * MINUTE_MS, config.min_interval_secs * 1000);
  const max = Math.max(config.max_heartbeat_mins * MINUTE_MS, min);
  return Math.min(Math.max(mins * MINUTE_MS, min), max);
}

/** Calls in the last hour and the gap between calls. */
export class CallLog {
  #calls: number[] = [];
  total = 0;

  constructor(
    private readonly maxPerHour: number,
    private readonly minIntervalMs: number,
  ) {}

  static of(config: MindConfig): CallLog {
    return new CallLog(config.max_calls_per_hour, config.min_interval_secs * 1000);
  }

  #recent(now: number): number[] {
    this.#calls = this.#calls.filter((at) => now - at < HOUR_MS);
    return this.#calls;
  }

  record(now: number): void {
    this.#recent(now).push(now);
    this.total++;
  }

  lastHour(now: number): number {
    return this.#recent(now).length;
  }

  last(): number | null {
    return this.#calls.at(-1) ?? null;
  }

  /** How long until a call is allowed (0 = now); `Infinity` when calls are capped at 0. */
  waitMs(now: number): number {
    const max = this.maxPerHour;
    if (max === 0) return Number.POSITIVE_INFINITY;
    const calls = this.#recent(now);
    const last = calls.at(-1);
    let wait = last === undefined ? 0 : last + this.minIntervalMs - now;
    if (calls.length >= max) {
      const oldest = calls[calls.length - max] as number;
      wait = Math.max(wait, oldest + HOUR_MS - now);
    }
    return Math.max(wait, 0);
  }
}

/** Her local calendar day (`YYYY-MM-DD`) and hour at `now`. */
export function localDay(now: number, offsetMinutes: number): { day: string; hour: number } {
  const d = new Date(now + offsetMinutes * MINUTE_MS);
  return { day: d.toISOString().slice(0, 10), hour: d.getUTCHours() };
}
