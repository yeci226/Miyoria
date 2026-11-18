// A singer's score while the song is still being sung (docs/design/karaoke.md 「做了什麼第四步」):
// the pitch arrives in pieces, a few a second, and a later piece may revise the frames an earlier
// one gave (the song worker's live pitch settles a moment after it is first read). `score()` is
// `scoreSinging` on the song so far: the reference cut where the singing has reached, so a phrase
// not reached yet costs nothing. `final()` is `scoreSinging` on the whole song. Once the singing is
// over (`finish()`, or the frames reached the end of the reference) `score()` is `final()`, so the
// running official number is exactly the final one at the end, whatever order the pieces came in.

import { type ReferenceCurve, type ScoreInput, type ScoreResult, scoreSinging } from "./score.js";
import { type PitchFrames, type PitchTrack, TRACK_HZ } from "./track.js";

/** What a stream score is scored against: everything of `ScoreInput` but the singing. */
export type StreamScoreInput = Omit<ScoreInput, "sung">;

export class StreamScore {
  readonly #input: StreamScoreInput;
  readonly #frames: (number | null)[] = [];
  readonly #max: number;
  #done = false;

  /** `maxSeconds`: frames past this (song time) are not kept. */
  constructor(input: StreamScoreInput, maxSeconds: number) {
    this.#input = input;
    this.#max = Math.max(0, Math.ceil(maxSeconds * TRACK_HZ));
  }

  /**
   * Frames at `TRACK_HZ` in song time as captured (before the latency): `midi[k]` is frame
   * `from + k`, replacing what was there. Frames before `from` stay; a gap is silence. `last`:
   * these are the last frames there are (a stream's final curve): anything after them goes.
   */
  put(from: number, midi: PitchFrames, last = false): void {
    if (!Number.isInteger(from) || from < 0) return;
    if (last) this.#frames.length = Math.min(this.#frames.length, from + midi.length);
    for (let k = 0; k < midi.length; k++) {
      const i = from + k;
      if (i >= this.#max) break;
      while (this.#frames.length < i) this.#frames.push(null);
      const m = midi[k];
      this.#frames[i] = m === null || m === undefined || !Number.isFinite(m) ? null : m;
    }
  }

  /** The singing so far. */
  get track(): PitchTrack {
    return { hz: TRACK_HZ, midi: [...this.#frames] };
  }

  /** Frames held (song time). */
  get length(): number {
    return this.#frames.length;
  }

  /** How many reference frames the singing has reached (the latency taken off). */
  reached(): number {
    const ref = this.#input.reference;
    const latency = this.#input.latency_ms / 1000;
    const sungS = this.#frames.length / TRACK_HZ;
    return Math.max(
      0,
      Math.min(ref.midi.length, Math.floor((sungS - latency - ref.start) * ref.hz)),
    );
  }

  /** The singing is over (the song ended, or this singer's stream did): `score()` is `final()`. */
  finish(): void {
    this.#done = true;
  }

  get finished(): boolean {
    return this.#done;
  }

  /** The score of the song so far; the whole song's once it is finished or reached its end. */
  score(): ScoreResult {
    const ref = this.#input.reference;
    const n = this.reached();
    if (this.#done || n >= ref.midi.length) return this.final();
    const reference: ReferenceCurve = { hz: ref.hz, start: ref.start, midi: ref.midi.slice(0, n) };
    return scoreSinging({ ...this.#input, reference, sung: this.track });
  }

  /** The score of the whole song with what was sung. */
  final(): ScoreResult {
    return scoreSinging({ ...this.#input, sung: this.track });
  }
}
