// The browser's detections cleaned the way the song worker cleans RMVPE's (`workers/sing/pitch.py`
// `clean_f0`), so the estimate and the official score read the same singing alike. RMVPE's curve is
// folded back where it jumps an octave for a moment and median-filtered against spikes before it is
// scored; McLeod's detections had neither, so every octave slip cost the frame (and, on a held note,
// the stability of the whole note: an octave is 1,200 cents of wobble). Not done here: the worker's
// bridging of short unvoiced gaps (the browser's track keeps a gap a gap).

import type { PitchFrames, PitchTrack } from "./track.js";

/** The running median the octave is judged against spans this much of voiced frames. */
const OCTAVE_MS = 500;
/** A frame this close (semitones) to a whole number of octaves off that median is folded back. */
const OCTAVE_NEAR = 3;
/** Spikes: a median of this many frames inside each voiced run at least as long. */
const SPIKE_FRAMES = 5;

/** The running median of `x` over `window` values (odd), the edges padded with the end values. */
function runningMedian(x: readonly number[], window: number): number[] {
  const w = Math.max(1, window | 1);
  if (x.length === 0 || w === 1) return [...x];
  const half = w >> 1;
  const at = (i: number) => x[Math.min(x.length - 1, Math.max(0, i))] as number;
  // A sorted copy of the window, moved one value at a time.
  const sorted: number[] = [];
  const place = (v: number) => {
    let lo = 0;
    let hi = sorted.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((sorted[mid] as number) < v) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  for (let i = -half; i <= half; i++) {
    const v = at(i);
    sorted.splice(place(v), 0, v);
  }
  const out = new Array<number>(x.length);
  for (let i = 0; i < x.length; i++) {
    out[i] = sorted[half] as number;
    if (i + 1 < x.length) {
      sorted.splice(place(at(i - half)), 1);
      const v = at(i + 1 + half);
      sorted.splice(place(v), 0, v);
    }
  }
  return out;
}

/** `midi` at `hz` with short octave excursions folded back and spikes filtered (`null` stays). */
export function cleanPitch(midi: PitchFrames, hz: number): (number | null)[] {
  const out: (number | null)[] = midi.map((m) =>
    m === null || m === undefined || !Number.isFinite(m) ? null : m,
  );
  const idx: number[] = [];
  for (let i = 0; i < out.length; i++) if (out[i] !== null) idx.push(i);
  if (idx.length < 3) return out;

  // Octave errors: against the running median of the voiced frames around each one. A real leap
  // that holds longer than half the window becomes the median and is kept.
  const seq = idx.map((i) => out[i] as number);
  const ref = runningMedian(seq, Math.round(OCTAVE_MS / (1000 / hz)));
  idx.forEach((i, k) => {
    const diff = (seq[k] as number) - (ref[k] as number);
    const octaves = Math.round(diff / 12);
    if (octaves !== 0 && Math.abs(diff - 12 * octaves) < OCTAVE_NEAR) {
      out[i] = (seq[k] as number) - 12 * octaves;
    }
  });

  // Spikes, inside each voiced run.
  let start = 0;
  while (start < out.length) {
    if (out[start] === null) {
      start++;
      continue;
    }
    let end = start;
    while (end < out.length && out[end] !== null) end++;
    if (end - start >= SPIKE_FRAMES) {
      const run = runningMedian(out.slice(start, end) as number[], SPIKE_FRAMES);
      for (let i = start; i < end; i++) out[i] = run[i - start] as number;
    }
    start = end;
  }
  return out;
}

/** `track` cleaned (`cleanPitch`), at its own rate. */
export function cleanTrack(track: PitchTrack): PitchTrack {
  return { hz: track.hz, midi: cleanPitch(track.midi, track.hz) };
}
