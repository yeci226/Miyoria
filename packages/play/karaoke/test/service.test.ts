// The karaoke service on a real store (SQLite in memory) with a song worker in memory: asking for
// a song, following its preparation, sessions and their signed links, scoring a submitted track,
// her note and her comment, the daily limit, the upkeep and forgetting a person, and the reference
// editor's saves and restores (step 6).

import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openTestDb, type TestDb } from "@miyoria/store/testing";
import { type AccountRef, type PersonId, toTimestamp } from "@miyoria/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type KaraokeConfig, KaraokeConfigSchema } from "../src/config.js";
import { deleteNotes, docOf, type EditDoc, setLineText, shiftSong } from "../src/edit/index.js";
import { karaokeSchema } from "../src/migrations.js";
import { type PitchTrack, resampleTrack, TrackRecorder } from "../src/score/index.js";
import {
  COMMENT_WAIT_MS,
  FILES_KEEP_MS,
  failureText,
  KaraokeError,
  type KaraokeNote,
  KaraokeService,
  sourceOf,
  TRACK_KEEP_MS,
  VOICE_UPLOAD_MS,
} from "../src/service.js";
import { KaraokeStore } from "../src/store.js";
import {
  copySinger,
  FakeKaraokeWorker,
  humanSinger,
  referenceOf,
  referenceV1Of,
  type SynthSong,
  synthSong,
} from "../src/testing.js";

const ALICE: AccountRef = { platform: "discord", id: "1" };
const BOB: AccountRef = { platform: "discord", id: "2" };
const STRANGER: AccountRef = { platform: "discord", id: "9" };
const BLOCKED: AccountRef = { platform: "discord", id: "6" };
const PEOPLE: Record<string, { person: PersonId | null; blocked: boolean }> = {
  "1": { person: "p-alice", blocked: false },
  "2": { person: "p-bob", blocked: false },
  "6": { person: "p-blocked", blocked: true },
};
const CHANNEL = "discord:111111:222222";
const T0 = Date.UTC(2026, 10, 18, 4, 0, 0);

const song = synthSong(2, 6);
const LYRICS_DEFAULTS = {
  aligner: "mms",
  matched: 0.75,
  uncertain: 0.5,
  keep_share: 0.5,
  wrong_share: 0.2,
};

interface Rig {
  service: KaraokeService;
  worker: FakeKaraokeWorker;
  store: KaraokeStore;
  notes: KaraokeNote[];
  together: { person: PersonId; detail: string }[];
  clock: { t: number };
  dir: string;
  raw: TestDb;
}

let rig: Rig;

async function makeRig(overrides: Partial<KaraokeConfig> = {}): Promise<Rig> {
  const raw = openTestDb({ identity: true, plugins: [karaokeSchema] });
  const store = new KaraokeStore(raw.db, raw.events);
  const worker = new FakeKaraokeWorker();
  const notes: KaraokeNote[] = [];
  const together: Rig["together"] = [];
  const clock = { t: T0 };
  const dir = await mkdtemp(join(tmpdir(), "karaoke-"));
  const config = KaraokeConfigSchema.parse({ comment_channel: CHANNEL, ...overrides });
  const service = new KaraokeService({
    config,
    store,
    worker: () => worker,
    now: () => clock.t,
    cacheDir: dir,
    who: (account) => PEOPLE[account.id] ?? { person: null, blocked: false },
    tell: (note) => notes.push(note),
    together: (person, detail) => together.push({ person, detail }),
    log: { info: () => {}, warn: () => {} },
  });
  return { service, worker, store, notes, together, clock, dir, raw };
}

beforeEach(async () => {
  rig = await makeRig();
});

afterEach(async () => {
  rig.raw.close();
  await rm(rig.dir, { recursive: true, force: true });
});

const signal = new AbortController().signal;

/** Asks for a song and has the worker finish it; its id. */
async function ready(r: Rig, text = "https://youtu.be/abc", s: SynthSong = song): Promise<string> {
  const asked = await r.service.request(ALICE, text);
  const job = r.store.song(asked.song.id)?.job as string;
  r.worker.finish(job, referenceOf(s, `k-${job}`));
  await r.service.tick(signal);
  return asked.song.id;
}

/** Sings `track` in a session started now, after its length, and submits it. */
async function sing(
  r: Rig,
  songId: string,
  track = humanSinger(song),
  options: {
    latency_ms?: number;
    calibrated?: boolean;
    who?: AccountRef;
    recording?: boolean;
  } = {},
) {
  const who = options.who ?? ALICE;
  const session = await r.service.start(who, "Alice", songId);
  const rec = new TrackRecorder(track.hz);
  track.midi.forEach((m, j) => {
    rec.push(j / track.hz, m);
  });
  r.clock.t += rec.seconds * 1000 + 2000;
  return {
    session,
    result: await r.service.submit(who, session.session, {
      track: rec.encode(),
      latency_ms: options.latency_ms ?? 0,
      calibrated: options.calibrated ?? true,
      client_total: 90,
      browser: "Chrome",
      recording: options.recording ?? false,
    }),
  };
}

/**
 * What the worker reads off a recording of `singer` that started `startS` seconds into the song:
 * the singer's pitch from then on, at 50 Hz, as RMVPE's answer.
 */
function recordingOf(singer: PitchTrack, startS: number, levels = { level: -20, floor: -62 }) {
  const frames = resampleTrack(singer, 50).slice(Math.round(startS * 50));
  return {
    hz: 50 as const,
    midi: frames,
    seconds: frames.length / 50,
    level_db: levels.level,
    floor_db: levels.floor,
    device: "cuda",
    method: "rmvpe",
  };
}

const WEBM = "audio/webm";

describe("asking for a song", () => {
  it("prepares a new song, follows it, and makes it ready", async () => {
    const asked = await rig.service.request(ALICE, "  https://youtu.be/abc#t=3 ");
    expect(asked.created).toBe(true);
    expect(asked.song.state).toBe("preparing");
    expect(rig.worker.asked).toEqual([
      { url: "https://youtu.be/abc", lyrics: LYRICS_DEFAULTS, video: true },
    ]);
    const job = rig.store.song(asked.song.id)?.job as string;
    rig.worker.progress(job, "separate", 0.4);
    await rig.service.tick(signal);
    const preparing = rig.service.song(ALICE, asked.song.id);
    expect(preparing).toMatchObject({ state: "preparing", stage: "separate", progress: 0.4 });
    rig.worker.finish(job, referenceOf(song, "k-1"));
    await rig.service.tick(signal);
    const done = rig.service.song(ALICE, asked.song.id);
    expect(done.state).toBe("ready");
    expect(done.lyrics).toBe(true);
    expect(done.notes).toBe(song.notes.length);
    expect(done.mine).toBe(true);
    expect((await readdir(join(rig.dir, asked.song.id))).sort()).toEqual([
      "karaoke.m4a",
      "reference.json",
    ]);
    // The same link again is the same song, and costs nothing.
    const again = await rig.service.request(BOB, "https://youtu.be/abc");
    expect(again).toMatchObject({ created: false, song: { id: asked.song.id, mine: false } });
    expect(rig.service.overview(BOB).songs.map((s) => s.id)).toEqual([asked.song.id]);
  });

  it("searches with words", async () => {
    await rig.service.request(ALICE, "某首 歌");
    expect(rig.worker.asked).toEqual([{ query: "某首 歌", lyrics: LYRICS_DEFAULTS, video: true }]);
    expect(sourceOf("某首  歌")?.key).toBe("query:某首 歌");
    expect(sourceOf("")).toBeNull();
  });

  it("sends the lyrics settings with every song, and keeps where its lyrics came from", async () => {
    rig = await makeRig({ aligner: "mms", lyrics_matched: 0.8, lyrics_uncertain: 0.9 });
    const heard = await rig.service.request(ALICE, "heard");
    expect(rig.worker.asked[0]?.lyrics).toEqual({
      ...LYRICS_DEFAULTS,
      aligner: "mms",
      matched: 0.8,
      uncertain: 0.8, // never above the matched threshold
    });
    rig.worker.finish(
      rig.store.song(heard.song.id)?.job as string,
      referenceOf(song, "k-heard", "聽來的", true),
    );
    // A song a step 1 worker made (reference.json version 1) is still sung.
    const old = await rig.service.request(ALICE, "old");
    rig.worker.finish(rig.store.song(old.song.id)?.job as string, referenceV1Of(song, "k-old"));
    await rig.service.tick(signal);
    expect(rig.service.song(ALICE, heard.song.id)).toMatchObject({
      state: "ready",
      lyrics: true,
      lyrics_source: "heard",
    });
    expect(rig.service.song(ALICE, old.song.id)).toMatchObject({
      state: "ready",
      lyrics_source: "found",
    });
    const ref = await rig.service.reference(old.song.id);
    expect(ref.version).toBe(2);
    expect(ref.lyrics?.lines[0]).toMatchObject({
      status: "unchecked",
      source: "found",
      pieces: null,
    });
    const { result } = await sing(rig, old.song.id);
    expect(result.total).toBeGreaterThan(85);
  });

  it("holds each person to the day's limit, counted in her local day", async () => {
    rig = await makeRig({ daily_songs: 2 });
    await rig.service.request(ALICE, "a");
    await rig.service.request(ALICE, "b");
    await expect(rig.service.request(ALICE, "c")).rejects.toMatchObject({ status: 409 });
    expect(rig.service.overview(ALICE).limits).toMatchObject({ daily: 2, used: 2 });
    // Bob has his own; a known song is free.
    await rig.service.request(BOB, "c");
    await expect(rig.service.request(ALICE, "c")).resolves.toMatchObject({ created: false });
    // Her day starts at midnight UTC+8 (16:00 UTC).
    rig.clock.t = Date.UTC(2026, 10, 18, 16, 0, 1);
    await expect(rig.service.request(ALICE, "d")).resolves.toMatchObject({ created: true });
  });

  it("keeps a made song in preparation while its files are still on their way", async () => {
    const a = await rig.service.request(ALICE, "slow link");
    rig.worker.finish(rig.store.song(a.song.id)?.job as string, referenceOf(song, "k-slow"));
    rig.worker.breakFiles = 2;
    await rig.service.tick(signal);
    expect(rig.service.song(ALICE, a.song.id)).toMatchObject({ state: "preparing" });
    await rig.service.tick(signal);
    expect(rig.service.song(ALICE, a.song.id)).toMatchObject({ state: "preparing" });
    await rig.service.tick(signal);
    expect(rig.service.song(ALICE, a.song.id)).toMatchObject({ state: "ready", error: null });
  });

  it("fails a made song whose files never arrive", async () => {
    const a = await rig.service.request(ALICE, "dead link");
    rig.worker.finish(rig.store.song(a.song.id)?.job as string, referenceOf(song, "k-dead"));
    rig.worker.breakFiles = 1000;
    for (let i = 0; i < 8; i++) await rig.service.tick(signal);
    expect(rig.service.song(ALICE, a.song.id).error).toBe("準備好了但拿不到檔案,再點一次");
  });

  it("says why a song could not be prepared", async () => {
    const a = await rig.service.request(ALICE, "https://youtu.be/long");
    const ja = rig.store.song(a.song.id)?.job as string;
    rig.worker.finish(ja, { ...referenceOf(song, "k-long"), duration_s: 900 });
    const b = await rig.service.request(ALICE, "no melody");
    const jb = rig.store.song(b.song.id)?.job as string;
    rig.worker.finish(jb, {
      ...referenceOf(song, "k-quiet"),
      quality: { ok: false, reason: "voiced 3%", voiced_ratio: 0.03, notes: 2, lead_split: true },
    });
    const c = await rig.service.request(ALICE, "https://example.com/x");
    rig.worker.fail(
      rig.store.song(c.song.id)?.job as string,
      "that link is not on an allowed host",
    );
    await rig.service.tick(signal);
    expect(rig.service.song(ALICE, a.song.id).error).toBe("這首太長了(最多 8 分鐘)");
    expect(rig.service.song(ALICE, b.song.id).error).toBe("這首抓不到主旋律,換一首試試");
    expect(rig.service.song(ALICE, c.song.id).error).toBe("這個網站的連結不能用,換一個或改打歌名");
    // A failed song may be asked for again.
    const retry = await rig.service.request(ALICE, "no melody");
    expect(retry).toMatchObject({ created: true, song: { id: b.song.id, state: "preparing" } });
    expect(failureText("ERROR: video too long", 300)).toBe("這首太長了(最多 5 分鐘)");
  });

  it("refuses what it cannot do, in a sentence", async () => {
    await expect(rig.service.request(BLOCKED, "a")).rejects.toMatchObject({ status: 403 });
    await expect(rig.service.request(STRANGER, "a")).rejects.toMatchObject({ status: 403 });
    rig.worker.refuse = { message: "not an allowed host", status: 400 };
    await expect(rig.service.request(ALICE, "https://x.y/z")).rejects.toMatchObject({
      status: 400,
    });
    rig = await makeRig({ open: false });
    await expect(rig.service.request(ALICE, "a")).rejects.toBeInstanceOf(KaraokeError);
  });

  it("calls a job the worker lost an interrupted preparation", async () => {
    const asked = await rig.service.request(ALICE, "a");
    rig.worker.jobs.clear();
    await rig.service.tick(signal);
    expect(rig.service.song(ALICE, asked.song.id)).toMatchObject({
      state: "failed",
      error: "準備被中斷了,再點一次",
    });
  });
});

describe("singing", () => {
  it("serves the files only through its signed links, to its own member", async () => {
    const id = await ready(rig);
    const session = await rig.service.start(ALICE, "Alice", id);
    const url = new URL(session.backing_url, "http://x");
    const [, , , , , sid, name] = url.pathname.split("/");
    const exp = url.searchParams.get("exp") ?? undefined;
    const sig = url.searchParams.get("sig") ?? undefined;
    expect(session.backing_url).not.toContain("download");
    expect(await rig.service.file(ALICE, sid as string, name as string, exp, sig)).toMatchObject({
      type: "audio/mp4",
    });
    expect(await rig.service.file(BOB, sid as string, name as string, exp, sig)).toBeNull();
    expect(await rig.service.file(ALICE, sid as string, "reference.json", exp, sig)).toBeNull();
    expect(await rig.service.file(ALICE, sid as string, name as string, exp, `${sig}x`)).toBeNull();
    expect(await rig.service.file(ALICE, sid as string, "meta.json", exp, sig)).toBeNull();
    rig.clock.t += 11 * 60_000;
    expect(await rig.service.file(ALICE, sid as string, name as string, exp, sig)).toBeNull();
  });

  it("sings in another key: the worker's backing in it, and the reference moved with it", async () => {
    const id = await ready(rig);
    await expect(rig.service.start(ALICE, "Alice", id, 7)).rejects.toMatchObject({ status: 400 });
    const session = await rig.service.start(ALICE, "Alice", id, 3);
    expect(session.shift).toBe(3);
    const url = new URL(session.backing_url, "http://x");
    const [, , , , , sid, name] = url.pathname.split("/");
    expect(name).toBe("karaoke.k+3.m4a");
    const exp = url.searchParams.get("exp") ?? undefined;
    const sig = url.searchParams.get("sig") ?? undefined;
    expect(await rig.service.file(ALICE, sid as string, name as string, exp, sig)).toMatchObject({
      type: "audio/mp4",
    });
    expect(rig.worker.keys).toEqual([`${rig.store.song(id)?.worker_song}/3`]);
    // The same key again is not made again; the key is only this session's.
    const other = await rig.service.start(ALICE, "Alice", id, 3);
    expect(rig.worker.keys).toHaveLength(1);
    const plain = await rig.service.start(ALICE, "Alice", id);
    expect(plain.backing_url).toContain("karaoke.m4a");
    expect(await rig.service.file(ALICE, plain.session, "karaoke.k+3.m4a", exp, sig)).toBeNull();
    // Sung three semitones up, it scores as the song; the song's own key does not.
    const up = humanSinger(song);
    const shifted = { ...up, midi: up.midi.map((m) => (m === null ? null : m + 3)) };
    const rec = new TrackRecorder(shifted.hz);
    shifted.midi.forEach((m, j) => {
      rec.push(j / shifted.hz, m);
    });
    const body = {
      track: rec.encode(),
      latency_ms: 0,
      calibrated: true,
      client_total: null,
      browser: "",
    };
    rig.clock.t += rec.seconds * 1000 + 2000;
    expect((await rig.service.submit(ALICE, other.session, body)).total).toBeGreaterThan(85);
    expect((await rig.service.submit(ALICE, plain.session, body)).total).toBeLessThan(50);
    rig.worker.keyFails = true;
    await expect(rig.service.start(ALICE, "Alice", id, -2)).rejects.toMatchObject({ status: 503 });
  });

  it("scores the track again, keeps it, tells her once and counts it as singing together", async () => {
    const id = await ready(rig);
    const { result } = await sing(rig, id);
    expect(result.total).toBeGreaterThan(85);
    expect(result.unranked).toBe(false);
    expect(result.phrases).toHaveLength(song.lines.length);
    expect(result.phrases[0]?.text).toBe("第 1 句");
    expect(result.comment.state).toBe("waiting");
    expect(result.best_before).toBeNull();
    expect(rig.notes).toHaveLength(1);
    const note = rig.notes[0] as KaraokeNote;
    expect(note.context).toEqual({
      platform: "discord",
      scope: "111111",
      channel: "222222",
      kind: "channel",
    });
    expect(note.summary).toContain(`系統分數 ${result.total} 分`);
    expect(note.summary).toContain("第一次唱這首");
    expect(rig.together).toEqual([
      { person: "p-alice", detail: expect.stringContaining("測試的歌") },
    ]);
    // Her next turn in that channel is her comment.
    rig.service.heard(
      { platform: "discord", scope: "111111", channel: "222222", kind: "channel" },
      "唱得好穩!",
    );
    const again = rig.service.result(ALICE, result.session);
    expect(again.comment).toEqual({ state: "said", text: "唱得好穩!" });
    expect(rig.service.overview(ALICE).recent[0]).toMatchObject({ session: result.session });
    expect(() => rig.service.result(BOB, result.session)).toThrow(KaraokeError);
  });

  it("takes a track once, never too soon, and never a broken one", async () => {
    const id = await ready(rig);
    const { session } = await sing(rig, id);
    await expect(
      rig.service.submit(ALICE, session.session, {
        track: "AAAA",
        latency_ms: 0,
        calibrated: true,
        client_total: null,
        browser: "",
      }),
    ).rejects.toMatchObject({ status: 409 });
    const fresh = await rig.service.start(ALICE, "Alice", id);
    const rec = new TrackRecorder(100);
    for (const [j, m] of humanSinger(song).midi.entries()) rec.push(j / 100, m);
    await expect(
      rig.service.submit(ALICE, fresh.session, {
        track: rec.encode(),
        latency_ms: 0,
        calibrated: true,
        client_total: null,
        browser: "",
      }),
    ).rejects.toMatchObject({ status: 409, message: "這一次的時間對不上,沒有收" });
    await expect(
      rig.service.submit(ALICE, fresh.session, {
        track: "@@@",
        latency_ms: 0,
        calibrated: true,
        client_total: null,
        browser: "",
      }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      rig.service.submit(BOB, fresh.session, {
        track: "AAAA",
        latency_ms: 0,
        calibrated: true,
        client_total: null,
        browser: "",
      }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("marks a track copied from the reference unranked, and never a best", async () => {
    const id = await ready(rig);
    const first = await sing(rig, id);
    const copied = await sing(rig, id, copySinger(song, 100));
    expect(copied.result.unranked).toBe(true);
    expect(copied.result.best_before).toBe(first.result.total);
    const third = await sing(rig, id);
    expect(third.result.best_before).toBe(first.result.total);
    expect(rig.service.song(ALICE, id).best).toBe(first.result.total);
    expect(rig.service.song(ALICE, id).sung).toBe(3);
    expect(rig.service.adminResults().results[1]).toMatchObject({
      unranked: true,
      reasons: expect.arrayContaining([expect.any(String)]),
    });
  });

  it("only lets her know when there is no comment channel", async () => {
    rig = await makeRig({ comment_channel: "" });
    const id = await ready(rig);
    const { result } = await sing(rig, id);
    expect(result.comment).toEqual({ state: "none", text: null });
    expect(rig.notes[0]?.context).toBeNull();
  });
});

describe("upkeep", () => {
  it("gives up on a comment, deletes old tracks and idle files", async () => {
    const id = await ready(rig);
    const { result } = await sing(rig, id);
    rig.clock.t += COMMENT_WAIT_MS + 1000;
    await rig.service.tick(signal, true);
    expect(rig.service.result(ALICE, result.session).comment.state).toBe("none");
    rig.clock.t += Math.max(TRACK_KEEP_MS, FILES_KEEP_MS) + 1000;
    await rig.service.tick(signal, true);
    expect(rig.store.latest(5)[0]?.track).toBeNull();
    expect(rig.store.result(result.session)).not.toBeNull();
    await expect(readdir(join(rig.dir, id))).rejects.toThrow();
    // Sung again: the files come back from the worker.
    await sing(rig, id);
    expect((await readdir(join(rig.dir, id))).length).toBe(2);
  });

  it("forgets a person's singing, and keeps the songs", async () => {
    const id = await ready(rig);
    await sing(rig, id);
    const counts = rig.store.forgetPerson(["p-alice"]);
    expect(counts).toMatchObject({ karaoke_results: 1, karaoke_sessions: 1, karaoke_tracks: 1 });
    expect(rig.store.song(id)?.requested_by).toBeNull();
    expect(rig.service.overview(ALICE).recent).toEqual([]);
  });
});

describe("the official score from a recording", () => {
  it("replaces the estimate with the recording's score, and tells her once with it", async () => {
    const id = await ready(rig);
    // The browser's own detection is sloppy; the recording's pitch is clean.
    const { result, session } = await sing(rig, id, humanSinger(song, { wanderCents: 70 }), {
      recording: true,
    });
    expect(session.recording).toEqual({
      max_bytes: 8 * 1024 * 1024,
      max_seconds: expect.any(Number),
    });
    expect(result).toMatchObject({ source: "estimate", voice: { state: "waiting", checks: [] } });
    expect(rig.notes).toHaveLength(0); // waits for the official score
    // The same singing (the same timing), its recording started 0.3 s into the song; the browser
    // thought 0.25 s (the recorder's own start lag).
    rig.worker.readVoice = () => recordingOf(humanSinger(song), 0.3);
    const bytes = new Uint8Array([1, 2, 3, 4]);
    expect(rig.service.voice(ALICE, result.session, bytes, "audio/webm;codecs=opus", 250)).toEqual({
      state: "scoring",
    });
    await rig.service.voiceSettled();
    expect(bytes).toEqual(new Uint8Array(4)); // not kept in memory
    expect(rig.worker.voices).toMatchObject([{ size: 4, type: WEBM }]);
    const official = rig.service.result(ALICE, result.session);
    expect(official.source).toBe("voice");
    expect(official.voice).toEqual({
      state: "scored",
      estimate_total: result.total,
      checks: [],
      upload: false,
    });
    expect(official.total).toBeGreaterThan(85);
    expect(official.total).toBeGreaterThan(result.total);
    expect(rig.notes).toHaveLength(1);
    expect(rig.notes[0]?.summary).toContain(`系統分數 ${official.total} 分`);
    // The recording's pitch is kept beside the browser's track; never the sound.
    expect(rig.store.track(result.session)?.voice_frames).toEqual(expect.any(String));
    const detail = JSON.parse(rig.store.result(result.session)?.detail ?? "{}");
    expect(detail.voice).toMatchObject({ found: true });
    expect(Math.abs(detail.voice.offset_ms - 300)).toBeLessThanOrEqual(20);
    await rig.service.tick(signal);
    expect(rig.notes).toHaveLength(1);
    expect(rig.service.adminResults().results[0]).toMatchObject({
      source: "voice",
      voice_state: "scored",
      estimate_total: result.total,
    });
  });

  it("takes one recording, after the result, of a known kind and size", async () => {
    const id = await ready(rig);
    const started = await rig.service.start(ALICE, "Alice", id);
    const bytes = () => new Uint8Array([1]);
    expect(() => rig.service.voice(ALICE, started.session, bytes(), WEBM, 0)).toThrow(/先交/);
    const { result } = await sing(rig, id, humanSinger(song), { recording: true });
    rig.worker.readVoice = () => recordingOf(humanSinger(song), 0);
    const refuse = (f: () => unknown, status: number) => {
      try {
        f();
        expect.unreachable();
      } catch (error) {
        expect((error as KaraokeError).status).toBe(status);
      }
    };
    refuse(() => rig.service.voice(BOB, result.session, bytes(), WEBM, 0), 404);
    refuse(() => rig.service.voice(ALICE, result.session, bytes(), "video/mp4", 0), 415);
    refuse(() => rig.service.voice(ALICE, result.session, new Uint8Array(), WEBM, 0), 400);
    refuse(
      () => rig.service.voice(ALICE, result.session, new Uint8Array(8 * 1024 * 1024 + 1), WEBM, 0),
      413,
    );
    rig.service.voice(ALICE, result.session, bytes(), "audio/ogg", 0);
    refuse(() => rig.service.voice(ALICE, result.session, bytes(), WEBM, 0), 409);
    await rig.service.voiceSettled();
    expect(rig.worker.voices).toHaveLength(1);
    // A session that announced none takes none.
    const plain = await sing(rig, id);
    expect(plain.result.voice.state).toBe("none");
    refuse(() => rig.service.voice(ALICE, plain.result.session, bytes(), WEBM, 0), 409);
  });

  it("stays 預估 when the worker cannot read it, and tells her then", async () => {
    const id = await ready(rig);
    const { result } = await sing(rig, id, humanSinger(song), { recording: true });
    rig.worker.readVoice = null;
    rig.service.voice(ALICE, result.session, new Uint8Array([1]), WEBM, 0);
    await rig.service.voiceSettled();
    const after = rig.service.result(ALICE, result.session);
    expect(after).toMatchObject({ source: "estimate", total: result.total });
    expect(after.voice.state).toBe("failed");
    expect(rig.notes).toHaveLength(1);
  });

  it("does not wait for her beyond the bound, nor for a recording that never comes", async () => {
    const id = await ready(rig);
    const { result } = await sing(rig, id, humanSinger(song), { recording: true });
    await rig.service.tick(signal);
    expect(rig.notes).toHaveLength(0);
    rig.clock.t += rig.service.config.voice_wait_secs * 1000 + 1000;
    await rig.service.tick(signal);
    expect(rig.notes).toHaveLength(1); // the estimate, after the wait
    expect(rig.service.result(ALICE, result.session).voice.state).toBe("waiting");
    rig.clock.t += VOICE_UPLOAD_MS;
    await rig.service.tick(signal);
    expect(rig.service.result(ALICE, result.session).voice.state).toBe("failed");
    expect(rig.notes).toHaveLength(1);
    expect(() => rig.service.voice(ALICE, result.session, new Uint8Array([1]), WEBM, 0)).toThrow(
      KaraokeError,
    );
  });

  it("takes no recording when the setting is off", async () => {
    rig = await makeRig({ voice_score: false });
    const id = await ready(rig);
    const { result, session } = await sing(rig, id, humanSinger(song), { recording: true });
    expect(session.recording).toBeNull();
    expect(result.voice.state).toBe("none");
    expect(rig.notes).toHaveLength(1);
  });

  it("keeps a quiet or far-away voice off the bests, and says so", async () => {
    const id = await ready(rig);
    const { result } = await sing(rig, id, humanSinger(song), { recording: true });
    rig.worker.readVoice = () => recordingOf(humanSinger(song), 0, { level: -58, floor: -63 });
    rig.service.voice(ALICE, result.session, new Uint8Array([1]), WEBM, 0);
    await rig.service.voiceSettled();
    const after = rig.service.result(ALICE, result.session);
    expect(after.voice.checks).toEqual(["quiet"]);
    expect(after.unranked).toBe(true);
    expect(rig.service.song(ALICE, id).best).toBeNull();
  });
});

describe("the background video", () => {
  async function readyWithVideo(r: Rig): Promise<string> {
    const asked = await r.service.request(ALICE, "https://youtu.be/v");
    const job = r.store.song(asked.song.id)?.job as string;
    r.worker.finish(job, referenceOf(song, `k-${job}`), true);
    await r.service.tick(signal);
    await vi.waitFor(() => expect(r.worker.fetched).toContain(`k-${job}/video.mp4`));
    // The fake worker counts a file as fetched before it has written it, and Core's upkeep leaves a
    // video being fetched alone: under load an upkeep right after this skipped it (the flake).
    // Wait for the fetch itself.
    await r.service.filesSettled();
    return asked.song.id;
  }

  it("is fetched after the song, served on a link that lasts the session, as video/mp4", async () => {
    const id = await readyWithVideo(rig);
    expect(rig.service.song(ALICE, id).video).toBe(true);
    const session = await vi.waitFor(async () => {
      const s = await rig.service.start(ALICE, "Alice", id);
      expect(s.video_url).not.toBeNull();
      return s;
    });
    const url = new URL(session.video_url as string, "http://x");
    const [, , , , , sid, name] = url.pathname.split("/");
    const exp = url.searchParams.get("exp") ?? undefined;
    const sig = url.searchParams.get("sig") ?? undefined;
    rig.clock.t += 11 * 60_000; // past the other links
    expect(await rig.service.file(ALICE, sid as string, name as string, exp, sig)).toMatchObject({
      type: "video/mp4",
    });
    expect(await rig.service.file(BOB, sid as string, name as string, exp, sig)).toBeNull();
  });

  it("is neither asked for nor shown when videos are off; a song without one has the still", async () => {
    rig = await makeRig({ video: false });
    const asked = await rig.service.request(ALICE, "https://youtu.be/v");
    expect(rig.worker.asked[0]?.video).toBe(false);
    const job = rig.store.song(asked.song.id)?.job as string;
    rig.worker.finish(job, referenceOf(song, `k-${job}`), true);
    await rig.service.tick(signal);
    expect(rig.service.song(ALICE, asked.song.id).video).toBe(false);
    expect((await rig.service.start(ALICE, "Alice", asked.song.id)).video_url).toBeNull();
    const plain = await ready(rig, "https://youtu.be/plain");
    expect((await rig.service.start(ALICE, "Alice", plain)).video_url).toBeNull();
  });

  it("goes from Core after its own hours, before the other files", async () => {
    rig = await makeRig({ video_keep_hours: 1 });
    const id = await readyWithVideo(rig);
    rig.clock.t += 2 * 3_600_000;
    await rig.service.tick(signal, true);
    expect((await readdir(join(rig.dir, id))).sort()).toEqual(["karaoke.m4a", "reference.json"]);
  });
});

describe("the reference editor", () => {
  /** The song's editor view as Alice (a panel admin), its edit changed by `change` and saved. */
  async function saveAs(
    r: Rig,
    id: string,
    change: (d: EditDoc) => EditDoc,
    options: { revision?: number; who?: AccountRef; name?: string } = {},
  ) {
    const who = options.who ?? ALICE;
    const view = await r.service.editor(who, id, true);
    const d = change(docOf(view.reference, view.edit.pitch_shift));
    return r.service.saveEdit(
      who,
      options.name ?? "Alice",
      id,
      { ...d, revision: options.revision ?? view.edit.revision },
      true,
    );
  }

  /** What a session's signed `reference.json` link serves. */
  async function servedReference(r: Rig, id: string) {
    const session = await r.service.start(ALICE, "Alice", id);
    const url = new URL(session.reference_url, "http://x");
    const [, , , , , sid, name] = url.pathname.split("/");
    return r.service.file(
      ALICE,
      sid as string,
      name as string,
      url.searchParams.get("exp") ?? undefined,
      url.searchParams.get("sig") ?? undefined,
    );
  }

  const refuses = async (p: Promise<unknown>, status: number, message?: string) => {
    const error = await p.then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(KaraokeError);
    expect((error as KaraokeError).status).toBe(status);
    if (message !== undefined) expect((error as KaraokeError).message).toBe(message);
  };

  it("is for panel admins only, on a ready song", async () => {
    const id = await ready(rig);
    const only = "只有管理員能改歌詞和音符";
    await refuses(rig.service.editor(ALICE, id, false), 403, only);
    await refuses(
      rig.service.saveEdit(
        ALICE,
        "Alice",
        id,
        { ...docOf(await rig.service.reference(id), 0), revision: 0 },
        false,
      ),
      403,
      only,
    );
    await refuses(rig.service.restoreEdit(ALICE, "Alice", id, 0, false), 403, only);
    await refuses(rig.service.editBacking(ALICE, id, false), 403, only);
    await refuses(rig.service.editor(ALICE, "nope", true), 404, "沒有這首歌");
    const preparing = await rig.service.request(ALICE, "https://youtu.be/later");
    await refuses(rig.service.editor(ALICE, preparing.song.id, true), 409, "這首還沒準備好");
    // The worker's own, with nothing edited yet.
    const view = await rig.service.editor(ALICE, id, true);
    const worker = await rig.service.workerReference(id);
    expect(view).toMatchObject({
      song: { id, title: "測試的歌", artist: "某人", duration_s: worker.reference.duration_s },
      original: { lyrics: worker.reference.lyrics, notes: worker.reference.notes, pitch_shift: 0 },
      edit: { revision: 0, pitch_shift: 0, saved_by: null, saved_at: null, worker_changed: false },
      history: [],
      results: 0,
      backing_url: `/api/member/karaoke/edit/${id}/backing`,
    });
    expect(view.reference).toEqual(worker.reference);
    expect(worker.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(await rig.service.editBacking(ALICE, id, true)).toBe(join(rig.dir, id, "karaoke.m4a"));
  });

  it("saves an edit everyone sings against from then on; recorded scores stay", async () => {
    const id = await ready(rig);
    const before = await sing(rig, id);
    expect(before.result.total).toBeGreaterThan(85);
    // The whole curve three semitones up, and the first line's words corrected.
    const saved = await saveAs(rig, id, (d) => shiftSong(setLineText(d, 0, "改過的第一句"), 3));
    expect(saved.edit).toMatchObject({
      revision: 1,
      pitch_shift: 3,
      saved_by: "Alice",
      saved_at: toTimestamp(rig.clock.t),
      worker_changed: false,
    });
    expect(saved.history).toEqual([
      {
        action: "save",
        name: "Alice",
        at: saved.edit.saved_at,
        revision: 1,
        lines: 1,
        notes: song.notes.length,
        pitch_shift: 3,
      },
    ]);
    expect(saved.results).toBe(1);
    const ref = await rig.service.reference(id);
    expect(ref.lyrics?.lines[0]).toMatchObject({ text: "改過的第一句", edited: true });
    expect(ref.lyrics?.lines[1]?.edited).toBe(false);
    expect(ref).toEqual(saved.reference);
    // The worker's file is as it was.
    expect((await rig.service.workerReference(id)).reference.lyrics?.lines[0]?.text).toBe(
      "第 1 句",
    );
    // The member's signed link serves the edit, from memory.
    const served = await servedReference(rig, id);
    if (served === null || !("data" in served)) throw new Error("not served from memory");
    expect(served.type).toBe("application/json");
    expect(JSON.parse(new TextDecoder().decode(served.data))).toEqual(ref);
    // Scored against the edited curve: the original's key is now three semitones off.
    const flat = await sing(rig, id);
    expect(flat.result.total).toBeLessThan(50);
    const up = humanSinger(song);
    const sharp = await sing(rig, id, {
      ...up,
      midi: up.midi.map((m) => (m === null ? null : m + 3)),
    });
    expect(sharp.result.total).toBeGreaterThan(85);
    // What was recorded before stays as it was scored.
    expect(rig.service.result(ALICE, before.result.session).total).toBe(before.result.total);
  });

  it("refuses a save over a newer one, and a broken one with its problems", async () => {
    const id = await ready(rig);
    await saveAs(rig, id, (d) => setLineText(d, 0, "第一次"));
    const conflict = "有人在你之後存過了,重新載入再改";
    await refuses(
      saveAs(rig, id, (d) => setLineText(d, 0, "晚了"), { revision: 0 }),
      409,
      conflict,
    );
    // Five notes out of range: the first three, and how many more.
    await refuses(
      saveAs(rig, id, (d) => ({
        ...d,
        notes: d.notes.map((n, i) => (i < 5 ? { ...n, midi: 200 } : n)),
      })),
      400,
      `${[1, 2, 3].map((i) => `第 ${i} 個音符:音高超出範圍(C1 到 C7)`).join("；")}(還有 2 個問題)`,
    );
    const late = await rig.service.reference(id);
    await refuses(
      saveAs(rig, id, (d) => {
        const lines = [...(d.lyrics?.lines ?? [])];
        lines[0] = {
          ...(lines[0] as (typeof lines)[number]),
          start: late.duration_s + 5,
          end: null,
        };
        return { ...d, lyrics: { ...(d.lyrics as NonNullable<EditDoc["lyrics"]>), lines } };
      }),
      400,
    );
    await refuses(
      saveAs(rig, id, (d) => {
        const lines = [...(d.lyrics?.lines ?? [])];
        lines[0] = { ...(lines[0] as (typeof lines)[number]), heard: "字".repeat(1_600_000) };
        return { ...d, lyrics: { ...(d.lyrics as NonNullable<EditDoc["lyrics"]>), lines } };
      }),
      400,
      "改的內容太大了",
    );
    // Nothing of the refused ones was kept.
    const view = await rig.service.editor(ALICE, id, true);
    expect(view.edit.revision).toBe(1);
    expect(view.history).toHaveLength(1);
    expect(view.reference.lyrics?.lines[0]?.text).toBe("第一次");
  });

  it("restores the worker's, and counts revisions on after it", async () => {
    const id = await ready(rig);
    await refuses(rig.service.restoreEdit(ALICE, "Alice", id, 0, true), 409, "這首沒有改過");
    const saved = await saveAs(rig, id, (d) => ({ ...d, notes: deleteNotes(d, [0]).doc.notes }));
    expect(rig.service.song(ALICE, id).notes).toBe(song.notes.length - 1);
    await refuses(
      rig.service.restoreEdit(ALICE, "Alice", id, saved.edit.revision + 1, true),
      409,
      "有人在你之後存過了,重新載入再改",
    );
    rig.clock.t += 60_000;
    const restored = await rig.service.restoreEdit(BOB, "Bob", id, saved.edit.revision, true);
    expect(restored.edit).toEqual({
      revision: 0,
      pitch_shift: 0,
      saved_by: null,
      saved_at: null,
      worker_changed: false,
    });
    expect(restored.history.map((h) => [h.action, h.name, h.revision])).toEqual([
      ["restore", "Bob", 0],
      ["save", "Alice", 1],
    ]);
    const worker = await rig.service.workerReference(id);
    expect(await rig.service.reference(id)).toEqual(worker.reference);
    expect(rig.service.song(ALICE, id).notes).toBe(song.notes.length);
    expect(await servedReference(rig, id)).toMatchObject({
      path: join(rig.dir, id, "reference.json"),
    });
    await refuses(rig.service.restoreEdit(ALICE, "Alice", id, 0, true), 409, "這首沒有改過");
    // The next save is a new revision: a page that still shows the first one cannot save over it.
    const again = await saveAs(rig, id, (d) => setLineText(d, 1, "又改了"));
    expect(again.edit.revision).toBe(2);
    await refuses(
      saveAs(rig, id, (d) => d, { revision: 1 }),
      409,
      "有人在你之後存過了,重新載入再改",
    );
  });

  it("keeps the edit when the worker's reference changes, and says it changed", async () => {
    const id = await ready(rig);
    await saveAs(rig, id, (d) =>
      setLineText({ ...d, notes: deleteNotes(d, [0]).doc.notes }, 0, "改過"),
    );
    const made = rig.store.song(id)?.worker_song as string;
    const changed = referenceOf(song, made);
    const lines = changed.lyrics?.lines ?? [];
    lines[1] = { ...(lines[1] as (typeof lines)[number]), text: "新的第二句" };
    rig.worker.references.set(made, changed);
    // Nobody sang it for a day: its files go from Core, and come back from the worker.
    rig.clock.t += FILES_KEEP_MS + 1000;
    await rig.service.tick(signal, true);
    await expect(readdir(join(rig.dir, id))).rejects.toThrow();
    const { result } = await sing(rig, id);
    expect(result.phrases[0]?.text).toBe("改過");
    const view = await rig.service.editor(ALICE, id, true);
    expect(view.edit).toMatchObject({ revision: 1, worker_changed: true });
    expect(view.original.lyrics?.lines[1]?.text).toBe("新的第二句");
    expect(view.reference.lyrics?.lines.map((l) => l.text).slice(0, 2)).toEqual([
      "改過",
      "第 2 句",
    ]);
    // Saving again builds on the worker's new one.
    const resaved = await saveAs(rig, id, (d) => d);
    expect(resaved.edit.worker_changed).toBe(false);
  });

  it("keeps the edit when the song is prepared again, and the song row says what is sung", async () => {
    const id = await ready(rig);
    await saveAs(rig, id, (d) => ({ ...d, notes: deleteNotes(d, [0, 1]).doc.notes }));
    const made = rig.store.song(id)?.worker_song as string;
    const changed = referenceOf(song, made, "新版");
    changed.pitch = {
      ...changed.pitch,
      midi: changed.pitch.midi.map((m) => (m === null ? m : m + 0.01)),
    };
    // Prepared again by a new job of the worker (as after a failure and a retry).
    const job = await rig.worker.prepare({ query: "again" });
    rig.store.patchSong(id, { status: "preparing", job: job.id });
    rig.worker.finish(job.id, changed);
    await rig.service.tick(signal);
    const row = rig.service.song(ALICE, id);
    expect(row).toMatchObject({ state: "ready", notes: song.notes.length - 2, title: "新版" });
    expect((await rig.service.reference(id)).notes).toHaveLength(song.notes.length - 2);
    const view = await rig.service.editor(ALICE, id, true);
    expect(view.edit.worker_changed).toBe(true);
    expect(view.original.notes).toHaveLength(song.notes.length);
  });

  it("forgets who saved an edit, and keeps the edit; a merge moves it", async () => {
    const id = await ready(rig);
    await saveAs(rig, id, (d) => setLineText(d, 0, "改過"), { who: BOB, name: "Bob" });
    expect(rig.store.override(id)?.saved_person).toBe("p-bob");
    expect(rig.store.merge("p-alice", "p-bob").counts).toMatchObject({
      karaoke_references: 1,
      karaoke_reference_edits: 1,
    });
    expect(rig.store.override(id)?.saved_person).toBe("p-alice");
    expect(rig.store.forgetPerson(["p-alice"])).toMatchObject({
      karaoke_references: 1,
      karaoke_reference_edits: 1,
    });
    const view = await rig.service.editor(ALICE, id, true);
    expect(view.edit).toMatchObject({ revision: 1, saved_by: "" });
    expect(view.history.map((h) => h.name)).toEqual([""]);
    expect(view.reference.lyrics?.lines[0]?.text).toBe("改過");
    expect(rig.store.override(id)?.saved_person).toBeNull();
    expect(rig.store.edits(id)[0]?.person_id).toBeNull();
  });
});
