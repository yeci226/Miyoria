// The notes as someone watching sees them go by (the stream's lanes, 「卡拉 OK 第二次實測留下的」):
// once a singer is past a reference note it is `perfect`, `good` or `miss`, by the same frame
// credit as the score's pitch part (full within the tolerance, nothing at twice it, in any octave),
// with the run of notes hit in a row (the combo) and, at the end of a phrase, whether the whole
// phrase was clean. It is for the show only: the number on the board is `scoreSinging`'s.
//
// A note with too little of the singer's pitch known (their frames did not arrive) is left
// unjudged and does not break the combo: a slow link is not a miss. A frame known and unvoiced is
// a frame not sung.

import { DEFAULT_TUNING, frameCredit } from "./score.js";
import { TRACK_HZ } from "./track.js";

export type Verdict = "perfect" | "good" | "miss";

/** A reference note: song seconds and a MIDI note (with a fraction). */
export interface JudgeNote {
  start: number;
  end: number;
  midi: number;
}

/** One judged note: which (its index in the notes given), how it went, and the combo after it. */
export interface Judgement {
  note: number;
  verdict: Verdict;
  /** The share of the note sung in tune, 0..1. */
  credit: number;
  combo: number;
  /** The note ended a phrase (all of its notes judged): whether every one was clean. */
  phrase: { index: number; perfect: boolean } | null;
}

/** The lines between verdicts (credit), and how much of a note must be known to judge it. */
export const JUDGE_PERFECT = 0.8;
export const JUDGE_GOOD = 0.45;
export const JUDGE_KNOWN = 0.5;
/** Notes shorter than this many frames are not judged (a slide, a grace note). */
export const JUDGE_MIN_FRAMES = 3;
/** A phrase is clean with at least this many notes judged, none missed, and this mean credit. */
export const PHRASE_NOTES = 3;
export const PHRASE_CREDIT = 0.8;

/** Cents between a sung note and the reference, in the nearest octave. */
export function foldedCents(sung: number, ref: number): number {
  const d = sung - ref;
  return Math.abs(d - 12 * Math.round(d / 12)) * 100;
}

/**
 * How a note was sung from the frames `frameAt` gives (frame `i` at song time `i / hz`;
 * `undefined`: not known). `known` is the share of its frames known.
 */
export function noteCredit(
  note: JudgeNote,
  frameAt: (i: number) => number | null | undefined,
  options: { hz?: number; tolerance_cents?: number } = {},
): { credit: number; known: number; frames: number } {
  const hz = options.hz ?? TRACK_HZ;
  const tol = options.tolerance_cents ?? DEFAULT_TUNING.tolerance_cents;
  const a = Math.ceil(note.start * hz);
  const b = Math.floor(note.end * hz);
  const frames = Math.max(0, b - a);
  let known = 0;
  let sum = 0;
  for (let i = a; i < b; i++) {
    const m = frameAt(i);
    if (m === undefined) continue;
    known++;
    if (m !== null && Number.isFinite(m)) sum += frameCredit(foldedCents(m, note.midi), tol);
  }
  return {
    credit: known === 0 ? 0 : sum / known,
    known: frames === 0 ? 0 : known / frames,
    frames,
  };
}

export function verdictOf(credit: number): Verdict {
  return credit >= JUDGE_PERFECT ? "perfect" : credit >= JUDGE_GOOD ? "good" : "miss";
}

/** One singer's notes judged as the song goes past them. */
export class NoteJudge {
  readonly #notes: JudgeNote[];
  readonly #index: number[];
  readonly #phraseOf: (number | null)[];
  readonly #phraseLast = new Map<number, number>();
  readonly #phrase = new Map<number, { judged: number; missed: boolean; sum: number }>();
  readonly #hz: number;
  readonly #tolerance: number;
  readonly #lag: number;
  #at = 0;
  #combo = 0;
  #best = 0;
  readonly #counts: Record<Verdict, number> = { perfect: 0, good: 0, miss: 0 };

  /**
   * `phrases`: the lyric lines' spans (song seconds; a note belongs to the one it starts in).
   * `lag_s`: how long after a note's end it is judged (the frames of its end are on their way).
   */
  constructor(
    notes: readonly JudgeNote[],
    options: {
      hz?: number;
      tolerance_cents?: number;
      phrases?: readonly { start: number; end: number }[];
      lag_s?: number;
    } = {},
  ) {
    const order = notes.map((n, i) => ({ n, i })).sort((x, y) => x.n.end - y.n.end || x.i - y.i);
    this.#notes = order.map((o) => o.n);
    this.#index = order.map((o) => o.i);
    this.#hz = options.hz ?? TRACK_HZ;
    this.#tolerance = options.tolerance_cents ?? DEFAULT_TUNING.tolerance_cents;
    this.#lag = options.lag_s ?? 0.1;
    const phrases = options.phrases ?? [];
    this.#phraseOf = this.#notes.map((n) => {
      const p = phrases.findIndex((s) => n.start >= s.start && n.start < s.end);
      return p < 0 ? null : p;
    });
    this.#phraseOf.forEach((p, k) => {
      if (p !== null) this.#phraseLast.set(p, k);
    });
  }

  /** Judges every note that ended by song time `t` (seconds). */
  advance(t: number, frameAt: (i: number) => number | null | undefined): Judgement[] {
    const out: Judgement[] = [];
    while (this.#at < this.#notes.length) {
      const k = this.#at;
      const note = this.#notes[k] as JudgeNote;
      if (note.end + this.#lag > t) break;
      this.#at++;
      const p = this.#phraseOf[k] ?? null;
      const got = noteCredit(note, frameAt, { hz: this.#hz, tolerance_cents: this.#tolerance });
      let judged: Judgement | null = null;
      if (got.frames >= JUDGE_MIN_FRAMES && got.known >= JUDGE_KNOWN) {
        const verdict = verdictOf(got.credit);
        this.#counts[verdict]++;
        this.#combo = verdict === "miss" ? 0 : this.#combo + 1;
        this.#best = Math.max(this.#best, this.#combo);
        judged = {
          note: this.#index[k] as number,
          verdict,
          credit: got.credit,
          combo: this.#combo,
          phrase: null,
        };
        if (p !== null) {
          const acc = this.#phrase.get(p) ?? { judged: 0, missed: false, sum: 0 };
          acc.judged++;
          acc.sum += got.credit;
          acc.missed ||= verdict === "miss";
          this.#phrase.set(p, acc);
        }
      }
      if (p !== null && this.#phraseLast.get(p) === k) {
        const acc = this.#phrase.get(p);
        const perfect =
          acc !== undefined &&
          acc.judged >= PHRASE_NOTES &&
          !acc.missed &&
          acc.sum / acc.judged >= PHRASE_CREDIT;
        if (judged !== null) judged.phrase = { index: p, perfect };
      }
      if (judged !== null) out.push(judged);
    }
    return out;
  }

  /** Notes hit in a row now, and the longest run so far. */
  get combo(): number {
    return this.#combo;
  }

  get best(): number {
    return this.#best;
  }

  get counts(): Readonly<Record<Verdict, number>> {
    return this.#counts;
  }
}
