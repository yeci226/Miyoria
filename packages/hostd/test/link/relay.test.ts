// The host's half of the relay on its own: `HostRelay` against a local HTTP service, with the
// frames it sends recorded and Core's frames fed in by hand.

import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { gzipSync } from "node:zlib";
import {
  decodeRelayFrame,
  encodeRelayFrame,
  HOST_ERROR_CODE,
  HOST_RELAY_FRAME,
  HOST_RELAY_LIMITS,
  type HostRelayFrame,
  type HostReport,
} from "@miyoria/contracts/host";
import { afterEach, describe, expect, it } from "vitest";
import { type HostApi, HostRelay, HostRpcError, relayUrl } from "../../src/link/index.js";

const F = HOST_RELAY_FRAME;
const WINDOW = HOST_RELAY_LIMITS.WINDOW_BYTES;

async function until(cond: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`${what} not met in time`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

interface Seen {
  url: string;
  headers: IncomingMessage["headers"];
  body: Buffer;
}

let server: Server | null = null;
const seen: Seen[] = [];
const cut: string[] = [];
const big = Buffer.alloc(3 * WINDOW, 7);

afterEach(async () => {
  seen.length = 0;
  cut.length = 0;
  server?.closeAllConnections();
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = null;
});

async function service(): Promise<string> {
  server = createServer(async (req, res) => {
    res.on("close", () => {
      if (!res.writableFinished) cut.push(req.url ?? "");
    });
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    seen.push({ url: req.url ?? "", headers: req.headers, body: Buffer.concat(chunks) });
    if (req.url === "/hang") return;
    if (req.url === "/big") {
      res.writeHead(200, { "content-type": "application/octet-stream" });
      res.end(big);
      return;
    }
    if (req.url === "/gzip") {
      const body = gzipSync(Buffer.from("hello hello hello"));
      res.writeHead(200, {
        "content-encoding": "gzip",
        "content-length": String(body.byteLength),
        "x-kept": "1",
        connection: "keep-alive",
      });
      res.end(body);
      return;
    }
    res.writeHead(200, { "content-type": "text/plain" });
    res.end(`echo ${Buffer.concat(chunks).byteLength}`);
  });
  const listening = server;
  await new Promise<void>((resolve) => listening.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(listening.address() as AddressInfo).port}`;
}

function api(targets: Record<string, string>, reported: string[] = []): HostApi {
  return {
    report: (): HostReport => ({
      name: "pc",
      version: "0",
      platform: "linux",
      protocol: 1,
      gpu: null,
      services: reported.map((name) => ({
        name,
        kind: "worker",
        provides: [name],
        state: "stopped",
        since: 0,
        healthy: false,
        restarts: 0,
      })),
    }),
    call: async () => null,
    onEvent: () => () => {},
    followLogs: () => () => {},
    target: (name) =>
      targets[name] === undefined
        ? null
        : { url: targets[name] as string, headers: { authorization: "Bearer svc" } },
    setGuardSource: () => {},
    setClusterClient: () => {},
  };
}

/** A relay with its sent frames decoded and its protocol errors recorded. */
function relay(targets: Record<string, string>, reported: string[] = []) {
  const frames: HostRelayFrame[] = [];
  const errors: string[] = [];
  const r = new HostRelay({
    api: api(targets, reported),
    sink: {
      send: (bytes) => {
        frames.push(decodeRelayFrame(new Uint8Array(bytes)));
        return true;
      },
      bufferedAmount: 0,
    },
    onProtocolError: (reason) => errors.push(reason),
  });
  const sent = (stream: number) =>
    frames
      .filter((f) => f.stream === stream && f.kind === F.RESPONSE_CHUNK)
      .reduce((n, f) => n + (f.kind === F.RESPONSE_CHUNK ? f.data.byteLength : 0), 0);
  const ended = (stream: number) =>
    frames.some((f) => f.stream === stream && f.kind === F.RESPONSE_END);
  const core = (f: HostRelayFrame) => r.frame(encodeRelayFrame(f));
  return { r, frames, errors, sent, ended, core };
}

const live = () => new AbortController().signal;

describe("relayUrl", () => {
  it("appends the path and never leaves the service's origin", () => {
    expect(relayUrl("http://127.0.0.1:8005", "/a?b=1")?.href).toBe("http://127.0.0.1:8005/a?b=1");
    expect(relayUrl("http://127.0.0.1:8005/", "//evil.example/x")?.href).toBe(
      "http://127.0.0.1:8005/evil.example/x",
    );
    expect(relayUrl("http://127.0.0.1:8005", "/../../x")?.origin).toBe("http://127.0.0.1:8005");
    expect(relayUrl("not a url", "/x")).toBeNull();
  });
});

describe("HostRelay", () => {
  it("sends the head, then a window of body, then more as credit arrives", async () => {
    const url = await service();
    const t = relay({ sing: url });
    const head = await t.r.handle(
      { stream: 1, service: "sing", method: "GET", path: "/big", headers: { authorization: "x" } },
      live(),
    );
    expect(head).toMatchObject({
      status: 200,
      headers: { "content-type": "application/octet-stream" },
    });
    expect(seen[0]?.headers.authorization).toBe("Bearer svc");
    await until(() => t.sent(1) === WINDOW, "a full window");
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(t.sent(1)).toBe(WINDOW);
    // Core reads it all and grants credit as it goes.
    while (!t.ended(1)) {
      t.core({ kind: F.CREDIT, stream: 1, bytes: HOST_RELAY_LIMITS.CREDIT_STEP_BYTES });
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    expect(t.sent(1)).toBe(big.byteLength);
    expect(t.r.open).toBe(0);
    expect(t.errors).toEqual([]);
  });

  it("takes a request body whole when its length is known, streamed when not", async () => {
    const url = await service();
    const t = relay({ sing: url });
    const whole = t.r.handle(
      { stream: 1, service: "sing", method: "POST", path: "/a", body: true, length: 5 },
      live(),
    );
    t.core({ kind: F.REQUEST_CHUNK, stream: 1, data: Buffer.from("hel") });
    t.core({ kind: F.REQUEST_CHUNK, stream: 1, data: Buffer.from("lo") });
    t.core({ kind: F.REQUEST_END, stream: 1 });
    await whole;
    expect(seen[0]?.headers["content-length"]).toBe("5");
    expect(seen[0]?.body.toString()).toBe("hello");

    const streamed = t.r.handle(
      { stream: 2, service: "sing", method: "POST", path: "/b", body: true },
      live(),
    );
    t.core({ kind: F.REQUEST_CHUNK, stream: 2, data: Buffer.from("abc") });
    t.core({ kind: F.REQUEST_END, stream: 2 });
    await streamed;
    expect(seen[1]?.headers["transfer-encoding"]).toBe("chunked");
    expect(seen[1]?.body.toString()).toBe("abc");
  });

  it("aborts the fetch on an abort frame, a cancel, or the link's close", async () => {
    const url = await service();
    const t = relay({ sing: url });
    const a = t.r.handle({ stream: 1, service: "sing", method: "GET", path: "/hang" }, live());
    const stop = new AbortController();
    const b = t.r.handle({ stream: 2, service: "sing", method: "GET", path: "/hang" }, stop.signal);
    const c = t.r.handle({ stream: 3, service: "sing", method: "GET", path: "/hang" }, live());
    await until(() => seen.length === 3, "three requests");
    t.core({ kind: F.ABORT, stream: 1, reason: "caller gave up" });
    await expect(a).rejects.toThrow(/aborted/);
    stop.abort();
    await expect(b).rejects.toThrow(/aborted/);
    t.r.close();
    await expect(c).rejects.toThrow(/aborted/);
    await until(() => cut.length === 3, "the service sees three closes");
    expect(t.r.open).toBe(0);
  });

  it("answers for a service it cannot reach", async () => {
    const t = relay({}, ["stopped"]);
    await expect(
      t.r.handle({ stream: 1, service: "stopped", method: "GET", path: "/" }, live()),
    ).rejects.toMatchObject({ code: HOST_ERROR_CODE.UnknownService, message: /not running/ });
    await expect(
      t.r.handle({ stream: 2, service: "nope", method: "GET", path: "/" }, live()),
    ).rejects.toBeInstanceOf(HostRpcError);
    await expect(
      t.r.handle({ stream: 3, service: "nope", method: "GET", path: "x" }, live()),
    ).rejects.toMatchObject({ message: /invalid params/ });
    expect(t.r.open).toBe(0);
  });

  it("drops what fetch decoded: the encoding and the length, and hop-by-hop headers", async () => {
    const url = await service();
    const t = relay({ sing: url });
    const head = await t.r.handle(
      { stream: 1, service: "sing", method: "GET", path: "/gzip" },
      live(),
    );
    expect(head.headers["x-kept"]).toBe("1");
    expect(head.headers["content-encoding"]).toBeUndefined();
    expect(head.headers["content-length"]).toBeUndefined();
    expect(head.headers.connection).toBeUndefined();
    await until(() => t.ended(1), "the end");
    const body = Buffer.concat(
      t.frames.flatMap((f) => (f.kind === F.RESPONSE_CHUNK ? [Buffer.from(f.data)] : [])),
    );
    expect(body.toString()).toBe("hello hello hello");
  });

  it("closes on a broken frame, ignores frames for unknown streams", async () => {
    const url = await service();
    const t = relay({ sing: url });
    t.core({ kind: F.REQUEST_CHUNK, stream: 99, data: Buffer.from("late") });
    t.core({ kind: F.CREDIT, stream: 99, bytes: 10 });
    t.core({ kind: F.ABORT, stream: 99, reason: "late" });
    expect(t.errors).toEqual([]);
    t.r.frame(Uint8Array.from([0x42, 1, 0, 0, 0]));
    t.core({ kind: F.RESPONSE_END, stream: 1 });
    expect(t.errors).toHaveLength(2);

    // A request body over its credit.
    const over = relay({ sing: url });
    void over.r
      .handle({ stream: 1, service: "sing", method: "POST", path: "/x", body: true }, live())
      .catch(() => {});
    const chunk = new Uint8Array(HOST_RELAY_LIMITS.CHUNK_BYTES);
    for (let i = 0; i <= WINDOW / chunk.byteLength; i++) {
      over.core({ kind: F.REQUEST_CHUNK, stream: 1, data: chunk });
    }
    expect(over.errors).toHaveLength(1);
    over.r.close();
  });
});
