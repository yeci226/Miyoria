// While singing. `LiveScore`: the pitch part only, as the frames come in, from the same frame credit
// as the full score; cheap enough for every detection (100 a second), and what gives the screen the
// singer's octave. `RunningScore`: the number to show while singing, the same measure as the room's
// board and the result (`scoreSinging` on the song so far, the way `StreamScore` cuts it), on the
// track as it will be sent.
//
// `LiveScore.score` is the pitch part on a scale of 100 (`100 * pitchFraction(hit)`), a different
// number from every other one: it leaves out stability, rhythm and expression, so on the same
// frames it reads anything from 20 points above the board's number to 20 below it.

import { cleanTrack } from "./clean.js";
import { median } from "./curve.js";
import {
  DEFAULT_TUNING,
  frameCredit,
  pitchFraction,
  type ReferenceCurve,
  type ScoreResult,
} from "./score.js";
import { StreamScore, type StreamScoreInput } from "./stream.js";
import { asSubmitted, type PitchTrack, TRACK_HZ, TrackRecorder } from "./track.js";

/** Frames between two estimates of the singer's octave. */
const OCTAVE_EVERY = 25;
/** Offsets kept for that estimate. */
const OCTAVE_KEEP = 250;

export class LiveScore {
  readonly #ref: ReferenceCurve;
  readonly #tolerance: number;
  readonly #latency: number;
  readonly #credit: Float32Array;
  #sum = 0;
  #octave = 0;
  readonly #diffs: number[] = [];
  #pushes = 0;
  /** The furthest reference frame reached, and how many voiced ones up to it. */
  #at = -1;
  #voiced = 0;
  #last: { frame: number; cents: number | null } | null = null;

  constructor(
    reference: ReferenceCurve,
    options: { tolerance_cents?: number; latency_ms?: number },
  ) {
    this.#ref = reference;
    this.#tolerance = options.tolerance_cents ?? DEFAULT_TUNING.tolerance_cents;
    this.#latency = (options.latency_ms ?? 0) / 1000;
    this.#credit = new Float32Array(reference.midi.length);
  }

  /** A detection captured at `t` seconds of the song (before the latency). */
  push(t: number, midi: number | null): void {
    const { hz, start, midi: ref } = this.#ref;
    const i = Math.round((t - this.#latency - start) * hz);
    if (i < 0 || i >= ref.length) return;
    while (this.#at < i) {
      this.#at++;
      if (ref[this.#at] !== null && ref[this.#at] !== undefined) this.#voiced++;
    }
    const r = ref[i];
    if (r === null || r === undefined || midi === null) {
      this.#last = { frame: i, cents: null };
      return;
    }
    this.#diffs.push(midi - r);
    if (this.#diffs.length > OCTAVE_KEEP) this.#diffs.shift();
    if (++this.#pushes % OCTAVE_EVERY === 1) {
      this.#octave = 12 * Math.round((median(this.#diffs) ?? 0) / 12) || 0;
    }
    const cents = (midi - r - this.#octave) * 100;
    const credit = frameCredit(cents, this.#tolerance);
    const before = this.#credit[i] as number;
    if (credit > before) {
      this.#sum += credit - before;
      this.#credit[i] = credit;
    }
    this.#last = { frame: i, cents };
  }

  /** The singer's octave against the original, in semitones (a multiple of 12). */
  get octave(): number {
    return this.#octave;
  }

  /** Pitch share so far, 0..1. */
  get hit(): number {
    return this.#voiced === 0 ? 0 : this.#sum / this.#voiced;
  }

  /** The running number, 0..100. */
  get score(): number {
    return Math.round(100 * pitchFraction(this.hit));
  }

  /** The last detection's offset from the reference, in cents (`null`: silent or a rest). */
  get last(): { frame: number; cents: number | null } | null {
    return this.#last;
  }
}

/** Song seconds between two computations of the running number (Core's board: every 2 s). */
const RUNNING_EVERY_S = 2;

/**
 * The running number: `scoreSinging` on the song so far, on the detections as the browser sends
 * them (100 Hz, cleaned like the worker's curve, at `TRACK_HZ`, a quarter semitone a step). Computed
 * when read, at most once per `RUNNING_EVERY_S` of song (a four-minute song costs about 25 ms).
 */
export class RunningScore {
  readonly #input: StreamScoreInput;
  readonly #recorder = new TrackRecorder(100);
  readonly #every: number;
  #result: ScoreResult | null = null;
  /** Frames (`TRACK_HZ`) the singing had reached when `#result` was computed. */
  #at = -1;

  constructor(input: StreamScoreInput, everyS = RUNNING_EVERY_S) {
    this.#input = input;
    this.#every = Math.max(1, Math.round(everyS * TRACK_HZ));
  }

  /** A detection captured at `t` seconds of the song (before the latency). */
  push(t: number, midi: number | null): void {
    this.#recorder.push(t, midi);
  }

  /** The detections so far, as captured (100 Hz). */
  get track(): PitchTrack {
    return this.#recorder.track;
  }

  /** The score of the song so far (`null` before anything was captured). */
  result(): ScoreResult | null {
    const frames = Math.floor(this.#recorder.seconds * TRACK_HZ);
    if (frames === 0) return null;
    if (this.#result === null || frames - this.#at >= this.#every) {
      const stream = new StreamScore(this.#input, Number.POSITIVE_INFINITY);
      stream.put(0, asSubmitted(cleanTrack(this.#recorder.track)));
      this.#result = stream.score();
      this.#at = frames;
    }
    return this.#result;
  }

  /** The running number, 0..100, as the screen shows it. */
  get score(): number {
    return Math.round(this.result()?.total ?? 0);
  }
}
