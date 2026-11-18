// The running number on the singing screen: the pitch part only, as the frames come in, from the
// same frame credit as the full score. Cheap enough for every detection (100 a second). The final
// number is `scoreSinging` on the track as it is submitted, the same as Core's.

import { median } from "./curve.js";
import { DEFAULT_TUNING, frameCredit, pitchFraction, type ReferenceCurve } from "./score.js";

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
