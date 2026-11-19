// Rooms (step 4) without a screen: the µ-law encoder and the downsampler the stream worklet runs,
// the chunk scheduler (`at` / `song_ms`, the end, stopping on `estimate`), the pitch posts, the
// clock offset, the trend plate's words, the singer's own number, 結算中, which stage a singer is
// on, the song queue (counts, why adding or starting waits, an entry's preparation), codes and
// addresses, the spectators' lines, and whether a recording is uploaded.

import { describe, expect, it } from "vitest";
import { decodeTrack, encodeTrack, fromBase64, toBase64 } from "@miyoria/play/karaoke/score";
import {
  decodeMulaw,
  Downsampler,
  encodeMulaw,
  mulawFromPcm16,
  pcm16FromMulaw,
  type StreamPiece,
} from "./mulaw";
import { isKaraokePath, roomCodeIn, roomPage } from "./path";
import { clockOffset, contextTimeFor, secondsLeft, songTimeByCore, syncClock } from "./room-clock";
import {
  type AudioChunk,
  BACKLOG_MAX,
  CHUNK_MAX,
  CHUNK_MIN,
  answerOf,
  ChunkScheduler,
  PitchFeed,
  type StreamAnswer,
} from "./room-stream";
import type { KaraokeRoomView, KaraokeSession } from "@miyoria/contracts/api";
import {
  BoardLines,
  canPay,
  canQueue,
  entryState,
  foldOctave,
  type HeldStage,
  memberColor,
  queueBlocked,
  queueCounts,
  readRoomCode,
  settlingView,
  stageOf,
  stageScore,
  startBlocked,
  trendView,
  wantsUpload,
} from "./room-text";

const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

describe("µ-law (G.711)", () => {
  it("encodes the known values", () => {
    expect(mulawFromPcm16(0)).toBe(0xff);
    expect(mulawFromPcm16(32_767)).toBe(0x80);
    expect(mulawFromPcm16(-32_768)).toBe(0x00);
    expect(mulawFromPcm16(1_000)).toBe(0xce);
    expect(mulawFromPcm16(-1_000)).toBe(0x4e);
    expect(pcm16FromMulaw(0xff)).toBe(0);
    expect(pcm16FromMulaw(0x80)).toBe(32_124);
    expect(pcm16FromMulaw(0x00)).toBe(-32_124);
  });

  it("comes back within half a step of its segment", () => {
    for (let x = -32_000; x <= 32_000; x += 37) {
      const byte = mulawFromPcm16(x);
      const exponent = (~byte >> 4) & 7;
      expect(Math.abs(pcm16FromMulaw(byte) - x)).toBeLessThanOrEqual(4 * 2 ** exponent);
    }
  });

  it("encodes float samples one byte each, and a sine survives within a few percent", () => {
    const sine = Float32Array.from({ length: 400 }, (_, i) => 0.6 * Math.sin((2 * Math.PI * i) / 40));
    const bytes = encodeMulaw(sine);
    expect(bytes).toHaveLength(400);
    const back = decodeMulaw(bytes);
    for (let i = 0; i < sine.length; i++) {
      expect(Math.abs((back[i] as number) - (sine[i] as number))).toBeLessThan(0.03 * Math.abs(sine[i] as number) + 0.002);
    }
  });
});

describe("the downsampler", () => {
  const tone = (rate: number, hz: number, n: number) =>
    Float32Array.from({ length: n }, (_, i) => 0.5 * Math.sin((2 * Math.PI * hz * i) / rate));
  const run = (down: Downsampler, input: Float32Array, block = 128) => {
    const out: number[] = [];
    for (let i = 0; i < input.length; i += block) out.push(...down.push(input.subarray(i, i + block)));
    return Float32Array.from(out);
  };

  it("takes 48 kHz to 16 kHz three to one, placing each sample exactly", () => {
    const down = new Downsampler(48_000, 16_000);
    expect(down.step).toBe(3);
    expect(down.inputPosition(100)).toBe(300);
    const out = run(down, tone(48_000, 440, 48_000));
    // All but the kernel's reach past the end.
    expect(out.length).toBeGreaterThan(16_000 - 8);
    expect(out.length).toBeLessThanOrEqual(16_000);
    expect(down.produced).toBe(out.length);
    let worst = 0;
    for (let n = 20; n < out.length; n++) {
      worst = Math.max(worst, Math.abs((out[n] as number) - 0.5 * Math.sin((2 * Math.PI * 440 * n) / 16_000)));
    }
    expect(worst).toBeLessThan(0.01);
  });

  it("keeps what is above 8 kHz out (no folding back into the voice)", () => {
    const out = run(new Downsampler(48_000, 16_000), tone(48_000, 12_000, 24_000));
    const rms = Math.sqrt(out.slice(20).reduce((s, v) => s + v * v, 0) / (out.length - 20));
    expect(rms).toBeLessThan(0.01);
  });

  it("takes 44.1 kHz to 16 kHz with fractional places", () => {
    const down = new Downsampler(44_100, 16_000);
    const out = run(down, tone(44_100, 300, 44_100), 441);
    expect(Math.abs(out.length - 16_000)).toBeLessThanOrEqual(8);
    let worst = 0;
    for (let n = 20; n < out.length; n++) {
      worst = Math.max(worst, Math.abs((out[n] as number) - 0.5 * Math.sin((2 * Math.PI * 300 * n) / 16_000)));
    }
    expect(worst).toBeLessThan(0.02);
  });
});

describe("the chunk scheduler", () => {
  /** Pieces of 100 ms from context time `t0`, the song starting at context time 10. */
  const piece = (i: number, t0 = 9.95): StreamPiece => ({ index: i * 1_600, t: t0 + i * 0.1, bytes: new Uint8Array(1_600).fill(i % 250) });
  const songTimeOf = (t: number) => t - 10;

  function sender(answers: (StreamAnswer | Error)[] = []) {
    const sent: AudioChunk[] = [];
    const send = async (c: AudioChunk) => {
      sent.push(c);
      const a = answers.shift() ?? "live";
      if (a instanceof Error) throw a;
      return a;
    };
    return { sent, send };
  }

  it("drops what came before the start, then sends ~400 ms chunks with their place in the stream and the song", async () => {
    const { sent, send } = sender();
    const s = new ChunkScheduler(send, songTimeOf);
    // Piece 0 starts 50 ms before the song: its first 800 samples are not sent.
    for (let i = 0; i < 5; i++) s.push(piece(i));
    await flush();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ at: 0, song_ms: 0, end: false });
    expect(sent[0]?.bytes.length).toBe(800 + 4 * 1_600);
    expect(sent[0]?.bytes.length).toBeGreaterThanOrEqual(CHUNK_MIN);
    for (let i = 5; i < 8; i++) s.push(piece(i));
    await flush();
    expect(sent).toHaveLength(1);
    s.push(piece(8));
    await flush();
    expect(sent).toHaveLength(2);
    // Contiguous: `at` follows on, `song_ms` is that sample's song time (a sample is 1/16 ms).
    expect(sent[1]?.at).toBe(7_200);
    expect(sent[1]?.song_ms).toBe(450);
    expect(sent[1]?.end).toBe(false);
  });

  it("sends what is left with `end` when the song ends, an empty last chunk if nothing is", async () => {
    const { sent, send } = sender();
    const s = new ChunkScheduler(send, songTimeOf);
    for (let i = 1; i < 3; i++) s.push(piece(i));
    await s.end();
    expect(s.state).toBe("ended");
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ at: 0, song_ms: 50, end: true });
    expect(sent[0]?.bytes.length).toBe(3_200);

    const empty = sender();
    const t = new ChunkScheduler(empty.send, songTimeOf);
    await t.end();
    expect(empty.sent).toEqual([{ at: 0, song_ms: 0, end: true, bytes: new Uint8Array(0) }]);
  });

  it("stops for the round when Core says `estimate`, or a send fails", async () => {
    const est = sender(["estimate"]);
    const s = new ChunkScheduler(est.send, songTimeOf);
    for (let i = 1; i < 6; i++) s.push(piece(i));
    await flush();
    expect(s.state).toBe("stopped");
    for (let i = 6; i < 20; i++) s.push(piece(i));
    await s.end();
    expect(est.sent).toHaveLength(1);

    const failing = sender([new Error("offline")]);
    const t = new ChunkScheduler(failing.send, songTimeOf);
    for (let i = 1; i < 6; i++) t.push(piece(i));
    await flush();
    expect(t.state).toBe("stopped");
    await t.end();
    expect(failing.sent).toHaveLength(1);
  });

  it("keeps streaming while the voice may go out on her stream: stops only when `estimate` and no relay", async () => {
    expect(answerOf({ stream: "live", relay: false })).toBe("live");
    expect(answerOf({ stream: "live", relay: true })).toBe("live");
    expect(answerOf({ stream: "estimate", relay: true })).toBe("live");
    expect(answerOf({ stream: "estimate", relay: false })).toBe("estimate");
    // An older Core that does not say `relay` is the same as no relay.
    expect(answerOf({ stream: "estimate" })).toBe("estimate");

    const replies = [
      { stream: "estimate", relay: true },
      { stream: "estimate", relay: true },
      { stream: "estimate", relay: false },
    ] as const;
    const sent: AudioChunk[] = [];
    const s = new ChunkScheduler(async (c) => {
      sent.push(c);
      return answerOf(replies[sent.length - 1] ?? { stream: "estimate", relay: false });
    }, songTimeOf);
    for (let i = 1; i < 30; i++) {
      s.push(piece(i));
      await flush();
    }
    expect(sent).toHaveLength(3);
    expect(s.state).toBe("stopped");
  });

  it("keeps one chunk in flight and at most two seconds a chunk; far behind, it gives up", async () => {
    let release: () => void = () => {};
    const sent: AudioChunk[] = [];
    const send = (c: AudioChunk) => {
      sent.push(c);
      return new Promise<StreamAnswer>((resolve) => {
        release = () => resolve("live");
      });
    };
    const s = new ChunkScheduler(send, songTimeOf);
    for (let i = 1; i < 6; i++) s.push(piece(i));
    await flush();
    expect(sent).toHaveLength(1);
    // Three seconds arrive while the first is out.
    for (let i = 6; i < 36; i++) s.push(piece(i));
    await flush();
    expect(sent).toHaveLength(1);
    release();
    await flush();
    expect(sent).toHaveLength(2);
    expect(sent[1]?.bytes.length).toBe(CHUNK_MAX);
    expect(sent[1]?.at).toBe(6_400);
    expect(sent[1]?.song_ms).toBe(450);
    release();
    await flush();
    expect(sent[2]?.at).toBe(6_400 + CHUNK_MAX);

    const slow = new ChunkScheduler(() => new Promise<StreamAnswer>(() => {}), songTimeOf);
    for (let i = 1; i < 2 + BACKLOG_MAX / 1_600 + 5; i++) slow.push(piece(i));
    expect(slow.state).toBe("stopped");
  });

  it("sends nothing after it was stopped (they left)", async () => {
    const { sent, send } = sender();
    const s = new ChunkScheduler(send, songTimeOf);
    s.stop();
    for (let i = 1; i < 10; i++) s.push(piece(i));
    await s.end();
    expect(sent).toHaveLength(0);
  });
});

describe("the pitch posts", () => {
  it("sends settled 50 Hz frames once, from where the last post ended", () => {
    const feed = new PitchFeed();
    for (let i = 0; i < 200; i++) feed.push(i / 100, i % 20 < 15 ? 60 + (i % 3) * 0.25 : null);
    const first = feed.take(1.0);
    expect(first?.from).toBe(0);
    const frames = decodeTrack(fromBase64(first?.track ?? "") as Uint8Array);
    // Up to 100 ms before now.
    expect(frames).toHaveLength(45);
    expect(frames[0]).toBe(60);
    expect(feed.take(1.0)).toBeNull();
    const second = feed.take(2.5);
    expect(second?.from).toBe(45);
    expect(decodeTrack(fromBase64(second?.track ?? "") as Uint8Array)).toHaveLength(75);
    // The last post takes everything.
    feed.push(2.9, 62);
    expect(feed.take(2.5, true)?.from).toBe(120);
  });

  it("stays under 4,000 characters a post", () => {
    const feed = new PitchFeed();
    feed.push(120, 60);
    const body = feed.take(121);
    expect(body?.track.length).toBeLessThanOrEqual(4_000);
    expect(feed.take(121)?.from).toBeGreaterThan(0);
  });
});

describe("Core's clock", () => {
  it("keeps the quickest round trip: Core's time less the middle of the trip", () => {
    expect(
      clockOffset([
        { t0: 1_000, t1: 1_080, server_ms: 6_050 },
        { t0: 2_000, t1: 2_020, server_ms: 7_013 },
        { t0: 3_000, t1: 2_990, server_ms: 9_999 },
      ]),
    ).toEqual({ offset: 5_003, rtt: 20 });
    expect(clockOffset([])).toBeNull();
  });

  it("asks eight times one after another and skips a lost trip", async () => {
    let clock = 0;
    const now = () => clock;
    let n = 0;
    const offset = await syncClock(async (t0) => {
      n++;
      if (n === 3) throw new Error("lost");
      clock += n === 5 ? 4 : 30;
      const reply = { server_ms: t0 + 1_000 + (n === 5 ? 2 : 15) };
      clock += n === 5 ? 4 : 30;
      return reply;
    }, now);
    expect(n).toBe(8);
    expect(offset).toEqual({ offset: 998, rtt: 8 });
  });

  it("places the start on the context's clock so it is heard at Core's moment", () => {
    // Core is 500 ms ahead; the start is 3 s away by Core's clock; the speakers play context time 10.
    expect(contextTimeFor(103_500, 500, 10, 100_000)).toBeCloseTo(13, 6);
    expect(songTimeByCore(103_500, 500, 100_000)).toBeCloseTo(-3, 6);
    expect(secondsLeft(-2.2)).toBe(3);
    expect(secondsLeft(-0.01)).toBe(1);
    expect(secondsLeft(0)).toBe(0);
  });
});

describe("the room's words", () => {
  it("tells a singer only a direction and where the live score comes from", () => {
    expect(trendView({ trend: "rising", source: "voice" })).toEqual({ word: "上升中", mark: "↑", source: "正式" });
    expect(trendView({ trend: "dropping", source: "estimate" })).toEqual({ word: "下降中", mark: "↓", source: "預估" });
    expect(trendView({ trend: "holding", source: "voice" })).toEqual({ word: "保持", mark: "—", source: "正式" });
    expect(trendView(null)).toBeNull();
  });

  it("reads a code as typed or from a link, and addresses a room", () => {
    expect(readRoomCode(" ktv 888 ")).toBe("KTV888");
    expect(readRoomCode("https://x.example/karaoke/room/KTV888?a=1")).toBe("KTV888");
    expect(readRoomCode("/karaoke?room=ktv888")).toBe("KTV888");
    expect(readRoomCode("KTVO88")).toBeNull();
    expect(readRoomCode("ABC")).toBeNull();
    expect(roomPage("KTV888")).toBe("/karaoke/room/KTV888");
    expect(isKaraokePath("/karaoke/room/KTV888?karaoke-demo")).toBe(true);
    expect(isKaraokePath("/karaoke/rooms")).toBe(false);
    expect(roomCodeIn("/karaoke/room/ktv888")).toBe("KTV888");
    expect(roomCodeIn("/karaoke?room=KTV888&karaoke-demo")).toBe("KTV888");
    expect(roomCodeIn("/karaoke")).toBeNull();
  });

  it("gives eight colours apart by shape too, and leaves an unknown balance to Core", () => {
    expect(memberColor(0)).toEqual({ color: "--chart-1", css: "var(--chart-1)", dashed: false });
    expect(memberColor(4).color).toBe("--chart-5");
    expect(memberColor(5)).toMatchObject({ color: "--chart-1", dashed: true });
    expect(memberColor(7)).toMatchObject({ color: "--chart-3", dashed: true });
    expect(canPay(19, 20)).toBe(false);
    expect(canPay(20, 20)).toBe(true);
    expect(canPay(null, 20)).toBe(true);
  });
});

describe("a singer's own number and 結算中", () => {
  it("shows the trend's own total by its source, and nothing to stand in for before there is one", () => {
    expect(stageScore({ source: "voice", total: 81.25 })).toEqual({ total: 81.25, source: "voice" });
    expect(stageScore({ source: "estimate", total: 0 })).toEqual({ total: 0, source: "estimate" });
    expect(stageScore({ source: "voice", total: null })).toBeNull();
    expect(stageScore(null)).toBeNull();
  });

  it("says whom the round waits for, or that it is nearly done", () => {
    expect(settlingView({ waiting: ["海苔", "Akari"], until_ms: 0 })).toEqual({ title: "結算中…", detail: "等 海苔、Akari 的分數" });
    expect(settlingView({ waiting: [], until_ms: 0 })).toEqual({ title: "結算中…", detail: "馬上就好" });
    expect(settlingView({ waiting: [" "], until_ms: 0 })).toEqual({ title: "結算中…", detail: "馬上就好" });
  });
});

describe("which stage a singer is on", () => {
  const session = (id: string) => ({ session: id }) as KaraokeSession;
  const view = (over: Partial<KaraokeRoomView>): KaraokeRoomView =>
    ({
      state: "singing",
      round: 1,
      start_at_ms: 1_000,
      me: { id: "me", role: "singer", opener: false, singing: true, session: session("S1") },
      ...over,
    }) as KaraokeRoomView;

  it("keeps the round's stage while the round is on, whatever a later view leaves out", () => {
    const held: { current: HeldStage | null } = { current: null };
    expect(stageOf(view({ state: "countdown" }), held)).toMatchObject({ round: 1, startAt: 1_000, session: { session: "S1" } });
    const first = stageOf(view({}), held);
    // The same stage object while nothing changed (it keys the stage).
    expect(stageOf(view({}), held)).toBe(first);
    // The song over, 結算中: a view without the session or the start keeps the stage until it is sent.
    expect(stageOf(view({ me: { id: "me", role: "singer", opener: false, singing: false, session: null }, start_at_ms: null }), held)).toBe(first);
    // The results, or the next round, let it go.
    expect(stageOf(view({ state: "results", me: { id: "me", role: "singer", opener: false, singing: false, session: null } }), held)).toBeNull();
    expect(stageOf(view({ round: 2, me: { id: "me", role: "singer", opener: false, singing: false, session: session("W2") } }), held)).toBeNull();
    expect(stageOf(view({ round: 2, me: { id: "me", role: "singer", opener: false, singing: true, session: session("S2") } }), held)).toMatchObject({
      round: 2,
      session: { session: "S2" },
    });
  });

  it("is no stage for someone who only watches", () => {
    const held: { current: HeldStage | null } = { current: null };
    expect(stageOf(view({ me: { id: "me", role: "spectator", opener: false, singing: false, session: session("W1") } }), held)).toBeNull();
  });
});

describe("the room's song queue", () => {
  type Q = Parameters<typeof startBlocked>[0];
  const entry = (state: "ready" | "preparing" | "failed", mine = false) =>
    ({ id: `${state}${mine ? "m" : ""}`, mine, shift: 0, by: { member: null, name: "x" }, song: { state } }) as unknown as KaraokeRoomView["queue"][number];
  const q = (over: Partial<Q>): Q => ({
    state: "lobby",
    queue: [],
    next: null,
    queue_limits: { per_person: 2, max: 3 },
    rounds_left: 4,
    members: [{ role: "singer", ready: true }] as KaraokeRoomView["members"],
    ...over,
  });

  it("counts what waits: failed entries count for nothing", () => {
    expect(queueCounts(q({ queue: [entry("ready", true), entry("preparing"), entry("failed", true)] }))).toEqual({ waiting: 2, mine: 1 });
  });

  it("adds between rounds while rounds are left, within each person's share and the queue's size", () => {
    expect(canQueue({ state: "lobby", rounds_left: 1 })).toBe(true);
    expect(canQueue({ state: "results", rounds_left: 1 })).toBe(true);
    expect(canQueue({ state: "singing", rounds_left: 1 })).toBe(false);
    expect(canQueue({ state: "results", rounds_left: 0 })).toBe(false);
    expect(queueBlocked(q({ queue: [entry("ready", true)] }))).toBeNull();
    // A failed one of theirs frees its place.
    expect(queueBlocked(q({ queue: [entry("ready", true), entry("failed", true)] }))).toBeNull();
    expect(queueBlocked(q({ queue: [entry("ready", true), entry("preparing", true)] }))).toBe("你已經點了 2 首在等,唱完再點");
    expect(queueBlocked(q({ queue: [entry("ready"), entry("ready"), entry("preparing")] }))).toBe("點歌的清單滿了,等唱完幾首再點");
    expect(queueBlocked(q({ rounds_left: 0 }))).toBe("這間房的輪數用完了");
  });

  it("starts with a ready entry and someone ready, from the lobby or the results", () => {
    expect(startBlocked(q({ queue: [entry("ready")], next: "ready" }))).toBeNull();
    expect(startBlocked(q({ state: "results", queue: [entry("ready")], next: "ready" }))).toBeNull();
    expect(startBlocked(q({}))).toBe("清單裡還沒有準備好的歌,先點一首");
    expect(startBlocked(q({ queue: [entry("failed")] }))).toBe("清單裡還沒有準備好的歌,先點一首");
    expect(startBlocked(q({ queue: [entry("preparing")] }))).toBe("清單裡的歌還在準備");
    const nobody = [{ role: "singer", ready: false }, { role: "spectator", ready: true }] as KaraokeRoomView["members"];
    expect(startBlocked(q({ queue: [entry("ready")], next: "ready", members: nobody }))).toBe("還沒有人準備好唱");
    expect(startBlocked(q({ queue: [entry("ready")], next: "ready", rounds_left: 0 }))).toBe("這間房的輪數用完了");
  });

  it("says where an entry's song is", () => {
    const word = (s: string | null) => (s === "lead" ? "分出主唱" : "準備中");
    expect(entryState({ state: "ready", stage: null, progress: 1 }, word)).toBeNull();
    expect(entryState({ state: "preparing", stage: "lead", progress: 0.374 }, word)).toEqual({ word: "分出主唱 37%", failed: false, progress: 0.374 });
    expect(entryState({ state: "preparing", stage: null, progress: 2 }, word)?.progress).toBe(1);
    expect(entryState({ state: "failed", stage: null, progress: 0 }, word)).toEqual({ word: "準備失敗,輪到時會跳過", failed: true, progress: null });
  });
});

describe("whether the recording is uploaded", () => {
  it("follows Core's `upload`; a Core without it: whenever it waits", () => {
    expect(wantsUpload({ state: "waiting", upload: true })).toBe(true);
    expect(wantsUpload({ state: "waiting", upload: false })).toBe(false);
    expect(wantsUpload({ state: "scoring", upload: false })).toBe(false);
    expect(wantsUpload({ state: "waiting" })).toBe(true);
    expect(wantsUpload({ state: "none" })).toBe(false);
  });
});

describe("the spectators' lines", () => {
  it("replaces a singer's frames from `from` on and folds them into the reference's octave", () => {
    const lines = new BoardLines();
    const track = (midi: (number | null)[]) => toBase64(encodeTrack(midi));
    const line = (member: string, from: number, midi: (number | null)[]) => ({
      member,
      name: member,
      color: 0,
      rank: 1,
      total: 80,
      source: "voice" as const,
      move: "same" as const,
      pitch: { from, track: track(midi) },
    });
    lines.take([line("a", 0, [48, 48, null, 49])]);
    lines.take([line("a", 2, [50, 50])]);
    const got = lines.line("a", 0, 1, () => 60);
    expect(got.map((p) => p.midi)).toEqual([60, 60, 62, 62]);
    expect(got.map((p) => p.t)).toEqual([0, 0.02, 0.04, 0.06]);
    expect(lines.line("nobody", 0, 1, () => null)).toEqual([]);
    expect(foldOctave(47.5, 60)).toBe(59.5);
    expect(foldOctave(47.5, null)).toBe(47.5);
    lines.clear();
    expect(lines.line("a", 0, 1, () => 60)).toEqual([]);
  });
});
