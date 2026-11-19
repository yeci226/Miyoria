// The relay over the control link (v5-hostd §7.1), end to end: the real cluster module, the
// daemon's real `CoreLink` with a fake `HostApi`, and a small HTTP service on an ephemeral port
// that the fake API points at. `registry.request` for the host's `link` endpoint must behave like
// `fetch` against the service.

import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import {
  encodeRelayFrame,
  HOST_ERROR_CODE,
  HOST_NOTIFICATION,
  HOST_RELAY_FRAME,
  HOST_RELAY_LIMITS,
  HOST_RELAY_PROTOCOL_ERROR,
  HostRelayLengthError,
  type HostReport,
  type HostServiceEvent,
  type HostServiceStatus,
} from "@miyoria/contracts/host";
import {
  type ClusterClient,
  CoreLink,
  type GuardSource,
  type HostApi,
  HostRpcError,
} from "@miyoria/hostd/link";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { type Endpoint, RelayError, type RelayOptions } from "../src/index.js";
import { approvedHost, FakeHost, Harness, report, service, sleepMs, waitUntil } from "./helpers.js";

const MiB = 1024 * 1024;
const BIG = 30 * MiB;
const WINDOW = HOST_RELAY_LIMITS.WINDOW_BYTES;

// ---- the service ------------------------------------------------------------------------------

interface Seen {
  method: string;
  path: string;
  headers: IncomingMessage["headers"];
  body: Buffer;
}

/** A service: records what it was sent and which responses were cut off. */
class Service {
  readonly seen: Seen[] = [];
  /** Paths whose response closed before it was finished. */
  readonly cut: string[] = [];
  /** Bytes `/big` has written so far. */
  written = 0;
  readonly #server: Server;

  private constructor(server: Server) {
    this.#server = server;
  }

  static async start(big: Buffer): Promise<Service> {
    let svc: Service | null = null;
    const server = createServer((req, res) => {
      void svc?.handle(req, res, big);
    });
    svc = new Service(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return svc;
  }

  get url(): string {
    return `http://127.0.0.1:${(this.#server.address() as AddressInfo).port}`;
  }

  async handle(req: IncomingMessage, res: ServerResponse, big: Buffer): Promise<void> {
    const url = new URL(req.url ?? "/", "http://x");
    res.on("close", () => {
      if (!res.writableFinished) this.cut.push(url.pathname);
    });
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks);
    this.seen.push({ method: req.method ?? "", path: req.url ?? "", headers: req.headers, body });
    switch (url.pathname) {
      case "/json":
        res.writeHead(200, { "content-type": "application/json", "x-service": "sing" });
        res.end(JSON.stringify({ ok: true, query: url.searchParams.get("q") }));
        return;
      case "/echo":
        res.writeHead(201, { "content-type": "application/octet-stream" });
        res.end(body);
        return;
      case "/status": {
        const code = Number(url.searchParams.get("code"));
        res.writeHead(code, { "content-type": "text/plain", "retry-after": "7" });
        res.end(`status ${code}`);
        return;
      }
      case "/empty":
        res.writeHead(204, { "x-empty": "yes" });
        res.end();
        return;
      case "/hang":
        return; // never answers
      case "/big": {
        const size = Number(url.searchParams.get("size") ?? big.byteLength);
        res.writeHead(200, {
          "content-type": "application/octet-stream",
          "content-length": String(size),
        });
        let at = 0;
        const write = () => {
          while (at < size) {
            const n = Math.min(64 * 1024, size - at);
            const ok = res.write(big.subarray(at, at + n));
            at += n;
            this.written = at;
            if (!ok) {
              res.once("drain", write);
              return;
            }
          }
          res.end();
        };
        write();
        return;
      }
      default:
        res.writeHead(404).end();
    }
  }

  async waitFor(path: string): Promise<Seen> {
    await waitUntil(() => this.seen.some((s) => s.path.startsWith(path)), `a request for ${path}`);
    return this.seen.find((s) => s.path.startsWith(path)) as Seen;
  }

  close(): Promise<void> {
    this.#server.closeAllConnections();
    return new Promise((resolve) => this.#server.close(() => resolve()));
  }
}

// ---- the host ----------------------------------------------------------------------------------

/** A daemon's API with services the test sets; `target` points at the test's service. */
class FakeApi implements HostApi {
  services: HostServiceStatus[] = [];
  targets = new Map<string, { url: string; headers: Record<string, string> }>();

  report(): HostReport {
    return report(this.services, "fake-pc");
  }

  async call(method: string): Promise<unknown> {
    throw new HostRpcError(HOST_ERROR_CODE.UnknownService, `no ${method}`);
  }

  onEvent(_listener: (event: HostServiceEvent) => void): () => void {
    return () => {};
  }

  target(name: string): { url: string; headers: Record<string, string> } | null {
    return this.targets.get(name) ?? null;
  }

  followLogs(): () => void {
    return () => {};
  }

  setGuardSource(_source: GuardSource | null): void {}

  setClusterClient(_client: ClusterClient | null): void {}
}

/** Response body bytes the host has put on the socket, by stream. */
class Wire {
  readonly sent = new Map<number, number>();
  socket: WebSocket | null = null;

  total(): number {
    let n = 0;
    for (const bytes of this.sent.values()) n += bytes;
    return n;
  }

  open(url: string): WebSocket {
    const ws = new WebSocket(url, { perMessageDeflate: false, maxPayload: 16 * MiB });
    const send = ws.send.bind(ws) as (data: unknown, cb?: (err?: Error) => void) => void;
    (ws as unknown as { send: (data: unknown, cb?: (err?: Error) => void) => void }).send = (
      data,
      cb,
    ) => {
      if (data instanceof Uint8Array && data[0] === HOST_RELAY_FRAME.RESPONSE_CHUNK) {
        const stream = Buffer.from(data.buffer, data.byteOffset, data.byteLength).readUInt32LE(1);
        this.sent.set(stream, (this.sent.get(stream) ?? 0) + data.byteLength - 5);
      }
      send(data, cb);
    };
    this.socket = ws;
    return ws;
  }
}

// ---- the setup ---------------------------------------------------------------------------------

let bigBody: Buffer;
let bigHash: string;
let harness: Harness | null = null;
let svc: Service | null = null;
let link: CoreLink | null = null;

beforeAll(() => {
  bigBody = randomBytes(BIG);
  bigHash = createHash("sha256").update(bigBody).digest("hex");
});

afterAll(() => {
  bigBody = Buffer.alloc(0);
});

afterEach(async () => {
  await link?.stop();
  link = null;
  await harness?.stop();
  harness = null;
  await svc?.close();
  svc = null;
});

interface Setup {
  h: Harness;
  svc: Service;
  api: FakeApi;
  wire: Wire;
  link: CoreLink;
  endpoint: Endpoint;
  request: (path: string, init?: RequestInit) => Promise<Response>;
}

async function setup(options: { relay?: RelayOptions; approved?: boolean } = {}): Promise<Setup> {
  svc = await Service.start(bigBody);
  harness = await Harness.start({}, options.relay ? { relay: options.relay } : {});
  const h = harness;
  const cluster = h.cluster();
  const made = cluster.hosts.create({
    name: "fake-pc",
    approved: options.approved ?? true,
    capabilities: ["sing"],
  });
  const api = new FakeApi();
  // No `url`: Core cannot call it directly, so its endpoint is `via: "link"`.
  api.services = [
    service({ name: "sing", provides: ["sing"], token: "report-token" }),
    service({ name: "stopped", provides: ["sing"] }),
  ];
  api.targets.set("sing", { url: svc.url, headers: { authorization: "Bearer service-token" } });
  const wire = new Wire();
  link = new CoreLink(api, {
    url: h.url(),
    hostId: made.host.id,
    key: made.key,
    name: "fake-pc",
    platform: "linux",
    version: "0.1.0",
    retryInitialMs: 20,
    retryMaxMs: 100,
    webSocket: (url) => wire.open(url),
  });
  link.start();
  await waitUntil(() => link?.state === "connected", "the link");
  const endpoint: Endpoint = {
    capability: "sing",
    host: "fake-pc",
    service: "sing",
    url: "link://fake-pc/sing",
    via: "link",
    headers: { authorization: "Bearer report-token" },
    healthy: true,
    version: null,
  };
  if (options.approved !== false) {
    await waitUntil(() => cluster.registry.pick("sing") !== null, "the report");
    expect(cluster.registry.pick("sing")).toMatchObject({ via: "link", service: "sing" });
  }
  return {
    h,
    svc,
    api,
    wire,
    link,
    endpoint,
    request: (path, init) => cluster.registry.request(endpoint, path, init),
  };
}

async function readAll(response: Response): Promise<Buffer> {
  return Buffer.from(await response.arrayBuffer());
}

// ---- the tests ---------------------------------------------------------------------------------

describe("relay over the control link", () => {
  it("relays a GET with JSON, with the service's authorization, not the caller's", async () => {
    const s = await setup();
    const res = await s.request("/json?q=1", { headers: { authorization: "Bearer caller" } });
    expect(res.status).toBe(200);
    expect(res.ok).toBe(true);
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(res.headers.get("x-service")).toBe("sing");
    expect(await res.json()).toEqual({ ok: true, query: "1" });
    const seen = await s.svc.waitFor("/json");
    expect(seen.method).toBe("GET");
    expect(seen.path).toBe("/json?q=1");
    expect(seen.headers.authorization).toBe("Bearer service-token");
  });

  it("relays a POST with a JSON body and with form data", async () => {
    const s = await setup();
    const payload = { song: "夜に駆ける", key: 2 };
    const res = await s.request("echo", {
      method: "POST",
      headers: { "content-type": "application/json", "x-trace": "abc" },
      body: JSON.stringify(payload),
    });
    expect(res.status).toBe(201);
    expect(JSON.parse(await res.text())).toEqual(payload);
    const json = await s.svc.waitFor("/echo");
    expect(json.headers["content-type"]).toBe("application/json");
    expect(json.headers["x-trace"]).toBe("abc");
    // The length was known: the service gets the body whole.
    expect(json.headers["content-length"]).toBe(String(json.body.byteLength));
    expect(json.headers["transfer-encoding"]).toBeUndefined();

    const form = new FormData();
    form.set("name", "vocals");
    const file = randomBytes(200_000);
    form.set("file", new Blob([file], { type: "audio/wav" }), "vocals.wav");
    const expected = new Request("http://x/", { method: "POST", body: form });
    const expectedType = expected.headers.get("content-type") ?? "";
    const formRes = await s.request("/echo?form", { method: "POST", body: form });
    const echoed = await readAll(formRes);
    const seen = s.svc.seen.find((x) => x.path === "/echo?form") as Seen;
    expect(seen.headers["content-type"]).toMatch(/^multipart\/form-data; boundary=/);
    expect(expectedType).toMatch(/^multipart\/form-data; boundary=/);
    expect(seen.headers["content-length"]).toBe(String(seen.body.byteLength));
    expect(echoed.equals(seen.body)).toBe(true);
    // The service can parse it back.
    const parsed = await new Request("http://x/", {
      method: "POST",
      headers: { "content-type": seen.headers["content-type"] as string },
      body: seen.body,
    }).formData();
    expect(parsed.get("name")).toBe("vocals");
    const got = parsed.get("file") as File;
    expect(got.name).toBe("vocals.wav");
    expect(Buffer.from(await got.arrayBuffer()).equals(file)).toBe(true);
  });

  it("streams a request body of unknown length within the credit", async () => {
    const s = await setup();
    const body = randomBytes(3 * MiB);
    let at = 0;
    const source = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (at >= body.byteLength) {
          controller.close();
          return;
        }
        const n = Math.min(100_000, body.byteLength - at);
        controller.enqueue(new Uint8Array(body.subarray(at, at + n)));
        at += n;
      },
    });
    const res = await s.request("/echo", {
      method: "PUT",
      body: source,
      duplex: "half",
    } as RequestInit);
    expect((await readAll(res)).equals(body)).toBe(true);
    const seen = await s.svc.waitFor("/echo");
    expect(seen.method).toBe("PUT");
    expect(seen.headers["transfer-encoding"]).toBe("chunked");
  });

  it("passes status codes and headers through: a 404 and a 503 are responses", async () => {
    const s = await setup();
    for (const code of [404, 503]) {
      const res = await s.request(`/status?code=${code}`);
      expect(res.status).toBe(code);
      expect(res.ok).toBe(false);
      expect(res.headers.get("retry-after")).toBe("7");
      expect(await res.text()).toBe(`status ${code}`);
    }
    const empty = await s.request("/empty");
    expect(empty.status).toBe(204);
    expect(empty.headers.get("x-empty")).toBe("yes");
    expect(empty.body).toBeNull();
    // Every stream ended: a next request still goes through.
    expect((await s.request("/json")).status).toBe(200);
  });

  it("streams 30 MB intact, never more than the window ahead of a slow reader", async () => {
    const s = await setup();
    const started = Date.now();
    const res = await s.request("/big");
    expect(res.headers.get("content-length")).toBe(String(BIG));
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    const hash = createHash("sha256");
    let read = 0;
    let peak = 0;
    let nextPause = 2 * MiB;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      hash.update(value);
      read += value.byteLength;
      peak = Math.max(peak, s.wire.total() - read);
      if (read >= nextPause) {
        // A slow consumer: the host fills the window and waits.
        nextPause += 2 * MiB;
        await sleepMs(15);
        peak = Math.max(peak, s.wire.total() - read);
      }
    }
    const ms = Date.now() - started;
    expect(read).toBe(BIG);
    expect(hash.digest("hex")).toBe(bigHash);
    expect(peak).toBeLessThanOrEqual(WINDOW);
    expect(peak).toBeGreaterThan(WINDOW / 2); // the window was used, not just never reached
    expect(ms).toBeLessThan(10_000);
  });

  it("keeps other streams moving while one reader does not read", async () => {
    const s = await setup();
    const stalled = await s.request("/big");
    // The host sends a window's worth and stops.
    await waitUntil(() => s.wire.total() >= WINDOW, "a full window");
    await sleepMs(50);
    expect(s.wire.total()).toBe(WINDOW);
    const started = Date.now();
    const res = await s.request("/json");
    expect(await res.json()).toEqual({ ok: true, query: null });
    expect(Date.now() - started).toBeLessThan(1_000);
    // Cancelling the stalled body stops the service's response.
    await stalled.body?.cancel();
    await waitUntil(() => s.svc.cut.includes("/big"), "the service sees the cut");
  });

  it("aborts before the head: the call rejects and the service sees the close", async () => {
    const s = await setup();
    const stop = new AbortController();
    const pending = s.request("/hang", { signal: stop.signal });
    await s.svc.waitFor("/hang");
    stop.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await waitUntil(() => s.svc.cut.includes("/hang"), "the service sees the close");
    // A second request after the aborted one works.
    expect(await (await s.request("/json")).json()).toMatchObject({ ok: true });
  });

  it("aborts mid-body: the reader fails and the service sees the close", async () => {
    const s = await setup();
    const stop = new AbortController();
    const res = await s.request("/big", { signal: stop.signal });
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    let read = 0;
    while (read < 2 * MiB) read += (await reader.read()).value?.byteLength ?? 0;
    stop.abort(new Error("enough"));
    await expect(reader.read()).rejects.toThrow("enough");
    await waitUntil(() => s.svc.cut.includes("/big"), "the service sees the close");
    expect(s.svc.written).toBeLessThan(BIG);
    expect(await (await s.request("/json")).json()).toMatchObject({ ok: true });
  });

  it("fails every open stream when the host goes away mid-download", async () => {
    const s = await setup();
    const res = await s.request("/big");
    const waiting = s.request("/hang");
    await s.svc.waitFor("/hang");
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    let read = 0;
    while (read < MiB) read += (await reader.read()).value?.byteLength ?? 0;
    s.wire.socket?.terminate();
    const failure = await (async () => {
      for (;;) await reader.read();
    })().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(RelayError);
    expect(String((failure as Error).message)).toMatch(/closed/);
    await expect(waiting).rejects.toBeInstanceOf(RelayError);
    // The host aborts its fetches.
    await waitUntil(
      () => s.svc.cut.includes("/big") && s.svc.cut.includes("/hang"),
      "the service sees both closes",
    );
  });

  it("answers for a service that is not running and refuses one the host does not report", async () => {
    const s = await setup();
    await expect(
      s.h.cluster().registry.request({ ...s.endpoint, service: "stopped" }, "/json"),
    ).rejects.toMatchObject({ name: "RelayError", code: HOST_ERROR_CODE.UnknownService });
    await expect(
      s.h.cluster().registry.request({ ...s.endpoint, service: "nope" }, "/json"),
    ).rejects.toThrow(/reports no service `nope`/);
    await expect(
      s.h.cluster().registry.request({ ...s.endpoint, host: "elsewhere" }, "/json"),
    ).rejects.toThrow(/not connected/);
    // Nothing was sent for a host that is not there: a caller may go elsewhere.
    await expect(
      s.h.cluster().registry.request({ ...s.endpoint, host: "elsewhere" }, "/json"),
    ).rejects.toMatchObject({ name: "RelayError", sent: false });
  });

  it("refuses a host that is not approved, until it is", async () => {
    const s = await setup({ approved: false });
    const cluster = s.h.cluster();
    await waitUntil(() => cluster.hosts.connected().length === 1, "the pending host");
    await expect(cluster.registry.request(s.endpoint, "/json")).rejects.toThrow(/not approved/);
    expect(s.svc.seen).toEqual([]);
    cluster.hosts.approve("fake-pc", ["sing"]);
    await waitUntil(() => cluster.registry.pick("sing") !== null, "the approval");
    expect((await cluster.registry.request(s.endpoint, "/json")).status).toBe(200);
  });

  it("fails at once over the stream cap, and frees the streams again", async () => {
    const s = await setup({ relay: { maxStreams: 4 } });
    const stop = new AbortController();
    const open = [1, 2, 3, 4].map(() => s.request("/hang", { signal: stop.signal }));
    await waitUntil(() => s.svc.seen.length === 4, "four requests at the service");
    await expect(s.request("/json")).rejects.toThrow(/4 relayed requests to host `fake-pc`/);
    stop.abort();
    for (const pending of open) await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect((await s.request("/json")).status).toBe(200);
  });

  it("times out waiting for the head and tells the host to stop", async () => {
    const s = await setup({ relay: { timeoutMs: 300 } });
    await expect(s.request("/hang")).rejects.toThrow(/did not answer within 300 ms/);
    await waitUntil(() => s.svc.cut.includes("/hang"), "the service sees the close");
  });

  it("fails a body that a host ends short of its content-length", async () => {
    // A host from before 2026-11-19 ends a body like a whole one whatever its length: Core checks.
    harness = await Harness.start();
    const cluster = harness.cluster();
    const { id, key } = approvedHost(cluster, "old-pc", ["sing"]);
    let host: FakeHost | null = null;
    const answer = (stream: number, send: number) => {
      setTimeout(() => {
        const frame = (f: Parameters<typeof encodeRelayFrame>[0]) =>
          host?.ws.send(encodeRelayFrame(f));
        frame({ kind: HOST_RELAY_FRAME.RESPONSE_CHUNK, stream, data: new Uint8Array(send) });
        frame({ kind: HOST_RELAY_FRAME.RESPONSE_END, stream });
      }, 20);
      return { status: 200, headers: { "content-length": "1000" } };
    };
    host = await FakeHost.connect(harness.url(), { host: id, key, name: "old-pc" }, (_m, p) => {
      const { stream, path } = p as { stream: number; path: string };
      return answer(stream, path === "/whole" ? 1000 : 600);
    });
    host.peer.notify(
      HOST_NOTIFICATION.Report,
      report([service({ name: "sing", provides: ["sing"], token: "t" })], "old-pc"),
    );
    await waitUntil(() => cluster.registry.pick("sing") !== null, "the report");
    const endpoint: Endpoint = {
      capability: "sing",
      host: "old-pc",
      service: "sing",
      url: "link://old-pc/sing",
      via: "link",
      headers: {},
      healthy: true,
      version: null,
    };
    const whole = await cluster.registry.request(endpoint, "/whole");
    expect((await readAll(whole)).byteLength).toBe(1000);
    const short = await cluster.registry.request(endpoint, "/short");
    const error = await readAll(short).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HostRelayLengthError);
    expect((error as HostRelayLengthError).received).toBe(600);
    await host.close();
  });

  it("closes a link that sends a malformed binary frame", async () => {
    harness = await Harness.start();
    const cluster = harness.cluster();
    const { id, key } = approvedHost(cluster, "raw", ["sing"]);
    const host = await FakeHost.connect(harness.url(), { host: id, key });
    host.ws.send(Buffer.from([0x09, 1, 0, 0, 0]));
    expect(await host.closed).toBe(HOST_RELAY_PROTOCOL_ERROR);
  });
});
