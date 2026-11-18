// Which lyric lines show at a song time, and how far each piece of an aligned line is sung
// (reference.json version 2, docs/design/karaoke.md 「做了什麼第二步」). The member page's singing
// scene and the stream's karaoke scene both draw from this, so the two never disagree about what
// is lit.

import type { WorkersKaraokeLineV2, WorkersKaraokePiece } from "@miyoria/contracts/workers";

/** The lyric line sung at `t` (the last that started) and the one after it. */
export function lyricAt<L extends { start: number; end: number | null }>(
  lines: readonly L[],
  t: number,
): { current: number | null; next: number | null } {
  let current: number | null = null;
  for (let i = 0; i < lines.length; i++) {
    if ((lines[i] as L).start <= t) current = i;
    else break;
  }
  if (current !== null) {
    const line = lines[current] as L;
    // A line that has ended long before the next one starts is not shown as being sung.
    if (line.end !== null && t > line.end + 1) {
      return { current: null, next: current + 1 < lines.length ? current + 1 : null };
    }
  }
  const next = current === null ? (lines.length > 0 ? 0 : null) : current + 1;
  return { current, next: next !== null && next < lines.length ? next : null };
}

/** How far `piece` is sung at `t`, 0..1; `null` when it has no time (shown as the line is). */
export function pieceProgress(piece: WorkersKaraokePiece, t: number): number | null {
  if (piece.start === null || piece.end === null) return null;
  if (t <= piece.start) return 0;
  if (t >= piece.end) return 1;
  return (t - piece.start) / Math.max(0.001, piece.end - piece.start);
}

/**
 * Each piece's progress at `t` for a line that is aligned: an unsung piece (a space, a comma)
 * takes the state of the sung piece before it. `null` for a line without times.
 */
export function lineProgress(line: WorkersKaraokeLineV2, t: number): number[] | null {
  const pieces = line.pieces;
  if (!line.aligned || pieces === null) return null;
  let before = 0;
  return pieces.map((p) => {
    const at = pieceProgress(p, t);
    if (at === null) return before >= 1 ? 1 : 0;
    before = at;
    return at;
  });
}

/** Under reduced motion a piece lights whole as it begins, without the wipe. */
export function stepped(at: number): number {
  return at > 0 ? 1 : 0;
}

/**
 * The share of a piece already sung, as a CSS `clip-path` on the lit copy laid over it: its right
 * edge is where the singing is.
 */
export function fillClip(at: number): string {
  // Past the box on the other three sides, so the outline is not cut.
  const right = at >= 1 ? "-0.2em" : `${Math.round((1 - Math.max(0, at)) * 1000) / 10}%`;
  return `inset(-0.3em ${right} -0.3em -0.2em)`;
}

/**
 * The two lines on the stage at `t`: the line being sung (or, between lines, the one coming, not
 * yet lit) and the one after it. Indices into `lines`.
 */
export function stageLines<L extends { start: number; end: number | null }>(
  lines: readonly L[],
  t: number,
): { main: number | null; second: number | null } {
  const at = lyricAt(lines, t);
  if (at.current !== null) return { main: at.current, second: at.next };
  const main = at.next;
  const second = main !== null && main + 1 < lines.length ? main + 1 : null;
  return { main, second };
}

/**
 * When a line's singing ends: its last timed piece's end when it is aligned (a line's own `end` is
 * often the next line's start), else its `end`.
 */
export function sungEnd(
  line: Pick<WorkersKaraokeLineV2, "start" | "end" | "aligned" | "pieces">,
): number | null {
  if (line.aligned && line.pieces) {
    for (let i = line.pieces.length - 1; i >= 0; i--) {
      const end = line.pieces[i]?.end;
      if (end !== null && end !== undefined) return end;
    }
  }
  return line.end;
}

/** Dots before a line comes in after a rest. */
export const COUNTDOWN_DOTS = 4;

/**
 * How many dots are left before the next line starts (one a second, the last four seconds of a
 * rest of at least that long), or `null` when none show.
 */
export function countdown<L extends { start: number; end: number | null }>(
  lines: readonly L[],
  t: number,
): number | null {
  const at = lyricAt(lines, t);
  if (at.current !== null || at.next === null) return null;
  const next = lines[at.next] as L;
  const before = at.next > 0 ? (lines[at.next - 1] as L) : null;
  // Only after a real rest: a line right after another needs no counting in.
  const restFrom = before === null ? 0 : (before.end ?? before.start);
  if (next.start - restFrom < COUNTDOWN_DOTS) return null;
  const left = next.start - t;
  if (left <= 0 || left > COUNTDOWN_DOTS) return null;
  return Math.ceil(left);
}

/**
 * A found line that did not match what was heard: shown with a light mark, unless a person has
 * since corrected or checked it in the reference editor (`edited`).
 */
export function isDoubtful(line: WorkersKaraokeLineV2): boolean {
  return (
    !line.edited &&
    line.source === "found" &&
    (line.status === "uncertain" || line.status === "failed")
  );
}
