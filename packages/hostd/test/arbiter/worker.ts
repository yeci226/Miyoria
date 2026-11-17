// What stays in the song worker after the move (gpu.py: `typical_peak`, the per-stage half of
// `Profile`, `StepMeter`, the work part of `silence_estimate`), written again here so the scenario
// harness can play the worker. These are not hostd code; the table test checks them against the
// same recorded rows that keep guarding the Python.

import { CPU_STAGES, median, pyRound } from "../../src/arbiter/index.js";

export const RATE_PRIORS: Readonly<Record<string, number>> = {
  separate: 0.05,
  lead: 0.25,
  convert: 0.3,
};
export const PEAKS_KEPT = 5;

/** The highest of the recent peaks that is no more than twice their (upper) median. */
export function typicalPeak(peaks: readonly number[]): number {
  const ordered = [...peaks].sort((a, b) => a - b);
  const mid = ordered[Math.floor(ordered.length / 2)] as number;
  return Math.max(...ordered.filter((p) => p <= 2 * mid));
}

interface StageRecord {
  peaks_mb?: number[];
  step_s?: number;
  samples?: number;
  rate?: number;
}

/**
 * Per card (`name/total_mb`, the key hostd reports), per stage: peaks, the normal step time, the
 * rate. `use` picks the card the next reads and notes are about.
 */
export class StageProfile {
  readonly cards = new Map<string, Map<string, StageRecord>>();
  key = "unknown";

  use(key: string): this {
    this.key = key;
    return this;
  }

  get stages(): Map<string, StageRecord> {
    if (!this.cards.has(this.key)) this.cards.set(this.key, new Map());
    return this.cards.get(this.key) as Map<string, StageRecord>;
  }

  #stage(stage: string): StageRecord {
    if (!this.stages.has(stage)) this.stages.set(stage, {});
    return this.stages.get(stage) as StageRecord;
  }

  need(stage: string, priorMb: number): number {
    const peaks = this.stages.get(stage)?.peaks_mb ?? [];
    return peaks.length > 0 ? typicalPeak(peaks) : priorMb;
  }

  step(stage: string): number | null {
    return this.stages.get(stage)?.step_s ?? null;
  }

  rate(stage: string): number {
    const r = this.stages.get(stage)?.rate;
    return r ? r : (RATE_PRIORS[stage] ?? 0.3);
  }

  samples(stage: string): number {
    return this.stages.get(stage)?.samples ?? 0;
  }

  /** `fn` on every card this profile knows, by card key (what `gpu.acquire` and `gpu.renew` carry). */
  byCard(fn: (p: this) => number | null): Record<string, number> {
    const here = this.key;
    const out: Record<string, number> = {};
    for (const key of [...this.cards.keys()].sort()) {
      this.key = key;
      const v = fn(this);
      if (v !== null) out[key] = v;
    }
    this.key = here;
    return out;
  }

  /** The stage's learned need per card (only cards with a measured peak). */
  needByCard(stage: string): Record<string, number> {
    return this.byCard((p) => {
      const peaks = p.stages.get(stage)?.peaks_mb ?? [];
      return peaks.length > 0 ? typicalPeak(peaks) : null;
    });
  }

  normalByCard(stage: string): Record<string, number> {
    return this.byCard((p) => p.step(stage));
  }

  /** The work estimate per card with that card's rates, and with the priors of a card it knows nothing of. */
  workByCard(
    audioS: number | null,
    converted: number,
    stage: string,
  ): { prior: number | null; byCard: Record<string, number> } {
    const prior = workEstimate(audioS, converted, stage, new StageProfile());
    return {
      prior,
      byCard: prior === null ? {} : this.byCard((p) => workEstimate(audioS, converted, stage, p)),
    };
  }

  notePeak(stage: string, mb: number): void {
    const s = this.#stage(stage);
    const peaks = s.peaks_mb ?? [];
    s.peaks_mb = [...peaks.slice(Math.max(0, peaks.length - (PEAKS_KEPT - 1))), Math.trunc(mb)];
  }

  /** A clean run's median: it sinks at once and rises at most 20 %. */
  noteStep(stage: string, seconds: number): void {
    const s = this.#stage(stage);
    const old = s.step_s;
    s.step_s = pyRound(old === undefined ? seconds : Math.min(seconds, old * 1.2), 4);
    s.samples = (s.samples ?? 0) + 1;
  }

  noteRate(stage: string, rate: number): void {
    this.#stage(stage).rate = pyRound(rate, 4);
  }
}

/** The worker's part of `silence_estimate`: the work left, without the reload. */
export function workEstimate(
  audioS: number | null,
  converted: number,
  stage: string,
  p: StageProfile,
): number | null {
  if (!audioS) return null;
  let work = audioS * (1 - converted) * p.rate("convert");
  if (CPU_STAGES.includes(stage)) work += audioS * p.rate(stage);
  return work;
}

/** Time per step, without the time spent giving way to her voice. */
export class StepMeter {
  readonly times: number[] = [];
  recent: number[] = [];
  activeS = 0.0;
  #from: number | null = null;

  step(now: number): void {
    if (this.#from !== null) {
      const dt = now - this.#from;
      this.times.push(dt);
      this.recent = [...this.recent, dt].slice(-3);
      this.activeS += dt;
      this.#from = null;
    }
  }

  resume(now: number): void {
    this.#from = now;
  }

  restart(): void {
    this.recent = [];
    this.#from = null;
  }

  median(): number | null {
    return this.times.length > 0 ? median(this.times) : null;
  }
}
