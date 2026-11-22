// Karaoke rooms (step 4) on a real store (SQLite in memory), a song worker in memory and a wallet
// in memory with the economy's rules: opening and paying for a room, rounds on one clock, the
// singers' voices relayed and scored live, who is sent what during a song, the final ranking and
// what it pays, and the money after a crash.

import { rm } from "node:fs/promises";
import type { KaraokeRoomEvent, KaraokeRoomView } from "@miyoria/contracts/api";
import type { KaraokeStageVoice } from "@miyoria/contracts/stage-link";
import type { AccountRef } from "@miyoria/types";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  END_GRACE_MS,
  OWN_RESULT_GRACE_MS,
  SETTLE_WAIT_MS,
  STREAM_QUIET_MS,
} from "../src/rooms.js";
import { karaokeRooms } from "../src/schema.js";
import { asSubmitted, encodeTrack, TRACK_HZ, toBase64 } from "../src/score/index.js";
import { KaraokeError, type KaraokeService } from "../src/service.js";
import { humanSinger, noiseSinger, referenceOf } from "../src/testing.js";
import { TrendTracker } from "../src/trend.js";
import { ALICE, BOB, CAROL, DAVE, makeRig, RATE, type Rig, STRANGER, song } from "./room-rig.js";

let rig: Rig;

beforeEach(async () => {
  rig = await makeRig();
});

afterEach(async () => {
  rig.raw.close();
  await rm(rig.dir, { recursive: true, force: true });
});

async function refused(p: Promise<unknown> | (() => unknown), status: number): Promise<void> {
  try {
    await (typeof p === "function" ? p() : p);
  } catch (error) {
    expect(error).toBeInstanceOf(KaraokeError);
    expect((error as KaraokeError).status).toBe(status);
    return;
  }
  throw new Error(`expected a refusal ${status}`);
}

/** Opens a room as Alice, Bob joins and both are ready. */
async function lobby(r: Rig = rig, more: AccountRef[] = [BOB]): Promise<KaraokeRoomView> {
  const room = await r.desk.open(ALICE, "Alice", r.songId, 0);
  for (const a of more) await r.desk.join(room.code, a, `P${a.id}`, "singer");
  for (const a of [ALICE, ...more]) {
    r.desk.ready(room.code, a, { ready: true, latency_ms: 0, calibrated: true });
  }
  return room;
}

/** Follows the room as `account`, keeping every message. */
function follow(r: Rig, code: string, account: AccountRef): KaraokeRoomEvent[] {
  const got: KaraokeRoomEvent[] = [];
  r.desk.follow(code, account, (e) => got.push(structuredClone(e)));
  return got;
}

/** The round's session of `account`. */
function sessionOf(r: Rig, code: string, account: AccountRef): string {
  const s = r.desk.view(code, account).me?.session?.session;
  if (s === undefined) throw new Error("no session");
  return s;
}

const SILENCE = (n: number) => new Uint8Array(n).fill(0xff);

/**
 * Sings the round: every `stepMs` each streaming singer posts its audio and its estimate, the
 * desk ticks; until the song's end, then the last chunk. `tracks`: each singer's pitch (50 Hz in
 * song time) as the worker will read it from their voice and as their browser detects it.
 */
async function singRound(
  r: Rig,
  code: string,
  tracks: Map<AccountRef, (number | null)[]>,
  options: { stream?: Set<AccountRef>; stepMs?: number; end?: boolean } = {},
): Promise<void> {
  const stepMs = options.stepMs ?? 500;
  const view = r.desk.view(code, ALICE);
  const startAt = view.start_at_ms as number;
  for (const [a, track] of tracks) r.worker.streamTracks.set(sessionOf(r, code, a), track);
  r.clock.t = startAt;
  await r.desk.tick();
  const length = Math.max(...[...tracks.values()].map((t) => t.length));
  const sent = new Map<AccountRef, number>();
  let estimateAt = 0;
  for (let ms = 0; ms <= (length / TRACK_HZ) * 1000; ms += stepMs) {
    r.clock.t = startAt + ms + stepMs;
    for (const [a, track] of tracks) {
      if (options.stream === undefined || options.stream.has(a)) {
        const at = sent.get(a) ?? 0;
        const n = (stepMs / 1000) * RATE;
        try {
          r.desk.audio(code, a, at, (at / RATE) * 1000, false, SILENCE(n));
        } catch {
          // refused (dropped): the browser stops
        }
        sent.set(a, at + n);
      }
      const to = Math.min(track.length, Math.round(((ms + stepMs) / 1000) * TRACK_HZ));
      if (to > estimateAt) {
        r.desk.pitch(code, a, estimateAt, toBase64(encodeTrack(track.slice(estimateAt, to))));
      }
    }
    estimateAt = Math.min(length, Math.round(((ms + stepMs) / 1000) * TRACK_HZ));
    await r.desk.tick();
    await r.desk.idle();
  }
  for (const [a] of tracks) {
    if (options.end === false) break;
    if (options.stream === undefined || options.stream.has(a)) {
      try {
        r.desk.audio(
          code,
          a,
          sent.get(a) ?? 0,
          ((sent.get(a) ?? 0) / RATE) * 1000,
          true,
          SILENCE(0),
        );
      } catch {
        // dropped
      }
    }
  }
  r.clock.t += 600;
  await r.desk.tick();
  await r.desk.idle();
}

/** Each singer submits their browser track as alone (recording: whether one would follow). */
async function submitAll(
  r: Rig,
  code: string,
  tracks: Map<AccountRef, (number | null)[]>,
  recording = true,
) {
  const out = new Map<AccountRef, Awaited<ReturnType<KaraokeService["submit"]>>>();
  for (const [a, track] of tracks) {
    const id = sessionOf(r, code, a);
    out.set(
      a,
      await r.service.submit(a, id, {
        track: toBase64(encodeTrack(track)),
        latency_ms: 0,
        calibrated: true,
        client_total: null,
        browser: "test",
        recording,
      }),
    );
  }
  await r.service.voiceSettled();
  await r.desk.tick();
  await r.desk.idle();
  await r.desk.settleMoney();
  return out;
}

/** Time passes by `ms` in quarter seconds, the desk looking each time. */
async function pass(r: Rig, ms: number): Promise<void> {
  for (let t = 0; t < ms; t += 250) {
    r.clock.t += 250;
    await r.desk.tick();
    await r.desk.idle();
    await r.service.voiceSettled();
  }
}

/** A good singer, a looser one, and noise (closer than this to the reference reads as made up). */
const great = (seed: number) => asSubmitted(humanSinger(song, { seed }));
const good = (seed: number) => asSubmitted(humanSinger(song, { seed, wanderCents: 45 }));
const noise = (seed: number) => asSubmitted(noiseSinger(song, seed));

describe("opening a room", () => {
  it("charges the opener once, only while she is in voice, and refuses what cannot pay", async () => {
    rig.voice.on = false;
    await refused(rig.desk.open(ALICE, "Alice", rig.songId, 0), 409);
    rig.voice.on = true;
    expect((await rig.desk.overview(ALICE)).terms).toMatchObject({
      price: 20,
      prize: 15,
      finish: 3,
    });
    const room = await rig.desk.open(ALICE, "Alice", rig.songId, 0);
    expect(room.code).toMatch(/^[2-9A-HJKMNP-Z]{6}$/);
    expect(room.me).toMatchObject({ role: "singer", opener: true });
    expect(rig.wallet.of("p-alice", "karaoke_room")).toEqual([-20]);
    expect((await rig.desk.overview(ALICE)).mine).toBe(room.code);
    // One room at a time.
    await refused(rig.desk.open(ALICE, "Alice", rig.songId, 0), 409);
    // Too few coins: nothing open, nothing owed.
    rig.wallet.balances.set("p-bob", 5);
    await refused(rig.desk.open(BOB, "Bob", rig.songId, 0), 402);
    // A stranger cannot pay.
    await refused(rig.desk.open(STRANGER, "S", rig.songId, 0), 403);
    expect(rig.store.openRooms()).toHaveLength(1);
    expect(rig.store.refundsDue()).toHaveLength(0);
    // Her: the room, in the comment channel.
    expect(rig.notes.at(-1)?.summary).toContain(room.code);
    expect(rig.notes.at(-1)?.context).not.toBeNull();
  });

  it("is closed to members while karaoke is not open, but not to a panel admin", async () => {
    const closed = await makeRig({ open: false });
    try {
      await refused(closed.desk.open(ALICE, "Alice", closed.songId, 0), 409);
      expect((await closed.desk.overview(ALICE)).available).toBe(false);
      expect((await closed.desk.overview(ALICE, true)).available).toBe(true);
      const room = await closed.desk.open(ALICE, "Alice", closed.songId, 0, true);
      await refused(closed.desk.join(room.code, BOB, "Bob", "singer"), 409);
      expect((await closed.desk.join(room.code, BOB, "Bob", "singer", true)).me?.role).toBe(
        "singer",
      );
      // The single-player side: closed to members, open to the admin.
      await refused(closed.service.request(BOB, "https://youtu.be/other"), 409);
      await refused(closed.service.start(BOB, "Bob", closed.songId), 409);
      expect(closed.service.overview(BOB).open).toBe(false);
      expect(closed.service.overview(BOB, true)).toMatchObject({ open: false, admin: true });
      expect((await closed.service.start(BOB, "Bob", closed.songId, 0, true)).session).toBeTruthy();
    } finally {
      closed.raw.close();
      await rm(closed.dir, { recursive: true, force: true });
    }
  });

  it("posts a notice in the comment channel, and says it ended when the room closes", async () => {
    const room = await rig.desk.open(ALICE, "Alice", rig.songId, 0);
    await rig.desk.idle();
    expect(rig.notices).toEqual([
      {
        id: "m1",
        channel: "222222",
        notice: { code: room.code, opener: "Alice", state: "open", reason: null },
      },
    ]);
    rig.desk.close(room.code, ALICE);
    await rig.desk.idle();
    expect(rig.notices.at(-1)).toMatchObject({
      id: "m1",
      notice: { code: room.code, state: "ended", reason: "開房的人關了房間" },
    });
    // Off, or no comment channel: nothing is posted.
    for (const overrides of [{ room_announce: false }, { comment_channel: "" }]) {
      const quiet = await makeRig(overrides);
      try {
        const r = await quiet.desk.open(ALICE, "Alice", quiet.songId, 0);
        quiet.desk.close(r.code, ALICE);
        await quiet.desk.idle();
        expect(quiet.notices).toEqual([]);
      } finally {
        quiet.raw.close();
        await rm(quiet.dir, { recursive: true, force: true });
      }
    }
  });

  it("lists the rooms open now for Discord, the most recently active first", async () => {
    expect(rig.desk.briefs()).toEqual([]);
    const a = await rig.desk.open(ALICE, "Alice", rig.songId, 0);
    rig.clock.t += 1000;
    const b = await rig.desk.open(BOB, "Bob", rig.songId, 0);
    await rig.desk.join(b.code, CAROL, "Carol", "singer");
    expect(rig.desk.briefs()).toMatchObject([
      { code: b.code, state: "lobby", singers: 2, max_singers: 8, members: 2 },
      { code: a.code, state: "lobby", singers: 1, members: 1 },
    ]);
    rig.desk.close(a.code, ALICE);
    expect(rig.desk.briefs().map((r) => r.code)).toEqual([b.code]);
  });
});

describe("a room that sings nothing", () => {
  it("gives the opening back in full when closed, once", async () => {
    const room = await lobby();
    rig.desk.close(room.code, ALICE);
    await rig.desk.idle();
    await rig.desk.settleMoney();
    expect(rig.wallet.of("p-alice", "karaoke_room_refund")).toEqual([20]);
    expect(rig.wallet.balances.get("p-alice")).toBe(100);
    // Again (a second pass, a restart): nothing more.
    await rig.desk.settleMoney();
    await rig.restart().recover();
    expect(rig.wallet.of("p-alice", "karaoke_room_refund")).toEqual([20]);
  });

  it("gives it back when she leaves voice, when it idles, and when everyone leaves", async () => {
    const a = await lobby();
    rig.voice.on = false;
    await rig.desk.tick();
    await rig.desk.idle();
    expect(rig.wallet.of("p-alice", "karaoke_room_refund")).toEqual([20]);
    rig.voice.on = true;
    const b = await rig.desk.open(BOB, "Bob", rig.songId, 0);
    rig.clock.t += rig.config.room_idle_mins * 60_000 + 1;
    for (const f of [ALICE, BOB]) follow(rig, b.code, f); // present, but idle
    await rig.desk.tick();
    await rig.desk.idle();
    expect(rig.wallet.of("p-bob", "karaoke_room_refund")).toEqual([20]);
    const c = await rig.desk.open(CAROL, "Carol", rig.songId, 0);
    rig.desk.leave(c.code, CAROL);
    await rig.desk.idle();
    expect(rig.wallet.of("p-carol", "karaoke_room_refund")).toEqual([20]);
    expect(a.code).not.toBe(b.code);
  });

  it("gives back what was taken when the answer to the charge was lost", async () => {
    rig.wallet.throwAfterCharge = true;
    await refused(rig.desk.open(ALICE, "Alice", rig.songId, 0), 503);
    await rig.desk.idle();
    expect(rig.wallet.of("p-alice", "karaoke_room")).toEqual([-20]);
    expect(rig.wallet.of("p-alice", "karaoke_room_refund")).toEqual([20]);
  });

  it("after a crash: a room left open (or left charging) is closed and given back once", async () => {
    await lobby();
    // Core stops (nothing closed), then starts again.
    const next = rig.restart();
    await next.recover();
    expect(rig.wallet.of("p-alice", "karaoke_room_refund")).toEqual([20]);
    expect(rig.store.openRooms()).toHaveLength(0);
    await rig.restart().recover();
    expect(rig.wallet.of("p-alice", "karaoke_room_refund")).toEqual([20]);
  });

  it("keeps a refund owed while the wallet is away, and pays it once it is back", async () => {
    const room = await lobby();
    rig.hasWallet.on = false;
    rig.desk.close(room.code, ALICE);
    await rig.desk.settleMoney();
    expect(rig.store.refundsDue()).toHaveLength(1);
    rig.hasWallet.on = true;
    await rig.restart().recover();
    expect(rig.wallet.of("p-alice", "karaoke_room_refund")).toEqual([20]);
    expect(rig.store.refundsDue()).toHaveLength(0);
  });
});

describe("a round", () => {
  it("starts for everyone at one moment, late joiners watch, and the opener alone starts it", async () => {
    const room = await lobby();
    await refused(rig.desk.start(room.code, BOB), 403);
    const started = await rig.desk.start(room.code, ALICE);
    expect(started.state).toBe("countdown");
    expect(started.start_at_ms).toBe(rig.clock.t + rig.config.room_countdown_secs * 1000);
    expect(started.me).toMatchObject({ singing: true });
    expect(started.me?.session?.backing_url).toContain("/files/");
    const late = await rig.desk.join(room.code, CAROL, "Carol", "singer");
    expect(late.me).toMatchObject({ role: "spectator", singing: false });
    // The spectator has files to watch with (never submitted), not a singing.
    expect(late.me?.session?.reference_url).toBeTruthy();
    expect(rig.desk.view(room.code, BOB).start_at_ms).toBe(started.start_at_ms);
    rig.clock.t = started.start_at_ms as number;
    await rig.desk.tick();
    expect(rig.desk.view(room.code, ALICE).state).toBe("singing");
  });

  it("never sends a singer the board or anyone else's score; spectators get the board", async () => {
    const room = await lobby(rig, [BOB, CAROL]);
    await rig.desk.start(room.code, ALICE);
    const alice = follow(rig, room.code, ALICE);
    const dave =
      (await rig.desk.join(room.code, DAVE, "Dave", "spectator")) && follow(rig, room.code, DAVE);
    const tracks = new Map([
      [ALICE, good(1)],
      [BOB, great(2)],
      [CAROL, noise(3)],
    ]);
    await singRound(rig, room.code, tracks);
    const during = alice.filter((e) => e.type !== "room");
    expect(during.length).toBeGreaterThan(5);
    expect(during.every((e) => e.type === "trend")).toBe(true);
    // Nothing a singer receives during the song names another singer, a rank or a score but
    // their own.
    for (const e of alice.filter((x) => x.type !== "room")) {
      const text = JSON.stringify(e);
      expect(text).not.toContain("P2");
      expect(text).not.toContain("P3");
      expect(text).not.toMatch(/"rank"|"lines"|"board"/);
      expect(Object.keys(e).sort()).toEqual(["round", "source", "total", "trend", "type"]);
    }
    // While singing, the singer's room view has no result and no ranking either.
    for (const e of alice.filter((x) => x.type === "room")) {
      if (e.type === "room" && e.room.state === "singing") expect(e.room.result).toBeNull();
    }
    const boards = dave.filter((e) => e.type === "board");
    expect(boards.length).toBeGreaterThan(5);
    const last = boards.at(-1);
    if (last?.type !== "board") throw new Error("no board");
    expect(last.lines.map((l) => l.name)).toEqual(expect.arrayContaining(["Alice", "P2", "P3"]));
    expect(last.lines.find((l) => l.name === "P3")?.rank).toBe(3);
    expect(last.lines.every((l) => l.source === "voice")).toBe(true);
    expect(last.lines[0]?.pitch?.track).toEqual(expect.any(String));
    // Alice's own running total is in her trend: the board's number for her (one decimal).
    const mine = during.filter((e) => e.type === "trend").at(-1);
    const hers = last.lines.find((l) => l.name === "Alice")?.total as number;
    expect(mine?.type === "trend" && mine.total).toBe(Math.round(hers * 10) / 10);
    expect(mine?.type === "trend" && mine.source).toBe("voice");
    expect(hers).toBeGreaterThan(0);
    // The noise singer's trend, told to them only, is never "rising" at the bottom for long.
    expect(dave.some((e) => e.type === "trend")).toBe(false);
  });

  it("ranks by the official scores, pays the winner and every finisher, and tells her once", async () => {
    const room = await lobby(rig, [BOB, CAROL]);
    await rig.desk.start(room.code, ALICE);
    const tracks = new Map([
      [ALICE, good(1)],
      [BOB, great(2)],
      [CAROL, noise(3)],
    ]);
    await singRound(rig, room.code, tracks);
    const results = await submitAll(rig, room.code, tracks);
    // The stream gave the official score: no recording wanted.
    for (const r of results.values()) expect(r.voice.upload).toBe(false);
    const view = rig.desk.view(room.code, ALICE);
    expect(view.state).toBe("results");
    const places = view.result?.places ?? [];
    expect(places.map((p) => [p.name, p.source])).toEqual([
      ["P2", "voice"],
      ["Alice", "voice"],
      ["P3", "voice"],
    ]);
    expect(places[0]).toMatchObject({ rank: 1, winner: true, coins: 18, finished: true });
    expect(places[1]).toMatchObject({ rank: 2, winner: false, coins: 3 });
    // Noise voiced the whole song but no closer than noise gets: not sung through, nothing.
    expect(places[2]).toMatchObject({ rank: 3, finished: false, coins: 0, note: "沒有算唱完" });
    expect(rig.wallet.of("p-carol", "karaoke_finish")).toEqual([]);
    expect(rig.wallet.of("p-bob", "karaoke_prize")).toEqual([15]);
    expect(rig.wallet.of("p-bob", "karaoke_finish")).toEqual([3]);
    expect(rig.wallet.of("p-alice", "karaoke_finish")).toEqual([3]);
    // The official result equals the live score at the end.
    const official = rig.service.result(BOB, sessionOf2(rig, results, BOB));
    expect(official.source).toBe("voice");
    expect(places[0]?.total).toBe(official.total);
    // Her: one note with the official numbers, and none per singer.
    const notes = rig.notes.filter((n) => n.key.includes(":result"));
    expect(notes).toHaveLength(1);
    expect(notes[0]?.summary).toContain(`${official.total} 分`);
    expect(rig.notes.some((n) => n.key.startsWith("karaoke:") && !n.key.includes("room"))).toBe(
      false,
    );
    // The room's opening is kept now: closing gives nothing back.
    rig.desk.close(room.code, ALICE);
    await rig.desk.idle();
    expect(rig.wallet.of("p-alice", "karaoke_room_refund")).toEqual([]);
  });

  it("pays no prize with fewer than two finishers, and nothing to a stranger", async () => {
    const room = await rig.desk.open(ALICE, "Alice", rig.songId, 0);
    await rig.desk.join(room.code, STRANGER, "S", "singer");
    for (const a of [ALICE, STRANGER]) {
      rig.desk.ready(room.code, a, { ready: true, latency_ms: 0, calibrated: true });
    }
    await rig.desk.start(room.code, ALICE);
    // The stranger sings almost nothing.
    const tracks = new Map([
      [ALICE, great(4)],
      [STRANGER, good(5).map((m, i) => (i < 200 ? m : null))],
    ]);
    await singRound(rig, room.code, tracks);
    await submitAll(rig, room.code, tracks);
    const result = rig.desk.view(room.code, ALICE).result;
    expect(result?.note).toContain("不到兩個人唱完");
    expect(result?.places.find((p) => p.name === "Alice")).toMatchObject({
      winner: false,
      coins: 3,
    });
    expect(rig.wallet.of("p-alice", "karaoke_prize")).toEqual([]);
    expect(rig.wallet.rows.filter((r) => r.person === null)).toEqual([]);
  });

  it("gives a tie the prize twice, and caps a person's prizes per day", async () => {
    const capped = await makeRig({ room_prizes_per_day: 1 });
    try {
      const play = async () => {
        const room = await lobby(capped, [BOB]);
        await capped.desk.start(room.code, ALICE);
        const same = great(7);
        const tracks = new Map([
          [ALICE, same],
          [BOB, same],
        ]);
        await singRound(capped, room.code, tracks);
        await submitAll(capped, room.code, tracks);
        const view = capped.desk.view(room.code, ALICE);
        capped.desk.close(room.code, ALICE);
        await capped.desk.idle();
        return view;
      };
      const first = await play();
      expect(first.result?.places.map((p) => [p.rank, p.winner])).toEqual([
        [1, true],
        [1, true],
      ]);
      expect(capped.wallet.of("p-alice", "karaoke_prize")).toEqual([15]);
      expect(capped.wallet.of("p-bob", "karaoke_prize")).toEqual([15]);
      // The same day again: the prize is capped (the finishing is not).
      const second = await play();
      expect(second.result?.places.every((p) => p.winner)).toBe(true);
      expect(capped.wallet.of("p-alice", "karaoke_prize")).toEqual([15]);
      expect(capped.wallet.of("p-alice", "karaoke_finish")).toEqual([3, 3]);
      expect(second.result?.places[0]?.note).toBe("今天拿獎勵的次數到了");
      expect(second.result?.places[0]?.coins).toBe(3);
    } finally {
      capped.raw.close();
      await rm(capped.dir, { recursive: true, force: true });
    }
  });

  it("drops a singer whose stream stops to the estimate: no prize, and their recording is asked for", async () => {
    const room = await lobby(rig, [BOB]);
    await rig.desk.start(room.code, ALICE);
    const tracks = new Map([
      [ALICE, great(1)],
      [BOB, good(2)],
    ]);
    // Alice's browser never streams.
    await singRound(rig, room.code, tracks, { stream: new Set([BOB]) });
    const results = await submitAll(rig, room.code, tracks);
    expect(results.get(ALICE)?.voice).toMatchObject({ state: "waiting", upload: true });
    expect(results.get(BOB)?.voice.upload).toBe(false);
    // She does not upload: after the wait the round settles with her estimate.
    rig.clock.t += END_GRACE_MS + SETTLE_WAIT_MS + 1;
    await rig.desk.tick();
    await rig.desk.idle();
    await rig.desk.settleMoney();
    const places = rig.desk.view(room.code, ALICE).result?.places ?? [];
    const alice = places.find((p) => p.name === "Alice");
    expect(alice).toMatchObject({ source: "estimate", winner: false });
    expect(alice?.note).toBe("預估分數不能拿第一名獎勵");
    expect(places.find((p) => p.name === "P2")).toMatchObject({ winner: true, source: "voice" });
  });

  it("keeps the prize from a voice flagged quiet", async () => {
    rig.worker.streamLevels = { level_db: -60, floor_db: -62 };
    const room = await lobby(rig, [BOB]);
    await rig.desk.start(room.code, ALICE);
    const tracks = new Map([
      [ALICE, great(1)],
      [BOB, good(2)],
    ]);
    await singRound(rig, room.code, tracks);
    await submitAll(rig, room.code, tracks);
    const places = rig.desk.view(room.code, ALICE).result?.places ?? [];
    expect(places.every((p) => p.checks.includes("quiet") && !p.winner)).toBe(true);
    expect(rig.wallet.of("p-alice", "karaoke_prize")).toEqual([]);
    expect(rig.wallet.of("p-alice", "karaoke_finish")).toEqual([3]);
  });

  for (const mode of ["missing", "down", "slow"] as const) {
    it(`goes on from the estimates when the worker is ${mode}`, { timeout: 30_000 }, async () => {
      rig.worker.streamMode = mode;
      const room = await lobby(rig, [BOB]);
      await rig.desk.start(room.code, ALICE);
      const tracks = new Map([
        [ALICE, great(1)],
        [BOB, good(2)],
      ]);
      const spectator =
        (await rig.desk.join(room.code, DAVE, "Dave", "spectator")) && follow(rig, room.code, DAVE);
      // A slow link: each batch is given up after its timeout (real time, a few seconds here);
      // after a few the room stops streaming, and the song never waits for it.
      await singRound(rig, room.code, tracks);
      const boards = spectator.filter((e) => e.type === "board");
      const last = boards.at(-1);
      expect(last?.type === "board" && last.lines.every((l) => l.source === "estimate")).toBe(true);
      const results = await submitAll(rig, room.code, tracks);
      expect(results.get(ALICE)?.voice.upload).toBe(true);
    });
  }

  it("after a crash mid-round: the round is void, nothing paid, and the opening given back", async () => {
    const room = await lobby(rig, [BOB]);
    await rig.desk.start(room.code, ALICE);
    rig.clock.t += 10_000;
    await rig.desk.tick();
    await rig.restart().recover();
    expect(rig.store.round(rigRoomId(), 1)?.state).toBe("void");
    expect(rig.wallet.of("p-alice", "karaoke_room_refund")).toEqual([20]);
    expect(
      rig.wallet.rows.filter(
        (r) => r.reason !== "karaoke_room" && r.reason !== "karaoke_room_refund",
      ),
    ).toEqual([]);
    expect(room.code).toBeTruthy();
  });

  it("after a crash between settling and paying: pays what is due once", async () => {
    const room = await lobby(rig, [BOB]);
    await rig.desk.start(room.code, ALICE);
    const tracks = new Map([
      [ALICE, good(1)],
      [BOB, great(2)],
    ]);
    await singRound(rig, room.code, tracks);
    rig.hasWallet.on = false; // the payouts are written, not paid
    await submitAll(rig, room.code, tracks);
    expect(rig.store.payoutsDue().length).toBe(3);
    rig.hasWallet.on = true;
    // Paid once but the answer lost: the next start pays again, which is the same row.
    const first = rig.store.payoutsDue()[0];
    if (first === undefined) throw new Error("no payout");
    await rig.wallet.pay(
      { platform: first.platform, id: first.account_id },
      first.kind as "prize",
      first.amount,
      `${first.room_id}:${first.round}:${first.person_id}`,
      null,
      { since: "2000-01-01T00:00:00.000Z", perDay: 9 },
    );
    await rig.restart().recover();
    await rig.restart().recover();
    expect(rig.store.payoutsDue()).toHaveLength(0);
    expect(rig.wallet.of("p-bob", "karaoke_prize")).toEqual([15]);
    expect(rig.wallet.of("p-bob", "karaoke_finish")).toEqual([3]);
    expect(rig.wallet.of("p-alice", "karaoke_finish")).toEqual([3]);
    // A round was sung through: the opening is kept, even though the room closed on the restart.
    expect(rig.wallet.of("p-alice", "karaoke_room_refund")).toEqual([]);
  });
});

/** A song asked for by `by` (by link): prepared when `done`, else still being prepared. */
async function prepare(r: Rig, link: string, by: AccountRef = BOB, done = true) {
  const asked = await r.service.request(by, link);
  const job = r.store.song(asked.song.id)?.job as string;
  if (done) {
    r.worker.finish(job, referenceOf(song, `k-${job}`, `歌 ${link.slice(-1)}`));
    await r.service.tick(new AbortController().signal);
  }
  return { id: asked.song.id, job };
}

describe("the room's queue", () => {
  it("opens with no song, and gives the opening back when nothing was sung", async () => {
    const room = await rig.desk.open(ALICE, "Alice");
    expect(room).toMatchObject({ song: null, queue: [], next: null, shift: 0 });
    expect(room.queue_limits).toEqual({ per_person: 2, max: 12 });
    expect(rig.wallet.of("p-alice", "karaoke_room")).toEqual([-20]);
    expect(rig.notes.at(-1)?.summary).toContain("還沒有點歌");
    rig.desk.ready(room.code, ALICE, { ready: true, latency_ms: 0, calibrated: true });
    await refused(rig.desk.start(room.code, ALICE), 409);
    rig.desk.close(room.code, ALICE);
    await rig.desk.idle();
    await rig.desk.settleMoney();
    expect(rig.wallet.of("p-alice", "karaoke_room_refund")).toEqual([20]);
  });

  it("queues an old client's song first, and a refused song costs nothing", async () => {
    await refused(rig.desk.open(BOB, "Bob", "no-such-song", 0), 404);
    await refused(rig.desk.open(BOB, "Bob", rig.songId, 9), 400);
    expect(rig.wallet.of("p-bob", "karaoke_room")).toEqual([]);
    const room = await rig.desk.open(ALICE, "Alice", rig.songId, 0);
    expect(room.queue).toHaveLength(1);
    expect(room.queue[0]).toMatchObject({
      song: { id: rig.songId, state: "ready", best: null, sung: 0, mine: false },
      shift: 0,
      by: { member: room.me?.id, name: "Alice" },
      mine: true,
    });
    expect(room.next).toBe(room.queue[0]?.id);
    expect(room.song?.id).toBe(rig.songId);
  });

  it("refuses a second press of open while the first is on its way, and charges once", async () => {
    const both = await Promise.allSettled([
      rig.desk.open(ALICE, "Alice"),
      rig.desk.open(ALICE, "Alice"),
    ]);
    expect(both.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    const no = both.find((x) => x.status === "rejected") as PromiseRejectedResult;
    expect(no.reason).toBeInstanceOf(KaraokeError);
    expect((no.reason as KaraokeError).status).toBe(409);
    expect(rig.wallet.of("p-alice", "karaoke_room")).toEqual([-20]);
    expect(rig.store.openRooms()).toHaveLength(1);
  });

  it("takes a ready song, one being prepared, or a link through the song request", async () => {
    const room = await rig.desk.open(ALICE, "Alice");
    await rig.desk.join(room.code, BOB, "Bob", "singer");
    await rig.desk.join(room.code, CAROL, "Carol", "spectator");
    // A spectator queues too; a ready song in another key gets its backing in that key now.
    const keyed = await rig.desk.queueAdd(room.code, CAROL, "Carol", {
      song: rig.songId,
      shift: 2,
    });
    expect(keyed.queue.at(-1)).toMatchObject({ shift: 2, mine: true, by: { name: "Carol" } });
    expect(rig.worker.keys.some((k) => k.endsWith("/2"))).toBe(true);
    // A link: prepared through the song request (counted against Bob's day).
    const used = rig.store.requestsSince("p-bob" as never, 0);
    const linked = await rig.desk.queueAdd(room.code, BOB, "Bob", {
      text: "https://youtu.be/queued",
    });
    const entry = linked.queue.at(-1);
    expect(entry?.song.state).toBe("preparing");
    expect(rig.store.requestsSince("p-bob" as never, 0)).toBe(used + 1);
    // One on the list still being prepared.
    const other = await prepare(rig, "https://youtu.be/other", ALICE, false);
    const waiting = await rig.desk.queueAdd(room.code, ALICE, "Alice", { song: other.id });
    expect(waiting.queue.map((e) => e.song.state)).toEqual(["ready", "preparing", "preparing"]);
    expect(waiting.next).toBe(waiting.queue[0]?.id);
    // Exactly one of the two; a song that is not there.
    await refused(rig.desk.queueAdd(room.code, ALICE, "Alice", {}), 400);
    await refused(
      rig.desk.queueAdd(room.code, ALICE, "Alice", { song: rig.songId, text: "x" }),
      400,
    );
    await refused(rig.desk.queueAdd(room.code, DAVE, "Dave", { song: rig.songId }), 409);
    await refused(rig.desk.queueAdd(room.code, ALICE, "Alice", { song: "nope" }), 404);
  });

  it("keeps the song request's daily limit", async () => {
    const tight = await makeRig({ daily_songs: 1 });
    try {
      const room = await tight.desk.open(ALICE, "Alice");
      await tight.desk.join(room.code, BOB, "Bob", "singer");
      await tight.desk.queueAdd(room.code, BOB, "Bob", { text: "https://youtu.be/one" });
      await refused(
        tight.desk.queueAdd(room.code, BOB, "Bob", { text: "https://youtu.be/two" }),
        409,
      );
      // A song already on the list is no new preparation.
      await tight.desk.queueAdd(room.code, BOB, "Bob", { text: "https://youtu.be/one" });
      expect(tight.desk.view(room.code, BOB).queue).toHaveLength(2);
    } finally {
      tight.raw.close();
      await rm(tight.dir, { recursive: true, force: true });
    }
  });

  it("holds each person to their share and the queue to its size; a failed song counts for neither", async () => {
    const small = await makeRig({ room_queue_max: 3 });
    try {
      const room = await small.desk.open(ALICE, "Alice");
      await small.desk.join(room.code, BOB, "Bob", "singer");
      const add = (a: AccountRef, n: string, body: { song?: string; text?: string }) =>
        small.desk.queueAdd(room.code, a, n, body);
      await add(ALICE, "Alice", { song: small.songId });
      await add(ALICE, "Alice", { song: small.songId });
      await refused(add(ALICE, "Alice", { song: small.songId }), 409);
      const failing = await prepare(small, "https://youtu.be/fails", BOB, false);
      await add(BOB, "Bob", { song: failing.id });
      // Three waiting: the queue is full for everyone.
      await refused(add(BOB, "Bob", { song: small.songId }), 409);
      small.worker.fail(failing.job, "no result");
      await small.service.tick(new AbortController().signal);
      await add(BOB, "Bob", { song: small.songId });
      // A failed song cannot be queued.
      await refused(add(BOB, "Bob", { song: failing.id }), 409);
      expect(small.desk.view(room.code, BOB).queue.map((e) => e.song.state)).toEqual([
        "ready",
        "ready",
        "failed",
        "ready",
      ]);
    } finally {
      small.raw.close();
      await rm(small.dir, { recursive: true, force: true });
    }
  });

  it("lets the one who added it, the opener or an admin take it out; only the opener or an admin moves", async () => {
    const room = await rig.desk.open(ALICE, "Alice");
    await rig.desk.join(room.code, BOB, "Bob", "singer");
    await rig.desk.join(room.code, CAROL, "Carol", "singer");
    for (const [a, n] of [
      [ALICE, "Alice"],
      [BOB, "Bob"],
      [CAROL, "Carol"],
      [BOB, "Bob"],
    ] as const) {
      await rig.desk.queueAdd(room.code, a, n, { song: rig.songId });
    }
    const ids = rig.desk.view(room.code, ALICE).queue.map((e) => e.id);
    const [a1, b1, c1, b2] = ids as [string, string, string, string];
    await refused(() => rig.desk.queueRemove(room.code, BOB, a1), 403);
    await refused(() => rig.desk.queueRemove(room.code, BOB, "nope"), 404);
    rig.desk.queueRemove(room.code, BOB, b1);
    rig.desk.queueRemove(room.code, ALICE, c1);
    // A panel admin, even from outside the room.
    rig.desk.queueRemove(room.code, DAVE, b2, true);
    expect(rig.desk.view(room.code, ALICE).queue.map((e) => e.id)).toEqual([a1]);
    for (const [a, n] of [
      [BOB, "Bob"],
      [CAROL, "Carol"],
    ] as const) {
      await rig.desk.queueAdd(room.code, a, n, { song: rig.songId });
    }
    const [, b3, c3] = rig.desk.view(room.code, ALICE).queue.map((e) => e.id) as string[];
    await refused(() => rig.desk.queueMove(room.code, BOB, b3 as string, 0), 403);
    const moved = rig.desk.queueMove(room.code, ALICE, c3 as string, 0);
    expect(moved.queue.map((e) => e.id)).toEqual([c3, a1, b3]);
    expect(
      rig.desk.queueMove(room.code, DAVE, c3 as string, 99, true).queue.map((e) => e.id),
    ).toEqual([a1, b3, c3]);
    // Bob's own entry shows as his to him, not to Alice.
    expect(rig.desk.view(room.code, BOB).queue.map((e) => e.mine)).toEqual([false, true, false]);
  });

  it("plays the first ready song: one being prepared keeps its place, a failed one is dropped", async () => {
    const room = await rig.desk.open(ALICE, "Alice");
    await rig.desk.join(room.code, BOB, "Bob", "singer");
    const later = await prepare(rig, "https://youtu.be/later", BOB, false);
    const broken = await prepare(rig, "https://youtu.be/broken", ALICE, false);
    const second = await prepare(rig, "https://youtu.be/second", ALICE);
    await rig.desk.queueAdd(room.code, BOB, "Bob", { song: later.id });
    await rig.desk.queueAdd(room.code, ALICE, "Alice", { song: broken.id });
    await rig.desk.queueAdd(room.code, ALICE, "Alice", { song: rig.songId });
    await rig.desk.queueAdd(room.code, BOB, "Bob", { song: second.id });
    rig.worker.fail(broken.job, "no result");
    await rig.service.tick(new AbortController().signal);
    const dave =
      (await rig.desk.join(room.code, DAVE, "Dave", "spectator")) && follow(rig, room.code, DAVE);
    // The scene shows the next ready song and the rest after it.
    const before = rig.desk.view(room.code, ALICE);
    expect(before.song?.id).toBe(rig.songId);
    expect(before.next).toBe(before.queue[2]?.id);
    const scene = rig.staged.scenes.at(-1);
    expect(scene?.song?.id).toBe(rig.songId);
    expect(scene?.queue.map((q) => [q.by, q.state])).toEqual([
      ["Bob", "preparing"],
      ["Alice", "failed"],
      ["Bob", "ready"],
    ]);
    expect(rig.desk.briefs()[0]).toMatchObject({
      song: "測試的歌",
      queue: [
        { by: "Bob", state: "preparing" },
        { by: "Alice", state: "failed" },
        { title: "測試的歌", by: "Alice", state: "ready" },
        { title: "歌 d", by: "Bob", state: "ready" },
      ],
    });
    for (const a of [ALICE, BOB]) {
      rig.desk.ready(room.code, a, { ready: true, latency_ms: 0, calibrated: true });
    }
    const started = await rig.desk.start(room.code, ALICE);
    expect(started.song?.id).toBe(rig.songId);
    expect(started.queue.map((e) => e.song.id)).toEqual([later.id, second.id]);
    // The song being prepared moves on its own: everyone in the room is told.
    const told = dave.length;
    rig.worker.progress(later.job, "separate", 0.5);
    await rig.service.tick(new AbortController().signal);
    await rig.desk.tick();
    const moving = dave.slice(told).filter((e) => e.type === "room");
    expect(moving.at(-1)?.type === "room" && moving.at(-1)).toMatchObject({
      room: { queue: [{ song: { state: "preparing", progress: 0.5 } }, {}] },
    });
    rig.worker.finish(later.job, referenceOf(song, `k-${later.job}`));
    await rig.service.tick(new AbortController().signal);
    await rig.desk.tick();
    const ready = dave.filter((e) => e.type === "room").at(-1);
    expect(ready?.type === "room" && ready.room.queue[0]?.song.state).toBe("ready");
    // Nothing of anyone's score is in an entry.
    expect(ready?.type === "room" && ready.room.queue.every((e) => e.song.best === null)).toBe(
      true,
    );
  });

  it("starts the next round from the results, and drops the rest once the rounds are used", async () => {
    const two = await makeRig({ room_rounds: 2 });
    try {
      const room = await two.desk.open(ALICE, "Alice");
      await two.desk.join(room.code, BOB, "Bob", "singer");
      for (const a of [ALICE, BOB, ALICE]) {
        await two.desk.queueAdd(room.code, a, a === ALICE ? "Alice" : "Bob", { song: two.songId });
      }
      const round = async () => {
        for (const a of [ALICE, BOB]) {
          two.desk.ready(room.code, a, { ready: true, latency_ms: 0, calibrated: true });
        }
        await two.desk.start(room.code, ALICE);
        const tracks = new Map([
          [ALICE, good(1)],
          [BOB, great(2)],
        ]);
        await singRound(two, room.code, tracks);
        await submitAll(two, room.code, tracks);
        return two.desk.view(room.code, ALICE);
      };
      const first = await round();
      expect(first.state).toBe("results");
      expect(first.queue).toHaveLength(2);
      // Everyone readies again; the opener starts the next straight from the results.
      expect(first.members.every((m) => !m.ready)).toBe(true);
      const second = await round();
      expect(second).toMatchObject({ state: "results", rounds_left: 0, queue: [], next: null });
      await refused(two.desk.queueAdd(room.code, BOB, "Bob", { song: two.songId }), 409);
      await two.desk.settleMoney();
      expect(two.wallet.of("p-alice", "karaoke_room")).toEqual([-20]);
      two.desk.close(room.code, ALICE);
      await two.desk.idle();
      expect(two.wallet.of("p-alice", "karaoke_room_refund")).toEqual([]);
    } finally {
      two.raw.close();
      await rm(two.dir, { recursive: true, force: true });
    }
  });
});

describe("a round without the browsers' results", () => {
  it("scores each singer from their live stream alone and settles right after the streams end", async () => {
    const room = await lobby(rig, [BOB]);
    await rig.desk.start(room.code, ALICE);
    const spectator =
      (await rig.desk.join(room.code, DAVE, "Dave", "spectator")) && follow(rig, room.code, DAVE);
    const tracks = new Map([
      [ALICE, good(1)],
      [BOB, great(2)],
    ]);
    const sessions = [ALICE, BOB].map((a) => sessionOf(rig, room.code, a));
    const startAt = rig.desk.view(room.code, ALICE).start_at_ms as number;
    // Both browsers stream the whole song and send their last chunk, but never submit.
    await singRound(rig, room.code, tracks);
    const songEnd = startAt + (song.reference.midi.length / song.reference.hz) * 1000;
    await pass(rig, OWN_RESULT_GRACE_MS + 1_000);
    const view = rig.desk.view(room.code, ALICE);
    expect(view.state).toBe("results");
    expect(view.settling).toBeNull();
    // Long before the last-resort wait (the song, the end grace and the settle wait).
    expect(rig.clock.t).toBeLessThan(songEnd + 10_000);
    for (const id of sessions) {
      expect(rig.store.result(id)).toMatchObject({ source: "voice", voice_state: "scored" });
      expect(rig.store.track(id)).not.toBeNull();
      expect(rig.store.session(id)?.status).toBe("scored");
    }
    expect(view.result?.places.map((p) => [p.name, p.source, p.finished])).toEqual([
      ["P2", "voice", true],
      ["Alice", "voice", true],
    ]);
    await rig.desk.settleMoney();
    expect(rig.wallet.of("p-bob", "karaoke_prize")).toEqual([15]);
    // The browser's submit after that gets the result, not an error.
    const late = await rig.service.submit(ALICE, sessions[0] as string, {
      track: toBase64(encodeTrack(good(1))),
      latency_ms: 0,
      calibrated: true,
      client_total: 50,
      browser: "test",
      recording: true,
    });
    expect(late).toMatchObject({ session: sessions[0], source: "voice" });
    expect(late.voice.upload).toBe(false);
    expect(late.total).toBe(view.result?.places[1]?.total);
    // The spectators were told it was being settled, and whom it waited for (names only).
    const settling = spectator.filter((e) => e.type === "room" && e.room.settling !== null);
    expect(settling.length).toBeGreaterThan(0);
    const first = settling[0];
    if (first?.type !== "room") throw new Error("no room");
    expect(first.room.settling?.until_ms).toBe(songEnd + END_GRACE_MS + SETTLE_WAIT_MS);
    expect(JSON.stringify(settling.map((e) => e.type === "room" && e.room.settling))).not.toMatch(
      /total|rank/,
    );
  });

  it("ends a stream that stops at the song's end without its last chunk, and still scores it", async () => {
    const room = await lobby(rig, [BOB]);
    await rig.desk.start(room.code, ALICE);
    const tracks = new Map([
      [ALICE, good(1)],
      [BOB, great(2)],
    ]);
    const startAt = rig.desk.view(room.code, ALICE).start_at_ms as number;
    await singRound(rig, room.code, tracks, { end: false });
    await pass(rig, STREAM_QUIET_MS + OWN_RESULT_GRACE_MS + 2_000);
    const view = rig.desk.view(room.code, ALICE);
    expect(view.state).toBe("results");
    expect(view.result?.places.every((p) => p.source === "voice")).toBe(true);
    const songEnd = startAt + (song.reference.midi.length / song.reference.hz) * 1000;
    expect(rig.clock.t).toBeLessThan(songEnd + END_GRACE_MS);
  });

  it("waits for a singer with neither a stream nor a result only until the last-resort wait", async () => {
    const room = await lobby(rig, [BOB]);
    await rig.desk.start(room.code, ALICE);
    const bob = follow(rig, room.code, BOB);
    const tracks = new Map([
      [ALICE, great(1)],
      [BOB, good(2)],
    ]);
    const bobSession = sessionOf(rig, room.code, BOB);
    const startAt = rig.desk.view(room.code, ALICE).start_at_ms as number;
    const settleBy =
      startAt +
      (song.reference.midi.length / song.reference.hz) * 1000 +
      END_GRACE_MS +
      SETTLE_WAIT_MS;
    // Bob's browser never streams and never submits; Alice streams and does not submit either.
    await singRound(rig, room.code, tracks, { stream: new Set([ALICE]) });
    await pass(rig, OWN_RESULT_GRACE_MS + 1_000);
    const waiting = rig.desk.view(room.code, ALICE);
    expect(waiting.state).toBe("singing");
    expect(waiting.settling).toEqual({ waiting: ["P2"], until_ms: settleBy });
    expect(rig.staged.scenes.at(-1)?.settling).toEqual({ waiting: ["P2"] });
    // Bob was told too: whom it waits for, never a score.
    const told = bob.filter((e) => e.type === "room" && e.room.settling !== null);
    expect(told.at(-1)?.type === "room" && told.at(-1)).toMatchObject({
      room: { settling: { waiting: ["P2"] } },
    });
    // Just before the wait is over: still waiting; then it settles without him.
    rig.clock.t = settleBy - 500;
    await rig.desk.tick();
    expect(rig.desk.view(room.code, ALICE).state).toBe("singing");
    rig.clock.t = settleBy;
    await rig.desk.tick();
    await rig.desk.idle();
    const view = rig.desk.view(room.code, ALICE);
    expect(view.state).toBe("results");
    expect(view.settling).toBeNull();
    expect(rig.staged.scenes.at(-1)?.settling).toBeNull();
    expect(view.result?.places.find((p) => p.name === "P2")).toMatchObject({
      rank: null,
      note: "沒有交出分數",
    });
    expect(view.result?.places.find((p) => p.name === "Alice")).toMatchObject({ source: "voice" });
    // His session takes nothing any more.
    expect(Date.parse(rig.store.session(bobSession)?.expires_at as string)).toBeLessThan(settleBy);
    await refused(
      rig.service.submit(BOB, bobSession, {
        track: toBase64(encodeTrack(good(2))),
        latency_ms: 0,
        calibrated: true,
        client_total: null,
        browser: "test",
      }),
      409,
    );
    // Everyone readies again for the next round.
    expect(view.members.every((m) => !m.ready)).toBe(true);
  });
});

describe("her stream (step 5)", () => {
  /** µ-law of a steady, audible level. */
  const voiced = (n: number) => new Uint8Array(n).fill(0x9f);

  it("plays a lone singer's voice only when they ask for it, and stops when they turn it off", async () => {
    const room = await lobby(rig, []);
    const asked = rig.desk.relay(room.code, ALICE, { hear: true });
    expect(asked.members[0]).toMatchObject({ hear: true, skip: false });
    expect(asked.air.relay).toMatchObject({ allowed: true, member: asked.me?.id, live: false });
    const started = await rig.desk.start(room.code, ALICE);
    const startAt = started.start_at_ms as number;
    rig.clock.t = startAt;
    await rig.desk.tick();
    await rig.desk.idle();
    // The round's words went to the stream at once, then again with the backing (as PCM).
    expect(rig.staged.lyrics).toHaveLength(2);
    expect(rig.staged.lyrics[0]?.backing).toBeNull();
    expect(rig.staged.lyrics[1]?.backing).toMatchObject({ format: "pcm", rate: 48_000 });
    const post = async (fromMs: number, toMs: number) => {
      const replies: boolean[] = [];
      for (let ms = fromMs; ms < toMs; ms += 500) {
        rig.clock.t = startAt + ms + 500;
        replies.push(rig.desk.audio(room.code, ALICE, ms * 16, ms, false, voiced(8_000)).relay);
        await rig.desk.tick();
        await rig.desk.idle();
      }
      return replies;
    };
    expect(await post(0, 6_000)).not.toContain(false);
    expect(rig.staged.voices.length).toBeGreaterThan(5);
    const scene = rig.staged.scenes.at(-1);
    expect(scene?.air).toMatchObject({ relay: "Alice", backing: true, delay_ms: 2_000 });
    expect(scene?.board[0]?.on_air).toBe(true);
    expect(scene?.position_ms).toBe(rig.clock.t - startAt - 2_000);
    // The stream's pieces follow each other on the song's time, ahead of the stream by the lead.
    const v = rig.staged.voices;
    for (let i = 1; i < v.length; i++) {
      const prev = v[i - 1] as KaraokeStageVoice;
      const bytes = Buffer.from(prev.audio, "base64").length;
      expect((v[i] as KaraokeStageVoice).at_ms).toBeCloseTo(prev.at_ms + bytes / 16, 0);
    }
    const mine = rig.desk.view(room.code, ALICE);
    expect(mine.air.relay).toMatchObject({ live: true, member: mine.me?.id });
    // Off mid-song: it fades out, and nothing more goes out.
    rig.desk.relay(room.code, ALICE, { hear: false });
    expect(await post(6_000, 7_000)).toEqual([false, false]);
    const sent = rig.staged.voices.length;
    await post(7_000, 9_000);
    expect(rig.staged.voices.length).toBe(sent);
    expect(rig.desk.view(room.code, ALICE).air.relay.live).toBe(false);
  });

  it("sends nothing of a singer who did not ask, and refuses a stranger's voice", async () => {
    const room = await rig.desk.open(ALICE, "Alice", rig.songId, 0);
    await rig.desk.join(room.code, STRANGER, "Someone", "singer");
    await refused(() => rig.desk.relay(room.code, STRANGER, { hear: true }), 403);
    await refused(() => rig.desk.relay(room.code, BOB, { hear: true }), 409);
    rig.desk.ready(room.code, ALICE, { ready: true, latency_ms: 0, calibrated: true });
    const started = await rig.desk.start(room.code, ALICE);
    rig.clock.t = (started.start_at_ms as number) + 500;
    await rig.desk.tick();
    expect(rig.desk.audio(room.code, ALICE, 0, 0, false, voiced(8_000)).relay).toBe(false);
    for (let i = 0; i < 12; i++) {
      rig.clock.t += 500;
      await rig.desk.tick();
    }
    expect(rig.staged.voices).toEqual([]);
    expect(rig.staged.scenes.at(-1)?.air.relay).toBeNull();
  });

  it("lets only the opener switch the leader's voice on, and the opener or an admin cut someone", async () => {
    const room = await lobby();
    const bob = rig.desk.view(room.code, BOB).me?.id as string;
    const alice = rig.desk.view(room.code, ALICE).me?.id as string;
    await refused(() => rig.desk.relay(room.code, BOB, { lead: true }), 403);
    await refused(() => rig.desk.relay(room.code, BOB, { member: alice }), 403);
    const on = rig.desk.relay(room.code, ALICE, { lead: true });
    expect(on.air).toMatchObject({ lead: true, relay: { allowed: true } });
    const cut = rig.desk.relay(room.code, ALICE, { member: bob });
    expect(cut.members.find((m) => m.id === bob)).toMatchObject({ hear: false, skip: true });
    rig.desk.relay(room.code, BOB, { skip: false });
    const admin = rig.desk.relay(room.code, BOB, { member: alice }, true);
    expect(admin.members.find((m) => m.id === alice)).toMatchObject({ skip: true });
    rig.desk.relay(room.code, ALICE, { lead: false });
    expect(rig.desk.view(room.code, ALICE).air.relay).toMatchObject({
      allowed: false,
      reason: "開房的人沒有開「播出第一名的歌聲」",
    });
  });

  it("with two or more singers plays the leader who allows it, and never tells a singer", async () => {
    const room = await lobby(rig, [BOB, CAROL]);
    rig.desk.relay(room.code, ALICE, { lead: true });
    rig.desk.relay(room.code, BOB, { skip: true });
    await rig.desk.start(room.code, ALICE);
    const alice = follow(rig, room.code, ALICE);
    const carol = follow(rig, room.code, CAROL);
    await rig.desk.join(room.code, DAVE, "Dave", "spectator");
    const dave = follow(rig, room.code, DAVE);
    // Bob sings best but opted out; Carol is next; Alice (first to join) is on before any score.
    const tracks = new Map([
      [ALICE, noise(1)],
      [BOB, great(2)],
      [CAROL, great(3)],
    ]);
    await singRound(rig, room.code, tracks);
    const sung = rig.staged.scenes.filter((x) => x.state === "singing");
    const onAir = sung.flatMap((x) => x.board.filter((l) => l.on_air).map((l) => l.name));
    expect(onAir).not.toContain("P2");
    expect(onAir[0]).toBe("Alice");
    expect(onAir.at(-1)).toBe("P3");
    // One voice at a time, and the change came only after a hold, not at the first lead.
    expect(sung.every((x) => x.board.filter((l) => l.on_air).length <= 1)).toBe(true);
    expect(onAir.filter((n) => n === "Alice").length).toBeGreaterThanOrEqual(4);
    expect(rig.staged.voices.length).toBeGreaterThan(10);
    // The singers' streams carry nothing of whose voice is on, nor of their rank.
    for (const events of [alice, carol]) {
      for (const e of events) {
        if (e.type === "room") {
          expect(e.room.air.relay.member).toBeNull();
          expect(e.room.air.relay.live).toBe(false);
        } else {
          expect(e.type).toBe("trend");
          expect(JSON.stringify(e)).not.toMatch(/on_air|"rank"|relay/);
        }
      }
    }
    // The spectator sees it.
    expect(dave.some((e) => e.type === "room" && e.room.air.relay.live)).toBe(true);
  });

  it("gives the scene the join link, the pitch lanes, the round's notes and the four parts", async () => {
    const site = await makeRig({
      site_url: "https://miyo.example/",
      stream_qr_while_singing: true,
    });
    try {
      const room = await site.desk.open(ALICE, "Alice", site.songId, 2);
      await site.desk.join(room.code, BOB, "Bob", "singer");
      for (const a of [ALICE, BOB]) {
        site.desk.ready(room.code, a, { ready: true, latency_ms: 0, calibrated: true });
      }
      expect(site.staged.scenes.at(-1)).toMatchObject({
        join_url: `https://miyo.example/karaoke/room/${room.code}`,
        qr_while_singing: true,
      });
      await site.desk.start(room.code, ALICE);
      const tracks = new Map([
        [ALICE, good(1)],
        [BOB, great(2)],
      ]);
      await singRound(site, room.code, tracks);
      // The round's reference notes, in its key, for the lanes.
      const reference = await site.service.reference(site.songId);
      const notes = site.staged.lyrics[0]?.notes ?? [];
      expect(notes.length).toBe(reference.notes.length);
      expect(notes[0]?.midi).toBeCloseTo((reference.notes[0]?.midi ?? 0) + 2, 2);
      expect(notes.every((n) => n.start >= 0 && n.end >= n.start)).toBe(true);
      // Each singer's recent pitch while sung, as the spectators' board has it.
      const sung = site.staged.scenes.filter((x) => x.state === "singing");
      const lanes = sung.flatMap((x) => x.board.filter((l) => l.pitch !== null));
      expect(lanes.length).toBeGreaterThan(5);
      expect(lanes[0]?.pitch).toEqual({ from: expect.any(Number), track: expect.any(String) });
      expect(sung.every((x) => x.board.every((l) => l.parts === null))).toBe(true);
      await submitAll(site, room.code, tracks);
      const results = site.staged.scenes.at(-1);
      expect(results?.state).toBe("results");
      expect(results?.board).toHaveLength(2);
      for (const line of results?.board ?? []) {
        expect(line.pitch).toBeNull();
        expect(line.parts).toEqual({
          pitch: expect.any(Number),
          stability: expect.any(Number),
          rhythm: expect.any(Number),
          expression: expect.any(Number),
        });
      }
    } finally {
      site.raw.close();
      await rm(site.dir, { recursive: true, force: true });
    }
  });

  it("has no join link without the site's address, or with the QR off", async () => {
    await rig.desk.open(ALICE, "Alice", rig.songId, 0);
    expect(rig.staged.scenes.at(-1)).toMatchObject({ join_url: null, qr_while_singing: false });
    const off = await makeRig({ site_url: "https://miyo.example", stream_qr: false });
    try {
      await off.desk.open(ALICE, "Alice", off.songId, 0);
      expect(off.staged.scenes.at(-1)?.join_url).toBeNull();
    } finally {
      off.raw.close();
      await rm(off.dir, { recursive: true, force: true });
    }
  });

  it("sends nothing when every singer opted out, and ends the scene with the room", async () => {
    const room = await lobby();
    rig.desk.relay(room.code, ALICE, { lead: true, skip: true });
    rig.desk.relay(room.code, BOB, { skip: true });
    await rig.desk.start(room.code, ALICE);
    await singRound(
      rig,
      room.code,
      new Map([
        [ALICE, great(1)],
        [BOB, good(2)],
      ]),
    );
    expect(rig.staged.voices).toEqual([]);
    rig.desk.close(room.code, ALICE);
    expect(rig.staged.scenes.at(-1)).toMatchObject({ room: null, state: null, board: [] });
  });
});

describe("what a room's round is sung against", () => {
  it("counts the round's singers for alone, not the members who chose to sing", async () => {
    const room = await rig.desk.open(ALICE, "Alice", rig.songId, 0);
    await rig.desk.join(room.code, BOB, "Bob", "singer");
    expect(rig.desk.view(room.code, ALICE).air.singers).toBe(2);
    // Only Alice is ready: the round is hers alone, though Bob is a singer of the room.
    rig.desk.ready(room.code, ALICE, { ready: true, latency_ms: 0, calibrated: true });
    const started = await rig.desk.start(room.code, ALICE);
    expect(started.air.singers).toBe(1);
    expect(rig.desk.view(room.code, BOB).air.singers).toBe(1);
  });

  it("sings a round started after an edit was saved against the edit", async () => {
    const view = await rig.service.editor(ALICE, rig.songId, true);
    const lines = [...(view.reference.lyrics?.lines ?? [])];
    const first = lines[0] as (typeof lines)[number];
    lines[0] = { ...first, text: "改過的第一句", pieces: null, edited: true };
    await rig.service.saveEdit(
      ALICE,
      "Alice",
      rig.songId,
      {
        lyrics: { ...(view.reference.lyrics as NonNullable<typeof view.reference.lyrics>), lines },
        notes: view.reference.notes,
        pitch_shift: 0,
        revision: 0,
      },
      true,
    );
    const room = await lobby(rig, []);
    const started = await rig.desk.start(room.code, ALICE);
    rig.clock.t = started.start_at_ms as number;
    await rig.desk.tick();
    await rig.desk.idle();
    expect(rig.staged.lyrics[0]?.lyrics?.lines[0]?.text).toBe("改過的第一句");
  });
});

describe("the trend a singer sees", () => {
  it("needs a few looks to move, more to settle, and does not flicker", () => {
    const t = new TrendTracker();
    let at = 0;
    const look = (rank: number, total: number) => {
      at += 1000;
      return t.push(at, rank, total);
    };
    for (let i = 0; i < 5; i++) look(3, 50);
    expect(t.trend).toBe("holding");
    // Overtakes: rising after two looks in a row, not one.
    expect(look(2, 52)).toBe("holding");
    expect(look(2, 53)).toBe("rising");
    // A jittering total around the same place does not flip it back and forth.
    const seen = new Set<string>();
    for (let i = 0; i < 12; i++) seen.add(look(2, 53 + (i % 2 === 0 ? 0.4 : -0.4)));
    expect([...seen].filter((s) => s === "dropping")).toEqual([]);
    expect(t.trend).toBe("holding");
    // Falls two places: dropping.
    look(4, 50);
    expect(look(4, 49)).toBe("dropping");
  });
});

/** The id of the only room the store knows. */
function rigRoomId(): string {
  const all = rig.raw.db.orm.select().from(karaokeRooms).all();
  return (all[0] as { id: string }).id;
}

function sessionOf2(_r: Rig, results: Map<AccountRef, { session: string }>, a: AccountRef): string {
  return (results.get(a) as { session: string }).session;
}
