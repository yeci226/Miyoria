// Synthetic songs and singers for the score's tests and the offline end-to-end check: a lead
// vocal's curve built from phrases of notes (consonant gaps, rests, vibrato on the long notes),
// and singers made from it. A seeded generator, so every run is the same. Test support only
// (`testing.ts`); nothing the module runs imports it.

import type { PitchTrack, ReferenceCurve } from "./score/index.js";

/** Mulberry32: a small seeded generator in [0, 1). */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Roughly normal (sum of uniforms). */
function gauss(r: () => number): number {
  return r() + r() + r() + r() + r() + r() - 3;
}

export interface SynthNote {
  start: number;
  end: number;
  midi: number;
}

export interface SynthSong {
  reference: ReferenceCurve;
  notes: SynthNote[];
  /** One per phrase, like lyric lines. */
  lines: { start: number; end: number; text: string }[];
}

const SCALE = [60, 62, 64, 65, 67, 69, 71, 72, 74];

/** A song of `phrases` phrases at 50 Hz, about five seconds each. */
export function synthSong(seed = 1, phrases = 8): SynthSong {
  const r = rng(seed);
  const hz = 50;
  const notes: SynthNote[] = [];
  const lines: SynthSong["lines"] = [];
  let t = 1.0;
  for (let p = 0; p < phrases; p++) {
    const lineStart = t;
    const count = 5 + Math.floor(r() * 4);
    let degree = 2 + Math.floor(r() * 4);
    for (let n = 0; n < count; n++) {
      const long = n === count - 1 || r() < 0.2;
      const dur = long ? 0.9 + r() * 0.8 : 0.25 + r() * 0.35;
      degree = Math.min(SCALE.length - 1, Math.max(0, degree + Math.floor(r() * 5) - 2));
      notes.push({ start: t, end: t + dur, midi: SCALE[degree] as number });
      // A consonant before the next note half the time (60–80 ms), else legato.
      t += dur + (r() < 0.5 ? 0.06 + r() * 0.02 : 0);
    }
    lines.push({ start: lineStart, end: t, text: `第 ${p + 1} 句` });
    t += 0.8 + r() * 0.4;
  }
  const frames = Math.ceil((t + 1) * hz);
  const midi: (number | null)[] = new Array(frames).fill(null);
  for (const note of notes) {
    for (let i = Math.round(note.start * hz); i < Math.round(note.end * hz); i++) {
      const since = i / hz - note.start;
      // The original's own vibrato on the long notes, after 0.3 s.
      const vib =
        note.end - note.start >= 0.8 && since > 0.3 ? 0.3 * Math.sin(2 * Math.PI * 5.5 * since) : 0;
      midi[i] = note.midi + vib;
    }
  }
  return { reference: { hz, start: 0, midi }, notes, lines };
}

/** The reference's value at `t` seconds (nearest frame). */
function refAt(ref: ReferenceCurve, t: number): number | null {
  const i = Math.round((t - ref.start) * ref.hz);
  return ref.midi[i] ?? null;
}

export interface SingerOptions {
  seed?: number;
  /** Detection rate. */
  hz?: number;
  /** Added to every voiced frame (12 = an octave up). */
  transpose?: number;
  /** The capture is this late (output + input latency of a device). */
  lateMs?: number;
  /** Random timing of each phrase, ± this. */
  jitterMs?: number;
  /** A slow wander of the pitch, ± this many cents, plus frame noise of a fifth of it. */
  wanderCents?: number;
  /** Silent from this phrase on (`lines` index), for partial singing. */
  stopAfter?: number;
}

/** A singer who follows the reference like a good human: on pitch, a little loose. */
export function humanSinger(song: SynthSong, options: SingerOptions = {}): PitchTrack {
  const r = rng(options.seed ?? 7);
  const hz = options.hz ?? 100;
  const late = (options.lateMs ?? 0) / 1000;
  const jitter = (options.jitterMs ?? 25) / 1000;
  const wander = (options.wanderCents ?? 15) / 100;
  const shifts = song.lines.map(() => (r() * 2 - 1) * jitter);
  const phase = r() * 6;
  const end = song.reference.midi.length / song.reference.hz;
  const midi: (number | null)[] = [];
  for (let j = 0; j < Math.ceil(end * hz); j++) {
    const t = j / hz - late;
    let line = song.lines.findIndex((l) => t >= l.start - 0.3 && t < l.end + 0.3);
    if (line < 0) line = 0;
    if (options.stopAfter !== undefined && line >= options.stopAfter) {
      midi.push(null);
      continue;
    }
    const v = refAt(song.reference, t - (shifts[line] ?? 0));
    if (v === null) {
      midi.push(null);
      continue;
    }
    const drift = wander * Math.sin(2 * Math.PI * 0.7 * t + phase) + (wander / 5) * gauss(r);
    midi.push(v + drift + (options.transpose ?? 0));
  }
  return { hz, midi };
}

/** The reference itself at `hz`, unchanged: what a program would make from it. */
export function copySinger(song: SynthSong, hz = 50): PitchTrack {
  const end = song.reference.midi.length / song.reference.hz;
  const midi: (number | null)[] = [];
  for (let j = 0; j < Math.ceil(end * hz); j++) midi.push(refAt(song.reference, j / hz));
  return { hz, midi };
}

/** Random pitches in a singing range; `voicing`: the share of frames that are voiced. */
export function noiseSinger(song: SynthSong, seed = 3, voicing = 1, hz = 100): PitchTrack {
  const r = rng(seed);
  const end = song.reference.midi.length / song.reference.hz;
  const midi: (number | null)[] = [];
  let voiced = true;
  for (let j = 0; j < Math.ceil(end * hz); j++) {
    // Voicing in runs of about a tenth of a second.
    if (j % 10 === 0) voiced = r() < voicing;
    midi.push(voiced ? 48 + r() * 24 : null);
  }
  return { hz, midi };
}

export function silentSinger(song: SynthSong, hz = 100): PitchTrack {
  const end = song.reference.midi.length / song.reference.hz;
  return { hz, midi: new Array(Math.ceil(end * hz)).fill(null) };
}
