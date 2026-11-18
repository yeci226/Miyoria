// The reference editor's state without the DOM (docs/design/karaoke.md 「做了什麼第六步」): the undo
// history of the session, the timeline's geometry over one line, what the pointer is on, the tap
// along, and the words for a line's state. The edits themselves are the shared module's
// (`@miyoria/play/karaoke/edit`), which Core checks every save with.

import type {
  WorkersKaraokeLineV2,
  WorkersKaraokeNote,
  WorkersKaraokePiece,
} from "@miyoria/contracts/workers/karaoke";
import { sungEnd } from "@miyoria/play/karaoke/lyrics";
import { type LaneView, midiToY, NOW_AT } from "../lane";

// ---- undo -----------------------------------------------------------------------------------------

/** The session's edits: what came before, what is shown, what was undone, and what Core has. */
export interface History<T> {
  past: T[];
  present: T;
  future: T[];
  saved: T;
}

/** Edits kept for undo. */
export const UNDO_DEPTH = 300;

export function startHistory<T>(doc: T): History<T> {
  return { past: [], present: doc, future: [], saved: doc };
}

/** A new state; the same one changes nothing (an edit that did nothing is not an undo step). */
export function pushHistory<T>(h: History<T>, next: T): History<T> {
  if (next === h.present) return h;
  return { ...h, past: [...h.past, h.present].slice(-UNDO_DEPTH), present: next, future: [] };
}

export function undo<T>(h: History<T>): History<T> {
  const prev = h.past.at(-1);
  if (prev === undefined) return h;
  return { ...h, past: h.past.slice(0, -1), present: prev, future: [h.present, ...h.future] };
}

export function redo<T>(h: History<T>): History<T> {
  const next = h.future[0];
  if (next === undefined) return h;
  return { ...h, past: [...h.past, h.present], present: next, future: h.future.slice(1) };
}

/** Core has a new state (saved, or loaded anew): it is what is shown, and undo still goes back. */
export function savedAs<T>(h: History<T>, doc: T): History<T> {
  return { ...h, present: doc, saved: doc, future: [] };
}

export const isDirty = <T>(h: History<T>) => h.present !== h.saved;

// ---- the timeline of one line ---------------------------------------------------------------------

/** The time a line shows over, and the canvas width it is drawn on. */
export interface Span {
  from: number;
  to: number;
  width: number;
}

export const tToX = (t: number, s: Span) => ((t - s.from) / Math.max(0.001, s.to - s.from)) * s.width;
export const xToT = (x: number, s: Span) => s.from + (x / Math.max(1, s.width)) * (s.to - s.from);

/** Seconds shown before and after a line. */
export const LINE_PAD_S = 0.8;

/** The time a line is shown over: its own, its pieces', a little either side, inside the song. */
export function lineWindow(line: WorkersKaraokeLineV2, songEnd: number): { from: number; to: number } {
  const times = [line.start];
  const end = line.end ?? sungEnd(line);
  if (end !== null) times.push(end);
  for (const p of line.pieces ?? []) {
    if (p.start !== null) times.push(p.start);
    if (p.end !== null) times.push(p.end);
  }
  let to = Math.max(...times);
  if (to - line.start < 2) to = line.start + 2;
  return {
    from: Math.max(0, Math.min(...times) - LINE_PAD_S),
    to: Math.min(Math.max(songEnd, to), to + LINE_PAD_S),
  };
}

/** The singing lane's view (`lane.ts`) laid over exactly `span`, so its drawing can be reused. */
export function laneOver(span: Span, height: number, range: { lo: number; hi: number }): LaneView {
  const length = span.to - span.from;
  return { width: span.width, height, now: span.from + NOW_AT * length, span: length, lo: range.lo, hi: range.hi };
}

/** The MIDI at height `y` of a lane (the inverse of `midiToY`). */
export function yToMidi(y: number, view: LaneView): number {
  const top = midiToY(view.hi, view);
  const bottom = midiToY(view.lo, view);
  return view.lo + ((bottom - y) / Math.max(1, bottom - top)) * (view.hi - view.lo);
}

/** Pixels from an edge that grab it. */
export const GRAB_PX = 6;
/** The shortest a piece or a note may be dragged to, in seconds. */
export const MIN_LEN_S = 0.03;

/** What the pointer is on in the strip of pieces. `k`: the piece; `next`: a shared edge's other. */
export type PieceGrab =
  | { kind: "start" | "end" | "move"; k: number }
  | { kind: "edge"; k: number; next: number };

/** Two pieces meet when one ends this close to where the next starts. */
const MEET_S = 0.005;

/** What the pointer at `x` is on among a line's timed pieces. */
export function grabPiece(pieces: readonly WorkersKaraokePiece[], span: Span, x: number): PieceGrab | null {
  const timed = pieces
    .map((p, k) => ({ p, k }))
    .filter(({ p }) => p.sung && p.start !== null && p.end !== null);
  // Edges first: a shared one moves both pieces.
  for (let j = 0; j < timed.length; j++) {
    const { p, k } = timed[j] as { p: WorkersKaraokePiece; k: number };
    const next = timed[j + 1];
    const xs = tToX(p.start as number, span);
    const xe = tToX(p.end as number, span);
    if (next !== undefined && Math.abs((next.p.start as number) - (p.end as number)) < MEET_S && Math.abs(x - xe) <= GRAB_PX) {
      return { kind: "edge", k, next: next.k };
    }
    if (Math.abs(x - xs) <= GRAB_PX && (j === 0 || !meets(timed[j - 1]?.p, p))) return { kind: "start", k };
    if (Math.abs(x - xe) <= GRAB_PX) return { kind: "end", k };
  }
  for (const { p, k } of timed) {
    if (x > tToX(p.start as number, span) && x < tToX(p.end as number, span)) return { kind: "move", k };
  }
  return null;
}

const meets = (a: WorkersKaraokePiece | undefined, b: WorkersKaraokePiece) =>
  a !== undefined && a.end !== null && b.start !== null && Math.abs(b.start - a.end) < MEET_S;

/** The free time around piece `k`: the end of the timed piece before it, the start of the one after. */
function room(pieces: readonly WorkersKaraokePiece[], k: number, lo: number, hi: number): [number, number] {
  let before = lo;
  for (let j = k - 1; j >= 0; j--) {
    const e = pieces[j]?.end;
    if (e !== null && e !== undefined) {
      before = Math.max(lo, e);
      break;
    }
  }
  let after = hi;
  for (let j = k + 1; j < pieces.length; j++) {
    const s = pieces[j]?.start;
    if (s !== null && s !== undefined) {
      after = Math.min(hi, s);
      break;
    }
  }
  return [before, after];
}

/**
 * The times of the pieces a drag changes, `dt` seconds from where they were: kept inside the line
 * (`lo`..`hi`), off their neighbours and at least `MIN_LEN_S` long. A list of `[k, start, end]`.
 */
export function dragPiece(
  pieces: readonly WorkersKaraokePiece[],
  grab: PieceGrab,
  dt: number,
  lo: number,
  hi: number,
): [number, number, number][] {
  const p = pieces[grab.k];
  if (p === undefined || p.start === null || p.end === null) return [];
  const [before, after] = room(pieces, grab.k, lo, hi);
  if (grab.kind === "move") {
    const len = p.end - p.start;
    const start = Math.min(Math.max(p.start + dt, before), after - len);
    return [[grab.k, start, start + len]];
  }
  if (grab.kind === "start") {
    return [[grab.k, Math.min(Math.max(p.start + dt, before), p.end - MIN_LEN_S), p.end]];
  }
  if (grab.kind === "end") {
    return [[grab.k, p.start, Math.max(Math.min(p.end + dt, after), p.start + MIN_LEN_S)]];
  }
  if (grab.kind !== "edge") return [];
  const q = pieces[grab.next];
  if (q === undefined || q.start === null || q.end === null) return [];
  const at = Math.min(Math.max(p.end + dt, p.start + MIN_LEN_S), q.end - MIN_LEN_S);
  return [
    [grab.k, p.start, at],
    [grab.next, at, q.end],
  ];
}

/** What the pointer is on among the notes: one's edge or its body. */
export interface NoteGrab {
  i: number;
  kind: "start" | "end" | "move";
}

/** The note under (`x`, `y`) on a lane, and which part of it. */
export function grabNote(
  notes: readonly WorkersKaraokeNote[],
  span: Span,
  view: LaneView,
  x: number,
  y: number,
  barHeight: number,
): NoteGrab | null {
  for (let i = notes.length - 1; i >= 0; i--) {
    const n = notes[i] as WorkersKaraokeNote;
    if (n.end < span.from || n.start > span.to) continue;
    const ny = midiToY(n.midi, view);
    if (Math.abs(y - ny) > Math.max(barHeight / 2, 5)) continue;
    const xs = tToX(n.start, span);
    const xe = tToX(n.end, span);
    if (x < xs - GRAB_PX || x > xe + GRAB_PX) continue;
    if (xe - xs > GRAB_PX * 3) {
      if (Math.abs(x - xs) <= GRAB_PX) return { i, kind: "start" };
      if (Math.abs(x - xe) <= GRAB_PX) return { i, kind: "end" };
    }
    return { i, kind: "move" };
  }
  return null;
}

// ---- tap along --------------------------------------------------------------------------------------

/**
 * Timing a line by tapping: a key held while each sung piece is sung (down: it starts; up: it
 * ends), the pieces in order. What was not tapped keeps the time it had.
 */
export class TapAlong {
  readonly #count: number;
  readonly #taps: [number, number | null][] = [];

  constructor(sungPieces: number) {
    this.#count = sungPieces;
  }

  /** The key went down at song time `t`: the next piece starts. */
  down(t: number): void {
    if (this.done) return;
    const open = this.#taps.at(-1);
    // A key that went down again without coming up ends the last piece here.
    if (open !== undefined && open[1] === null) open[1] = t;
    this.#taps.push([t, null]);
  }

  /** The key came up at `t`: the piece being held ends. */
  up(t: number): void {
    const open = this.#taps.at(-1);
    if (open !== undefined && open[1] === null) open[1] = Math.max(t, open[0] + MIN_LEN_S);
  }

  /** Pieces tapped so far (started). */
  get tapped(): number {
    return this.#taps.length;
  }

  get done(): boolean {
    return this.#taps.length >= this.#count && this.#taps.at(-1)?.[1] !== null;
  }

  /**
   * The sung pieces' times: the tapped ones as tapped (one still held ends at `now`), the rest as
   * they were (`before`).
   */
  times(before: readonly (readonly [number, number] | null)[], now: number): ((readonly [number, number]) | null)[] {
    return Array.from({ length: this.#count }, (_, j) => {
      const tap = this.#taps[j];
      if (tap === undefined) return before[j] ?? null;
      return [tap[0], tap[1] ?? Math.max(now, tap[0] + MIN_LEN_S)] as const;
    });
  }
}

/** The sung pieces' times as they are (`null` for an untimed one). */
export function sungTimes(pieces: readonly WorkersKaraokePiece[]): ((readonly [number, number]) | null)[] {
  return pieces
    .filter((p) => p.sung)
    .map((p) => (p.start !== null && p.end !== null ? ([p.start, p.end] as const) : null));
}

// ---- words ------------------------------------------------------------------------------------------

/** What a line's state is called, and whether it wants a look (listed first). */
export function lineFlags(line: WorkersKaraokeLineV2): { words: string[]; look: boolean } {
  const words: string[] = [];
  if (line.edited) words.push("已改");
  if (!line.edited && line.source === "heard") words.push("聽寫");
  if (!line.edited && line.status === "uncertain" && line.source === "found") words.push("不確定");
  if (!line.edited && line.status === "failed") words.push("對不上");
  if (!line.aligned && line.text.trim() !== "") words.push("沒有逐字");
  const look =
    !line.edited && (line.source === "heard" || line.status === "uncertain" || line.status === "failed");
  return { words, look };
}

const NAMES = ["C", "C♯", "D", "D♯", "E", "F", "F♯", "G", "G♯", "A", "A♯", "B"];

/** `C4`, `A♯3`; with the cents off the nearest note when there are any (`C4 +20`). */
export function midiName(midi: number): string {
  const near = Math.round(midi);
  const cents = Math.round((midi - near) * 100);
  const name = `${NAMES[((near % 12) + 12) % 12]}${Math.floor(near / 12) - 1}`;
  return cents === 0 ? name : `${name} ${cents > 0 ? "+" : "−"}${Math.abs(cents)}`;
}

/** `1:05.32` */
export function clockOf(t: number): string {
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${m}:${s < 10 ? "0" : ""}${s.toFixed(2)}`;
}

/** Lines in the order they are listed: those that want a look first when `lookFirst`, else by time. */
export function lineOrder(lines: readonly WorkersKaraokeLineV2[], lookFirst: boolean): number[] {
  const all = lines.map((_, i) => i);
  if (!lookFirst) return all;
  const look = all.filter((i) => lineFlags(lines[i] as WorkersKaraokeLineV2).look);
  return [...look, ...all.filter((i) => !look.includes(i))];
}
