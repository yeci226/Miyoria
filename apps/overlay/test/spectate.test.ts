// The stream's scene as someone watching sees it: cheers read from a frame and shown once, what the
// feed calls out (joins, leaves, a new leader), the intro's line-up, the next song, numbers that
// count up, a singer's mark, and the notes judged from the pitch the frames bring (a frame that did
// not come is not a miss).

import { NoteJudge } from "@miyoria/play/karaoke/score";
import { describe, expect, it } from "vitest";
import { type KaraokeLine, type KaraokeScene, parseMessage } from "../src/feed.js";
import {
  CHEER_WORDS,
  comboText,
  countUp,
  freshCheers,
  happenings,
  happeningText,
  initialOf,
  LEAD_AFTER_MS,
  lineup,
  nextUp,
  phraseNames,
} from "../src/karaoke.js";
import { LANE_HZ, LaneTracks } from "../src/lanes.js";

const parse = (v: unknown) => parseMessage(JSON.stringify(v));

const line = (name: string, color: number, rank: number | null, total: number | null): KaraokeLine => ({
  name,
  color,
  rank,
  total,
  source: total === null ? null : "voice",
  move: "same",
  winner: false,
  coins: 0,
  finished: false,
  onAir: false,
  parts: null,
  pitch: null,
  cheers: 0,
});

function scene(extra: Partial<KaraokeScene> = {}): KaraokeScene {
  return {
    room: "K7PQ2M",
    state: "singing",
    round: 1,
    roundsLeft: 3,
    song: { id: "s", title: "夜に駆ける", artist: "YOASOBI", durationMs: 200_000 },
    shift: 0,
    members: [
      { name: "Mia", color: 0, role: "singer", ready: true, opener: true },
      { name: "Kai", color: 2, role: "singer", ready: true, opener: false },
    ],
    positionMs: 20_000,
    board: [line("Mia", 0, 1, 80), line("Kai", 2, 2, 75)],
    note: null,
    currency: "魚幣",
    air: { backing: false, relay: null, delayMs: 2_000, backingGain: 0, voiceGain: 0, duckGain: 0 },
    queue: [],
    joinUrl: null,
    qrWhileSinging: false,
    settling: null,
    cheers: [],
    ...extra,
  };
}

describe("cheers on the stream", () => {
  it("are read from a frame, odd ones dropped, at most twelve, with each line's count", () => {
    const m = parse({
      type: "karaoke",
      room: "K7PQ2M",
      state: "singing",
      round: 1,
      rounds_left: 3,
      members: [],
      position_ms: 1_000,
      board: [{ name: "Mia", color: 0, rank: 1, total: 70, source: "voice", move: "same", cheers: 4 }],
      currency: "",
      air: {},
      cheers: [
        { id: "c1-1", kind: "wow", to: { name: "Mia", color: 0 }, by: { name: "阿翔", color: 3 } },
        { id: "c1-2", kind: "boo", to: { name: "Mia", color: 0 }, by: { name: "x", color: 1 } },
        { id: "c1-3", kind: "nice", to: { name: "", color: 0 }, by: { name: "x", color: 1 } },
        ...Array.from({ length: 14 }, (_, i) => ({
          id: `c1-${10 + i}`,
          kind: "cheer",
          to: { name: "Mia", color: 0 },
          by: { name: "Fan", color: 9 },
        })),
      ],
    });
    if (m?.type !== "karaoke" || m.scene === null) throw new Error("not parsed");
    expect(m.scene.board[0]?.cheers).toBe(4);
    expect(m.scene.cheers[0]).toEqual({ id: "c1-1", kind: "wow", to: { name: "Mia", color: 0 }, by: { name: "阿翔", color: 3 } });
    // The odd two are dropped; the list stops at twelve; a colour out of range is the first.
    expect(m.scene.cheers).toHaveLength(10);
    expect(m.scene.cheers[1]?.by.color).toBe(0);
    expect(CHEER_WORDS.wow).toBe("太強了");
  });

  it("are shown once each, even when the same frame comes again", () => {
    const seen = new Set<string>();
    const a = { id: "c1-1", kind: "cheer" as const, to: { name: "Mia", color: 0 }, by: { name: "阿翔", color: 3 } };
    const b = { ...a, id: "c1-2" };
    expect(freshCheers(seen, [a])).toEqual([a]);
    expect(freshCheers(seen, [a, b])).toEqual([b]);
    expect(freshCheers(seen, [a, b])).toEqual([]);
  });
});

describe("what the feed calls out", () => {
  it("says who came in (to sing or to watch) and who left, only within one room", () => {
    const before = scene();
    const after = scene({
      members: [
        { name: "Mia", color: 0, role: "singer", ready: true, opener: true },
        { name: "小雨", color: 4, role: "spectator", ready: false, opener: false },
      ],
    });
    const said = happenings(before, after);
    expect(said).toEqual([
      { kind: "join", name: "小雨", color: 4, role: "spectator" },
      { kind: "leave", name: "Kai", color: 2 },
    ]);
    expect(said.map(happeningText)).toEqual(["進來看了", "離開了"]);
    expect(happenings(null, after)).toEqual([]);
    expect(happenings(before, { ...after, room: "TVR8HN" })).toEqual([]);
  });

  it("calls a new leader once the round is under way, not a tie or the first seconds", () => {
    const before = scene();
    const swapped = scene({ board: [line("Kai", 2, 1, 81), line("Mia", 0, 2, 80)] });
    expect(happenings(before, swapped)).toEqual([{ kind: "lead", name: "Kai", color: 2 }]);
    expect(happenings(before, { ...swapped, positionMs: LEAD_AFTER_MS - 1 })).toEqual([]);
    const tie = scene({ board: [line("Kai", 2, 1, 80), line("Mia", 0, 1, 80)] });
    expect(happenings(before, tie)).toEqual([]);
    // Settling, or from nobody leading, is not a change of lead.
    expect(happenings(before, { ...swapped, settling: { waiting: [] } })).toEqual([]);
    expect(happenings(scene({ board: [line("Mia", 0, null, null)] }), swapped)).toEqual([]);
  });
});

describe("the round's intro and what comes next", () => {
  it("lines up the round's singers, or the members who sing before there is a board", () => {
    expect(lineup(scene())).toEqual([
      { name: "Mia", color: 0 },
      { name: "Kai", color: 2 },
    ]);
    expect(lineup(scene({ board: [] }))).toEqual([
      { name: "Mia", color: 0 },
      { name: "Kai", color: 2 },
    ]);
  });

  it("names the next song while a round is on, skipping one that failed", () => {
    const queue = [
      { title: "壞掉的", artist: null, by: "Kai", state: "failed" as const },
      { title: "群青", artist: "YOASOBI", by: "小明", state: "ready" as const },
    ];
    expect(nextUp(scene({ queue }))).toEqual({ title: "群青", by: "小明" });
    expect(nextUp(scene({ queue, state: "results" }))).toBeNull();
    expect(nextUp(scene())).toBeNull();
  });

  it("counts up eased, lands on the number, and marks a singer with a whole first letter", () => {
    expect(countUp(70, 80, 0)).toBe(70);
    expect(countUp(70, 80, 1)).toBe(80);
    expect(countUp(70, 80, 0.5)).toBeGreaterThan(75);
    expect(countUp(70, 80, 2)).toBe(80);
    expect(initialOf("mia")).toBe("M");
    expect(initialOf("  小明")).toBe("小");
    expect(initialOf("👩‍🎤 Kai")).toBe("👩‍🎤");
    expect(comboText(2)).toBeNull();
    expect(comboText(12)).toBe("連續 12");
    expect(phraseNames(["Mia"])).toBe("Mia");
    expect(phraseNames(["Mia", "小明", "Kai"])).toBe("Mia、小明 和 Kai");
    expect(phraseNames(["a", "b", "c", "d"])).toBe("a、b 等 4 人");
  });
});

describe("the notes judged from the frames that came", () => {
  const notes = [
    { start: 1, end: 1.6, midi: 64 },
    { start: 2, end: 2.6, midi: 67 },
    { start: 3, end: 3.6, midi: 60 },
  ];

  it("hits, misses and leaves unjudged what never arrived, an octave off counting as on", () => {
    const tracks = new LaneTracks();
    const piece = (from: number, to: number, midi: (t: number) => number | null) => ({
      from: Math.round(from * LANE_HZ),
      midi: Array.from({ length: Math.round((to - from) * LANE_HZ) }, (_, i) => midi(from + i / LANE_HZ)),
    });
    // The first note an octave down; then a gap no frame covers (a slow link); then silence.
    tracks.put("k", piece(0.8, 1.8, () => 52));
    tracks.put("k", piece(2.9, 3.8, () => null));
    expect(tracks.frame("k", 100)).toBeUndefined();
    expect(tracks.frame("k", 160)).toBeNull();
    const judge = new NoteJudge(notes, { hz: LANE_HZ });
    const got = judge.advance(4, (i) => tracks.frame("k", i));
    expect(got.map((j) => [j.note, j.verdict])).toEqual([
      [0, "perfect"],
      [2, "miss"],
    ]);
  });
});
