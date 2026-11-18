// Pitch detection behind one interface, so the detector that feeds the screen and the one that
// feeds the score can be told apart later (owner 2026-11-17: a fast one for the screen, an
// accurate one for the score). This milestone has one: McLeod's method (`pitchy`), run in the
// AudioWorklet every 10 ms over a 2048-sample window. No DOM here: the worklet imports this file.

import { PitchDetector as Mpm } from "pitchy";

/** One window's answer: the frequency (0 when none) and how clear it was, 0..1. */
export interface PitchEstimate {
  hz: number;
  clarity: number;
}

export interface PitchDetector {
  /** For the owner's records (`mcleod`). */
  readonly name: string;
  /** Samples per window. */
  readonly size: number;
  detect(frame: Float32Array, sampleRate: number): PitchEstimate;
}

/** McLeod's method, `size` samples a window. */
export function mcleodDetector(size = 2048): PitchDetector {
  // pitchy's defaults: no volume floor (the voiced check is ours: clarity and the room's level).
  const mpm = Mpm.forFloat32Array(size);
  return {
    name: "mcleod",
    size,
    detect(frame, sampleRate) {
      const [hz, clarity] = mpm.findPitch(frame, sampleRate);
      return { hz: Number.isFinite(hz) ? hz : 0, clarity: Number.isFinite(clarity) ? clarity : 0 };
    },
  };
}

/** What the worklet posts every hop. Times are the audio context's, in seconds. */
export interface Detection {
  /** The middle of the analysed window. */
  t: number;
  /** MIDI with a fraction when voiced, else `null`. */
  midi: number | null;
  clarity: number;
  /** RMS of the window. */
  rms: number;
  /** RMS of the newest hop alone, at `levelT` (the middle of that hop): for onsets. */
  level: number;
  levelT: number;
}

/** Clarity a voiced window needs. */
export const CLARITY_MIN = 0.9;
/** A voice must be this much above the room's level (6 dB). */
export const FLOOR_RATIO = 2;
/** The range a singing voice is looked for in. */
export const HZ_MIN = 60;
export const HZ_MAX = 1400;

export function hzToMidi(hz: number): number {
  return 69 + 12 * Math.log2(hz / 440);
}

export function rms(frame: ArrayLike<number>, from = 0, to = frame.length): number {
  let sum = 0;
  for (let i = from; i < to; i++) {
    const v = frame[i] as number;
    sum += v * v;
  }
  return to > from ? Math.sqrt(sum / (to - from)) : 0;
}

/** The window's note, or `null` when it is not a clear voice above the room. */
export function voicedMidi(estimate: PitchEstimate, level: number, floor: number): number | null {
  if (estimate.clarity < CLARITY_MIN) return null;
  if (level <= floor * FLOOR_RATIO) return null;
  if (estimate.hz < HZ_MIN || estimate.hz > HZ_MAX) return null;
  return hzToMidi(estimate.hz);
}
