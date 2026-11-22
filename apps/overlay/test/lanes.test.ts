import { describe, expect, it } from "vitest";
import type { KaraokeLine, KaraokeMember, KaraokeNote } from "../src/feed.js";
import { lineKey } from "../src/karaoke.js";
import {
  foldOctave,
  LANE_HZ,
  LANE_KEEP_S,
  LANE_NOW_AT,
  LANE_RANGE_MIN,
  LANE_SPAN_S,
  LaneTracks,
  LANES_MAX,
  laneHeight,
  laneRange,
  laneSingers,
  laneWindow,
  laneX,
  laneY,
  noteNear,
  notesIn,
  strokes,
} from "../src/lanes.js";

const member = (name: string, color: number, role: "singer" | "spectator" = "singer"): KaraokeMember => ({
  name,
  color,
  role,
  ready: true,
  opener: false,
});

const line = (name: string, color: number, extra: Partial<KaraokeLine> = {}): KaraokeLine => ({
  name,
  color,
  rank: 1,
  total: 80,
  source: "voice",
  move: "same",
  winner: false,
  coins: 0,
  finished: false,
  onAir: false,
  parts: null,
  pitch: null,
  cheers: 0,
  ...extra,
});

const NOTES: KaraokeNote[] = [
  { start: 1, end: 1.5, midi: 64 },
  { start: 1.6, end: 2.2, midi: 67 },
  { start: 4, end: 5, midi: 60 },
];

describe("who gets a lane", () => {
  it("the round's singers in the order they came, then the board's others, at most eight, with their scores", () => {
    const members = [member("Mia", 0), member("阿翔", 3, "spectator"), member("Kai", 2), member("Mia", 5)];
    const board = [
      line("Kai", 2, { total: 90.04, cheers: 3 }),
      line("Mia", 0, { total: null, rank: null }),
      line("走了的人", 1, { rank: 2 }),
    ];
    const lanes = laneSingers(members, board);
    // The second Mia chose to sing but is not in the round: no lane.
    expect(lanes.map((l) => [l.name, l.color, l.total, l.rank, l.cheers])).toEqual([
      ["Mia", 0, null, null, 0],
      ["Kai", 2, 90.04, 1, 3],
      ["走了的人", 1, 80, 2, 0],
    ]);
    // Before the round's board, whoever chose to sing.
    expect(laneSingers(members, []).map((l) => l.color)).toEqual([0, 2, 5]);
    expect(lanes[0]?.key).toBe(lineKey({ name: "Mia", color: 0 }));
    const crowd = Array.from({ length: 12 }, (_, i) => member(`唱 ${i}`, i % 8));
    expect(laneSingers(crowd, [])).toHaveLength(LANES_MAX);
    expect(laneSingers([member("阿翔", 3, "spectator")], [])).toEqual([]);
  });

  it("stacks one big lane, two to four of about 150 px, and up to eight that share the column", () => {
    expect(laneHeight(0, 34, 0.5)).toBe(0);
    expect(laneHeight(1, 34, 0.5)).toBe(15);
    expect(laneHeight(3, 34, 0.5)).toBe(9.5);
    const eight = laneHeight(8, 34, 0.5);
    expect(eight * 8 + 0.5 * 7).toBeCloseTo(34, 9);
    // 1080p: 16 px a rem.
    expect(eight * 16).toBeGreaterThan(60);
  });
});

describe("a lane's geometry", () => {
  it("scrolls with now a quarter of the way in, and holds still a page at a time under reduced motion", () => {
    const win = laneWindow(30, false);
    expect(win).toEqual({ from: 30 - LANE_NOW_AT * LANE_SPAN_S, to: 30 + (1 - LANE_NOW_AT) * LANE_SPAN_S, nowAt: LANE_NOW_AT });
    expect(laneX(30, win, 1000)).toBeCloseTo(250, 9);
    expect(laneX(win.to, win, 1000)).toBeCloseTo(1000, 9);
    const still = laneWindow(23, true);
    expect(still).toEqual({ from: 20, to: 30, nowAt: 0.3 });
    // The page does not move while the song is in it.
    expect(laneWindow(27, true).from).toBe(20);
  });

  it("spans the round's notes with a margin, at least a set range, and keeps points inside", () => {
    // 57..70 is narrower than the least range: one more semitone above.
    expect(laneRange(NOTES)).toEqual({ lo: 57, hi: 71 });
    expect(laneRange([])).toEqual({ lo: 60 - LANE_RANGE_MIN / 2, hi: 60 + LANE_RANGE_MIN / 2 });
    const wide = laneRange([
      { start: 0, end: 1, midi: 48.5 },
      { start: 1, end: 2, midi: 79.2 },
    ]);
    expect(wide).toEqual({ lo: 45, hi: 83 });
    const range = { lo: 50, hi: 70 };
    expect(laneY(70, range, 100, 0)).toBe(0);
    expect(laneY(50, range, 100, 0)).toBe(100);
    expect(laneY(60, range, 100, 0)).toBe(50);
    expect(laneY(99, range, 100, 4)).toBe(4);
    expect(laneY(10, range, 100, 4)).toBe(96);
  });

  it("finds the notes in view and the note a point belongs to", () => {
    expect(notesIn(NOTES, 1.45, 3).map((n) => n.midi)).toEqual([64, 67]);
    expect(notesIn(NOTES, 1.55, 3).map((n) => n.midi)).toEqual([67]);
    expect(notesIn(NOTES, 6, 9)).toEqual([]);
    expect(noteNear(NOTES, 1.7)?.midi).toBe(67);
    expect(noteNear(NOTES, 1.53)?.midi).toBe(64);
    expect(noteNear(NOTES, 3.4)?.midi).toBe(60);
    expect(noteNear(NOTES, 9)).toBeNull();
    expect(foldOctave(52.3, 64)).toBeCloseTo(64.3, 9);
    expect(foldOctave(77, 67)).toBe(65);
  });
});

describe("a singer's line from the boards", () => {
  const key = lineKey({ name: "Mia", color: 0 });

  it("puts the pieces together on the song clock, a later piece replacing what it covers", () => {
    const tracks = new LaneTracks();
    // Frames 50..: song second 1.0 on; the first board says 64 for a second.
    tracks.take([line("Mia", 0, { pitch: { from: 50, midi: Array(50).fill(64) } })]);
    // The next one starts half a second in and says 65 (a late correction) for a second.
    tracks.take([line("Mia", 0, { pitch: { from: 75, midi: Array(50).fill(65) } })]);
    const points = tracks.line(key, 0, 3, []);
    expect(points[0]).toEqual({ t: 1, midi: 64 });
    expect(points.find((p) => p.t === 1.48)?.midi).toBe(64);
    expect(points.find((p) => p.t === 1.5)?.midi).toBe(65);
    expect(points.at(-1)).toEqual({ t: (75 + 49) / LANE_HZ, midi: 65 });
    // Nothing past the newest frame, and only what is asked for.
    expect(tracks.line(key, 1.2, 1.3, []).map((p) => p.t)).toEqual([1.2, 1.22, 1.24, 1.26, 1.28, 1.3]);
    expect(tracks.line("nobody", 0, 3, [])).toEqual([]);
  });

  it("fills a short gap with silence, starts over after a long one, and ignores a piece older than it keeps", () => {
    const tracks = new LaneTracks();
    tracks.put(key, { from: 0, midi: [60, 60] });
    tracks.put(key, { from: 10, midi: [62] });
    expect(tracks.line(key, 0, 1, []).map((p) => p.midi)).toEqual([60, 60, null, null, null, null, null, null, null, null, 62]);
    // A long silence: the old frames are dropped.
    const far = 10 + LANE_HZ * LANE_KEEP_S * 2;
    tracks.put(key, { from: far, midi: [64] });
    expect(tracks.line(key, 0, far / LANE_HZ, []).map((p) => p.midi)).toEqual([64]);
    // A piece from before what is kept, ending before it: too old, nothing changes.
    tracks.put(key, { from: 0, midi: [70] });
    expect(tracks.line(key, 0, far / LANE_HZ, []).map((p) => p.midi)).toEqual([64]);
  });

  it("keeps only the last few seconds", () => {
    const tracks = new LaneTracks();
    for (let s = 0; s < 30; s++) tracks.put(key, { from: s * LANE_HZ, midi: Array(LANE_HZ).fill(60 + (s % 3)) });
    const all = tracks.line(key, 0, 100, []);
    expect(all).toHaveLength(LANE_KEEP_S * LANE_HZ);
    expect(all[0]?.t).toBe(30 - LANE_KEEP_S);
  });

  it("folds each point into the octave of the note near it, and breaks the line at a rest or a jump", () => {
    const tracks = new LaneTracks();
    // Sung an octave low over the 64 and 67, then a frame unvoiced, then a big jump.
    tracks.put(key, { from: 50, midi: [52, 52.25, 55, null, 55, 58.5] });
    const points = tracks.line(key, 0, 2, NOTES);
    expect(points.map((p) => p.midi)).toEqual([64, 64.25, 67, null, 67, 58.5]);
    const runs = strokes(points);
    expect(runs.map((r) => r.map((p) => p.midi))).toEqual([[64, 64.25, 67], [67], [58.5]]);
    expect(tracks.keys()).toEqual([key]);
    tracks.clear();
    expect(tracks.line(key, 0, 2, NOTES)).toEqual([]);
  });
});
