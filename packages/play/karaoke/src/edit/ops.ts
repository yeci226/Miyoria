// The edits the reference editor makes (docs/design/karaoke.md 「做了什麼第六步」), as pure
// functions over `EditDoc`: the lyrics, the guide notes and how far the whole pitch curve is moved.
// Each returns a new document and never changes the one it was given, so the editor's undo is a
// list of documents. Lines, pieces and notes stay consistent: a note's `line` / `char` follow a
// line that moves, splits, merges or goes; a line's `aligned` follows whether every sung piece has
// a time; every line an edit touches is marked `edited`.

import type {
  WorkersKaraokeLineV2,
  WorkersKaraokeLyricsV2,
  WorkersKaraokeNote,
  WorkersKaraokePiece,
} from "@miyoria/contracts/workers";
import { piecesFromText, piecesTimed, repiece } from "./pieces.js";

/** What the editor changes of a reference; the rest is the worker's. */
export interface EditDoc {
  lyrics: WorkersKaraokeLyricsV2 | null;
  notes: WorkersKaraokeNote[];
  /** Semitones the whole pitch curve is moved by from the worker's (the notes move with it). */
  pitch_shift: number;
}

/** A note edit's result: the document, and where the edited notes are now (notes stay in time order). */
export interface NoteEdit {
  doc: EditDoc;
  selection: number[];
}

const r3 = (n: number) => Math.round(n * 1000) / 1000;
const r2 = (n: number) => Math.round(n * 100) / 100;

function linesOf(doc: EditDoc): WorkersKaraokeLineV2[] {
  return doc.lyrics?.lines ?? [];
}

function withLines(doc: EditDoc, lines: WorkersKaraokeLineV2[]): EditDoc {
  const lyrics: WorkersKaraokeLyricsV2 = doc.lyrics ?? {
    provider: null,
    source: "found",
    language: null,
    timing: "line",
    check: null,
    lines: [],
  };
  return {
    ...doc,
    lyrics: { ...lyrics, lines, timing: lines.some((l) => l.aligned) ? "char" : "line" },
  };
}

/** A line after an edit: `edited`, and `aligned` when every sung piece has a time. */
function touched(line: WorkersKaraokeLineV2): WorkersKaraokeLineV2 {
  return { ...line, edited: true, aligned: piecesTimed(line.pieces) };
}

function sortNotes(
  notes: WorkersKaraokeNote[],
  keep: Set<WorkersKaraokeNote>,
): NoteEdit["selection"] {
  notes.sort((a, b) => a.start - b.start || a.end - b.end);
  const out: number[] = [];
  notes.forEach((n, i) => {
    if (keep.has(n)) out.push(i);
  });
  return out;
}

/** The notes with each `line` / `char` passed through `map` (`null`: the note leaves its line). */
function remapNotes(
  notes: readonly WorkersKaraokeNote[],
  map: (line: number, char: number | null) => { line: number; char: number | null } | null,
): WorkersKaraokeNote[] {
  return notes.map((n) => {
    if (n.line === null) return n;
    const to = map(n.line, n.char);
    if (to === null) return { ...n, source: "pitch", line: null, char: null };
    if (to.line === n.line && to.char === n.char) return n;
    return { ...n, line: to.line, char: to.char };
  });
}

/** A line's pieces, or the pieces its text cuts into when it has none. */
export function piecesOf(line: WorkersKaraokeLineV2): WorkersKaraokePiece[] {
  return line.pieces ?? piecesFromText(line.text);
}

/** The lyrics present (an empty set of lines when the song had none), to add a line to. */
export function ensureLyrics(doc: EditDoc): EditDoc {
  return doc.lyrics === null ? withLines(doc, []) : doc;
}

// ---- lines --------------------------------------------------------------------------------------

/** A line's text changed: its pieces outside the changed span stay as they were. */
export function setLineText(doc: EditDoc, i: number, text: string): EditDoc {
  const lines = linesOf(doc);
  const line = lines[i];
  if (line === undefined || line.text === text) return doc;
  const { pieces, moved } = repiece(line.pieces, text);
  const next = [...lines];
  next[i] = touched({ ...line, text, pieces });
  const notes = remapNotes(doc.notes, (l, c) =>
    l !== i ? { line: l, char: c } : { line: l, char: c === null ? null : (moved[c] ?? null) },
  );
  return { ...withLines(doc, next), notes };
}

/** A line's start and end (`end` `null`: until the next line). */
export function setLineTimes(doc: EditDoc, i: number, start: number, end: number | null): EditDoc {
  const lines = linesOf(doc);
  const line = lines[i];
  if (line === undefined) return doc;
  const next = [...lines];
  next[i] = touched({ ...line, start: r3(start), end: end === null ? null : r3(end) });
  return withLines(doc, next);
}

/** A line widened to hold every timed piece of it. */
export function fitLineToPieces(doc: EditDoc, i: number): EditDoc {
  const line = linesOf(doc)[i];
  if (line === undefined) return doc;
  const timed = (line.pieces ?? []).filter((p) => p.start !== null && p.end !== null);
  if (timed.length === 0) return doc;
  const first = Math.min(...timed.map((p) => p.start as number));
  const last = Math.max(...timed.map((p) => p.end as number));
  const start = Math.min(line.start, first);
  const end = line.end === null ? null : Math.max(line.end, last);
  if (start === line.start && end === line.end) return doc;
  return setLineTimes(doc, i, start, end);
}

/** A line and everything sung in it moved by `dt` seconds (its notes stay with the voice). */
export function shiftLine(doc: EditDoc, i: number, dt: number): EditDoc {
  const lines = linesOf(doc);
  const line = lines[i];
  if (line === undefined || dt === 0) return doc;
  const next = [...lines];
  next[i] = touched(movedLine(line, dt));
  return withLines(doc, next);
}

function movedLine(line: WorkersKaraokeLineV2, dt: number): WorkersKaraokeLineV2 {
  const at = (t: number | null) => (t === null ? null : r3(t + dt));
  return {
    ...line,
    start: r3(line.start + dt),
    end: at(line.end),
    pieces:
      line.pieces === null
        ? null
        : line.pieces.map((p) => ({ ...p, start: at(p.start), end: at(p.end) })),
  };
}

/** Where a split at piece `k` falls in time: that piece's start, else in proportion to the text. */
function splitTime(line: WorkersKaraokeLineV2, pieces: readonly WorkersKaraokePiece[], k: number) {
  for (let j = k; j < pieces.length; j++) {
    const s = pieces[j]?.start;
    if (s !== null && s !== undefined) return s;
  }
  const before = pieces.slice(0, k).reduce((n, p) => n + p.text.length, 0);
  const all = Math.max(
    1,
    pieces.reduce((n, p) => n + p.text.length, 0),
  );
  const end = line.end ?? line.start + 4;
  return line.start + ((end - line.start) * before) / all;
}

/**
 * Line `i` split before its piece `k` (`0 < k < pieces`): the unsung pieces at the cut (a space)
 * are dropped; the second half starts where its first piece is sung.
 */
export function splitLine(doc: EditDoc, i: number, k: number): EditDoc {
  const lines = linesOf(doc);
  const line = lines[i];
  if (line === undefined) return doc;
  const pieces = piecesOf(line);
  if (k <= 0 || k >= pieces.length) return doc;
  let aEnd = k;
  while (aEnd > 0 && !(pieces[aEnd - 1] as WorkersKaraokePiece).sung) aEnd--;
  let bStart = k;
  while (bStart < pieces.length && !(pieces[bStart] as WorkersKaraokePiece).sung) bStart++;
  if (aEnd === 0 || bStart === pieces.length) return doc;
  const a = pieces.slice(0, aEnd);
  const b = pieces.slice(bStart);
  const at = r3(splitTime(line, pieces, bStart));
  const keepPieces = line.pieces !== null;
  const first = touched({
    ...line,
    text: a.map((p) => p.text).join(""),
    pieces: keepPieces ? a : null,
    end: at,
  });
  const second = touched({
    ...line,
    start: at,
    text: b.map((p) => p.text).join(""),
    pieces: keepPieces ? b : null,
    heard: null,
    similarity: null,
  });
  const next = [...lines.slice(0, i), first, second, ...lines.slice(i + 1)];
  const notes = remapNotes(doc.notes, (l, c) => {
    if (l < i) return { line: l, char: c };
    if (l > i) return { line: l + 1, char: c };
    if (c === null || !keepPieces) return { line: l, char: c };
    if (c < aEnd) return { line: l, char: c };
    if (c >= bStart) return { line: l + 1, char: c - bStart };
    return null;
  });
  return { ...withLines(doc, next), notes };
}

/** Line `i` and the one after it as one line. */
export function mergeLines(doc: EditDoc, i: number): EditDoc {
  const lines = linesOf(doc);
  const a = lines[i];
  const b = lines[i + 1];
  if (a === undefined || b === undefined) return doc;
  const latin = /[\p{Script=Latin}\d]$/u.test(a.text) && /^[\p{Script=Latin}\d]/u.test(b.text);
  const gap = latin ? " " : "";
  const pa = piecesOf(a);
  const pb = piecesOf(b);
  const joined: WorkersKaraokePiece[] = [
    ...pa,
    ...(gap === ""
      ? []
      : [{ text: gap, sung: false, start: null, end: null, reading: null, roman: null }]),
    ...pb,
  ];
  const offset = pa.length + (gap === "" ? 0 : 1);
  const keepPieces = a.pieces !== null || b.pieces !== null;
  const heard = [a.heard, b.heard].filter((h): h is string => h !== null).join(" ");
  const merged = touched({
    ...a,
    text: a.text + gap + b.text,
    end: b.end,
    pieces: keepPieces ? joined : null,
    status: a.status === b.status ? a.status : worse(a.status, b.status),
    similarity: null,
    heard: heard === "" ? null : heard,
  });
  const next = [...lines.slice(0, i), merged, ...lines.slice(i + 2)];
  const notes = remapNotes(doc.notes, (l, c) => {
    if (l <= i) return { line: l, char: c };
    if (l === i + 1) return { line: i, char: c === null || !keepPieces ? null : c + offset };
    return { line: l - 1, char: c };
  });
  return { ...withLines(doc, next), notes };
}

const STATUS_ORDER: WorkersKaraokeLineV2["status"][] = [
  "matched",
  "unchecked",
  "uncertain",
  "failed",
];
function worse(a: WorkersKaraokeLineV2["status"], b: WorkersKaraokeLineV2["status"]) {
  return STATUS_ORDER.indexOf(a) >= STATUS_ORDER.indexOf(b) ? a : b;
}

/** Line `i` gone; its notes stay on screen as notes of no line. */
export function deleteLine(doc: EditDoc, i: number): EditDoc {
  const lines = linesOf(doc);
  if (lines[i] === undefined) return doc;
  const next = [...lines.slice(0, i), ...lines.slice(i + 1)];
  const notes = remapNotes(doc.notes, (l, c) =>
    l < i ? { line: l, char: c } : l === i ? null : { line: l - 1, char: c },
  );
  return { ...withLines(doc, next), notes };
}

/**
 * A new empty line after line `after` (`-1`: before the first), starting at `start` (by default
 * just after the line before, or a second before the line after).
 */
export function insertLine(doc: EditDoc, after: number, start?: number): EditDoc {
  const lines = linesOf(doc);
  const prev = after >= 0 ? lines[after] : undefined;
  const next = lines[after + 1];
  const from =
    start ??
    (prev !== undefined
      ? (prev.end ?? prev.start + 2)
      : next !== undefined
        ? Math.max(0, next.start - 1)
        : 0);
  const line: WorkersKaraokeLineV2 = {
    start: r3(from),
    end: next !== undefined ? next.start : null,
    text: "",
    status: "unchecked",
    source: "found",
    similarity: null,
    heard: null,
    aligned: false,
    pieces: [],
    edited: true,
  };
  const out = [...lines.slice(0, after + 1), line, ...lines.slice(after + 1)];
  const notes = remapNotes(doc.notes, (l, c) => ({ line: l > after ? l + 1 : l, char: c }));
  return { ...withLines(ensureLyrics(doc), out), notes };
}

/** Line `i` looked at and found right as it is (it is not marked as doubtful any more). */
export function markChecked(doc: EditDoc, i: number): EditDoc {
  const lines = linesOf(doc);
  const line = lines[i];
  if (line === undefined || line.edited) return doc;
  const next = [...lines];
  next[i] = { ...line, edited: true };
  return withLines(doc, next);
}

// ---- pieces -------------------------------------------------------------------------------------

/** Piece `k` of line `i` changed (its time, its reading, its romaji). */
export function setPiece(
  doc: EditDoc,
  i: number,
  k: number,
  patch: Partial<Pick<WorkersKaraokePiece, "start" | "end" | "reading" | "roman">>,
): EditDoc {
  const lines = linesOf(doc);
  const line = lines[i];
  if (line === undefined) return doc;
  const pieces = [...piecesOf(line)];
  const p = pieces[k];
  if (p === undefined) return doc;
  const clean = (v: string | null | undefined) =>
    v === undefined ? undefined : v === null || v.trim() === "" ? null : v.trim();
  const reading = clean(patch.reading);
  const roman = clean(patch.roman);
  pieces[k] = {
    ...p,
    ...(patch.start === undefined ? {} : { start: patch.start === null ? null : r3(patch.start) }),
    ...(patch.end === undefined ? {} : { end: patch.end === null ? null : r3(patch.end) }),
    ...(reading === undefined ? {} : { reading }),
    ...(roman === undefined ? {} : { roman }),
  };
  const next = [...lines];
  next[i] = touched({ ...line, pieces });
  return withLines(doc, next);
}

/**
 * The sung pieces of line `i` timed anew, in order (`times[j]` for the `j`-th sung piece; `null`
 * leaves it untimed). Unsung pieces have no time.
 */
export function timePieces(
  doc: EditDoc,
  i: number,
  times: readonly (readonly [number, number] | null)[],
): EditDoc {
  const lines = linesOf(doc);
  const line = lines[i];
  if (line === undefined) return doc;
  let j = 0;
  const pieces = piecesOf(line).map((p) => {
    if (!p.sung) return { ...p, start: null, end: null };
    const t = times[j++] ?? null;
    return { ...p, start: t === null ? null : r3(t[0]), end: t === null ? null : r3(t[1]) };
  });
  const next = [...lines];
  next[i] = touched({ ...line, pieces });
  return withLines(doc, next);
}

/** The sung pieces of a line spread evenly from its start to its end. */
export function spreadPieces(doc: EditDoc, i: number, songEnd: number): EditDoc {
  const line = linesOf(doc)[i];
  if (line === undefined) return doc;
  const sung = piecesOf(line).filter((p) => p.sung).length;
  if (sung === 0) return doc;
  const end = line.end ?? Math.min(songEnd, line.start + sung * 0.4);
  const step = (end - line.start) / sung;
  return timePieces(
    doc,
    i,
    Array.from(
      { length: sung },
      (_, j) => [line.start + j * step, line.start + (j + 1) * step] as const,
    ),
  );
}

// ---- notes --------------------------------------------------------------------------------------

/** The notes at `sel` moved by `dt` seconds and `semitones`. */
export function moveNotes(
  doc: EditDoc,
  sel: readonly number[],
  dt: number,
  semitones: number,
): NoteEdit {
  const notes = [...doc.notes];
  const keep = new Set<WorkersKaraokeNote>();
  for (const i of sel) {
    const n = notes[i];
    if (n === undefined) continue;
    const moved = {
      ...n,
      start: r3(n.start + dt),
      end: r3(n.end + dt),
      midi: r2(n.midi + semitones),
    };
    notes[i] = moved;
    keep.add(moved);
  }
  const selection = sortNotes(notes, keep);
  return { doc: { ...doc, notes }, selection };
}

/** One note's start, end or pitch set. */
export function setNote(
  doc: EditDoc,
  i: number,
  patch: Partial<Pick<WorkersKaraokeNote, "start" | "end" | "midi">>,
): NoteEdit {
  const n = doc.notes[i];
  if (n === undefined) return { doc, selection: [] };
  const notes = [...doc.notes];
  const changed = {
    ...n,
    ...(patch.start === undefined ? {} : { start: r3(patch.start) }),
    ...(patch.end === undefined ? {} : { end: r3(patch.end) }),
    ...(patch.midi === undefined ? {} : { midi: r2(patch.midi) }),
  };
  notes[i] = changed;
  return { doc: { ...doc, notes }, selection: sortNotes(notes, new Set([changed])) };
}

/** A note cut in two at `at` (both halves keep its pitch and line). */
export function splitNote(doc: EditDoc, i: number, at: number): NoteEdit {
  const n = doc.notes[i];
  if (n === undefined || at <= n.start + 0.02 || at >= n.end - 0.02) return { doc, selection: [i] };
  const a = { ...n, end: r3(at) };
  const b = { ...n, start: r3(at) };
  const notes = [...doc.notes.slice(0, i), a, b, ...doc.notes.slice(i + 1)];
  return { doc: { ...doc, notes }, selection: sortNotes(notes, new Set([a, b])) };
}

/**
 * The notes at `sel` as one, from the first's start to the last's end, at the pitch of the longest
 * (merging is for a note the extractor cut in pieces).
 */
export function mergeNotes(doc: EditDoc, sel: readonly number[]): NoteEdit {
  const picked = [...new Set(sel)]
    .map((i) => doc.notes[i])
    .filter((n): n is WorkersKaraokeNote => n !== undefined);
  if (picked.length < 2) return { doc, selection: [...sel] };
  picked.sort((a, b) => a.start - b.start);
  const first = picked[0] as WorkersKaraokeNote;
  const longest = picked.reduce((a, b) => (b.end - b.start > a.end - a.start ? b : a));
  const merged: WorkersKaraokeNote = {
    ...first,
    end: Math.max(...picked.map((n) => n.end)),
    midi: longest.midi,
  };
  const gone = new Set(picked);
  const notes = [...doc.notes.filter((n) => !gone.has(n)), merged];
  return { doc: { ...doc, notes }, selection: sortNotes(notes, new Set([merged])) };
}

/** The notes at `sel` gone. */
export function deleteNotes(doc: EditDoc, sel: readonly number[]): NoteEdit {
  const gone = new Set(sel);
  return { doc: { ...doc, notes: doc.notes.filter((_, i) => !gone.has(i)) }, selection: [] };
}

/** A new guide note (a note of no line: it guides, it is not one per character). */
export function addNote(doc: EditDoc, start: number, end: number, midi: number): NoteEdit {
  const note: WorkersKaraokeNote = {
    start: r3(start),
    end: r3(end),
    midi: r2(midi),
    source: "pitch",
    line: null,
    char: null,
  };
  const notes = [...doc.notes, note];
  return { doc: { ...doc, notes }, selection: sortNotes(notes, new Set([note])) };
}

// ---- the whole song -----------------------------------------------------------------------------

/**
 * Every note and the reference curve moved by `semitones` (an octave when the extractor heard the
 * song an octave off). The curve is what scores are made against.
 */
export function shiftSong(doc: EditDoc, semitones: number): EditDoc {
  if (semitones === 0) return doc;
  return {
    ...doc,
    notes: doc.notes.map((n) => ({ ...n, midi: r2(n.midi + semitones) })),
    pitch_shift: doc.pitch_shift + semitones,
  };
}

/** Every lyric time moved by `ms` (the notes stay with the voice). */
export function shiftLyrics(doc: EditDoc, ms: number): EditDoc {
  if (ms === 0 || doc.lyrics === null) return doc;
  return withLines(
    doc,
    linesOf(doc).map((l) => touched(movedLine(l, ms / 1000))),
  );
}
