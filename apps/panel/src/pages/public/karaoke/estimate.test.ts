// The browser's estimate against the official score on the same singing. A synthetic voice (a
// harmonic tone following a sung curve, with breath noise and jitter) goes through the real pitch
// worklet (`pitch.worklet.ts`, McLeod via pitchy) into a `Take`, as on the singing screen; the same
// curve, clean at 50 Hz, stands in for what RMVPE reads off the room's stream, scored by
// `StreamScore` as Core's board does. Both are scored with the same latency and reference.

import { beforeAll, describe, expect, it } from "vitest";
import {
  asSubmitted,
  cleanTrack,
  type PitchTrack,
  type ScoreInput,
  type ScoreResult,
  StreamScore,
} from "@miyoria/play/karaoke/score";
import { humanSinger, rng, type SynthSong, synthSong } from "../../../../../../packages/play/karaoke/src/synth";
import { noiseFloor } from "./latency";
import type { Detection } from "./pitch";
import { finishTake, Take } from "./take";

const SR = 48_000;

// ---- the worklet, run outside a browser --------------------------------------------------------

interface FakePort {
  onmessage: ((e: { data: unknown }) => void) | null;
  postMessage(d: unknown): void;
  out: Detection[];
}
type Processor = { process(inputs: Float32Array[][]): boolean; readonly port: FakePort };
let Worklet: (new () => Processor) | null = null;
const scope = globalThis as unknown as Record<string, unknown>;

beforeAll(async () => {
  scope.sampleRate = SR;
  scope.currentFrame = 0;
  scope.AudioWorkletProcessor = class {
    readonly port: FakePort = {
      onmessage: null,
      out: [],
      postMessage(d: unknown) {
        this.out.push(d as Detection);
      },
    };
  };
  scope.registerProcessor = (_name: string, ctor: new () => Processor) => {
    Worklet = ctor;
  };
  await import("./pitch.worklet");
});

/** `samples` through the pitch worklet in 128-sample blocks, the context starting at 0. */
function detect(samples: Float32Array, floor: number | null): Detection[] {
  const node = new (Worklet as new () => Processor)();
  if (floor !== null) node.port.onmessage?.({ data: { floor } });
  for (let at = 0; at + 128 <= samples.length; at += 128) {
    scope.currentFrame = at;
    node.process([[samples.subarray(at, at + 128)]]);
  }
  return node.port.out;
}

// ---- a voice -----------------------------------------------------------------------------------

interface VoiceOptions {
  /** Level of the voice (about its peak). */
  level?: number;
  /** Harmonics to breath noise, dB. */
  hnr?: number;
  /** The fundamental's share against a natural one (a low voice through a small microphone). */
  h1?: number;
}

/** RMS of the harmonic part, and of the unit breath noise below (for the HNR). */
const HARMONIC_RMS = 0.4244;
const NOISE_RMS = 0.2425;

/** A voice singing `track` (song time as captured), `seconds` long, at `SR`. */
function voice(track: PitchTrack, seconds: number, seed: number, o: VoiceOptions = {}): Float32Array {
  const r = rng(seed);
  const out = new Float32Array(Math.ceil(seconds * SR));
  const level = o.level ?? 0.05;
  const breath = (HARMONIC_RMS / NOISE_RMS) * 10 ** (-(o.hnr ?? 30) / 20);
  const h1 = o.h1 ?? 1;
  let phase = 0;
  let env = 0;
  let noise = 0;
  let jitter = 0;
  for (let i = 0; i < out.length; i++) {
    const j = (i / SR) * track.hz;
    const k = Math.floor(j);
    const a = track.midi[k];
    const b = track.midi[k + 1];
    const m = a === null || a === undefined ? null : b === null || b === undefined ? a : a + (b - a) * (j - k);
    env += ((m === null ? 0 : 1) - env) / (0.02 * SR);
    if (m !== null) {
      if (i % 480 === 0) jitter = (r() * 2 - 1) * 0.004;
      phase += (2 * Math.PI * 440 * 2 ** ((m - 69) / 12) * (1 + jitter)) / SR;
    }
    let v = h1 * Math.sin(phase);
    for (let h = 2; h <= 10; h++) v += Math.sin(h * phase) / h ** 1.1;
    noise += 0.3 * (r() * 2 - 1 - noise);
    out[i] = level * env * (v / 2 + breath * noise) + 0.0005 * (r() * 2 - 1);
  }
  return out;
}

// ---- the two paths -----------------------------------------------------------------------------

const song: SynthSong = synthSong(4, 6);
const SONG_S = song.reference.midi.length / song.reference.hz;
const LATENCY = 120;

function input(calibrated: boolean): Omit<ScoreInput, "sung"> {
  return {
    reference: song.reference,
    latency_ms: LATENCY,
    calibrated,
    phrases: song.lines,
    tuning: { tolerance_cents: 50 },
  };
}

/** A singer 120 ms late (the device), loose by `wander` cents, `transpose` semitones off. */
function singing(wander = 45, transpose = 0): PitchTrack {
  return humanSinger(song, { seed: 9, lateMs: LATENCY, hz: 100, wanderCents: wander, transpose });
}

/** The official side: the curve as RMVPE gives it, scored the way Core's board scores a stream. */
function official(truth: PitchTrack, calibrated = false, untilS = SONG_S + 1): StreamScore {
  const s = new StreamScore(input(calibrated), SONG_S + 30);
  s.put(0, asSubmitted({ hz: truth.hz, midi: truth.midi.slice(0, Math.round(untilS * truth.hz)) }));
  return s;
}

interface Browser {
  take: Take;
  dets: Detection[];
}

/**
 * The browser's side, as the singing screen runs it: the room heard while the song loads (`talk`:
 * the singer talking that share of it) sets the floor, then the detections go to a `Take`.
 */
function browser(truth: PitchTrack, o: VoiceOptions & { talk?: number; calibrated?: boolean } = {}): Browser {
  const words: PitchTrack = {
    hz: 100,
    midi: Array.from({ length: 300 }, (_, i) => ((o.talk ?? 0) * 100 > i % 100 ? 50 + (i % 7) : null)),
  };
  const loading = detect(voice(words, 3, 5, { ...o, level: 0.05 }), null);
  const floor = noiseFloor(loading.map((d) => d.level));
  const dets = detect(voice(truth, SONG_S, 3, o), floor);
  const take = new Take(song.reference, {
    tolerance_cents: 50,
    latency_ms: LATENCY,
    calibrated: o.calibrated ?? false,
    phrases: song.lines,
  });
  return { take, dets };
}

function pushUntil(b: Browser, untilS: number, alter?: (d: Detection) => number | null): void {
  for (const d of b.dets) if (d.t < untilS) b.take.push(d.t, alter ? alter(d) : d.midi);
}

async function provisional(b: Browser, calibrated = false): Promise<ScoreResult> {
  const done = await finishTake(b.take, { calibrated, phrases: song.lines, tolerance_cents: 50, browser: "" });
  return done.provisional as ScoreResult;
}

describe("the browser's estimate and the official score, on the same singing", () => {
  it("shows the board's measure while singing: the score of the song so far", { timeout: 60_000 }, () => {
    // A wide vibrato: its pitch part alone reads far above the four parts together.
    let held = 0;
    const base = singing(45);
    const truth: PitchTrack = {
      hz: 100,
      midi: base.midi.map((m, i) => {
        held = m === null ? 0 : held + 1;
        return m === null || held < 25 ? m : m + Math.sin((2 * Math.PI * 5.5 * i) / 100);
      }),
    };
    const b = browser(truth, { hnr: 20 });
    const halfway = SONG_S / 2;
    pushUntil(b, halfway);
    // What the board computes from the same frames (the estimate's `StreamScore`), exactly.
    const sameFrames = new StreamScore(input(false), SONG_S + 30);
    sameFrames.put(0, asSubmitted(cleanTrack(b.take.running.track)));
    expect(b.take.running.score).toBe(Math.round(sameFrames.score().total));
    // And near the official score of the voice so far (the old number, the pitch part on a scale of
    // 100, read 11 above it here). A little above: the detector's 43 ms window reads a wide vibrato
    // narrower than the ideal curve standing in for RMVPE.
    const board = official(truth, false, halfway).score().total;
    expect(Math.abs(b.take.running.score - board)).toBeLessThanOrEqual(7);
  });

  it("keeps a low voice with a weak fundamental (its clarity hovers under 0.9)", { timeout: 60_000 }, async () => {
    const truth = singing(45, -12);
    const b = browser(truth, { hnr: 15, h1: 0.1 });
    pushUntil(b, SONG_S + 1);
    const est = await provisional(b);
    expect(est.facts.coverage).toBeGreaterThan(0.9);
    expect(Math.abs(est.total - official(truth).final().total)).toBeLessThanOrEqual(4);
  });

  it("keeps the singing when the singer talked while the song loaded", { timeout: 60_000 }, async () => {
    const truth = singing(45);
    const b = browser(truth, { hnr: 15, talk: 0.3 });
    pushUntil(b, SONG_S + 1);
    const est = await provisional(b);
    expect(est.facts.coverage).toBeGreaterThan(0.9);
    expect(Math.abs(est.total - official(truth).final().total)).toBeLessThanOrEqual(4);
  });

  it("folds the detector's octave slips back, as the worker folds RMVPE's", { timeout: 60_000 }, async () => {
    const truth = singing(45);
    const b = browser(truth, { hnr: 20 });
    // Bursts of three to six windows an octave up, starting on one voiced window in 48.
    const r = rng(21);
    let left = 0;
    pushUntil(b, SONG_S + 1, (d) => {
      if (d.midi === null) return null;
      if (left === 0 && r() < 1 / 48) left = 3 + Math.floor(r() * 4);
      if (left === 0) return d.midi;
      left--;
      return d.midi + 12;
    });
    const est = await provisional(b);
    expect(Math.abs(est.total - official(truth).final().total)).toBeLessThanOrEqual(4);
  });

  it("takes the device's latency off once on both sides: the rhythm agrees", { timeout: 60_000 }, async () => {
    const truth = singing(15);
    const b = browser(truth, { hnr: 20, calibrated: true });
    pushUntil(b, SONG_S + 1);
    const est = await provisional(b, true);
    const off = official(truth, true).final();
    expect(est.rhythm.measured && off.rhythm.measured).toBe(true);
    expect(Math.abs((est.rhythm.offset_ms ?? 999) - (off.rhythm.offset_ms ?? -999))).toBeLessThanOrEqual(20);
    expect(Math.abs(off.rhythm.offset_ms ?? 999)).toBeLessThanOrEqual(40);
  });
});
