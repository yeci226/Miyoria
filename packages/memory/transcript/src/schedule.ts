// When the transcripts are swept (`TranscriptStore.sweep`): once every `everyMs`, the first time
// `firstMs` after the schedule was made, like the artifact store's sweep.

import type { TranscriptStore } from "./store.js";
import type { SweepResult, TranscriptRetention } from "./types.js";

const HOUR_MS = 3_600_000;

export interface SweepScheduleOptions {
  /** Time between sweeps. Default 24 hours. */
  everyMs?: number;
  /** Time before the first. Default one minute (at most `everyMs`). */
  firstMs?: number;
  /** What a sweep keeps. */
  retention?: TranscriptRetention;
}

/** Runs the sweep when one is due. */
export class TranscriptSweepSchedule {
  readonly everyMs: number;
  readonly firstMs: number;
  readonly #store: Pick<TranscriptStore, "sweep">;
  readonly #clock: { now(): number };
  readonly #retention: TranscriptRetention;
  readonly #startedAt: number;
  #lastAt: number | null = null;

  constructor(
    store: Pick<TranscriptStore, "sweep">,
    clock: { now(): number },
    options: SweepScheduleOptions = {},
  ) {
    this.#store = store;
    this.#clock = clock;
    this.#retention = options.retention ?? {};
    this.everyMs = Math.max(1, options.everyMs ?? 24 * HOUR_MS);
    this.firstMs = Math.min(Math.max(0, options.firstMs ?? 60_000), this.everyMs);
    this.#startedAt = clock.now();
  }

  /** When the next sweep is due (epoch ms). */
  get dueAt(): number {
    return this.#lastAt === null ? this.#startedAt + this.firstMs : this.#lastAt + this.everyMs;
  }

  /** How often `tick` is worth calling. */
  get checkMs(): number {
    return Math.max(1, Math.min(600_000, this.everyMs, Math.max(this.firstMs, 1)));
  }

  /**
   * Sweeps if one is due now; `null` when it is not. A sweep that throws still counts as this
   * period's run, and the error goes to the caller.
   */
  tick(): SweepResult | null {
    const now = this.#clock.now();
    if (now < this.dueAt) return null;
    this.#lastAt = now;
    return this.#store.sweep(this.#retention);
  }
}
