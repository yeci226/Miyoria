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
  roomPlaces,
} from "@miyoria/play/karaoke";
import { encodeTrack, toBase64 } from "@miyoria/play/karaoke/score";
import {
  FakeKaraokeWallet,
  FakeKaraokeWorker,
  humanSinger,
  referenceOf,
  synthSong,
} from "@miyoria/play/karaoke/testing";
import { configureLogging } from "@miyoria/runtime/kernel";
import { PeopleStoreKey, SpacePlaces } from "@miyoria/store";
import { openTestDb, type TestDb } from "@miyoria/store/testing";
import { type AccountRef, type PersonId, type Places, PlacesKey } from "@miyoria/types";
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
  /** With `servers`: the Spaces A (primary) and B, and who is a member where. */
  spaces: { A: string; B: string } | null;
  /** With `servers`: the servers she is in voice in. */
  voice: Set<string>;
}

let rig: Rig | null = null;

async function makeRig(open = true, servers = false): Promise<Rig> {
  const raw = openTestDb({ identity: true, plugins: [karaokeSchema] });
  // Two servers (phase 6): Alice is a member of both, Bob of A only, Carol of none.
  let places: Places | undefined;
  let spaces: Rig["spaces"] = null;
  const voice = new Set<string>();
  const people = new Map<string, PersonId>();
  if (servers) {
    const identity = raw.identity;
    if (identity === null) throw new Error("identity");
    const at = (scope: string, id: string) => {
      const r = identity.resolve(
        { platform: "discord", scope, channel: `${scope}-c`, kind: "channel" },
        { account: { platform: "discord", id }, display_name: NAMES[id] ?? id },
      );
      people.set(id, r.person_id as PersonId);
      return r.space_id as string;
    };
    const A = at("gA", "1");
    const B = at("gB", "1");
    at("gA", "2");
    raw.db.run("UPDATE spaces SET established = 1");
    places = new SpacePlaces(raw.db, identity);
    spaces = { A, B };
    voice.add(A);
    voice.add(B);
  }
  const worker = new FakeKaraokeWorker();
  const clock = { t: T0 };
  const dir = await mkdtemp(join(tmpdir(), "karaoke-rooms-api-"));
  const config = KaraokeConfigSchema.parse({ comment_channel: "discord:111111:222222", open });
  const store = new KaraokeStore(raw.db, raw.events);
  const who = (account: AccountRef) => ({
    person: people.get(account.id) ?? (`p-${account.id}` as PersonId),
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
    inVoice: (s) => !servers || (s === null ? voice.size > 0 : voice.has(s)),
    ...(places === undefined
      ? {}
      : {
          places: roomPlaces(places, {
            base: () => config,
            for: ({ space_id }) => ({
              ...config,
              comment_channel: space_id === spaces?.B ? "discord:gB:gB-c" : "discord:gA:gA-c",
            }),
          }),
        }),
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
    optional: (key: unknown) => {
      if (places === undefined) return undefined;
      if (key === PlacesKey) return places;
      if (key === PeopleStoreKey) {
        return { personByAccount: async (a: AccountRef) => ({ id: people.get(a.id) ?? null }) };
      }
      return undefined;
    },
    service: (key: unknown, what: string) => {
      if (key === KaraokeKey) return service;
      if (key === KaraokeRoomsKey) return desk;
      if (key === PlacesKey && places !== undefined) return places;
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
  return { hono, desk, service, worker, wallet, clock, as, raw, dir, spaces, voice };
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
    // Carol, watching, cheers Bobby (once: the second right after is too soon).
    const bobby = (
      await call<KaraokeRoomView>(r, CAROL, `/api/member/karaoke/rooms/${code}`)
    ).body.members.find((m) => m.name === "Bobby")?.id;
    const cheer = (kind: string) =>
      call<{ wait_ms: number }>(
        r,
        CAROL,
        `/api/member/karaoke/rooms/${code}/cheer`,
        post({ member: bobby, kind }),
      );
    const cheered = await cheer("wow");
    expect(cheered).toEqual({ status: 200, body: { wait_ms: 1_500 } });
    expect((await cheer("nice")).status).toBe(429);
    expect((await cheer("boo")).status).toBe(422);
    await tick(r);
    await carol.stop();
    for (const singer of [alice, bob]) {
      const got = singer.events();
      expect(got.some((e) => e.type === "trend")).toBe(true);
      expect(got.some((e) => e.type === "board")).toBe(false);
      // Nothing after the round started names another person or carries a rank; the only
      // number is their own running total in their trend.
      const during = got.filter((e) => e.type !== "room");
      const text = JSON.stringify(during);
      expect(text).not.toMatch(/Bobby|Alice|Carol|"rank"|"lines"/);
      for (const e of during) {
        expect(e.type).toBe("trend");
        expect(Object.keys(e.data).sort()).toEqual(["round", "source", "total", "trend", "type"]);
      }
      expect(during.at(-1)?.data.total).toEqual(expect.any(Number));
    }
    const watched = carol.events();
    const boards = watched.filter((e) => e.type === "board");
    expect(boards.length).toBeGreaterThan(3);
    expect(JSON.stringify(boards.at(-1))).toMatch(/Alice/);
    expect(JSON.stringify(boards.at(-1))).toMatch(/Bobby/);
    expect(watched.some((e) => e.type === "trend")).toBe(false);
    // The singers' own pitch, a few times a second, and the cheer.
    const live = watched.filter((e) => e.type === "live");
    expect(live.length).toBeGreaterThan(5);
    expect(live.at(-1)?.data.lines).toHaveLength(2);
    expect(watched.find((e) => e.type === "cheer")?.data).toMatchObject({
      member: bobby,
      kind: "wow",
      by: { name: "Carol" },
    });
    // Too much in one go is refused before it is read.
    const big = await r.hono.request(`/api/member/karaoke/rooms/${code}/audio?at=0&song_ms=0`, {
      method: "POST",
      body: new Uint8Array(40_000),
      headers: { "content-type": "application/octet-stream" },
    });
    expect(big.status).toBe(413);
  });

  it("logs a refused result at warn, without its track", async () => {
    const r = await makeRig();
    rig = r;
    const songId = r.service.overview(ALICE).songs[0]?.id as string;
    const started = await call<{ session: string }>(
      r,
      ALICE,
      `/api/member/karaoke/songs/${songId}/sessions`,
      post({}),
    );
    const lines: string[] = [];
    configureLogging({ level: "warn", destination: { write: (l: string) => void lines.push(l) } });
    const track = toBase64(encodeTrack(humanSinger(song, { seed: 4, hz: 50 }).midi));
    try {
      // Someone else's session: 404. A body that is not the contract's: 422 (the input check).
      const other = await call(
        r,
        BOB,
        `/api/member/karaoke/sessions/${started.body.session}/result`,
        post({ track, latency_ms: 0, calibrated: true, client_total: null, browser: "t" }),
      );
      expect(other.status).toBe(404);
      const bad = await call(
        r,
        CAROL,
        `/api/member/karaoke/sessions/${started.body.session}/result`,
        post({ track, latency_ms: 99_999 }),
      );
      expect(bad.status).toBe(422);
      // A room's microphone of someone not singing: 404 for the room.
      r.as.account = ALICE;
      const audio = await r.hono.request("/api/member/karaoke/rooms/ABCDEF/audio?at=0&song_ms=0", {
        method: "POST",
        body: new Uint8Array(100),
        headers: { "content-type": "application/octet-stream" },
      });
      expect(audio.status).toBe(404);
    } finally {
      configureLogging({ level: "silent" });
    }
    const refused = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(refused).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          level: 40,
          route: "karaoke.submit",
          status: 404,
          session: started.body.session,
          account: "discord:2",
        }),
        expect.objectContaining({ route: "karaoke.submit", status: 422 }),
        expect.objectContaining({ route: "karaokeRooms.audio", status: 404, room: "ABCDEF" }),
      ]),
    );
    expect(lines.join(" ")).not.toContain(track.slice(0, 40));
  });

  it("opens without a song, and queues, removes and moves songs through the routes", async () => {
    const r = await makeRig();
    rig = r;
    const songId = r.service.overview(ALICE).songs[0]?.id as string;
    const opened = await call<KaraokeRoomView>(r, ALICE, "/api/member/karaoke/rooms", post({}));
    expect(opened.status).toBe(200);
    expect(opened.body).toMatchObject({ song: null, queue: [], next: null, settling: null });
    const code = opened.body.code;
    const base = `/api/member/karaoke/rooms/${code}`;
    await call(r, BOB, `${base}/join`, post({ as: "spectator" }));
    // Anyone in the room queues; exactly one of song and text.
    const added = await call<KaraokeRoomView>(r, BOB, `${base}/queue`, post({ song: songId }));
    expect(added.status).toBe(200);
    expect(added.body.queue[0]).toMatchObject({ mine: true, by: { name: "Bobby" } });
    expect((await call(r, BOB, `${base}/queue`, post({}))).status).toBe(400);
    expect((await call(r, BOB, `${base}/queue`, post({ song: songId, text: "x" }))).status).toBe(
      400,
    );
    expect((await call(r, CAROL, `${base}/queue`, post({ song: songId }))).status).toBe(409);
    const mine = await call<KaraokeRoomView>(
      r,
      ALICE,
      `${base}/queue`,
      post({ song: songId, shift: 0 }),
    );
    const [bobs, alices] = mine.body.queue.map((e) => e.id) as [string, string];
    expect(mine.body.next).toBe(bobs);
    // Only the opener (or an admin) moves; the adder, the opener or an admin removes.
    expect((await call(r, BOB, `${base}/queue/${alices}/move`, post({ to: 0 }))).status).toBe(403);
    const moved = await call<KaraokeRoomView>(
      r,
      ALICE,
      `${base}/queue/${alices}/move`,
      post({ to: 0 }),
    );
    expect(moved.body.queue.map((e) => e.id)).toEqual([alices, bobs]);
    expect(
      (await call(r, CAROL, `${base}/queue/${bobs}/move`, post({ to: 0 }), "admin")).status,
    ).toBe(200);
    expect((await call(r, BOB, `${base}/queue/${alices}`, { method: "DELETE" })).status).toBe(403);
    const removed = await call<KaraokeRoomView>(r, BOB, `${base}/queue/${bobs}`, {
      method: "DELETE",
    });
    expect(removed.status).toBe(200);
    expect(removed.body.queue.map((e) => e.id)).toEqual([alices]);
    expect((await call(r, BOB, `${base}/queue/nope`, { method: "DELETE" })).status).toBe(404);
    // The old route to pick the song is gone.
    expect((await r.hono.request(`${base}/song`, post({ song: songId }))).status).toBe(404);
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

describe("karaoke rooms per server", () => {
  it("lists and opens in the server asked for, and refuses a server they are not in", async () => {
    const r = await makeRig(true, true);
    rig = r;
    const { A, B } = r.spaces as { A: string; B: string };
    // Alice opens one in B; Bob (A only) is refused B, and a server that does not exist.
    const opened = await call<KaraokeRoomView>(
      r,
      ALICE,
      `/api/member/karaoke/rooms?space=${B}`,
      post({}),
    );
    expect(opened.status).toBe(200);
    expect(r.desk.briefs(B).map((x) => x.code)).toEqual([opened.body.code]);
    expect(r.desk.briefs(A)).toEqual([]);
    const refused = await call<{ message: string }>(r, BOB, `/api/member/karaoke/rooms?space=${B}`);
    expect(refused.status).toBe(403);
    expect((await call(r, BOB, `/api/member/karaoke/rooms?space=${B}`, post({}))).status).toBe(403);
    expect((await call(r, BOB, "/api/member/karaoke/rooms?space=nowhere")).status).toBe(404);
    // Left out: their own server (Bob's is A); she is in A's voice.
    const own = await call<{ available: boolean }>(r, BOB, "/api/member/karaoke/rooms");
    expect(own.body.available).toBe(true);
    // Carol is a member nowhere: the primary, as before there were servers.
    const carol = await call<KaraokeRoomView>(r, CAROL, "/api/member/karaoke/rooms", post({}));
    expect(carol.status).toBe(200);
    expect(r.desk.briefs(A).map((x) => x.code)).toEqual([carol.body.code]);
    // The voice check is the server's own: out of A's voice, A says so; B is still open.
    r.voice.delete(A);
    const a = await call<{ available: boolean; reason: string }>(
      r,
      BOB,
      `/api/member/karaoke/rooms?space=${A}`,
    );
    expect(a.body).toMatchObject({ available: false });
    expect(a.body.reason).toContain("別的伺服器");
  });

  it("splits the admin's results by server only when asked", async () => {
    const r = await makeRig(true, true);
    rig = r;
    const all = await call<{ results: unknown[] }>(r, ALICE, "/api/karaoke/results");
    expect(all.status).toBe(200);
    expect(
      (await call(r, ALICE, `/api/karaoke/results?space=${(r.spaces as { A: string }).A}`)).status,
    ).toBe(200);
    expect((await call(r, ALICE, "/api/karaoke/results?space=nowhere")).status).toBe(404);
  });
});
