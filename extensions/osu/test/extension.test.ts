// The whole extension through the SDK runtime against a fake host, a fake request queue (osu_rl live.requests) and a
// fake seat (osu_rl live.room_play).

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { PassThrough } from "node:stream";
import { type InitializeResult, RpcPeer, runExtension } from "@miyoria/sdk";
import { afterEach, describe, expect, it } from "vitest";
import extension, { beatmapIdOf } from "../src/index.js";

const TOKEN = "test-token-0123456789";
const context = { platform: "discord", scope: null, channel: "c1", kind: "voice" };

let server: Server | undefined;
let shutdown: (() => Promise<void>) | undefined;

afterEach(async () => {
  await shutdown?.();
  shutdown = undefined;
  const s = server;
  if (s) await new Promise((resolve) => s.close(resolve));
  server = undefined;
});

function host() {
  const hostToExt = new PassThrough();
  const extToHost = new PassThrough();
  const runtime = runExtension(extension, {
    input: hostToExt,
    output: extToHost,
    exit: () => {},
    timeoutMs: 2000,
  });
  const peer = new RpcPeer({
    input: extToHost,
    output: hostToExt,
    timeoutMs: 3000,
    onRequest: () => ({}),
    onNotification: () => {},
  });
  shutdown = () => runtime.shutdown();
  return peer;
}

function initialize(peer: RpcPeer, config: Record<string, unknown>) {
  return peer.request<InitializeResult>("initialize", {
    protocol: 2,
    host: { name: "miyoria", version: "0.1.0" },
    extension: { id: "miyoria.osu", version: "0.2.0", dir: "/ext", game: null },
    config,
    permissions: { events: [], tools: false, commands: true, network: [], input: [] },
  });
}

interface Recorded {
  method: string;
  path: string;
  auth?: string;
  body: unknown;
}

/** A fake HTTP service: records requests, answers with `answer(path, body)` ([status, data]). */
async function fakeServer(
  answer: (path: string, body: Record<string, unknown>) => [number, unknown],
) {
  const requests: Recorded[] = [];
  const s = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : null;
      requests.push({
        method: req.method ?? "",
        path: req.url ?? "",
        auth: req.headers.authorization,
        body,
      });
      const [status, data] =
        req.headers.authorization === `Bearer ${TOKEN}`
          ? answer(req.url ?? "", body)
          : [401, { error: "unauthorized" }];
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(data));
    });
  });
  server = s;
  await new Promise<void>((resolve) => s.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${(s.address() as AddressInfo).port}`, requests };
}

/** Fake osu_rl request queue (live.requests), answering like the real one. */
function fakeQueue() {
  const item = (no: number, extra: Record<string, unknown> = {}) => ({
    no,
    title: "Soleily - Renatus [Hard]",
    stars: 4.214,
    length: 200,
    by: "Owen_",
    feel: "good",
    state: "waiting",
    result: null,
    ...extra,
  });
  return fakeServer((path, body) => {
    if (path === "/request") {
      if (body.beatmap_id === 404) return [400, { error: "找不到這張譜" }];
      return [200, { item: item(3), position: 2 }];
    }
    if (path === "/queue")
      return [
        200,
        {
          now: item(1, { state: "playing" }),
          queue: [item(2)],
          recent: [item(0, { state: "done", result: { accuracy: 0.9712, misses: 3 } })],
          held: true,
        },
      ];
    if (path === "/skip") return [200, { skipped: false }];
    if (path === "/clear") return [200, { cleared: 4, skipped: body.all === true }];
    return [404, { error: "not found" }];
  });
}

/** Fake osu_rl live.room_play, answering like the real one (vision only: no feel). */
function fakeSeat() {
  const status = {
    problem: null,
    room: true,
    room_id: 8,
    map: "Soleily - Renatus [Hard]",
    ready: true,
    preparing: false,
    playing: null,
    model: "r033_aim6/best_cal.pt",
    last: { map: "Soleily - Renatus [Normal]", accuracy: 96.5, misses: 2 },
  };
  return fakeServer((path, body) => {
    if (path === "/status") return [200, status];
    if (path === "/rooms")
      return [200, { rooms: [{ id: 8, name: "SQL's room", has_password: false }] }];
    if (path === "/join")
      return body.room_id === 8
        ? [200, status]
        : [400, { error: "already in room 8: leave it first" }];
    if (path === "/leave") return [200, { ...status, room: false, room_id: null }];
    return [404, { error: "not found" }];
  });
}

const invoke = (peer: RpcPeer, path: string, args: Record<string, unknown> = {}) =>
  peer.request<{ text: string; ephemeral?: boolean } | string>("commands.invoke", {
    path: path.split(" "),
    args,
    invoker: { platform: "discord", id: "789" },
    invoker_display_name: "Owen_",
    context,
    invoker_is_guild_admin: false,
  });
const text = (r: { text: string } | string) => (typeof r === "string" ? r : r.text);

describe("/queue osu", () => {
  it("registers nothing without queue_url or seat_url, and no tools", async () => {
    const peer = host();
    const result = await initialize(peer, { token: TOKEN });
    expect(result.contributions.commands ?? []).toEqual([]);
    expect(result.contributions.tools ?? []).toEqual([]);
  });

  it("turns the commands into the queue's HTTP calls", async () => {
    const queue = await fakeQueue();
    const peer = host();
    const result = await initialize(peer, { token: TOKEN, queue_url: queue.url });
    const commands = result.contributions.commands ?? [];
    expect(commands.map((c) => [c.path.join(" "), c.permission])).toEqual([
      ["queue osu request", "queue.request"],
      ["queue osu list", "queue.list"],
      ["queue osu skip", "queue.osu.skip"],
      ["queue osu clear", "queue.osu.clear"],
    ]);
    // the vision student has no feel to pick
    expect(
      commands.find((c) => c.path.join(" ") === "queue osu request")?.args.map((a) => a.name),
    ).toEqual(["map"]);

    expect(
      text(
        await invoke(peer, "queue osu request", {
          map: "https://osu.ppy.sh/beatmapsets/1#osu/129891",
        }),
      ),
    ).toBe("已點播 #3 Soleily - Renatus \\[Hard\\]（★4.21，3:20）· Owen\\_，排第 2 首。");
    expect(await invoke(peer, "queue osu request", { map: "404" })).toEqual({
      text: "沒辦法點播：找不到這張譜",
      ephemeral: true,
    });
    // A link that names no difficulty never reaches the queue.
    expect(
      await invoke(peer, "queue osu request", { map: "https://osu.ppy.sh/beatmapsets/1" }),
    ).toMatchObject({ ephemeral: true });
    const list = text(await invoke(peer, "queue osu list"));
    expect(list).toMatch(/^AI 現在在多人房,點播先排著/);
    expect(list).toContain("正在打：#1");
    expect(list).toContain("1. #2");
    expect(list).toContain("：97.12%，miss 3");
    expect(await invoke(peer, "queue osu skip")).toEqual({
      text: "現在沒有在打點播。",
      ephemeral: true,
    });
    expect(text(await invoke(peer, "queue osu clear", { all: true }))).toBe(
      "清掉了 4 首點播，也停了正在打的。",
    );

    expect(queue.requests.map((r) => [r.method, r.path, r.body])).toEqual([
      ["POST", "/request", { beatmap_id: 129891, by: "Owen_", by_id: "discord:789" }],
      ["POST", "/request", { beatmap_id: 404, by: "Owen_", by_id: "discord:789" }],
      ["GET", "/queue", null],
      ["POST", "/skip", {}],
      ["POST", "/clear", { all: true }],
    ]);
    expect(queue.requests.every((r) => r.auth === `Bearer ${TOKEN}`)).toBe(true);
  });

  it("says when the queue is down", async () => {
    const peer = host();
    await initialize(peer, { token: TOKEN, queue_url: "http://127.0.0.1:1" });
    expect(text(await invoke(peer, "queue osu list"))).toMatch(/^連不到 osu! 點播服務/);
  });

  it("shows the seated AI and takes it into a room and out, with seat_url", async () => {
    const seat = await fakeSeat();
    const peer = host();
    const result = await initialize(peer, { token: TOKEN, seat_url: seat.url });
    expect(
      (result.contributions.commands ?? []).map((c) => [c.path.join(" "), c.permission]),
    ).toEqual([
      ["queue osu status", "queue.list"],
      ["queue osu join", "queue.osu.room"],
      ["queue osu leave", "queue.osu.room"],
    ]);
    const status = text(await invoke(peer, "queue osu status"));
    expect(status).toContain("AI 準備好了:Soleily - Renatus \\[Hard\\]");
    expect(status).toContain("在多人房裡(房間 8)。");
    expect(status).toContain("上一首:Soleily - Renatus \\[Normal\\] 96.50%,miss 2");
    expect(text(await invoke(peer, "queue osu join", { room: 8 }))).toBe(
      "AI 進了房間 8,譜下載好就會自己按準備。",
    );
    expect(await invoke(peer, "queue osu join", { room: 7, password: "pw" })).toEqual({
      text: "沒辦法進房:already in room 8: leave it first",
      ephemeral: true,
    });
    expect(text(await invoke(peer, "queue osu leave"))).toBe("AI 離開房間了。");
    expect(seat.requests.map((r) => [r.method, r.path, r.body])).toEqual([
      ["GET", "/status", null],
      ["POST", "/join", { room_id: 8 }],
      ["POST", "/join", { room_id: 7, password: "pw" }],
      ["POST", "/leave", {}],
    ]);
    expect(seat.requests.every((r) => r.auth === `Bearer ${TOKEN}`)).toBe(true);
  });

  it("gives her the tools, every play by the vision student", async () => {
    const seat = await fakeSeat();
    const queue = await fakeQueue();
    const peer = host();
    const result = await initialize(peer, {
      token: TOKEN,
      seat_url: seat.url,
      queue_url: queue.url,
    });
    const tools = result.contributions.tools ?? [];
    expect(tools.map((t) => [t.name, t.permission])).toEqual([
      ["osu_ai.status", null],
      ["osu_ai.list_rooms", null],
      ["osu_ai.join_room", "tools.osu.play"],
      ["osu_ai.leave_room", "tools.osu.play"],
      ["osu_ai.play_map", "tools.osu.play"],
    ]);
    const call = async (name: string, args: unknown) =>
      (
        await peer.request<{ content: string }>("tools.call", {
          name,
          args,
          context: {
            turn: "01J00000000000000000000000",
            context,
            account: { platform: "discord", id: "42" },
            message: { context, id: "m1" },
            priority: "normal",
          },
        })
      ).content;
    expect(JSON.parse(await call("osu_ai.status", {}))).toMatchObject({ room_id: 8, ready: true });
    expect(JSON.parse(await call("osu_ai.list_rooms", {}))).toMatchObject({ rooms: [{ id: 8 }] });
    expect(await call("osu_ai.join_room", { room_id: 7 })).toBe(
      "失敗:already in room 8: leave it first",
    );
    expect(JSON.parse(await call("osu_ai.play_map", { beatmap_id: 75 }))).toMatchObject({
      position: 2,
    });
    expect(queue.requests.map((r) => [r.path, r.body])).toEqual([
      ["/request", { beatmap_id: 75, by: "Miyoria", by_id: "miyoria" }],
    ]);
  });

  it("says when the seat is down", async () => {
    const peer = host();
    await initialize(peer, { token: TOKEN, seat_url: "http://127.0.0.1:1" });
    expect(await invoke(peer, "queue osu status")).toMatchObject({
      text: expect.stringMatching(/^連不到直播機的 osu! AI/),
      ephemeral: true,
    });
  });
});

describe("beatmapIdOf", () => {
  it("finds the difficulty in a link or a bare id", () => {
    expect(beatmapIdOf("129891")).toEqual({ id: 129891 });
    expect(beatmapIdOf(" https://osu.ppy.sh/beatmapsets/39804#osu/129891 ")).toEqual({
      id: 129891,
    });
    expect(beatmapIdOf("https://osu.ppy.sh/beatmaps/129891")).toEqual({ id: 129891 });
    expect(beatmapIdOf("https://osu.ppy.sh/b/129891?m=0")).toEqual({ id: 129891 });
    expect(beatmapIdOf("https://shdcloud.top/beatmapsets/1#osu/2")).toEqual({ id: 2 });
  });

  it("explains links it cannot use", () => {
    expect(beatmapIdOf("https://osu.ppy.sh/beatmapsets/39804")).toMatchObject({
      error: expect.stringMatching(/選一個難度/),
    });
    expect(beatmapIdOf("https://osu.ppy.sh/s/39804")).toMatchObject({
      error: expect.stringMatching(/選一個難度/),
    });
    expect(beatmapIdOf("https://osu.ppy.sh/beatmapsets/1#mania/2")).toMatchObject({
      error: expect.stringMatching(/standard/),
    });
    expect(beatmapIdOf("Renatus")).toMatchObject({ error: expect.any(String) });
    expect(beatmapIdOf("https://example.com/")).toMatchObject({ error: expect.any(String) });
  });
});
