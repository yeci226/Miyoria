// Karaoke rooms through the routes (docs/design/karaoke.md 「做了什麼第四步」): opening and paying,
// joining, the clock, a singer's microphone and pitch, and above all what each connection of the
// event stream is sent during a song: a singer's stream carries only their own trend, never the
// board, another singer's name or a score; a spectator's carries the board. And a panel admin can
// use karaoke while it is closed to members.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { KaraokeRoomView } from "@miyoria/contracts/api";
import {
  KaraokeConfigSchema,
  KaraokeKey,
  KaraokeRoomsKey,
  KaraokeService,
  KaraokeStore,
  karaokeSchema,
  RoomDesk,
} from "@miyoria/play/karaoke";
import { encodeTrack, toBase64 } from "@miyoria/play/karaoke/score";
import {
  FakeKaraokeWallet,
  FakeKaraokeWorker,
  humanSinger,
  referenceOf,
  synthSong,
} from "@miyoria/play/karaoke/testing";
import { openTestDb, type TestDb } from "@miyoria/store/testing";
import type { AccountRef, PersonId } from "@miyoria/types";
import type { AnyRouter } from "@orpc/server";
import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import { ApiError } from "../src/errors.js";
import {
  karaokeAdminRpc,
  karaokeRoomsRpc,
  karaokeRoutes,
  karaokeRpc,
} from "../src/karaoke-routes.js";
import { tableRoutes } from "../src/rpc.js";
import type { ApiEnv } from "../src/state.js";

const ALICE: AccountRef = { platform: "discord", id: "1" };
const BOB: AccountRef = { platform: "discord", id: "2" };
const CAROL: AccountRef = { platform: "discord", id: "3" };
const NAMES: Record<string, string> = { "1": "Alice", "2": "Bobby", "3": "Carol" };
const T0 = Date.UTC(2026, 10, 18, 4, 0, 0);
const song = synthSong(5, 4);

interface Rig {
  hono: Hono<ApiEnv>;
  desk: RoomDesk;
  service: KaraokeService;
  worker: FakeKaraokeWorker;
  wallet: FakeKaraokeWallet;
  clock: { t: number };
  as: { account: AccountRef; tier: "admin" | "member" };
  raw: TestDb;
  dir: string;
}

let rig: Rig | null = null;

async function makeRig(open = true): Promise<Rig> {
  const raw = openTestDb({ plugins: [karaokeSchema] });
  const worker = new FakeKaraokeWorker();
  const clock = { t: T0 };
  const dir = await mkdtemp(join(tmpdir(), "karaoke-rooms-api-"));
  const config = KaraokeConfigSchema.parse({ comment_channel: "discord:111111:222222", open });
  const store = new KaraokeStore(raw.db, raw.events);
  const who = (account: AccountRef) => ({
    person: `p-${account.id}` as PersonId,
    blocked: false,
  });
  const log = { info: () => {}, warn: () => {} };
  const service = new KaraokeService({
    config,
    store,
    worker: () => worker,
    now: () => clock.t,
    cacheDir: dir,
    who,
    tell: () => {},
    together: () => {},
    log,
  });
  const wallet = new FakeKaraokeWallet({ "1": "p-1", "2": "p-2", "3": "p-3" }, () => clock.t);
  for (const p of ["p-1", "p-2", "p-3"]) wallet.balances.set(p, 50);
  const desk = new RoomDesk({
    config,
    store,
    service,
    worker: () => worker,
    wallet: () => wallet,
    inVoice: () => true,
    who,
    tell: () => {},
    together: () => {},
    now: () => clock.t,
    log,
  });
  service.attachRooms(desk);
  const as: Rig["as"] = { account: ALICE, tier: "member" };
  const state = {
    publicSide: { config: { enabled: true }, admitMember: () => null },
    optional: () => undefined,
    service: (key: unknown, what: string) => {
      if (key === KaraokeKey) return service;
      if (key === KaraokeRoomsKey) return desk;
      throw ApiError.unavailable(`${what} is not available`);
    },
  };
  const table: AnyRouter = {
    karaoke: karaokeRpc,
    karaokeAdmin: karaokeAdminRpc,
    karaokeRooms: karaokeRoomsRpc,
  };
  const hono = new Hono<ApiEnv>();
  for (const r of [
    ...tableRoutes(state as never, table, { responseCheck: "strict" }),
    ...karaokeRoutes(state as never),
  ]) {
    hono.on(r.method, r.path, async (c) => {
      // Who asks is fixed when the request starts (a stream keeps its own).
      const me = { account: as.account, name: NAMES[as.account.id] ?? "?", tier: as.tier };
      if (r.member) c.set("member", me as never);
      try {
        return await r.handler(c);
      } catch (error) {
        return error instanceof ApiError
          ? error.toResponse()
          : ApiError.internal(error).toResponse();
      }
    });
  }
  // A ready song (asked for by an admin, so it works closed too).
  const asked = await service.request(ALICE, "https://youtu.be/rooms-api", true);
  const job = store.song(asked.song.id)?.job as string;
  worker.finish(job, referenceOf(song, `k-${job}`));
  await service.tick(new AbortController().signal);
  return { hono, desk, service, worker, wallet, clock, as, raw, dir };
}

afterEach(async () => {
  if (rig === null) return;
  rig.raw.close();
  await rm(rig.dir, { recursive: true, force: true });
  rig = null;
});

const post = (body: unknown) => ({
  method: "POST",
  body: JSON.stringify(body),
  headers: { "content-type": "application/json" },
});

async function call<T>(
  r: Rig,
  account: AccountRef,
  path: string,
  init?: RequestInit,
  tier: "admin" | "member" = "member",
): Promise<{ status: number; body: T }> {
  r.as.account = account;
  r.as.tier = tier;
  const res = await r.hono.request(path, init);
  const text = await res.text();
  return { status: res.status, body: (text === "" ? null : JSON.parse(text)) as T };
}

/** Opens `/events` as `account` and keeps everything it says until `stop`. */
async function listen(r: Rig, account: AccountRef, code: string) {
  r.as.account = account;
  r.as.tier = "member";
  const abort = new AbortController();
  const res = await r.hono.request(`/api/member/karaoke/rooms/${code}/events`, {
    signal: abort.signal,
  });
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toContain("text/event-stream");
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  const box = { text: "" };
  const loop = (async () => {
    for (;;) {
      const { done, value } = await reader.read().catch(() => ({ done: true, value: undefined }));
      if (done) return;
      box.text += decoder.decode(value, { stream: true });
    }
  })();
  return {
    box,
    events: () =>
      box.text
        .split("\n\n")
        .map((block) => /^event: (\w+)\ndata: (.*)$/m.exec(block))
        .filter((m): m is RegExpExecArray => m !== null)
        .map((m) => ({ type: m[1] as string, data: JSON.parse(m[2] as string) })),
    stop: async () => {
      abort.abort();
      await reader.cancel().catch(() => {});
      await loop;
    },
  };
}

const tick = async (r: Rig) => {
  await r.desk.tick();
  await r.desk.idle();
  await new Promise((resolve) => setTimeout(resolve, 0));
};

describe("karaoke rooms through the routes", () => {
  it("opens and pays, joins by code, and keeps the board from a singer's stream", {
    timeout: 30_000,
  }, async () => {
    const r = await makeRig();
    rig = r;
    const songId = r.service.overview(ALICE).songs[0]?.id as string;
    const terms = await call<{ terms: { price: number }; available: boolean; balance: number }>(
      r,
      ALICE,
      "/api/member/karaoke/rooms",
    );
    expect(terms.body).toMatchObject({ available: true, balance: 50, terms: { price: 20 } });
    const opened = await call<KaraokeRoomView>(
      r,
      ALICE,
      "/api/member/karaoke/rooms",
      post({ song: songId, shift: 0 }),
    );
    expect(opened.status).toBe(200);
    const code = opened.body.code;
    expect(r.wallet.balances.get("p-1")).toBe(30);
    expect((await call(r, BOB, "/api/member/karaoke/rooms/ABCDEF")).status).toBe(404);
    expect(
      (await call(r, BOB, `/api/member/karaoke/rooms/${code}/join`, post({ as: "singer" }))).status,
    ).toBe(200);
    expect(
      (await call(r, CAROL, `/api/member/karaoke/rooms/${code}/join`, post({ as: "spectator" })))
        .status,
    ).toBe(200);
    for (const a of [ALICE, BOB]) {
      const ready = await call(
        r,
        a,
        `/api/member/karaoke/rooms/${code}/ready`,
        post({ ready: true, latency_ms: 40, calibrated: true }),
      );
      expect(ready.status).toBe(200);
    }
    // Only the opener starts.
    expect((await call(r, BOB, `/api/member/karaoke/rooms/${code}/start`, post({}))).status).toBe(
      403,
    );
    const started = await call<KaraokeRoomView>(
      r,
      ALICE,
      `/api/member/karaoke/rooms/${code}/start`,
      post({}),
    );
    expect(started.body.state).toBe("countdown");
    // The clock.
    const clock = await call<{ t0: number; server_ms: number }>(
      r,
      BOB,
      `/api/member/karaoke/rooms/${code}/clock`,
      post({ t0: 123 }),
    );
    expect(clock.body).toEqual({ t0: 123, server_ms: r.clock.t });
    const alice = await listen(r, ALICE, code);
    const bob = await listen(r, BOB, code);
    const carol = await listen(r, CAROL, code);
    r.clock.t = started.body.start_at_ms as number;
    await tick(r);
    // Sing a few seconds: audio (µ-law silence stands in for a voice) and the browser's pitch.
    const track = humanSinger(song, { seed: 3, hz: 50 }).midi.slice(0, 400);
    for (const a of [ALICE, BOB]) {
      const mine = await call<KaraokeRoomView>(r, a, `/api/member/karaoke/rooms/${code}`);
      r.worker.streamTracks.set(
        mine.body.me?.session?.session ?? "",
        track.map((m) => m ?? null),
      );
    }
    for (let i = 0; i < 12; i++) {
      r.clock.t += 500;
      for (const a of [ALICE, BOB]) {
        r.as.account = a;
        const audio = await r.hono.request(
          `/api/member/karaoke/rooms/${code}/audio?at=${i * 8000}&song_ms=${i * 500}`,
          {
            method: "POST",
            body: new Uint8Array(8000).fill(0xff),
            headers: { "content-type": "application/octet-stream" },
          },
        );
        expect(audio.status).toBe(200);
        expect(await audio.json()).toEqual({ stream: "live", relay: false });
        const pitch = await call(
          r,
          a,
          `/api/member/karaoke/rooms/${code}/pitch`,
          post({ from: i * 25, track: toBase64(encodeTrack(track.slice(i * 25, i * 25 + 25))) }),
        );
        expect(pitch.status).toBe(204);
      }
      await tick(r);
    }
    await alice.stop();
    await bob.stop();
    await carol.stop();
    for (const singer of [alice, bob]) {
      const got = singer.events();
      expect(got.some((e) => e.type === "trend")).toBe(true);
      expect(got.some((e) => e.type === "board")).toBe(false);
      // Nothing after the round started names another person or carries a score.
      const during = got.filter((e) => e.type !== "room");
      const text = JSON.stringify(during);
      expect(text).not.toMatch(/Bobby|Alice|Carol|"total"|"rank"/);
    }
    const watched = carol.events();
    const boards = watched.filter((e) => e.type === "board");
    expect(boards.length).toBeGreaterThan(3);
    expect(JSON.stringify(boards.at(-1))).toMatch(/Alice/);
    expect(JSON.stringify(boards.at(-1))).toMatch(/Bobby/);
    expect(watched.some((e) => e.type === "trend")).toBe(false);
    // Too much in one go is refused before it is read.
    const big = await r.hono.request(`/api/member/karaoke/rooms/${code}/audio?at=0&song_ms=0`, {
      method: "POST",
      body: new Uint8Array(40_000),
      headers: { "content-type": "application/octet-stream" },
    });
    expect(big.status).toBe(413);
  });

  it("lets a panel admin use karaoke while it is closed to members", async () => {
    const r = await makeRig(false);
    rig = r;
    const songId = r.service.overview(ALICE, true).songs[0]?.id as string;
    const member = await call<{ open: boolean; admin: boolean }>(r, BOB, "/api/member/karaoke");
    expect(member.body).toMatchObject({ open: false, admin: false });
    const admin = await call<{ open: boolean; admin: boolean }>(
      r,
      ALICE,
      "/api/member/karaoke",
      undefined,
      "admin",
    );
    expect(admin.body).toMatchObject({ open: false, admin: true });
    expect(
      (await call(r, BOB, `/api/member/karaoke/songs/${songId}/sessions`, post({}))).status,
    ).toBe(409);
    expect(
      (await call(r, ALICE, `/api/member/karaoke/songs/${songId}/sessions`, post({}), "admin"))
        .status,
    ).toBe(200);
    expect(
      (await call(r, BOB, "/api/member/karaoke/rooms", post({ song: songId, shift: 0 }))).status,
    ).toBe(409);
    const room = await call<KaraokeRoomView>(
      r,
      ALICE,
      "/api/member/karaoke/rooms",
      post({ song: songId, shift: 0 }),
      "admin",
    );
    expect(room.status).toBe(200);
    const rooms = await call<{ available: boolean; reason: string }>(
      r,
      BOB,
      "/api/member/karaoke/rooms",
    );
    expect(rooms.body).toMatchObject({ available: false, reason: "現在沒有開放唱 K" });
  });
});
