// What keeps her sharing within bounds, whatever the model decides: posts and rounds a day, the
// gap between posts, quiet hours and pauses. Pure, so all of it is tested with plain timestamps.
// Days and quiet hours are in the local time of the machine running Core.

import { z } from "zod";
import type { ShareConfig } from "./config.js";

export type Pause = "login" | "no_posts" | null;

const LimitStateSchema = z.object({
  day: z.string(),
  posts: z.number().int().nonnegative(),
  rounds: z.number().int().nonnegative(),
  last_post_ms: z.number().nullable(),
  last_round_ms: z.number().nullable().default(null),
  pause: z.enum(["login", "no_posts"]).nullable(),
  empty_rounds: z.number().int().nonnegative(),
});
export type LimitState = z.output<typeof LimitStateSchema>;

/** Rounds in a row without a post to read before something is wrong. */
const EMPTY_ROUNDS = 3;
const MINUTE_MS = 60_000;

function localDay(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

function minutes(hhmm: string): number {
  return Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
}

export class Limits {
  readonly #config: ShareConfig;
  #state: LimitState;

  constructor(config: ShareConfig, state?: unknown) {
    this.#config = config;
    const stored = LimitStateSchema.safeParse(state);
    this.#state = stored.success
      ? stored.data
      : {
          day: "",
          posts: 0,
          rounds: 0,
          last_post_ms: null,
          last_round_ms: null,
          pause: null,
          empty_rounds: 0,
        };
  }

  get paused(): Pause {
    return this.#state.pause;
  }

  quiet(nowMs: number): boolean {
    const range = this.#config.quiet_hours;
    if (range === "") return false;
    const d = new Date(nowMs);
    const now = d.getHours() * 60 + d.getMinutes();
    const [from, to] = range.split("-").map(minutes) as [number, number];
    return from <= to ? now >= from && now < to : now >= from || now < to;
  }

  canPost(nowMs: number): boolean {
    this.#roll(nowMs);
    const s = this.#state;
    const gap = this.#config.min_gap_mins * MINUTE_MS;
    return (
      !this.quiet(nowMs) &&
      s.posts < this.#config.max_per_day &&
      (s.last_post_ms === null || nowMs - s.last_post_ms >= gap)
    );
  }

  canBrowse(nowMs: number): boolean {
    const last = this.#state.last_round_ms;
    const gap = this.#config.browse_gap_mins * MINUTE_MS;
    return (
      this.canPost(nowMs) &&
      this.#state.pause === null &&
      this.#state.rounds < this.#config.browse_per_day &&
      (last === null || nowMs - last >= gap)
    );
  }

  noteRound(nowMs: number): void {
    this.#roll(nowMs);
    this.#state.rounds++;
    this.#state.last_round_ms = nowMs;
  }

  notePost(nowMs: number): void {
    this.#roll(nowMs);
    this.#state.posts++;
    this.#state.last_post_ms = nowMs;
  }

  /** A round found nothing to read; `true` when that makes three in a row. */
  noteEmpty(): boolean {
    this.#state.empty_rounds++;
    return this.#state.empty_rounds >= EMPTY_ROUNDS;
  }

  noteFound(): void {
    this.#state.empty_rounds = 0;
  }

  /** `true` only when this starts the pause. */
  pause(why: Exclude<Pause, null>): boolean {
    if (this.#state.pause !== null) return false;
    this.#state.pause = why;
    return true;
  }

  resume(): void {
    this.#state.pause = null;
    this.#state.empty_rounds = 0;
  }

  snapshot(): LimitState {
    return { ...this.#state };
  }

  #roll(nowMs: number): void {
    const day = localDay(nowMs);
    if (this.#state.day === day) return;
    this.#state = { ...this.#state, day, posts: 0, rounds: 0 };
  }
}
