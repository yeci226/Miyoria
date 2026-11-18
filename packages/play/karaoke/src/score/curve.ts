// What the scoring reads off the reference curve itself: voiced runs, the moments a voice starts,
// the stretches held on one pitch, and phrases when there are no lyric lines. None of it uses the
// notes the worker cut: the score compares curves (owner 2026-11-17), and these stretches are only
// where stability, long tones and onsets are looked for.

import type { PitchFrames } from "./track.js";

/** A stretch of frames, `[start, end)`. */
export interface Span {
  start: number;
  end: number;
}

export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1
    ? (sorted[mid] as number)
    : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

export function mean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  let s = 0;
  for (const v of values) s += v;
  return s / values.length;
}

export function std(values: readonly number[]): number {
  if (values.length < 2) return 0;
  const m = mean(values);
  let s = 0;
  for (const v of values) s += (v - m) * (v - m);
  return Math.sqrt(s / values.length);
}

/** Linear from 1 at `good` to 0 at `bad` (either way round), clamped. */
export function ramp(x: number, good: number, bad: number): number {
  if (good === bad) return x <= good ? 1 : 0;
  return Math.min(1, Math.max(0, (bad - x) / (bad - good)));
}

/** Runs of voiced frames. */
export function voicedRuns(frames: PitchFrames): Span[] {
  const out: Span[] = [];
  let start = -1;
  for (let i = 0; i <= frames.length; i++) {
    const voiced = i < frames.length && frames[i] !== null && frames[i] !== undefined;
    if (voiced && start < 0) start = i;
    if (!voiced && start >= 0) {
      out.push({ start, end: i });
      start = -1;
    }
  }
  return out;
}

/** The centred moving average of `values` over `window` (odd) values, shorter at the edges. */
export function smooth(values: readonly number[], window: number): number[] {
  const half = window >> 1;
  const out: number[] = new Array(values.length);
  for (let i = 0; i < values.length; i++) {
    const from = Math.max(0, i - half);
    const to = Math.min(values.length, i + half + 1);
    let s = 0;
    for (let j = from; j < to; j++) s += values[j] as number;
    out[i] = s / (to - from);
  }
  return out;
}

/**
 * Where a voice starts: a voiced frame after at least `gap` unvoiced ones (or at the very start),
 * whose run lasts at least `minRun` frames.
 */
export function onsets(frames: PitchFrames, gap: number, minRun: number): number[] {
  const out: number[] = [];
  let lastEnd: number | null = null;
  for (const run of voicedRuns(frames)) {
    const lead = lastEnd === null ? Number.POSITIVE_INFINITY : run.start - lastEnd;
    if (lead >= gap && run.end - run.start >= minRun) out.push(run.start);
    lastEnd = run.end;
  }
  return out;
}

/**
 * Stretches the reference holds on one pitch: within each voiced run, the curve smoothed over
 * `window` frames (so vibrato does not break it) stays within `spread` semitones of the stretch's
 * running mean. Only stretches of `minFrames` or more.
 */
export function heldSpans(
  frames: PitchFrames,
  minFrames: number,
  spread = 0.6,
  window = 9,
): { span: Span; midi: number }[] {
  const out: { span: Span; midi: number }[] = [];
  for (const run of voicedRuns(frames)) {
    const values = frames.slice(run.start, run.end) as number[];
    const smoothed = smooth(values, window);
    let start = 0;
    let sum = 0;
    let count = 0;
    const close = (end: number) => {
      if (end - start >= minFrames) {
        const midi = median(values.slice(start, end)) ?? 0;
        out.push({ span: { start: run.start + start, end: run.start + end }, midi });
      }
    };
    for (let i = 0; i < smoothed.length; i++) {
      const v = smoothed[i] as number;
      if (count > 0 && Math.abs(v - sum / count) > spread) {
        close(i);
        start = i;
        sum = 0;
        count = 0;
      }
      sum += v;
      count++;
    }
    close(smoothed.length);
  }
  return out;
}

/**
 * Phrases from the curve when there are no lyric lines: voiced runs joined across gaps shorter
 * than `gap` frames, then phrases shorter than `minLen` frames joined to the one after (the last
 * to the one before).
 */
export function curvePhrases(frames: PitchFrames, gap: number, minLen: number): Span[] {
  const joined: Span[] = [];
  for (const run of voicedRuns(frames)) {
    const last = joined[joined.length - 1];
    if (last !== undefined && run.start - last.end < gap) last.end = run.end;
    else joined.push({ ...run });
  }
  const out: Span[] = [];
  let pending: Span | null = null;
  for (const p of joined) {
    const cur: Span = pending === null ? { ...p } : { start: pending.start, end: p.end };
    if (cur.end - cur.start < minLen) pending = cur;
    else {
      out.push(cur);
      pending = null;
    }
  }
  if (pending !== null) {
    const last = out[out.length - 1];
    if (last !== undefined) last.end = pending.end;
    else out.push(pending);
  }
  return out;
}
