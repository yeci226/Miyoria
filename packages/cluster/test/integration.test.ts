// The daemon's real link client (`CoreLink` from `@miyoria/hostd/link`) with a fake `HostApi`,
// against the real cluster module: connect, report, events, Core calling the host, the host
// asking Core, a restart of the server, and a revoked key.

import type { AddressInfo } from "node:net";
import {
  HOST_ERROR_CODE,
  HOST_LINK_CLOSE,
  HOST_PROTOCOL_VERSION,
  type HostGuardState,
  type HostReport,
  type HostServiceEvent,
  type HostServiceStatus,
  type HostWelcome,
} from "@miyoria/contracts/host";
import {
  type Caller,
  type ClusterClient,
  CoreLink,
  type CoreLinkOptions,
  type GuardSource,
  type HostApi,
  HostRpcError,
} from "@miyoria/hostd/link";
import { RpcPeer, WebSocketTransport } from "@miyoria/sdk";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket, { WebSocketServer } from "ws";
import { Harness, nextEvent, report, service, sleepMs, waitUntil } from "./helpers.js";

/** A daemon's API with services the test sets, recording what the link does with it. */
class FakeApi implements HostApi {
  services: HostServiceStatus[] = [];
  readonly calls: Array<{ method: string; params: unknown; caller: Caller }> = [];
  readonly tokensAsked: boolean[] = [];
  guard: GuardSource | null = null;
  client: ClusterClient | null = null;
  readonly #events = new Set<(event: HostServiceEvent) => void>();
  readonly #logs = new Set<(line: string) => void>();
  readonly #changes = new Set<() => void>();

  report(options: { withTokens: boolean }): HostReport {
    this.tokensAsked.push(options.withTokens);
    return report(this.services, "fake-pc");
  }

  async call(method: string, params: unknown, caller: Caller): Promise<unknown> {
    this.calls.push({ method, params, caller });
    if (method === "service.list") return { services: this.services };
    if (method === "service.logs") return { lines: ["old 1", "old 2"] };
    throw new HostRpcError(HOST_ERROR_CODE.UnknownService, `no service for ${method}`);
  }

  onEvent(listener: (event: HostServiceEvent) => void): () => void {
    this.#events.add(listener);
    return () => this.#events.delete(listener);
  }

  emit(event: HostServiceEvent): void {
    for (const listener of this.#events) listener(event);
  }

  target(): { url: string; headers: Record<string, string> } | null {
    return null;
  }

  onChange(listener: () => void): () => void {
    this.#changes.add(listener);
    return () => this.#changes.delete(listener);
  }

  /** A change that is not a state change, such as a failed probe of a running service. */
  changed(): void {
    for (const listener of this.#changes) listener();
  }

  get eventListeners(): number {
    return this.#events.size;
  }

  followLogs(_service: string, listener: (line: string) => void): () => void {
    this.#logs.add(listener);
    return () => this.#logs.delete(listener);
  }

  write(line: string): void {
    for (const listener of this.#logs) listener(line);
  }

  get logFollowers(): number {
    return this.#logs.size;
  }

  setGuardSource(source: GuardSource | null): void {
    this.guard = source;
  }

  setClusterClient(client: ClusterClient | null): void {
    this.client = client;
  }
}

let harness: Harness | null = null;
const links: CoreLink[] = [];
let wss: WebSocketServer | null = null;

afterEach(async () => {
  for (const link of links.splice(0)) await link.stop();
  await harness?.stop();
  harness = null;
  await new Promise<void>((resolve) => (wss ? wss.close(() => resolve()) : resolve()));
  wss = null;
});

function coreLink(api: HostApi, options: Partial<CoreLinkOptions> & { url: string }): CoreLink {
  const link = new CoreLink(api, {
    hostId: "",
    key: "",
    name: "fake-pc",
    platform: "linux",
    version: "0.1.0",
    retryInitialMs: 20,
    retryMaxMs: 100,
    ...options,
  });
  links.push(link);
  return link;
}

const asr = service({ name: "asr", url: "http://10.0.0.5:8003", token: "tok" });

describe("CoreLink against the cluster module", () => {
  it("connects, reports, forwards events, and is called by Core", async () => {
    const sing = (): HostGuardState | null => "singing";
    harness = await Harness.start({}, { guards: [() => sing()] });
    const h = harness;
    const cluster = h.cluster();
    const made = cluster.hosts.create({ name: "fake-pc", approved: true, capabilities: ["asr"] });
    const api = new FakeApi();
    api.services = [asr];
    const states: string[] = [];
    const link = coreLink(api, { url: h.url(), hostId: made.host.id, key: made.key });
    link.onState((s) => states.push(s));
    link.start();

    await waitUntil(() => cluster.registry.pick("asr") !== null, "the report");
    expect(link.state).toBe("connected");
    expect(link.welcome?.approved).toEqual(["asr"]);
    expect(api.tokensAsked[0]).toBe(true);
    expect(cluster.registry.pick("asr")?.headers).toEqual({ authorization: "Bearer tok" });

    // A service fails: its event reaches the bus and the next report takes it out.
    const sub = h.bus.subscribe(["cluster.service.state"]);
    api.services = [{ ...asr, state: "failed", healthy: false }];
    api.emit({ service: "asr", state: "failed", previous: "running", at: 1, reason: "exit 1" });
    expect((await nextEvent(sub)).data).toEqual({
      host: "fake-pc",
      service: "asr",
      state: "failed",
      previous: "running",
      reason: "exit 1",
    });
    await waitUntil(() => cluster.registry.pick("asr") === null, "the fresh report");

    // Core calls the host; the host's errors keep their codes.
    expect(await cluster.hosts.call("fake-pc", "service.list", {})).toMatchObject({
      services: [{ name: "asr", state: "failed" }],
    });
    expect(api.calls.at(-1)).toEqual({
      method: "service.list",
      params: {},
      caller: { kind: "core" },
    });
    await expect(
      cluster.hosts.call("fake-pc", "service.start", { service: "x" }),
    ).rejects.toMatchObject({
      code: HOST_ERROR_CODE.UnknownService,
    });

    // The host asks Core.
    expect(await api.guard?.states()).toEqual(["singing"]);
    // A service the table grants nothing gets no endpoint (nor its token), with Core's code.
    await expect(
      api.client?.call("cluster.resolve", { capability: "asr", service: "asr" }),
    ).rejects.toMatchObject({ code: HOST_ERROR_CODE.NotAllowed });
    await expect(api.client?.call("cluster.nothing", {})).rejects.toBeInstanceOf(HostRpcError);
    expect(states).toEqual(["connecting", "connected"]);
  });

  it("reports again when only a service's health changed", async () => {
    harness = await Harness.start();
    const h = harness;
    const cluster = h.cluster();
    const made = cluster.hosts.create({ name: "fake-pc", approved: true, capabilities: ["asr"] });
    const api = new FakeApi();
    api.services = [asr];
    const link = coreLink(api, { url: h.url(), hostId: made.host.id, key: made.key });
    link.start();
    await waitUntil(() => cluster.registry.pick("asr") !== null, "the report");

    api.services = [{ ...asr, healthy: false }];
    api.changed();
    await waitUntil(() => cluster.registry.pick("asr") === null, "the report after the change");
  });

  it("coalesces a burst of events into few reports", async () => {
    harness = await Harness.start();
    const cluster = harness.cluster();
    const made = cluster.hosts.create({ name: "fake-pc", approved: true, capabilities: ["asr"] });
    const api = new FakeApi();
    api.services = [asr];
    const link = coreLink(api, {
      url: harness.url(),
      hostId: made.host.id,
      key: made.key,
      reportMs: 200,
    });
    link.start();
    await waitUntil(() => link.state === "connected");
    await sleepMs(250);
    const before = api.tokensAsked.length;
    for (let i = 0; i < 10; i++) {
      api.emit({ service: "asr", state: "running", previous: "starting", at: i });
    }
    await sleepMs(350);
    // One at once, one at the end of the window.
    expect(api.tokensAsked.length - before).toBe(2);
  });

  it("dials again when the server restarts, and lets go of Core while it is away", async () => {
    harness = await Harness.start();
    const h = harness;
    const cluster = () => h.cluster();
    const made = cluster().hosts.create({ name: "fake-pc", approved: true, capabilities: ["asr"] });
    const api = new FakeApi();
    api.services = [asr];
    // The module comes back on another ephemeral port: dial wherever it is now.
    const link = coreLink(api, {
      url: "unused",
      hostId: made.host.id,
      key: made.key,
      webSocket: () => new WebSocket(h.url()),
    });
    link.start();
    await waitUntil(() => link.state === "connected");
    expect(api.client).not.toBeNull();

    await h.sup.disable("cluster");
    await waitUntil(() => link.state === "connecting", "the link noticing");
    expect(api.client).toBeNull();
    expect(api.guard).toBeNull();
    expect(api.eventListeners).toBe(0);

    await h.sup.enable("cluster");
    await waitUntil(() => link.state === "connected", "the link coming back");
    await waitUntil(() => cluster().registry.pick("asr") !== null, "the report after reconnect");
    expect(api.client).not.toBeNull();
  });

  it("stops for good when its key is revoked", async () => {
    harness = await Harness.start();
    const h = harness;
    const cluster = h.cluster();
    const made = cluster.hosts.create({ name: "fake-pc", approved: true, capabilities: [] });
    const api = new FakeApi();
    let dials = 0;
    const link = coreLink(api, {
      url: h.url(),
      hostId: made.host.id,
      key: made.key,
      webSocket: (url) => {
        dials++;
        return new WebSocket(url);
      },
    });
    link.start();
    await waitUntil(() => link.state === "connected");
    cluster.hosts.revoke("fake-pc");
    await waitUntil(() => link.state === "unauthorized", "the link giving up");
    const seen = dials;
    await sleepMs(300);
    expect(dials).toBe(seen);
    expect(link.state).toBe("unauthorized");
    expect(api.client).toBeNull();
  });

  it("a wrong key never gets through and is not retried", async () => {
    harness = await Harness.start();
    const made = harness.cluster().hosts.create({ name: "fake-pc" });
    let dials = 0;
    const link = coreLink(new FakeApi(), {
      url: harness.url(),
      hostId: made.host.id,
      key: "wrong",
      webSocket: (url) => {
        dials++;
        return new WebSocket(url);
      },
    });
    link.start();
    await waitUntil(() => link.state === "unauthorized");
    await sleepMs(200);
    expect(dials).toBe(1);
  });
});

/** A bare Core: welcomes any hello and keeps a peer to watch what the link sends. */
async function bareCore(): Promise<{
  url: string;
  peer: Promise<RpcPeer>;
  told: Array<{ method: string; params: unknown }>;
}> {
  wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise<void>((resolve) => wss?.once("listening", () => resolve()));
  const told: Array<{ method: string; params: unknown }> = [];
  const peer = new Promise<RpcPeer>((resolve) => {
    wss?.once("connection", (ws) => {
      ws.once("message", () => {
        const welcome: HostWelcome = {
          protocol: HOST_PROTOCOL_VERSION,
          core_version: "1",
          host: "fake-pc",
          approved: [],
        };
        ws.send(JSON.stringify(welcome));
        resolve(
          new RpcPeer({
            transport: new WebSocketTransport(ws),
            role: "host",
            onNotification: (method, params) => told.push({ method, params }),
          }),
        );
      });
    });
  });
  const { port } = wss.address() as AddressInfo;
  return { url: `ws://127.0.0.1:${port}/cluster-link`, peer, told };
}

describe("CoreLink against a bare Core", () => {
  it("follows a service's log until Core cancels", async () => {
    const core = await bareCore();
    const api = new FakeApi();
    const link = coreLink(api, { url: core.url });
    link.start();
    const peer = await core.peer;
    const controller = new AbortController();
    const following = peer.request(
      "service.logs",
      { service: "asr", lines: 2, follow: true },
      5_000,
      controller.signal,
    );
    following.catch(() => undefined);
    await waitUntil(() => api.logFollowers === 1);
    await waitUntil(() => core.told.filter((t) => t.method === "service.log").length === 2);
    api.write("new line");
    await waitUntil(() => core.told.filter((t) => t.method === "service.log").length === 3);
    expect(core.told.filter((t) => t.method === "service.log").map((t) => t.params)).toEqual([
      { service: "asr", line: "old 1" },
      { service: "asr", line: "old 2" },
      { service: "asr", line: "new line" },
    ]);
    expect(api.calls.at(-1)?.params).toEqual({ service: "asr", lines: 2, follow: false });
    controller.abort(new Error("enough"));
    await waitUntil(() => api.logFollowers === 0, "the follow ending");
  });

  it("a Core that does not welcome is dialled again", async () => {
    wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await new Promise<void>((resolve) => wss?.once("listening", () => resolve()));
    let connections = 0;
    wss.on("connection", (ws) => {
      connections++;
      ws.once("message", () => ws.send(JSON.stringify({ hello: "back" })));
    });
    const { port } = wss.address() as AddressInfo;
    const link = coreLink(new FakeApi(), { url: `ws://127.0.0.1:${port}/cluster-link` });
    link.start();
    await waitUntil(() => connections >= 2, "a second dial");
    expect(link.state).toBe("connecting");
  });

  it("REPLACED stops the link", async () => {
    wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await new Promise<void>((resolve) => wss?.once("listening", () => resolve()));
    wss.on("connection", (ws) => {
      ws.once("message", () => ws.close(HOST_LINK_CLOSE.REPLACED, "replaced"));
    });
    const { port } = wss.address() as AddressInfo;
    const link = coreLink(new FakeApi(), { url: `ws://127.0.0.1:${port}/cluster-link` });
    link.start();
    await waitUntil(() => link.state === "stopped");
  });
});
