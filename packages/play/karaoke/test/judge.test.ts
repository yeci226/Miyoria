// The notes as someone watching sees them go by: perfect, good or miss by the score's own frame
// credit, in any octave; the combo; a slow link is not a miss; a clean phrase.

import { describe, expect, it } from "vitest";
import {
  DEFAULT_TUNING,
  foldedCents,
  frameCredit,
  type JudgeNote,
  NoteJudge,
  noteCredit,
  verdictOf,
} from "../src/score/index.js";

const HZ = 50;
/** Frames of a singing: `at(t)` the MIDI sung at song time t (`null` silent, `undefined` unknown). */
const framesOf =
  (at: (t: number) => number | null | undefined) =>
  (i: number): number | null | undefined =>
    at(i / HZ);

const notes: JudgeNote[] = [
  { start: 1, end: 1.5, midi: 60 },
  { start: 1.6, end: 2.2, midi: 62 },
  { start: 2.3, end: 3, midi: 64 },
  { start: 4, end: 4.6, midi: 65 },
];
const on = (t: number): number | null => notes.find((n) => t >= n.start && t < n.end)?.midi ?? null;

describe("judging the notes", () => {
  it("credits a frame as the score does, in the nearest octave", () => {
    expect(foldedCents(48.2, 60)).toBeCloseTo(20);
    expect(foldedCents(71.7, 60)).toBeCloseTo(30);
    const note = notes[0] as JudgeNote;
    const low = noteCredit(
      note,
      framesOf((t) => (on(t) === null ? null : 48.3)),
    );
    expect(low.credit).toBeCloseTo(frameCredit(30, DEFAULT_TUNING.tolerance_cents));
    expect(low.known).toBe(1);
    // Three quarters of a semitone off: half the credit.
    expect(
      noteCredit(
        note,
        framesOf(() => 60.75),
      ).credit,
    ).toBeCloseTo(0.5);
    expect(verdictOf(0.9)).toBe("perfect");
    expect(verdictOf(0.5)).toBe("good");
    expect(verdictOf(0.2)).toBe("miss");
  });

  it("judges each note once it is past, with the combo", () => {
    const judge = new NoteJudge(notes);
    const sing = framesOf((t) => (t >= 2.3 && t < 3 ? null : on(t)));
    expect(judge.advance(1.55, sing)).toEqual([]);
    const first = judge.advance(1.7, sing);
    expect(first).toMatchObject([{ note: 0, verdict: "perfect", combo: 1 }]);
    expect(judge.advance(2.4, sing)).toMatchObject([{ note: 1, verdict: "perfect", combo: 2 }]);
    // Silent through the third: a miss, and the combo starts over.
    expect(judge.advance(3.2, sing)).toMatchObject([{ note: 2, verdict: "miss", combo: 0 }]);
    expect(judge.advance(9, sing)).toMatchObject([{ note: 3, verdict: "perfect", combo: 1 }]);
    expect(judge.best).toBe(2);
    expect(judge.counts).toEqual({ perfect: 3, good: 0, miss: 1 });
    expect(judge.advance(10, sing)).toEqual([]);
  });

  it("leaves a note whose frames did not arrive unjudged, and the combo as it was", () => {
    const judge = new NoteJudge(notes);
    const sing = framesOf((t) => (t >= 1.6 && t < 2.2 ? undefined : on(t)));
    const got = judge.advance(3.5, sing);
    expect(got.map((j) => j.note)).toEqual([0, 2]);
    expect(got.at(-1)?.combo).toBe(2);
  });

  it("says when a phrase was sung clean, and when it was not", () => {
    const phrases = [
      { start: 0.5, end: 3.2 },
      { start: 3.8, end: 5 },
    ];
    const clean = new NoteJudge(notes, { phrases });
    const got = clean.advance(9, framesOf(on));
    expect(got[2]?.phrase).toEqual({ index: 0, perfect: true });
    // One note in it is too few for a clean phrase.
    expect(got[3]?.phrase).toEqual({ index: 1, perfect: false });
    const flat = new NoteJudge(notes, { phrases });
    const off = flat.advance(
      9,
      framesOf((t) => (t >= 1.6 && t < 2.2 ? 61 : on(t))),
    );
    expect(off[2]?.phrase).toEqual({ index: 0, perfect: false });
  });
});
