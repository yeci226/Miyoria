// Karaoke's routes, and the offline end-to-end check without people (docs/design/karaoke.md
// 「做了什麼(第一步)」): a song prepared by a song worker in memory, fetched through the member
// routes and the signed file links, then a "singer" made from the reference curve itself (and
// detuned, late and noisy ones) recorded the way the browser records, encoded, sent through the
// route, and scored again by Core with the shared module. The scores have to make sense.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  contract,
  type KaraokeEditView,
  type KaraokeResult,
  type KaraokeSession,
  routeMeta,
} from "@miyoria/contracts/api";
import { WorkersKaraokeReferenceSchema } from "@miyoria/contracts/workers";
import {
  KaraokeConfigSchema,
  KaraokeKey,
  KaraokeService,
  KaraokeStore,
  karaokeSchema,
} from "@miyoria/play/karaoke";
import { docOf, setLineText } from "@miyoria/play/karaoke/edit";
import { type PitchTrack, resampleTrack, TrackRecorder } from "@miyoria/play/karaoke/score";
import {
  FAKE_BACKING,
  FAKE_VIDEO,
  FakeKaraokeWorker,
  humanSinger,
  noiseSinger,
  referenceOf,
  synthSong,
} from "@miyoria/play/karaoke/testing";
import { openTestDb, type TestDb } from "@miyoria/store/testing";
import { AuthorizerKey } from "@miyoria/types";
import type { AnyRouter } from "@orpc/server";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../src/errors.js";
import { byteRange, karaokeAdminRpc, karaokeRoutes, karaokeRpc } from "../src/karaoke-routes.js";
import { rpcRoutes, tableRoutes } from "../src/rpc.js";
import type { ApiEnv } from "../src/state.js";

const ALICE = { platform: "discord", id: "1" };
const BOB = { platform: "discord", id: "2" };
const T0 = Date.UTC(2026, 10, 18, 4, 0, 0);
const song = synthSong(4, 8);

interface Rig {
  hono: Hono<ApiEnv>;
  service: KaraokeService;
  worker: FakeKaraokeWorker;
  clock: { t: number };
  /** Who the next request is from: their account, their session tier, and whether it may write. */
  as: { account: typeof ALICE; tier: "admin" | "member"; write: boolean };
  raw: TestDb;
  dir: string;
}

let rig: Rig;

beforeEach(async () => {
  const raw = openTestDb({ identity: true, plugins: [karaokeSchema] });
  const worker = new FakeKaraokeWorker();
  const clock = { t: T0 };
  const dir = await mkdtemp(join(tmpdir(), "karaoke-api-"));
  const service = new KaraokeService({
    config: KaraokeConfigSchema.parse({ comment_channel: "discord:111111:222222" }),
    store: new KaraokeStore(raw.db, raw.events),
    worker: () => worker,
    now: () => clock.t,
    cacheDir: dir,
    who: (account) => ({ person: `p-${account.id}`, blocked: false }),
    tell: () => {},
    together: () => {},
    log: { info: () => {}, warn: () => {} },
  });
  const as: Rig["as"] = { account: ALICE, tier: "member", write: true };
  const state = {
    publicSide: { config: { enabled: true }, admitMember: () => null },
    // A session holds every permission node, unless it may not write (`admin.panel.write`).
    optional: (key: unknown) =>
      key === AuthorizerKey
        ? { allows: (_: unknown, node: string) => as.write || node !== "admin.panel.write" }
        : undefined,
    service: (key: unknown, what: string) => {
      if (key === KaraokeKey) return service;
      throw ApiError.unavailable(`${what} is not available`);
    },
  };
  const table: AnyRouter = { karaoke: karaokeRpc, karaokeAdmin: karaokeAdminRpc };
  const hono = new Hono<ApiEnv>();
  const all = [
    ...tableRoutes(state as never, table, { responseCheck: "strict" }),
    ...karaokeRoutes(state as never),
  ];
  for (const r of all) {
    hono.on(r.method, r.path, async (c) => {
      if (r.member) {
        c.set("member", { account: as.account, name: "Alice", tier: as.tier } as never);
      }
      try {
        return await r.handler(c);
      } catch (error) {
        return error instanceof ApiError
          ? error.toResponse()
          : ApiError.internal(error).toResponse();
      }
    });
  }
  rig = { hono, service, worker, clock, as, raw, dir };
});

afterEach(async () => {
  rig.raw.close();
  await rm(rig.dir, { recursive: true, force: true });
});

const post = (body: unknown) => ({
  method: "POST",
  body: JSON.stringify(body),
  headers: { "content-type": "application/json" },
});

async function call<T>(path: string, init?: RequestInit): Promise<{ status: number; body: T }> {
  const res = await rig.hono.request(path, init);
  const text = await res.text();
  return { status: res.status, body: (text === "" ? null : JSON.parse(text)) as T };
}

/** A song asked for through the route and finished by the worker; its id. */
async function prepared(): Promise<string> {
  const asked = await call<{ song: { id: string }; created: boolean }>(
    "/api/member/karaoke/songs",
    post({ text: "https://youtu.be/e2e" }),
  );
  expect(asked.status).toBe(200);
  expect(asked.body.created).toBe(true);
  const [job] = [...rig.worker.jobs.keys()];
  rig.worker.finish(job as string, referenceOf(song, "k-e2e"));
  // The module's pass, once.
  await rig.service.tick(new AbortController().signal);
  return asked.body.song.id;
}

/**
 * One singing through the routes, the way the page does it: start, fetch the reference and the
 * backing through their signed links, record the detections at 100 Hz, wait the song's length,
 * send the encoded track.
 */
async function singThrough(
  songId: string,
  singer: PitchTrack,
  latency_ms: number,
  calibrated = true,
  recording = false,
): Promise<KaraokeResult> {
  const started = await call<KaraokeSession>(
    `/api/member/karaoke/songs/${songId}/sessions`,
    post({}),
  );
  expect(started.status).toBe(200);
  const refRes = await rig.hono.request(started.body.reference_url);
  expect(refRes.status).toBe(200);
  expect(refRes.headers.get("content-type")).toBe("application/json");
  expect(refRes.headers.get("content-disposition")).toBeNull();
  const reference = WorkersKaraokeReferenceSchema.parse(await refRes.json());
  const backing = await rig.hono.request(started.body.backing_url);
  expect(backing.headers.get("content-type")).toBe("audio/mp4");
  expect(new Uint8Array(await backing.arrayBuffer())).toEqual(FAKE_BACKING);
  const rec = new TrackRecorder(100);
  singer.midi.forEach((m, j) => {
    rec.push(j / singer.hz, m);
  });
  expect(rec.seconds).toBeLessThanOrEqual(reference.duration_s + 1);
  rig.clock.t += reference.duration_s * 1000 + 3000;
  const sent = await call<KaraokeResult>(
    `/api/member/karaoke/sessions/${started.body.session}/result`,
    post({
      track: rec.encode(),
      latency_ms,
      calibrated,
      client_total: null,
      browser: "test",
      recording,
    }),
  );
  expect(sent.status).toBe(200);
  return sent.body;
}

describe("the karaoke routes", () => {
  it("are member routes, limited (saving an edit needs a node); the owner's list is an admin route", () => {
    for (const name of ["overview", "request", "song", "start", "submit", "result", "editor"]) {
      expect(routeMeta(contract, ["karaoke", name])).toEqual({
        audience: "member",
        permission: null,
        limited: true,
      });
    }
    for (const name of ["saveEdit", "restoreEdit"]) {
      expect(routeMeta(contract, ["karaoke", name])).toEqual({
        audience: "member",
        permission: "admin.panel.write",
        refusal: "這個帳號只能看,不能存",
        limited: true,
      });
    }
    expect(routeMeta(contract, ["karaokeAdmin", "results"])).toEqual({
      audience: "admin",
      permission: null,
    });
  });

  it("go away with the public side's switch, the owner's stays", () => {
    const off = { publicSide: { config: { enabled: false } }, optional: () => undefined };
    const paths = rpcRoutes(off as never).map((r) => r.path);
    expect(paths).not.toContain("/api/member/karaoke");
    expect(paths).toContain("/api/karaoke/results");
    expect(karaokeRoutes(off as never)).toEqual([]);
  });

  it("answer a refusal with its status and sentence, and a stranger's link with a 404", async () => {
    const id = await prepared();
    const bad = await call<{ error: string }>("/api/member/karaoke/songs/nope");
    expect(bad).toMatchObject({ status: 404, body: { error: "沒有這首歌" } });
    const started = await call<KaraokeSession>(
      `/api/member/karaoke/songs/${id}/sessions`,
      post({}),
    );
    rig.as.account = BOB;
    expect((await rig.hono.request(started.body.backing_url)).status).toBe(404);
    const theirs = await call(`/api/member/karaoke/sessions/${started.body.session}`);
    expect(theirs.status).toBe(404);
    const overview = await call<{ songs: { id: string; state: string }[] }>("/api/member/karaoke");
    expect(overview.body.songs).toEqual([expect.objectContaining({ id, state: "ready" })]);
  });
});

describe("offline end to end: encoder, route, Core's score", () => {
  it("scores the reference sung back high (and flags the exact copy), a detuned or noisy one low", async () => {
    const id = await prepared();
    // The reference curve itself, as a program would send it: high, and unranked.
    const copy = await singThrough(id, { hz: 50, midi: song.reference.midi.map((m) => m) }, 0);
    expect(copy.total).toBeGreaterThan(90);
    expect(copy.unranked).toBe(true);
    // A good human-like singer on a device 150 ms late, calibrated: high, steady, ranked.
    const good = await singThrough(id, humanSinger(song, { lateMs: 150 }), 150);
    expect(good.total).toBeGreaterThan(85);
    expect(good.unranked).toBe(false);
    expect(good.rhythm.feel).toBe("steady");
    expect(good.comment.state).toBe("waiting");
    // The same singer whose latency was not taken out: late.
    const late = await singThrough(id, humanSinger(song, { lateMs: 150 }), 0);
    expect(late.rhythm.feel).toBe("late");
    expect(late.total).toBeLessThan(good.total);
    // Without calibration, rhythm stands in for pitch and says nothing about timing.
    const uncalibrated = await singThrough(id, humanSinger(song), 0, false);
    expect(uncalibrated.rhythm.measured).toBe(false);
    // A semitone sharp all the way: the pitch part is gone.
    const detuned = await singThrough(id, humanSinger(song, { transpose: 1 }), 0);
    expect(detuned.pitch.score).toBeLessThan(5);
    expect(detuned.total).toBeLessThan(40);
    // Noise.
    const noisy = await singThrough(id, noiseSinger(song, 11, 0.7), 0);
    expect(noisy.total).toBeLessThan(15);
    // An octave low is as good as in the original octave.
    const low = await singThrough(id, humanSinger(song, { transpose: -12 }), 0);
    expect(low.facts.octave).toBe(-1);
    const same = await singThrough(id, humanSinger(song), 0);
    expect(Math.abs(low.total - same.total)).toBeLessThanOrEqual(1);
    // The owner sees the flag; the member's list has every result.
    const admin = await call<{ results: { unranked: boolean }[] }>("/api/karaoke/results");
    expect(admin.body.results.filter((r) => r.unranked)).toHaveLength(1);
    const mine = await call<{ recent: unknown[] }>("/api/member/karaoke");
    expect(mine.body.recent).toHaveLength(8);
  });
});

describe("the recording and the background video", () => {
  it("takes the recording once through its route, and the official score replaces the estimate", async () => {
    const id = await prepared();
    // The browser's detection is sloppy; the recording (read by the worker) is clean.
    const estimate = await singThrough(id, humanSinger(song, { wanderCents: 70 }), 0, true, true);
    expect(estimate).toMatchObject({ source: "estimate", voice: { state: "waiting" } });
    rig.worker.readVoice = () => {
      const midi = resampleTrack(humanSinger(song), 50);
      return {
        hz: 50,
        midi,
        seconds: midi.length / 50,
        level_db: -20,
        floor_db: -60,
        device: "cuda",
        method: "rmvpe",
      };
    };
    const upload = (body: Uint8Array<ArrayBuffer>, type = "audio/webm") =>
      rig.hono.request(`/api/member/karaoke/sessions/${estimate.session}/voice?offset_ms=0`, {
        method: "POST",
        body,
        headers: { "content-type": type },
      });
    expect((await upload(new Uint8Array([1, 2]), "text/plain")).status).toBe(415);
    const big = await upload(new Uint8Array(8 * 1024 * 1024 + 1));
    expect(big.status).toBe(413);
    const res = await upload(new Uint8Array([1, 2, 3]));
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ state: "scoring" });
    expect((await upload(new Uint8Array([1]))).status).toBe(409);
    await rig.service.voiceSettled();
    const official = await call<KaraokeResult>(`/api/member/karaoke/sessions/${estimate.session}`);
    expect(official.body).toMatchObject({
      source: "voice",
      voice: { state: "scored", estimate_total: estimate.total, checks: [] },
    });
    expect(official.body.total).toBeGreaterThan(estimate.total);
    expect(rig.worker.voices).toMatchObject([{ size: 3, type: "audio/webm" }]);
    rig.as.account = BOB;
    expect((await upload(new Uint8Array([1]))).status).toBe(404);
  });

  it("serves the video in byte ranges", async () => {
    const asked = await call<{ song: { id: string } }>(
      "/api/member/karaoke/songs",
      post({ text: "https://youtu.be/video" }),
    );
    const [job] = [...rig.worker.jobs.keys()];
    rig.worker.finish(job as string, referenceOf(song, "k-video"), true);
    await rig.service.tick(new AbortController().signal);
    const started = await vi.waitFor(async () => {
      const s = await call<KaraokeSession>(
        `/api/member/karaoke/songs/${asked.body.song.id}/sessions`,
        post({}),
      );
      expect(s.body.video_url).not.toBeNull();
      return s.body;
    });
    const whole = await rig.hono.request(started.video_url as string);
    expect(whole.status).toBe(200);
    expect(whole.headers.get("content-type")).toBe("video/mp4");
    expect(whole.headers.get("accept-ranges")).toBe("bytes");
    expect(new Uint8Array(await whole.arrayBuffer())).toEqual(FAKE_VIDEO);
    const part = await rig.hono.request(started.video_url as string, {
      headers: { range: "bytes=4-7" },
    });
    expect(part.status).toBe(206);
    expect(part.headers.get("content-range")).toBe(`bytes 4-7/${FAKE_VIDEO.length}`);
    expect(new Uint8Array(await part.arrayBuffer())).toEqual(FAKE_VIDEO.slice(4, 8));
    const past = await rig.hono.request(started.video_url as string, {
      headers: { range: "bytes=999-" },
    });
    expect(past.status).toBe(416);
  });

  it("reads one byte range of a header", () => {
    expect(byteRange(undefined, 10)).toBeNull();
    expect(byteRange("bytes=0-", 10)).toEqual({ start: 0, end: 9 });
    expect(byteRange("bytes=2-4", 10)).toEqual({ start: 2, end: 4 });
    expect(byteRange("bytes=8-20", 10)).toEqual({ start: 8, end: 9 });
    expect(byteRange("bytes=-3", 10)).toEqual({ start: 7, end: 9 });
    expect(byteRange("bytes=10-", 10)).toBe("unsatisfiable");
    expect(byteRange("bytes=0-1,4-5", 10)).toBeNull();
    expect(byteRange("items=0-1", 10)).toBeNull();
  });
});

describe("the reference editor's routes", () => {
  const put = (body: unknown) => ({ ...post(body), method: "PUT" });

  it("are a panel admin's, and saving needs admin.panel.write", async () => {
    const id = await prepared();
    const path = `/api/member/karaoke/songs/${id}/edit`;
    const only = { error: "只有管理員能改歌詞和音符" };
    expect(await call(path)).toMatchObject({ status: 403, body: only });
    rig.as.tier = "admin";
    const view = await call<KaraokeEditView>(path);
    expect(view.status).toBe(200);
    expect(view.body.edit).toMatchObject({ revision: 0, worker_changed: false });
    const doc = setLineText(docOf(view.body.reference, 0), 0, "改過的第一句");
    // A session that may only look.
    rig.as.write = false;
    expect(await call(path, put({ ...doc, revision: 0 }))).toMatchObject({
      status: 403,
      body: { error: "這個帳號只能看,不能存" },
    });
    rig.as.write = true;
    const saved = await call<KaraokeEditView>(path, put({ ...doc, revision: 0 }));
    expect(saved.status).toBe(200);
    expect(saved.body.edit).toMatchObject({ revision: 1, saved_by: "Alice" });
    expect(saved.body.reference.lyrics?.lines[0]?.text).toBe("改過的第一句");
    expect(await call(path, put({ ...doc, revision: 0 }))).toMatchObject({
      status: 409,
      body: { error: "有人在你之後存過了,重新載入再改" },
    });
    const broken = { ...doc, notes: doc.notes.map((n) => ({ ...n, midi: 200 })), revision: 1 };
    const refused = await call<{ error: string }>(path, put(broken));
    expect(refused.status).toBe(400);
    expect(refused.body.error).toMatch(/^第 1 個音符:音高超出範圍/);
    // A member singing it gets the edit through the signed link.
    rig.as.tier = "member";
    const started = await call<KaraokeSession>(
      `/api/member/karaoke/songs/${id}/sessions`,
      post({}),
    );
    const ref = await rig.hono.request(started.body.reference_url);
    expect(ref.status).toBe(200);
    expect(ref.headers.get("content-type")).toBe("application/json");
    expect(ref.headers.get("content-disposition")).toBeNull();
    const served = WorkersKaraokeReferenceSchema.parse(await ref.json());
    expect(served.version === 2 && served.lyrics?.lines[0]?.text).toBe("改過的第一句");
    expect(await call(`${path}/restore`, post({ revision: 1 }))).toMatchObject({
      status: 403,
      body: only,
    });
    rig.as.tier = "admin";
    const restored = await call<KaraokeEditView>(`${path}/restore`, post({ revision: 1 }));
    expect(restored.status).toBe(200);
    expect(restored.body.edit.revision).toBe(0);
    expect(restored.body.history.map((h) => h.action)).toEqual(["restore", "save"]);
    expect(restored.body.reference.lyrics?.lines[0]?.text).toBe(song.lines[0]?.text);
  });

  it("serve the backing to a panel admin only, in byte ranges", async () => {
    const id = await prepared();
    rig.as.tier = "admin";
    const view = await call<KaraokeEditView>(`/api/member/karaoke/songs/${id}/edit`);
    const whole = await rig.hono.request(view.body.backing_url);
    expect(whole.status).toBe(200);
    expect(whole.headers.get("content-type")).toBe("audio/mp4");
    expect(whole.headers.get("content-disposition")).toBeNull();
    expect(new Uint8Array(await whole.arrayBuffer())).toEqual(FAKE_BACKING);
    const part = await rig.hono.request(view.body.backing_url, { headers: { range: "bytes=2-3" } });
    expect(part.status).toBe(206);
    expect(new Uint8Array(await part.arrayBuffer())).toEqual(FAKE_BACKING.slice(2, 4));
    expect((await rig.hono.request("/api/member/karaoke/edit/nope/backing")).status).toBe(404);
    rig.as.tier = "member";
    expect((await rig.hono.request(view.body.backing_url)).status).toBe(404);
  });
});
