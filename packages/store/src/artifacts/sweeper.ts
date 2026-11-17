// When the artifact store's sweep runs (`store.ts`: expiry, purge, unused blobs, stray files).
// Once a day. The time of the last run is kept in memory only: after a restart the first run comes
// `firstMs` after the start, which costs nothing, because the sweep is safe to run at any time and
// to run again.
//
// The owner of the store's maintenance loop (the `facts` module, beside the event log's
// compaction) calls `tick()` every few minutes; `tick` decides by the clock it is given.

import type { Clock } from "@miyoria/types";
import type { SweepResult } from "./store.js";

const DAY_MS = 86_400_000;

/** What the schedule runs: the artifact store, or a stand-in. */
export interface Sweepable {
  sweep(): Promise<SweepResult>;
}

export interface SweepScheduleOptions {
  /** Time between two runs. Default 24 hours. */
  everyMs?: number;
  /** Time from the start to the first run. Default one minute (never more than `everyMs`). */
  firstMs?: number;
}

/** Runs the sweep when one is due. */
export class ArtifactSweepSchedule {
  readonly everyMs: number;
  readonly firstMs: number;
  readonly #store: Sweepable;
  readonly #clock: Clock;
  readonly #startedAt: number;
  #lastAt: number | null = null;

  constructor(store: Sweepable, clock: Clock, options: SweepScheduleOptions = {}) {
    this.#store = store;
    this.#clock = clock;
    this.everyMs = Math.max(1, options.everyMs ?? DAY_MS);
    this.firstMs = Math.min(Math.max(0, options.firstMs ?? 60_000), this.everyMs);
    this.#startedAt = clock.now();
  }

  /** When the next run is due (epoch ms). */
  get dueAt(): number {
    return this.#lastAt === null ? this.#startedAt + this.firstMs : this.#lastAt + this.everyMs;
  }

  /** How often `tick` is worth calling. */
  get checkMs(): number {
    return Math.max(1, Math.min(600_000, this.everyMs, Math.max(this.firstMs, 1)));
  }

  /**
   * Runs the sweep if one is due now; `null` when it is not. A sweep that throws still counts as
   * this day's run (the next one is a day later), and the error goes to the caller.
   */
  async tick(): Promise<SweepResult | null> {
    const now = this.#clock.now();
    if (now < this.dueAt) return null;
    this.#lastAt = now;
    return this.#store.sweep();
  }
}
