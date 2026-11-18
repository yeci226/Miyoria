import { describe, expect, it } from "vitest";
import { type KaraokeScene, parseMessage, initialState, reduce } from "../src/feed.js";
import {
  airText,
  boardRanks,
  boardRows,
  clockText,
  coinsText,
  countdownLeft,
  karaokeMode,
  lobbyMembers,
  lobbyStatus,
  lyricsFor,
  memberSwatch,
  resultTail,
  roundsLeftText,
  scoreText,
  songProgress,
} from "../src/karaoke.js";
import {
  anchorBase,
  audioSongMs,
  base64Bytes,
  bytesBase64,
  decodeMulaw,
  duckedGain,
  encodeMulaw,
  MULAW_TABLE,
  needsReanchor,
  pcm16le,
  placeSound,
  REANCHOR_MS,
  START_LEAD_S,
  VOICE_AHEAD_S,
} from "../src/karaoke-audio.js";
import { demoBacking, demoLyrics, demoVoice } from "../src/karaoke-demo.js";
import { CLOCK_EASE_MS, CLOCK_JUMP_MS, SongClock } from "../src/song-clock.js";

/** A `karaoke` frame as the Stage sends it. */
function wire(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "karaoke",
    room: "K7PQ2M",
    state: "singing",
    round: 2,
    rounds_left: 2,
    song: { id: "yt-abc", title: "夜に駆ける", artist: "YOASOBI", duration_ms: 261_000 },
    shift: -2,
    members: [
      { name: "Mia", color: 0, role: "singer", ready: true, opener: true },
      { name: "阿翔", color: 6, role: "spectator", ready: false, opener: false },
    ],
    position_ms: 12_500,
    board: [
      { name: "Mia", color: 0, rank: 1, total: 81.44, source: "voice", move: "up", winner: false, coins: 0, finished: false, on_air: true },
    ],
    note: null,
    currency: "魚幣",
    air: { backing: true, relay: "Mia", delay_ms: 2000, backing_gain: 0.8, voice_gain: 1.5, duck_gain: 0.35 },
    ...extra,
  };
}

const parse = (v: unknown) => parseMessage(JSON.stringify(v));

function scene(extra: Partial<KaraokeScene> = {}): KaraokeScene {
  const m = parse(wire());
  if (m?.type !== "karaoke" || m.scene === null) throw new Error("fixture");
  return { ...m.scene, ...extra };
}

describe("karaoke frames", () => {
  it("reads the scene into the overlay's own shape", () => {
    expect(parse(wire())).toEqual({
      type: "karaoke",
      scene: {
        room: "K7PQ2M",
        state: "singing",
        round: 2,
        roundsLeft: 2,
        song: { id: "yt-abc", title: "夜に駆ける", artist: "YOASOBI", durationMs: 261_000 },
        shift: -2,
        members: [
          { name: "Mia", color: 0, role: "singer", ready: true, opener: true },
          { name: "阿翔", color: 6, role: "spectator", ready: false, opener: false },
        ],
        positionMs: 12_500,
        board: [
          { name: "Mia", color: 0, rank: 1, total: 81.44, source: "voice", move: "up", winner: false, coins: 0, finished: false, onAir: true },
        ],
        note: null,
        currency: "魚幣",
        air: { backing: true, relay: "Mia", delayMs: 2000, backingGain: 0.8, voiceGain: 1.5, duckGain: 0.35 },
      },
    });
  });

  it("room null ends the scene; a frame without a room code or state is skipped", () => {
    expect(parse({ type: "karaoke", room: null, state: null })).toEqual({ type: "karaoke", scene: null });
    expect(parse(wire({ room: "" }))).toBeNull();
    expect(parse(wire({ room: "X".repeat(13) }))).toBeNull();
    expect(parse(wire({ room: 7 }))).toBeNull();
    expect(parse(wire({ state: "closed" }))).toBeNull();
    expect(parse(wire({ state: undefined }))).toBeNull();
  });

  it("drops odd members and lines one by one, and clamps the rest", () => {
    const m = parse(
      wire({
        members: [{ name: "" }, "Mia", { name: " Kai ", color: 99, role: "boss" }, null],
        board: [{ name: "Kai", rank: 0, total: 500, source: "magic", move: "sideways", coins: -3 }, { total: 1 }],
        position_ms: "soon",
        shift: 40,
        song: { title: "  " },
        note: "  ",
        air: "nope",
      }),
    );
    expect(m?.type === "karaoke" && m.scene).toMatchObject({
      members: [{ name: "Kai", color: 0, role: "singer", ready: false, opener: false }],
      board: [{ name: "Kai", rank: null, total: null, source: null, move: "same", coins: 0, winner: false, finished: false, onAir: false }],
      positionMs: null,
      shift: 0,
      song: null,
      note: null,
      air: { backing: false, relay: null, delayMs: 0, backingGain: 0, voiceGain: 0, duckGain: 0 },
    });
  });

  it("reads a round's words, keeping only usable lines and pieces, in time order", () => {
    const m = parse({
      type: "karaoke_lyrics",
      room: "K7PQ2M",
      round: 2,
      song: "yt-abc",
      video: "karaoke/video?r=K7PQ2M-2",
      lyrics: {
        provider: "lrclib",
        source: "heard",
        language: "ja",
        timing: "char",
        check: null,
        lines: [
          { start: 9, end: 12, text: "二", status: "matched", source: "heard", aligned: false, pieces: null },
          {
            start: 4,
            end: 8,
            text: "星の",
            status: "weird",
            aligned: true,
            pieces: [
              { text: "星", sung: true, start: 4, end: 5, reading: "ほし", roman: "hoshi" },
              { text: "の", sung: true, start: 5, end: 6, reading: null, roman: "no" },
            ],
          },
          { start: "x", text: "bad" },
          { start: 13, text: "piece broken", aligned: true, pieces: [{ text: 3 }] },
        ],
      },
    });
    if (m?.type !== "karaoke_lyrics") throw new Error("not parsed");
    expect(m.lyrics).toMatchObject({ room: "K7PQ2M", round: 2, song: "yt-abc", video: "karaoke/video?r=K7PQ2M-2" });
    const lines = m.lyrics.lyrics?.lines ?? [];
    expect(lines.map((l) => l.start)).toEqual([4, 9, 13]);
    expect(lines[0]).toMatchObject({ status: "unchecked", source: "found", aligned: true });
    expect(lines[0]?.pieces?.[0]).toEqual({ text: "星", sung: true, start: 4, end: 5, reading: "ほし", roman: "hoshi" });
    // A line whose pieces are not all pieces shows as its text, never wiped.
    expect(lines[2]).toMatchObject({ pieces: null, aligned: false, text: "piece broken" });
    expect(m.lyrics.lyrics?.source).toBe("heard");
  });

  it("skips words without their round, and takes no video it cannot load", () => {
    expect(parse({ type: "karaoke_lyrics", room: "K7PQ2M", round: 0, lyrics: null, video: null })).toBeNull();
    expect(parse({ type: "karaoke_lyrics", round: 1, lyrics: null, video: null })).toBeNull();
    const words = (video: unknown) => {
      const m = parse({ type: "karaoke_lyrics", room: "K7PQ2M", round: 1, song: "s", lyrics: "garbage", video });
      return m?.type === "karaoke_lyrics" ? m.lyrics : null;
    };
    expect(words(null)).toMatchObject({ lyrics: null, video: null });
    expect(words("javascript:alert(1)")?.video).toBeNull();
    expect(words("data:video/mp4;base64,AAAA")?.video).toBeNull();
    expect(words(42)?.video).toBeNull();
    expect(words("http://127.0.0.1:7884/overlay/karaoke/video?r=x")?.video).toBe(
      "http://127.0.0.1:7884/overlay/karaoke/video?r=x",
    );
  });

  it("is not part of the reduced state: the overlay is as before", () => {
    const s = initialState();
    const m = parse(wire());
    if (m === null) throw new Error("not parsed");
    expect(reduce(s, m)).toBe(s);
  });
});

describe("the song clock", () => {
  it("has no time without a round, and runs on from a frame", () => {
    const c = new SongClock();
    expect(c.at(0)).toBeNull();
    c.update(-3_000, 1_000);
    expect(c.at(1_000)).toBe(-3_000);
    expect(c.at(2_500)).toBe(-1_500);
    c.reset();
    expect(c.at(3_000)).toBeNull();
  });

  it("eases a small difference away and never runs backwards", () => {
    const c = new SongClock();
    c.update(10_000, 0);
    // The next frame says the song is 120 ms behind what the page shows.
    c.update(10_880, 1_000);
    expect(c.at(1_000)).toBe(11_000);
    let last = c.at(1_000) as number;
    for (let t = 1_016; t <= 1_000 + CLOCK_EASE_MS; t += 16) {
      const now = c.at(t) as number;
      expect(now).toBeGreaterThan(last);
      last = now;
    }
    expect(c.at(1_000 + CLOCK_EASE_MS)).toBe(10_880 + CLOCK_EASE_MS);
    expect(c.at(5_000)).toBe(10_880 + 4_000);
  });

  it("jumps to a frame that is far off (a seek, a stall)", () => {
    const c = new SongClock();
    c.update(10_000, 0);
    c.update(10_000 + 1_000 + CLOCK_JUMP_MS + 1, 1_000);
    expect(c.at(1_000)).toBe(10_000 + 1_000 + CLOCK_JUMP_MS + 1);
    c.update(2_000, 2_000);
    expect(c.at(2_000)).toBe(2_000);
  });
});

describe("what of the room shows", () => {
  it("nothing without a room or the section, a plate in the lobby, the scene for a round", () => {
    expect(karaokeMode(null, true)).toBe("none");
    expect(karaokeMode(scene({ state: "lobby" }), false)).toBe("none");
    expect(karaokeMode(scene({ state: "lobby" }), true)).toBe("lobby");
    for (const state of ["countdown", "singing", "results"] as const) {
      expect(karaokeMode(scene({ state }), true)).toBe("stage");
    }
  });

  it("counts down whole seconds and runs the song's bar", () => {
    expect(countdownLeft(null)).toBeNull();
    expect(countdownLeft(-5_400)).toBe(6);
    expect(countdownLeft(-1)).toBe(1);
    expect(countdownLeft(0)).toBeNull();
    expect(songProgress(-500, 10_000)).toBe(0);
    expect(songProgress(2_500, 10_000)).toBe(0.25);
    expect(songProgress(20_000, 10_000)).toBe(1);
    expect(songProgress(2_500, null)).toBe(0);
    expect(clockText(65_400)).toBe("1:05");
    expect(clockText(-200)).toBe("0:00");
    expect(clockText(null)).toBe("—");
  });

  it("says what the lobby waits for, singers first", () => {
    const m = (name: string, role: "singer" | "spectator", ready = false) => ({ name, color: 0, role, ready, opener: false });
    const song = scene().song;
    expect(lobbyStatus({ members: [m("阿翔", "spectator")], song })).toBe("等人加入");
    expect(lobbyStatus({ members: [m("Mia", "singer")], song: null })).toBe("等開房的人選歌");
    expect(lobbyStatus({ members: [m("Mia", "singer", true), m("Kai", "singer")], song })).toBe("等大家準備好(1/2)");
    expect(lobbyStatus({ members: [m("Mia", "singer", true), m("阿翔", "spectator")], song })).toBe("都準備好了,等開房的人按開始");
    expect(lobbyMembers([m("阿翔", "spectator"), m("Mia", "singer"), m("Kai", "singer")]).map((x) => x.name)).toEqual([
      "Mia",
      "Kai",
      "阿翔",
    ]);
    expect(roundsLeftText(3)).toBe("還可以唱 3 首");
    expect(roundsLeftText(0)).toBe("這間房的歌都唱完了");
  });

  it("names what the voice channel carries", () => {
    expect(airText({ backing: true, relay: null })).toBe("直播播出:伴奏");
    expect(airText({ backing: true, relay: "Mia" })).toBe("直播播出:伴奏、Mia 的歌聲");
    expect(airText({ backing: false, relay: "Mia" })).toBe("直播播出:Mia 的歌聲");
    expect(airText({ backing: false, relay: null })).toBeNull();
  });

  it("uses a round's words only for that round", () => {
    const words = { room: "K7PQ2M", round: 2, song: "yt-abc", lyrics: null, video: null, backing: null };
    expect(lyricsFor(scene(), words)).toBe(words);
    expect(lyricsFor(scene({ round: 3 }), words)).toBeNull();
    expect(lyricsFor(scene({ room: "ABCDEF" }), words)).toBeNull();
    expect(lyricsFor(null, words)).toBeNull();
  });

  it("writes scores, coins and colours the panel's way", () => {
    expect(scoreText(81.44)).toBe("81.4");
    expect(scoreText(100)).toBe("100.0");
    expect(scoreText(null)).toBe("—");
    expect(coinsText(15, "魚幣")).toBe("+15 魚幣");
    expect(memberSwatch(0)).toEqual({ slot: 1, hollow: false });
    expect(memberSwatch(4)).toEqual({ slot: 5, hollow: false });
    expect(memberSwatch(5)).toEqual({ slot: 1, hollow: true });
    expect(memberSwatch(7)).toEqual({ slot: 3, hollow: true });
    expect(resultTail({ coins: 18, finished: true }, "魚幣")).toBe("+18 魚幣");
    expect(resultTail({ coins: 0, finished: false }, "魚幣")).toBe("沒唱完");
    expect(resultTail({ coins: 0, finished: true }, "魚幣")).toBe("");
  });
});

describe("the board", () => {
  const line = (name: string, color: number, rank: number | null, total: number | null, extra = {}) => ({
    name,
    color,
    rank,
    total,
    source: "voice" as const,
    move: "same" as const,
    winner: false,
    coins: 0,
    finished: false,
    onAir: false,
    ...extra,
  });

  it("goes in rank order, unranked last in the order they came, estimates tagged", () => {
    const rows = boardRows(
      [line("Kai", 2, 2, 70.06), line("貓", 5, null, null), line("Mia", 0, 1, 81.4, { source: "estimate" }), line("阿", 3, null, null)],
      new Map(),
    );
    expect(rows.map((r) => [r.rank, r.name, r.score, r.estimate])).toEqual([
      [1, "Mia", "81.4", true],
      [2, "Kai", "70.1", false],
      [null, "貓", "—", false],
      [null, "阿", "—", false],
    ]);
    // The first board moves nothing.
    expect(rows.every((r) => !r.moved)).toBe(true);
  });

  it("marks the rows whose place changed since the last board, once", () => {
    const first = boardRows([line("Mia", 0, 1, 80), line("Kai", 2, 2, 79)], new Map());
    const swapped = boardRows(
      [line("Mia", 0, 2, 80, { move: "down" }), line("Kai", 2, 1, 81, { move: "up" })],
      boardRanks(first),
    );
    expect(swapped.map((r) => [r.name, r.move, r.moved])).toEqual([
      ["Kai", "up", true],
      ["Mia", "down", true],
    ]);
    // Core may still say "up" a second later; the place did not change, so nothing slides again.
    const held = boardRows([line("Mia", 0, 2, 80, { move: "down" }), line("Kai", 2, 1, 82, { move: "up" })], boardRanks(swapped));
    expect(held.map((r) => r.moved)).toEqual([false, false]);
    // Someone new is not a move.
    const joined = boardRows([line("Kai", 2, 1, 82), line("Mia", 0, 2, 80), line("貓", 5, 3, 60)], boardRanks(held));
    expect(joined.map((r) => r.moved)).toEqual([false, false, false]);
  });

  it("keys a singer by colour and name, so two of the same name stay apart", () => {
    const rows = boardRows([line("Mia", 0, 1, 80), line("Mia", 3, 2, 70)], new Map());
    expect(new Set(rows.map((r) => r.key)).size).toBe(2);
  });
});

describe("the demo's words", () => {
  it("are aligned piece by piece, in order, with readings", () => {
    const words = demoLyrics({
      id: "s",
      title: "t",
      artist: "a",
      language: "ja",
      seconds: 10,
      doubtful: 1,
      lines: [
        [1, [["星", "ほし", "hoshi"], ["の", null, "no"]]],
        [6, [["夜", "よる", "yoru"]]],
      ],
    });
    expect(words.lines.map((l) => [l.text, l.aligned, l.status])).toEqual([
      ["星の", true, "matched"],
      ["夜", true, "uncertain"],
    ]);
    const pieces = words.lines[0]?.pieces ?? [];
    expect(pieces[0]?.start).toBe(1);
    expect((pieces[0]?.end ?? 0) < (pieces[1]?.start ?? 0)).toBe(true);
    expect(pieces[0]?.reading).toBe("ほし");
  });
});

describe("the round's sound on the feed", () => {
  it("reads the backing as the page's URL, and nothing it cannot load", () => {
    const words = (backing: unknown) => {
      const m = parse({ type: "karaoke_lyrics", room: "K7PQ2M", round: 2, song: "s", lyrics: null, video: null, backing });
      return m?.type === "karaoke_lyrics" ? m.lyrics.backing : undefined;
    };
    expect(words({ path: "karaoke/backing?r=K7PQ2M-2", format: "pcm", rate: 48_000 })).toEqual({
      url: "karaoke/backing?r=K7PQ2M-2",
      format: "pcm",
      rate: 48_000,
    });
    expect(words({ path: "karaoke/backing?r=K7PQ2M-2", format: "m4a", rate: 44_100 })?.format).toBe("m4a");
    expect(words(null)).toBeNull();
    expect(words({ path: "javascript:alert(1)", format: "pcm", rate: 48_000 })).toBeNull();
    expect(words({ path: "karaoke/backing?r=x", format: "wav", rate: 48_000 })).toBeNull();
    expect(words({ path: "karaoke/backing?r=x", format: "pcm", rate: 1 })).toBeNull();
  });

  it("reads a voice piece, and skips one without its round, time or audio", () => {
    const voice = { type: "karaoke_voice", room: "K7PQ2M", round: 2, at_ms: 12_250, audio: "/38A" };
    expect(parse(voice)).toEqual({
      type: "karaoke_voice",
      voice: { room: "K7PQ2M", round: 2, atMs: 12_250, audio: "/38A" },
    });
    expect(parse({ ...voice, round: 0 })).toBeNull();
    expect(parse({ ...voice, at_ms: "soon" })).toBeNull();
    expect(parse({ ...voice, audio: "" })).toBeNull();
    expect(parse({ ...voice, audio: "not base64!" })).toBeNull();
    expect(parse({ ...voice, audio: "A".repeat(44_004) })).toBeNull();
    const m = parse(voice);
    if (m === null) throw new Error("not parsed");
    expect(reduce(initialState(), m)).toEqual(initialState());
  });

  it("marks whose voice is on air on the board", () => {
    const rows = boardRows(scene().board, new Map());
    expect(rows[0]?.onAir).toBe(true);
  });
});

describe("the sound's arithmetic", () => {
  it("expands µ-law the G.711 way", () => {
    expect(MULAW_TABLE[0xff]).toBe(0);
    expect(MULAW_TABLE[0x80]).toBeCloseTo(32_124 / 32_768, 6);
    expect(MULAW_TABLE[0x00]).toBeCloseTo(-32_124 / 32_768, 6);
    expect(MULAW_TABLE[0xfe]).toBeCloseTo(8 / 32_768, 6);
    expect(MULAW_TABLE[0x7e]).toBeCloseTo(-8 / 32_768, 6);
    expect([...decodeMulaw(new Uint8Array([0xff, 0x80]))]).toEqual([0, MULAW_TABLE[0x80]]);
  });

  it("encodes back to the nearest step (the demo's voice)", () => {
    for (const x of [0, 0.001, -0.01, 0.1, -0.25, 0.5, -0.9, 1, -1]) {
      const back = MULAW_TABLE[encodeMulaw(x)] as number;
      // µ-law keeps about 1/16 of the size of the value (plus a floor near zero).
      expect(Math.abs(back - x), String(x)).toBeLessThanOrEqual(Math.abs(x) / 16 + 0.0005);
    }
    expect(encodeMulaw(0)).toBe(0xff);
  });

  it("reads base64 and raw s16le", () => {
    const bytes = new Uint8Array([0, 1, 127, 128, 255]);
    expect([...base64Bytes(bytesBase64(bytes))]).toEqual([...bytes]);
    const pcm = new Uint8Array([0x00, 0x40, 0x00, 0xc0, 0xff, 0x7f, 0x01]).buffer;
    expect([...pcm16le(pcm)]).toEqual([0.5, -0.5, 32_767 / 32_768]);
  });

  it("places a sound at its song time on the audio clock", () => {
    // Song time 0 sounds at audio time 10.
    expect(anchorBase(14, 4_000)).toBe(10);
    expect(audioSongMs(12.5, 10)).toBe(2_500);
    // Still ahead: exactly at its place, so pieces that follow each other abut.
    expect(placeSound({ base: 10, startS: 3, duration: 0.25, now: 12 })).toEqual({ when: 13, offset: 0 });
    expect(placeSound({ base: 10, startS: 3.25, duration: 0.25, now: 12 })).toEqual({ when: 13.25, offset: 0 });
    // Already begun: what is left of it, a moment from now.
    const late = placeSound({ base: 10, startS: 3, duration: 0.25, now: 13.1 });
    expect(late?.when).toBeCloseTo(13.1 + START_LEAD_S, 9);
    expect(late?.offset).toBeCloseTo(0.1 + START_LEAD_S, 9);
    // Over, or too far ahead: nothing.
    expect(placeSound({ base: 10, startS: 3, duration: 0.25, now: 13.3 })).toBeNull();
    expect(placeSound({ base: 10, startS: 20, duration: 0.25, now: 13, maxAheadS: VOICE_AHEAD_S })).toBeNull();
    // The backing joined mid-round starts at its place in the song.
    expect(placeSound({ base: 10, startS: 0, duration: 240, now: 70 })?.offset).toBeCloseTo(60 + START_LEAD_S, 9);
  });

  it("starts the sound over only when the clocks are far apart, and dips under her", () => {
    expect(needsReanchor(10_000, 10_000 + REANCHOR_MS)).toBe(false);
    expect(needsReanchor(10_000, 10_000 - REANCHOR_MS - 1)).toBe(true);
    expect(duckedGain(0.8, 0.25, false)).toBe(0.8);
    expect(duckedGain(0.8, 0.25, true)).toBeCloseTo(0.2, 9);
  });

  it("makes the demo's backing and voice", () => {
    const pcm = demoBacking(1);
    expect(pcm.length).toBe(16_000 * 2);
    const lyrics = demoLyrics({ id: "s", title: "t", artist: "a", language: "zh", seconds: 4, doubtful: null, lines: [[1, [["晚", "wǎn", null]]]] });
    const silent = demoVoice(lyrics, 0, 250, false);
    expect(silent.length).toBe(4_000);
    expect(silent.every((b) => b === 0xff)).toBe(true);
    const sung = demoVoice(lyrics, 2_000, 250, false);
    expect(sung.some((b) => b !== 0xff)).toBe(true);
  });
});
