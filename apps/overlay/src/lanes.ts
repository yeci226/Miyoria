// The karaoke scene's pitch lanes (docs/design/karaoke.md §7.1): one lane per singer, the round's
// reference notes scrolling from right to left past a "now" line a quarter of the way in, and the
// singer's own pitch drawn in their colour. Pure (no DOM): which singers get a lane, the pieces of
// pitch the boards bring put together per singer, and where a note or a point goes on a lane.
// src/lanes-view.ts paints it.
//
// The boards come about once a second, each with about 1.5 s of a singer's latest pitch from a
// frame `from` on (50 Hz song time); a later board's piece replaces what earlier ones said from
// its first frame on. Everything is drawn on the scene's song clock (the stream's delayed one, the
// same as the lyrics and the backing), so a singer's line lands on the notes as it was sung.

import type { KaraokeLine, KaraokeMember, KaraokeNote, KaraokePitch } from "./feed.js";
import { lineKey } from "./karaoke.js";

/** Frames per second of a board's pitch. */
export const LANE_HZ = 50;
/** Most lanes the scene draws. */
export const LANES_MAX = 8;
/** Seconds across a lane, and where "now" sits on it (a share of its width from the left). */
export const LANE_SPAN_S = 10;
export const LANE_NOW_AT = 0.25;
/** Seconds of a singer's pitch kept behind the newest frame (more than a lane shows of the past). */
export const LANE_KEEP_S = 6;
/** Semitones kept above and below the round's notes, and the smallest range a lane shows. */
export const LANE_MARGIN = 3;
export const LANE_RANGE_MIN = 14;
/** A gap in a singer's line: a jump of this many semitones, or a frame not voiced. */
export const LANE_JUMP = 5;
/** A note this close in time (s) still sets the octave a point is folded into. */
const FOLD_NEAR_S = 1.5;

/** One singer with a lane: the key their pitch is kept under, their name and colour. */
export interface LaneSinger {
  key: string;
  name: string;
  color: number;
  /** Their running score on the board, or `null` (none yet, or no board). */
  total: number | null;
  /** Their place on the board (`null`: none yet), and the cheers they got. */
  rank: number | null;
  cheers: number;
}

/**
 * The singers that get a lane: the round's singers (its board) in the order they came into the
 * room (the lanes stay put when ranks change), then anyone on the board who is not a member any
 * more; before there is a board, the members who chose to sing. At most `LANES_MAX`. A member who
 * chose to sing but is not in the round (not ready when it started) has none.
 */
export function laneSingers(members: readonly KaraokeMember[], board: readonly KaraokeLine[]): LaneSinger[] {
  const lines = new Map(board.map((l) => [lineKey(l), l]));
  const out: LaneSinger[] = [];
  const seen = new Set<string>();
  const add = (name: string, color: number): void => {
    const key = lineKey({ name, color });
    if (seen.has(key) || out.length >= LANES_MAX) return;
    seen.add(key);
    const line = lines.get(key);
    out.push({
      key,
      name,
      color,
      total: line?.total ?? null,
      rank: line?.total == null ? null : (line.rank ?? null),
      cheers: line?.cheers ?? 0,
    });
  };
  for (const m of members) {
    if (m.role === "singer" && (board.length === 0 || lines.has(lineKey(m)))) add(m.name, m.color);
  }
  for (const l of board) add(l.name, l.color);
  return out;
}

/** A lane's pitch range: the round's notes with a margin, at least `LANE_RANGE_MIN`, whole semitones. */
export function laneRange(notes: readonly KaraokeNote[]): { lo: number; hi: number } {
  if (notes.length === 0) return { lo: 60 - LANE_RANGE_MIN / 2, hi: 60 + LANE_RANGE_MIN / 2 };
  let lo = Number.POSITIVE_INFINITY;
  let hi = Number.NEGATIVE_INFINITY;
  for (const n of notes) {
    lo = Math.min(lo, n.midi);
    hi = Math.max(hi, n.midi);
  }
  lo = Math.floor(lo) - LANE_MARGIN;
  hi = Math.ceil(hi) + LANE_MARGIN;
  if (hi - lo < LANE_RANGE_MIN) {
    const grow = LANE_RANGE_MIN - (hi - lo);
    lo -= Math.floor(grow / 2);
    hi += Math.ceil(grow / 2);
  }
  return { lo, hi };
}

/**
 * The song seconds a lane shows at song time `now` and where "now" is on it (0..1 of the width).
 * The lane scrolls; under reduced motion it holds still a page at a time and the now line moves.
 */
export function laneWindow(now: number, reduced: boolean): { from: number; to: number; nowAt: number } {
  if (!reduced) {
    const from = now - LANE_NOW_AT * LANE_SPAN_S;
    return { from, to: from + LANE_SPAN_S, nowAt: LANE_NOW_AT };
  }
  const from = Math.floor(now / LANE_SPAN_S) * LANE_SPAN_S;
  return { from, to: from + LANE_SPAN_S, nowAt: (now - from) / LANE_SPAN_S };
}

/** The x of song time `t` on a lane `width` wide showing `from`..`to`. */
export function laneX(t: number, win: { from: number; to: number }, width: number): number {
  return ((t - win.from) / (win.to - win.from)) * width;
}

/** The y of a MIDI note on a lane `height` tall (the top is `hi`), clamped to the lane, with `pad` above and below. */
export function laneY(midi: number, range: { lo: number; hi: number }, height: number, pad = 4): number {
  const m = Math.min(range.hi, Math.max(range.lo, midi));
  return pad + (height - 2 * pad) * (1 - (m - range.lo) / (range.hi - range.lo));
}

/** The notes that reach into `from`..`to` (`notes` in time order). */
export function notesIn(notes: readonly KaraokeNote[], from: number, to: number): KaraokeNote[] {
  const out: KaraokeNote[] = [];
  for (const n of notes) {
    if (n.start > to) break;
    if (n.end >= from) out.push(n);
  }
  return out;
}

/** The note sung at `t`, else the nearest within `FOLD_NEAR_S`, else `null`. */
export function noteNear(notes: readonly KaraokeNote[], t: number): KaraokeNote | null {
  let best: KaraokeNote | null = null;
  let bestGap = FOLD_NEAR_S;
  for (const n of notes) {
    if (n.start - t > FOLD_NEAR_S) break;
    const gap = t < n.start ? n.start - t : t > n.end ? t - n.end : 0;
    if (gap <= bestGap) {
      best = n;
      bestGap = gap;
      if (gap === 0) break;
    }
  }
  return best;
}

/** `midi` moved by whole octaves to sit nearest `ref` (people sing an octave off). */
export function foldOctave(midi: number, ref: number): number {
  return midi + 12 * Math.round((ref - midi) / 12);
}

/** One point of a singer's line: song seconds and MIDI (folded), `null` where nothing is voiced. */
export interface LanePoint {
  t: number;
  midi: number | null;
}

/**
 * Each singer's pitch, put together from the boards' pieces. A frame no piece has said anything
 * about is unknown (`undefined`), not silent: the notes' judging leaves it out.
 */
export class LaneTracks {
  /** Per singer: the frame of `frames[0]` and the frames from there. */
  readonly #tracks = new Map<string, { start: number; frames: (number | null | undefined)[] }>();

  /** One board's lines: each piece replaces what was kept from its first frame on. */
  take(board: readonly KaraokeLine[]): void {
    for (const line of board) if (line.pitch !== null) this.put(lineKey(line), line.pitch);
  }

  /** One singer's piece. */
  put(key: string, piece: KaraokePitch): void {
    const keep = LANE_KEEP_S * LANE_HZ;
    const old = this.#tracks.get(key);
    let track = old;
    // Nothing kept, or what is kept is too far from this piece to be one line with it: start over.
    if (track === undefined || piece.from < track.start || piece.from > track.start + track.frames.length + keep) {
      if (track !== undefined && piece.from < track.start && piece.from + piece.midi.length < track.start) return;
      track = { start: piece.from, frames: [] };
    }
    const at = piece.from - track.start;
    const frames = track.frames;
    while (frames.length < at) frames.push(undefined);
    frames.length = at;
    for (const m of piece.midi) frames.push(m);
    // Only the last few seconds are drawn.
    const drop = frames.length - keep;
    if (drop > 0) {
      frames.splice(0, drop);
      track.start += drop;
    }
    this.#tracks.set(key, track);
  }

  /**
   * A singer's line from `from` to `to` song seconds, each point folded into the octave of the
   * note near it (`notes` in time order); a point with no note near keeps its octave.
   */
  line(key: string, from: number, to: number, notes: readonly KaraokeNote[]): LanePoint[] {
    const track = this.#tracks.get(key);
    if (track === undefined) return [];
    const near = notesIn(notes, from - FOLD_NEAR_S, to + FOLD_NEAR_S);
    const a = Math.max(track.start, Math.ceil(from * LANE_HZ));
    const b = Math.min(track.start + track.frames.length - 1, Math.floor(to * LANE_HZ));
    const out: LanePoint[] = [];
    for (let i = a; i <= b; i++) {
      const t = i / LANE_HZ;
      const m = track.frames[i - track.start];
      if (m === null || m === undefined) {
        out.push({ t, midi: null });
        continue;
      }
      const note = noteNear(near, t);
      out.push({ t, midi: note === null ? m : foldOctave(m, note.midi) });
    }
    return out;
  }

  /** Frame `i` (50 Hz song time) of a singer: MIDI, `null` silent, `undefined` not known. */
  frame(key: string, i: number): number | null | undefined {
    const track = this.#tracks.get(key);
    if (track === undefined) return undefined;
    return track.frames[i - track.start];
  }

  /** The singers with any pitch kept. */
  keys(): string[] {
    return [...this.#tracks.keys()];
  }

  /** A new round: nothing is kept. */
  clear(): void {
    this.#tracks.clear();
  }
}

/**
 * The runs of a line to draw as one stroke each: points next to each other (one frame apart),
 * both voiced, within `LANE_JUMP` semitones.
 */
export function strokes(points: readonly LanePoint[]): LanePoint[][] {
  const out: LanePoint[][] = [];
  let run: LanePoint[] = [];
  let prev: LanePoint | null = null;
  for (const p of points) {
    const joins =
      prev !== null &&
      prev.midi !== null &&
      p.midi !== null &&
      p.t - prev.t <= 1.5 / LANE_HZ &&
      Math.abs(p.midi - prev.midi) < LANE_JUMP;
    if (!joins && run.length > 0) {
      out.push(run);
      run = [];
    }
    if (p.midi !== null) run.push(p);
    prev = p;
  }
  if (run.length > 0) out.push(run);
  return out;
}

/** The height of one lane (rem) for `n` lanes in a column `room` rem tall with `gap` rem between them. */
export function laneHeight(n: number, room: number, gap: number): number {
  if (n <= 0) return 0;
  // One singer gets a big lane, two to four about 150 px each (at 1080p), more share the column.
  const most = n === 1 ? 15 : n <= 4 ? 9.5 : room;
  return Math.min(most, (room - gap * (n - 1)) / n);
}
