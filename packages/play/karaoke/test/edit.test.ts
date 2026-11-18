// The reference editor's shared edits (`src/edit/`, `@miyoria/play/karaoke/edit`): cutting a line
// into pieces, keeping what a text edit did not touch, lines split, merged, deleted and inserted
// with their notes following, timing pieces, the note edits, the whole-song moves, every rule a
// save is checked with, and the edit made into the reference everyone sings against.

import type {
  WorkersKaraokeLineV2,
  WorkersKaraokeNote,
  WorkersKaraokePiece,
  WorkersKaraokeReferenceV2,
} from "@miyoria/contracts/workers";
import { describe, expect, it } from "vitest";
import {
  addNote,
  composeReference,
  deleteLine,
  deleteNotes,
  docOf,
  EDIT_LIMITS,
  type EditDoc,
  editedLines,
  insertLine,
  mergeLines,
  mergeNotes,
  moveNotes,
  piecesFromText,
  repiece,
  setLineText,
  setNote,
  shiftLyrics,
  shiftSong,
  splitLine,
  splitNote,
  spreadPieces,
  timePieces,
  validateEdit,
} from "../src/edit/index.js";
import { referenceOf, synthSong } from "../src/testing.js";

const p = (
  text: string,
  start: number | null = null,
  end: number | null = null,
  reading: string | null = null,
): WorkersKaraokePiece => ({
  text,
  sung: !/^[\s\p{P}]+$/u.test(text),
  start,
  end,
  reading,
  roman: null,
});

const line = (
  text: string,
  start: number,
  end: number | null,
  pieces: WorkersKaraokePiece[] | null = null,
): WorkersKaraokeLineV2 => ({
  start,
  end,
  text,
  status: "matched",
  source: "found",
  similarity: 1,
  heard: text,
  aligned: pieces?.filter((x) => x.sung).every((x) => x.start !== null) ?? false,
  pieces,
  edited: false,
});

const note = (
  start: number,
  end: number,
  midi: number,
  l: number | null = null,
  char: number | null = null,
): WorkersKaraokeNote => ({
  start,
  end,
  midi,
  source: l === null ? "pitch" : "lyric",
  line: l,
  char,
});

/** Three timed lines: 你好 世界 (with a space), 今天 (with readings), 明天. */
function doc(): EditDoc {
  return {
    lyrics: {
      provider: "test",
      source: "found",
      language: "zh",
      timing: "char",
      check: null,
      lines: [
        line("你好 世界", 1, 3, [
          p("你", 1, 1.4),
          p("好", 1.4, 1.8),
          p(" "),
          p("世", 2, 2.4),
          p("界", 2.4, 2.9),
        ]),
        line("今天", 4, 5, [p("今", 4, 4.5, "jīn"), p("天", 4.5, 5, "tiān")]),
        line("明天", 6, 7, [p("明", 6, 6.5), p("天", 6.5, 7)]),
      ],
    },
    notes: [
      note(1, 1.4, 60, 0, 0),
      note(1.4, 1.8, 62, 0, 1),
      note(2, 2.4, 64, 0, 3),
      note(2.4, 2.9, 65, 0, 4),
      note(4, 4.5, 67, 1, 0),
      note(4.5, 5, 65, 1, 1),
      note(6, 6.5, 64, 2, 0),
    ],
    pitch_shift: 0,
  };
}

const lines = (d: EditDoc) => d.lyrics?.lines ?? [];
const at = (d: EditDoc, i: number) => lines(d)[i] as WorkersKaraokeLineV2;
const CTX = { duration_s: 10, curve: [null, 60, 62, 64, null] };
const messages = (d: EditDoc, ctx = CTX) => validateEdit(d, ctx).map((x) => x.message);

describe("cutting a line into pieces", () => {
  it("makes a Chinese character one piece each", () => {
    expect(piecesFromText("你好世界").map((x) => [x.text, x.sung])).toEqual([
      ["你", true],
      ["好", true],
      ["世", true],
      ["界", true],
    ]);
  });

  it("keeps small kana with the kana before, and kanji one each", () => {
    expect(piecesFromText("きゃりー歌う").map((x) => x.text)).toEqual([
      "きゃ",
      "り",
      "ー",
      "歌",
      "う",
    ]);
    expect(piecesFromText("ジャズ").map((x) => x.text)).toEqual(["ジャ", "ズ"]);
  });

  it("makes an English word one piece, spaces and punctuation unsung pieces between", () => {
    expect(piecesFromText("Hello, don't go!").map((x) => [x.text, x.sung])).toEqual([
      ["Hello", true],
      [", ", false],
      ["don't", true],
      [" ", false],
      ["go", true],
      ["!", false],
    ]);
    expect(piecesFromText("").length).toBe(0);
    for (const x of piecesFromText("a b")) {
      expect(x).toMatchObject({ start: null, end: null, reading: null, roman: null });
    }
  });
});

describe("a text edit", () => {
  it("keeps the pieces it did not touch, their times and readings", () => {
    const old = [p("今", 4, 4.5, "jīn"), p("天", 4.5, 5, "tiān"), p("好", 5, 5.5, "hǎo")];
    const { pieces, moved } = repiece(old, "今日好");
    expect(pieces.map((x) => x.text)).toEqual(["今", "日", "好"]);
    expect(pieces[0]).toEqual(old[0]);
    expect(pieces[2]).toEqual(old[2]);
    expect(pieces[1]).toMatchObject({ start: null, end: null, reading: null });
    expect(moved).toEqual([0, null, 2]);
    // The same text: every piece where it was.
    expect(repiece(old, "今天好")).toEqual({ pieces: old, moved: [0, 1, 2] });
    // No pieces before: cut afresh.
    expect(repiece(null, "ab c").pieces.map((x) => x.text)).toEqual(["ab", " ", "c"]);
  });

  it("follows the line's notes to their pieces, and drops the ones of a piece cut again", () => {
    const d = setLineText(doc(), 0, "你們 世界");
    expect(at(d, 0)).toMatchObject({ text: "你們 世界", edited: true });
    expect(at(d, 0).pieces?.map((x) => x.text)).toEqual(["你", "們", " ", "世", "界"]);
    expect(at(d, 0).aligned).toBe(false); // 們 has no time
    expect(d.notes.slice(0, 4).map((n) => n.char)).toEqual([0, null, 3, 4]);
    // The other lines are untouched.
    expect(at(d, 1)).toEqual(at(doc(), 1));
  });
});

describe("lines", () => {
  it("split: the notes of the second half move to the new line, the ones after move down", () => {
    const d = splitLine(doc(), 0, 3);
    expect(lines(d).map((l) => l.text)).toEqual(["你好", "世界", "今天", "明天"]);
    expect(at(d, 0)).toMatchObject({ start: 1, end: 2, edited: true });
    expect(at(d, 1)).toMatchObject({ start: 2, end: 3, edited: true, heard: null });
    expect(d.notes.map((n) => [n.line, n.char])).toEqual([
      [0, 0],
      [0, 1],
      [1, 0],
      [1, 1],
      [2, 0],
      [2, 1],
      [3, 0],
    ]);
    // Not at the very start or end.
    expect(splitLine(doc(), 0, 0)).toEqual(doc());
  });

  it("merge: the second line's notes follow onto the first, the ones after move up", () => {
    const d = mergeLines(doc(), 1);
    expect(lines(d).map((l) => l.text)).toEqual(["你好 世界", "今天明天"]);
    expect(at(d, 1)).toMatchObject({ start: 4, end: 7, edited: true, aligned: true });
    expect(d.notes.slice(4).map((n) => [n.line, n.char])).toEqual([
      [1, 0],
      [1, 1],
      [1, 2],
    ]);
    // Latin words keep a space between them.
    const en: EditDoc = {
      ...doc(),
      lyrics: {
        ...(doc().lyrics as NonNullable<EditDoc["lyrics"]>),
        lines: [line("hello", 1, 2, [p("hello", 1, 2)]), line("world", 2, 3, [p("world", 2, 3)])],
      },
      notes: [note(2, 3, 60, 1, 0)],
    };
    const merged = mergeLines(en, 0);
    expect(at(merged, 0).text).toBe("hello world");
    expect(merged.notes[0]).toMatchObject({ line: 0, char: 2 });
  });

  it("delete: its notes stay as notes of no line, the ones after move up", () => {
    const d = deleteLine(doc(), 0);
    expect(lines(d).map((l) => l.text)).toEqual(["今天", "明天"]);
    expect(d.notes.slice(0, 4).every((n) => n.line === null && n.char === null)).toBe(true);
    expect(d.notes.slice(0, 4).every((n) => n.source === "pitch")).toBe(true);
    expect(d.notes.slice(4).map((n) => n.line)).toEqual([0, 0, 1]);
  });

  it("insert: an empty edited line, the notes after it move down", () => {
    const d = insertLine(doc(), 0);
    expect(lines(d).map((l) => l.text)).toEqual(["你好 世界", "", "今天", "明天"]);
    expect(at(d, 1)).toMatchObject({ start: 3, end: 4, edited: true, pieces: [] });
    expect(d.notes.map((n) => n.line)).toEqual([0, 0, 0, 0, 2, 2, 3]);
    // Into a song without lyrics.
    const none = insertLine({ lyrics: null, notes: [], pitch_shift: 0 }, -1);
    expect(lines(none)).toHaveLength(1);
  });
});

describe("timing pieces", () => {
  it("timePieces sets aligned once every sung piece has a time, unsung ones never timed", () => {
    const start = setLineText(doc(), 2, "明天見");
    expect(at(start, 2).aligned).toBe(false);
    const half = timePieces(start, 2, [[6, 6.3], null, [6.6, 7]]);
    expect(at(half, 2).aligned).toBe(false);
    const all = timePieces(start, 2, [
      [6, 6.3],
      [6.3, 6.6],
      [6.6, 7],
    ]);
    expect(at(all, 2)).toMatchObject({ aligned: true, edited: true });
    const spaced = timePieces(doc(), 0, [
      [1, 1.2],
      [1.2, 1.4],
      [2, 2.2],
      [2.2, 2.4],
    ]);
    expect(at(spaced, 0).pieces?.[2]).toMatchObject({ text: " ", start: null, end: null });
    expect(at(spaced, 0).aligned).toBe(true);
  });

  it("spreadPieces spreads the sung pieces over the line and sets aligned", () => {
    const untimed = setLineText(doc(), 1, "後天呢");
    const d = spreadPieces(untimed, 1, 10);
    const ps = at(d, 1).pieces ?? [];
    expect(ps.map((x) => [x.start, x.end])).toEqual([
      [4, 4.333],
      [4.333, 4.667],
      [4.667, 5],
    ]);
    expect(at(d, 1).aligned).toBe(true);
  });
});

describe("notes", () => {
  it("stay in time order after a move, and the selection follows them", () => {
    const base: EditDoc = {
      lyrics: null,
      notes: [note(0, 1, 60), note(2, 3, 62), note(4, 5, 64)],
      pitch_shift: 0,
    };
    const { doc: d, selection } = moveNotes(base, [0], 3, 1);
    expect(d.notes.map((n) => [n.start, n.midi])).toEqual([
      [2, 62],
      [3, 61],
      [4, 64],
    ]);
    expect(selection).toEqual([1]);
    expect(base.notes[0]?.start).toBe(0); // the old document is as it was
    const set = setNote(base, 2, { start: 0.5, end: 0.9 });
    expect(set.doc.notes.map((n) => n.start)).toEqual([0, 0.5, 2]);
    expect(set.selection).toEqual([1]);
  });

  it("split, merge, delete and add", () => {
    const base: EditDoc = {
      lyrics: null,
      notes: [note(0, 1, 60), note(1, 1.2, 61), note(2, 3, 62)],
      pitch_shift: 0,
    };
    const split = splitNote(base, 0, 0.5);
    expect(split.doc.notes.map((n) => [n.start, n.end])).toEqual([
      [0, 0.5],
      [0.5, 1],
      [1, 1.2],
      [2, 3],
    ]);
    expect(split.selection).toEqual([0, 1]);
    const merged = mergeNotes(base, [0, 1]);
    expect(merged.doc.notes.map((n) => [n.start, n.end, n.midi])).toEqual([
      [0, 1.2, 60],
      [2, 3, 62],
    ]);
    expect(merged.selection).toEqual([0]);
    expect(deleteNotes(base, [1]).doc.notes.map((n) => n.start)).toEqual([0, 2]);
    const added = addNote(base, 1.5, 1.8, 63);
    expect(added.selection).toEqual([2]);
    expect(added.doc.notes[2]).toMatchObject({ start: 1.5, source: "pitch", line: null });
  });
});

describe("the whole song", () => {
  it("shiftSong moves every note and the curve's shift", () => {
    const d = shiftSong(doc(), 12);
    expect(d.pitch_shift).toBe(12);
    expect(d.notes.map((n) => n.midi)).toEqual(doc().notes.map((n) => n.midi + 12));
    expect(shiftSong(d, -12).pitch_shift).toBe(0);
  });

  it("shiftLyrics moves every line and piece, not the notes", () => {
    const d = shiftLyrics(doc(), 500);
    expect(lines(d).map((l) => [l.start, l.end, l.edited])).toEqual([
      [1.5, 3.5, true],
      [4.5, 5.5, true],
      [6.5, 7.5, true],
    ]);
    expect(at(d, 0).pieces?.[0]).toMatchObject({ start: 1.5, end: 1.9 });
    expect(d.notes).toEqual(doc().notes);
  });
});

describe("what a save must hold", () => {
  it("passes a good edit", () => {
    expect(validateEdit(doc(), CTX)).toEqual([]);
  });

  it("line starts in order, and inside the song", () => {
    const d = doc();
    at(d, 1).start = 0.5;
    at(d, 2).start = 11;
    at(d, 2).pieces = null;
    at(d, 2).aligned = false;
    const got = messages(d);
    expect(got).toContain("第 2 行:開始的時間要比上一行晚");
    expect(got).toContain("第 3 行:開始的時間(11 秒)在歌結束之後");
    expect(got).toContain("第 3 行:結束的時間要在開始之後");
  });

  it("pieces inside their line, in order, joining to its text", () => {
    const d = doc();
    (at(d, 1).pieces as WorkersKaraokePiece[])[0] = p("今", 3.5, 4.5);
    expect(messages(d)).toContain("第 2 行:「今」在這一行的時間外面(3.5 秒–4.5 秒)");
    const e = doc();
    (at(e, 1).pieces as WorkersKaraokePiece[])[1] = p("天", 4.2, 5);
    expect(messages(e)).toContain("第 2 行:「天」和前一個字重疊了");
    const f = doc();
    at(f, 2).text = "明日";
    expect(messages(f)).toContain("第 3 行:片段合起來要等於這一行的字");
  });

  it("aligned only with every sung piece timed", () => {
    const d = doc();
    at(d, 2).pieces = null;
    expect(messages(d)).toContain("第 3 行:標成逐字對好了,卻沒有逐字的時間");
    const e = doc();
    (at(e, 2).pieces as WorkersKaraokePiece[])[1] = p("天");
    expect(messages(e)).toContain("第 3 行:標成逐字對好了,還有字沒有時間");
  });

  it("notes of one line never overlap, notes inside the song and in range", () => {
    const d = doc();
    d.notes[1] = note(1.2, 1.8, 62, 0, 1);
    d.notes.push(note(9, 11, 60), note(8, 8.5, 110), note(3, 3.5, 60, 7, null));
    const got = messages(d);
    expect(got).toContain("第 1 行:第 2 個音符和第 1 個重疊了");
    expect(got).toContain("第 8 個音符:在歌結束之後(11 秒)");
    expect(got).toContain("第 9 個音符:音高超出範圍(C1 到 C7)");
    expect(got).toContain("第 10 個音符:指到不存在的第 8 行");
    // Notes of no line are one guide: they do not overlap either; notes of two lines may.
    const free: EditDoc = { lyrics: null, notes: [note(0, 2, 60), note(1, 3, 62)], pitch_shift: 0 };
    expect(messages(free)).toEqual(["第 2 個音符和第 1 個重疊了"]);
    const two = doc();
    two.notes.push(note(1.2, 1.3, 70, 1, null));
    expect(messages(two).filter((m) => m.includes("重疊"))).toEqual([]);
  });

  it("the shift and the sizes", () => {
    expect(messages({ ...doc(), pitch_shift: 25 })).toContain("整首最多移 24 個半音");
    expect(messages({ ...doc(), pitch_shift: 24 }, { duration_s: 10, curve: [80] })).toContain(
      "整首移了之後,參考的音高超出範圍(C1 到 C7)",
    );
    const long = doc();
    at(long, 0).text = "字".repeat(EDIT_LIMITS.text + 1);
    at(long, 0).pieces = null;
    at(long, 0).aligned = false;
    expect(messages(long)).toContain(`第 1 行:字太多了(最多 ${EDIT_LIMITS.text} 個)`);
    const many: EditDoc = {
      lyrics: null,
      notes: Array.from({ length: EDIT_LIMITS.notes + 1 }, (_, i) =>
        note(i * 0.001, i * 0.001 + 0.0005, 60),
      ),
      pitch_shift: 0,
    };
    expect(messages(many, { duration_s: 100, curve: [] })).toContain(
      `音符最多 ${EDIT_LIMITS.notes} 個`,
    );
    // At most `max` problems.
    expect(validateEdit(many, { duration_s: 0.5, curve: [] }, 3)).toHaveLength(3);
  });
});

describe("the edit as the reference everyone sings against", () => {
  const song = synthSong(2, 3);
  const original: WorkersKaraokeReferenceV2 = referenceOf(song, "k-edit");

  it("marks the lines that are not the worker's, keeps the rest", () => {
    const edit = setLineText(docOf(original, 0), 1, "改過的一句");
    const ref = composeReference(original, edit);
    expect(ref.lyrics?.lines.map((l) => l.edited)).toEqual([false, true, false]);
    expect(editedLines(ref.lyrics?.lines ?? [])).toBe(1);
    // A line put back as the worker wrote it is the worker's again.
    const back = setLineText(edit, 1, original.lyrics?.lines[1]?.text as string);
    const backRef = composeReference(original, { ...back, lyrics: original.lyrics });
    expect(editedLines(backRef.lyrics?.lines ?? [])).toBe(0);
    // Everything else is the worker's.
    expect(ref).toMatchObject({
      id: "k-edit",
      duration_s: original.duration_s,
      quality: original.quality,
    });
    expect(ref.pitch).toBe(original.pitch);
  });

  it("moves the curve by the shift, and keeps the notes in time order", () => {
    const before = JSON.stringify(original);
    const shifted = shiftSong(docOf(original, 0), 3);
    const edit = { ...shifted, notes: [...shifted.notes].reverse() };
    const ref = composeReference(original, edit);
    original.pitch.midi.forEach((m, i) => {
      const got = ref.pitch.midi[i];
      if (m === null) expect(got).toBeNull();
      else expect(got).toBeCloseTo(m + 3, 5);
    });
    expect(ref.notes.map((n) => n.start)).toEqual(
      [...ref.notes.map((n) => n.start)].sort((a, b) => a - b),
    );
    expect(ref.notes[0]?.midi).toBeCloseTo((original.notes[0]?.midi as number) + 3, 5);
    // The worker's reference is never changed.
    expect(JSON.stringify(original)).toBe(before);
  });
});
