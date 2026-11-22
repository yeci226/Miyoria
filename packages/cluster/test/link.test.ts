// The control link against a real server: hello and its close codes, a replaced connection,
// reports feeding the registry, the requests Core serves, Core calling a host, and the events.

import { HOST_ERROR_CODE, HOST_LINK_CLOSE, HOST_PROTOCOL_VERSION } from "@miyoria/contracts/host";
import { RpcError } from "@miyoria/sdk";
import { afterEach, describe, expect, it } from "vitest";
import {
  approvedHost,
  FakeHost,
  Harness,
  nextEvent,
  open,
  report,
  service,
  waitUntil,
} from "./helpers.js";

let harness: Harness | null = null;

async function start(...args: Parameters<typeof Harness.start>): Promise<Harness> {
  harness = await Harness.start(...args);
  return harness;
}

afterEach(async () => {
  await harness?.stop();
  harness = null;
});

function hello(fields: Record<string, unknown>): string {
  return JSON.stringify({
    protocol: HOST_PROTOCOL_VERSION,
    name: "pc",
    platform: "win32",
    version: "0.1.0",
    ...fields,
  });
}

describe("hello", () => {
  it("refuses a bad hello, a stranger, a wrong key, a revoked host and silence", async () => {
    const h = await start({ hello_timeout_ms: 200 });
    const cluster = h.cluster();
    const { id, key } = approvedHost(cluster, "pc", ["asr"]);

    const garbage = await open(h.url());
    garbage.ws.send("not json");
    expect(await garbage.closed).toBe(HOST_LINK_CLOSE.BAD_HELLO);

    const shapeless = await open(h.url());
    shapeless.ws.send(JSON.stringify({ hello: true }));
    expect(await shapeless.closed).toBe(HOST_LINK_CLOSE.BAD_HELLO);

    const binary = await open(h.url());
    binary.ws.send(Buffer.from([1, 2, 3]));
    expect(await binary.closed).toBe(HOST_LINK_CLOSE.BAD_HELLO);

    const stranger = await open(h.url());
    stranger.ws.send(hello({ host: "nobody", key }));
    expect(await stranger.closed).toBe(HOST_LINK_CLOSE.UNAUTHORIZED);

    const wrongKey = await open(h.url());
    wrongKey.ws.send(hello({ host: id, key: `${key}x` }));
    expect(await wrongKey.closed).toBe(HOST_LINK_CLOSE.UNAUTHORIZED);

    // Another protocol, from a host that proved who it is.
    const future = await open(h.url());
    future.ws.send(hello({ host: id, key, protocol: HOST_PROTOCOL_VERSION + 1 }));
    expect(await future.closed).toBe(HOST_LINK_CLOSE.BAD_HELLO);

    const silent = await open(h.url());
    expect(await silent.closed).toBe(HOST_LINK_CLOSE.TIMEOUT);

    cluster.hosts.revoke("pc");
    const revoked = await open(h.url());
    revoked.ws.send(hello({ host: id, key }));
    expect(await revoked.closed).toBe(HOST_LINK_CLOSE.UNAUTHORIZED);
  });

  it("welcomes a host with what it is approved for, and records the visit", async () => {
    const h = await start();
    const cluster = h.cluster();
    const { id, key } = approvedHost(cluster, "main-pc", ["asr", "tts"]);
    const sub = h.bus.subscribe(["cluster.*"]);
    const host = await FakeHost.connect(h.url(), { host: id, key, name: "what-i-call-myself" });
    expect(host.welcome).toEqual({
      protocol: HOST_PROTOCOL_VERSION,
      core_version: "9.9.9",
      host: "main-pc",
      approved: ["asr", "tts"],
    });
    const connected = await nextEvent(sub);
    expect(connected.type).toBe("cluster.host.connected");
    expect(connected.data).toEqual({
      host: "main-pc",
      platform: "win32",
      version: "0.1.0",
      approved: true,
    });
    const row = cluster.hosts.list()[0];
    expect(row?.platform).toBe("win32");
    expect(row?.last_seen_at).not.toBeNull();
    expect(cluster.hosts.connected().map((c) => c.name)).toEqual(["main-pc"]);

    await host.close();
    const gone = await nextEvent(sub);
    expect(gone.type).toBe("cluster.host.disconnected");
    expect(gone.data).toMatchObject({ host: "main-pc", code: 1000 });
    await waitUntil(() => cluster.hosts.connected().length === 0);
  });

  it("a second connection of the same host replaces the first", async () => {
    const h = await start();
    const cluster = h.cluster();
    const { id, key } = approvedHost(cluster, "pc", ["asr"]);
    const first = await FakeHost.connect(h.url(), { host: id, key });
    first.peer.notify("host.report", report([service({ name: "asr", url: "http://a:1" })]));
    await waitUntil(() => cluster.registry.pick("asr") !== null);
    const second = await FakeHost.connect(h.url(), { host: id, key });
    expect(await first.closed).toBe(HOST_LINK_CLOSE.REPLACED);
    // The old link's close leaves the new one alone.
    expect(cluster.hosts.connected().map((c) => c.name)).toEqual(["pc"]);
    second.peer.notify("host.report", report([service({ name: "asr", url: "http://b:2" })]));
    await waitUntil(() => cluster.registry.pick("asr")?.url === "http://b:2");
  });
});

describe("reports and the registry", () => {
  it("uses an approved host's report, ignores a pending one's until it is approved", async () => {
    const h = await start({ order: { asr: ["pending-pc"] } });
    const cluster = h.cluster();
    const approved = approvedHost(cluster, "main-pc", ["asr"]);
    const pending = cluster.hosts.create({ name: "pending-pc" });
    const a = await FakeHost.connect(h.url(), { host: approved.id, key: approved.key });
    const p = await FakeHost.connect(h.url(), { host: pending.host.id, key: pending.key });
    expect(p.welcome.approved).toEqual([]);
    a.peer.notify(
      "host.report",
      report([
        service({ name: "asr", url: "http://main:8003", token: "t1" }),
        // Not approved for tts: never returned.
        service({ name: "tts", url: "http://main:8002" }),
      ]),
    );
    p.peer.notify("host.report", report([service({ name: "asr", url: "http://other:8003" })]));
    await waitUntil(() => cluster.registry.pick("asr") !== null);
    expect(cluster.registry.candidates("asr").map((e) => e.host)).toEqual(["main-pc"]);
    expect(cluster.registry.pick("asr")?.headers).toEqual({ authorization: "Bearer t1" });
    expect(cluster.registry.pick("tts")).toBeNull();

    // Approval while connected: the report it already sent is used, first by `order`.
    const sub = h.bus.subscribe(["cluster.host.approved"]);
    cluster.hosts.approve("pending-pc", ["asr"]);
    expect((await nextEvent(sub)).data).toEqual({ host: "pending-pc", capabilities: ["asr"] });
    expect(cluster.registry.candidates("asr").map((e) => e.host)).toEqual([
      "pending-pc",
      "main-pc",
    ]);

    // A host that goes loses its endpoints at once.
    await p.close();
    await waitUntil(() => cluster.registry.candidates("asr").length === 1);
    await a.close();
    await waitUntil(() => cluster.registry.pick("asr") === null);
  });

  it("a bad report is ignored and the link stays", async () => {
    const h = await start();
    const cluster = h.cluster();
    const { id, key } = approvedHost(cluster, "pc", ["asr"]);
    const host = await FakeHost.connect(h.url(), { host: id, key });
    host.peer.notify("host.report", { services: "none" });
    host.peer.notify("host.report", report([service({ name: "asr", url: "http://pc:1" })]));
    await waitUntil(() => cluster.registry.pick("asr") !== null);
  });

  it("revoking a connected host closes its link and drops its endpoints", async () => {
    const h = await start();
    const cluster = h.cluster();
    const { id, key } = approvedHost(cluster, "pc", ["asr"]);
    const host = await FakeHost.connect(h.url(), { host: id, key });
    host.peer.notify("host.report", report([service({ name: "asr", url: "http://pc:1" })]));
    await waitUntil(() => cluster.registry.pick("asr") !== null);
    const sub = h.bus.subscribe(["cluster.host.removed"]);
    cluster.hosts.revoke("pc");
    expect(await host.closed).toBe(HOST_LINK_CLOSE.UNAUTHORIZED);
    expect((await nextEvent(sub)).data).toEqual({ host: "pc", how: "revoked" });
    await waitUntil(() => cluster.registry.pick("asr") === null);
  });
});

describe("removing a host", () => {
  it("closes its link, drops its endpoints and forgets its row", async () => {
    const h = await start();
    const cluster = h.cluster();
    const { id, key } = approvedHost(cluster, "pc", ["asr"]);
    const host = await FakeHost.connect(h.url(), { host: id, key });
    host.peer.notify("host.report", report([service({ name: "asr", url: "http://pc:1" })]));
    await waitUntil(() => cluster.registry.pick("asr") !== null);
    expect(cluster.hosts.connected().map((c) => c.name)).toEqual(["pc"]);
    const sub = h.bus.subscribe(["cluster.host.removed"]);
    expect(cluster.hosts.remove("pc")?.name).toBe("pc");
    expect(await host.closed).toBe(HOST_LINK_CLOSE.UNAUTHORIZED);
    expect((await nextEvent(sub)).data).toEqual({ host: "pc", how: "deleted" });
    await waitUntil(() => cluster.registry.pick("asr") === null);
    expect(cluster.hosts.list()).toEqual([]);
    expect(cluster.hosts.remove("pc")).toBeNull();
    // Its key is gone: it cannot come back.
    await expect(FakeHost.connect(h.url(), { host: id, key })).rejects.toThrow(/4401/);
  });
});

describe("what Core serves and calls", () => {
  it("answers cluster.guard from every source", async () => {
    let singing = false;
    const h = await start({}, { guards: [() => (singing ? "singing" : null)] });
    const cluster = h.cluster();
    const extra = cluster.guards.add(async () => "live" as const);
    cluster.guards.add(() => {
      throw new Error("a broken source");
    });
    const { id, key } = approvedHost(cluster, "pc", []);
    const host = await FakeHost.connect(h.url(), { host: id, key });
    expect(await host.peer.request("cluster.guard", {})).toEqual({ states: ["live"] });
    singing = true;
    expect(await host.peer.request("cluster.guard", {})).toEqual({ states: ["singing", "live"] });
    extra();
    expect(await host.peer.request("cluster.guard", null)).toEqual({ states: ["singing"] });
  });

  it("answers cluster.resolve for an approved host's granted service only", async () => {
    const h = await start(
      { static: { friend: { provides: ["sing"], url: "http://f:8005" } } },
      { module: { uses: { lyrics: { resolve: ["sing"] } } } },
    );
    const cluster = h.cluster();
    const approved = approvedHost(cluster, "pc", ["lyrics"]);
    const pending = cluster.hosts.create({ name: "new-pc" });
    const a = await FakeHost.connect(h.url(), { host: approved.id, key: approved.key });
    a.peer.notify("host.report", report([service({ name: "lyrics" })]));
    await a.peer.request("cluster.guard", {});
    const result = (await a.peer.request("cluster.resolve", {
      capability: "sing",
      service: "lyrics",
    })) as { endpoints: { host: string; via: string }[] };
    expect(result.endpoints).toMatchObject([{ host: "friend", via: "direct" }]);
    await expect(a.peer.request("cluster.resolve", {})).rejects.toMatchObject({ code: -32602 });
    await expect(a.peer.request("cluster.resolve", { capability: "sing" })).rejects.toMatchObject({
      code: HOST_ERROR_CODE.NotAllowed,
    });
    await expect(a.peer.request("cluster.nothing", {})).rejects.toMatchObject({ code: -32601 });
    const p = await FakeHost.connect(h.url(), { host: pending.host.id, key: pending.key });
    await expect(
      p.peer.request("cluster.resolve", { capability: "sing", service: "lyrics" }),
    ).rejects.toMatchObject({ code: HOST_ERROR_CODE.NotAllowed });
  });

  it("calls a connected host, and fails for one that is not", async () => {
    const h = await start();
    const cluster = h.cluster();
    const { id, key } = approvedHost(cluster, "pc", []);
    await FakeHost.connect(h.url(), { host: id, key }, async (method, params) => {
      if (method === "service.list") return { services: [], asked: params };
      throw new RpcError(HOST_ERROR_CODE.UnknownService, "no such service");
    });
    expect(await cluster.hosts.call("pc", "service.list", { x: 1 })).toEqual({
      services: [],
      asked: { x: 1 },
    });
    await expect(cluster.hosts.call("pc", "service.start", {})).rejects.toMatchObject({
      code: HOST_ERROR_CODE.UnknownService,
    });
    await expect(cluster.hosts.call("elsewhere", "host.info", {})).rejects.toThrow(/not connected/);
  });

  it("publishes a host's service events as cluster.service.state", async () => {
    const h = await start();
    const cluster = h.cluster();
    const { id, key } = approvedHost(cluster, "pc", []);
    const host = await FakeHost.connect(h.url(), { host: id, key });
    const sub = h.bus.subscribe(["cluster.service.state"]);
    host.peer.notify("service.event", { service: "asr", state: "failed" });
    host.peer.notify("service.event", {
      service: "asr",
      state: "failed",
      previous: "running",
      at: 1,
      reason: "exited with 1",
      log_tail: ["boom"],
    });
    const env = await nextEvent(sub);
    expect(env.data).toEqual({
      host: "pc",
      service: "asr",
      state: "failed",
      previous: "running",
      reason: "exited with 1",
    });
  });
});

describe("heartbeat and life", () => {
  it("drops a host that stops answering pings", async () => {
    const h = await start({ ping_secs: 0.05, peer_timeout_secs: 0.2 });
    const cluster = h.cluster();
    const { id, key } = approvedHost(cluster, "pc", []);
    const host = await FakeHost.connect(h.url(), { host: id, key });
    // A `ws` client answers pings by itself: alive.
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(cluster.hosts.connected()).toHaveLength(1);
    // A paused socket answers nothing.
    const sub = h.bus.subscribe(["cluster.host.disconnected"]);
    host.ws.pause();
    expect((await nextEvent(sub)).data).toMatchObject({
      host: "pc",
      code: HOST_LINK_CLOSE.TIMEOUT,
    });
    expect(cluster.hosts.connected()).toEqual([]);
    host.ws.terminate();
  });

  it("fails the module when the port is taken, and Core keeps going", async () => {
    const first = await start();
    const port = first.module.localAddr()?.port;
    const second = await Harness.start({ bind: `127.0.0.1:${port}` });
    try {
      await waitUntil(() => second.moduleState().state === "failed", "the module failing");
      expect(second.moduleState().reason).toMatch(/cannot bind the cluster link/);
    } finally {
      await second.stop();
    }
  });

  it("refuses a socket on another path", async () => {
    const h = await start();
    const url = h.url().replace("/cluster-link", "/elsewhere");
    await expect(open(url)).rejects.toThrow(/404/);
  });
});
