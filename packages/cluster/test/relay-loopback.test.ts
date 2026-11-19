// The relay with its real pieces on loopback (2026-11-19: songs from a friend's machine crawled
// through the relay where plain HTTP over the same path took seconds). The real cluster module is
// Core's end, the daemon's real `CoreLink` (and its `HostRelay`, the real global `fetch`) is the
// host's, and the files come from a real HTTP service: a Node server, and, when Python has them,
// uvicorn and Starlette's `FileResponse` as the song worker serves `play_mix.pcm`
// (`fixtures/file_service.py`), whose pacing and chunking differ from Node's.
//
// Loopback is a fast link, so anything slow would be the relay's own; but nothing here asserts a
// speed. Bodies must arrive byte-exact (concurrently too), and a body the service breaks off must
// fail at Core instead of ending short. Ports are fixed in 47100–47199, never an ephemeral one.
//
// `RELAY_LOOPBACK_BENCH=1` also prints MB/s for 10 and 50 MB bodies, one and two at once, from
// both services, the worst `host.info` round trip meanwhile, and the same round trip with two
// bodies over a slow uplink (`RELAY_LOOPBACK_BENCH_MBIT`, default 0.64, the friend's measured rate).

import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  HOST_ERROR_CODE,
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
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import type { Endpoint } from "../src/index.js";
import { Harness, report, service, waitUntil } from "./helpers.js";
import { Throttle } from "./throttle.js";

const MB = 1_000_000;
const BENCH = process.env.RELAY_LOOPBACK_BENCH === "1";
/** The size of the song worker's `play_mix.pcm` that broke at 9 961 472 bytes. */
const SONG_BYTES = 10_052_200;
const PORT = { python: 47101, node: 47102, core: 47110, throttle: 47150 } as const;

class FakeApi implements HostApi {
  readonly services: HostServiceStatus[] = [
    service({ name: "sing", provides: ["sing"], token: "t" }),
  ];
  readonly targets = new Map<string, { url: string; headers: Record<string, string> }>();
  report(): HostReport {
    return report(this.services, "far-pc");
  }
  async call(method: string): Promise<unknown> {
    // `host.info` and the like: a small answer that has to come back over the busy link.
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

/** A Python that has uvicorn and Starlette, or `null`. */
function python(): string | null {
  for (const exe of ["python3", "python"]) {
    const r = spawnSync(exe, ["-c", "import uvicorn, starlette"], { stdio: "ignore" });
    if (r.status === 0) return exe;
  }
  return null;
}

const PYTHON = python();
const dir = join(process.env.TMP ?? tmpdir(), `relay-loopback-${process.pid}`);
const files = new Map<string, { size: number; sha: string }>();
let py: ChildProcess | null = null;
let node: Server | null = null;

function makeFile(name: string, size: number): void {
  const buf = Buffer.alloc(size);
  // Every 4 bytes their own offset: a missing, doubled or misplaced chunk changes the hash.
  for (let i = 0; i + 4 <= size; i += 4) buf.writeUInt32LE(i, i);
  writeFileSync(join(dir, name), buf);
  files.set(name, { size, sha: createHash("sha256").update(buf).digest("hex") });
}

beforeAll(async () => {
  mkdirSync(dir, { recursive: true });
  makeFile("song.pcm", SONG_BYTES);
  if (BENCH) makeFile("big.pcm", 50 * MB);
  node = createServer((req, res) => {
    const url = req.url ?? "";
    if (url === "/files/short") {
      // Says a song's length, sends 600 bytes, and the connection goes.
      res.writeHead(200, { "content-length": String(SONG_BYTES) });
      res.write(Buffer.alloc(600, 1), () => setTimeout(() => res.socket?.destroy(), 20));
      return;
    }
    const name = url.replace(/^\/files\//u, "");
    const f = files.get(name);
    if (f === undefined) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { "content-type": "audio/L16", "content-length": String(f.size) });
    createReadStream(join(dir, name)).pipe(res);
  });
  const server = node;
  await new Promise<void>((resolve) => server.listen(PORT.node, "127.0.0.1", resolve));
  if (PYTHON !== null) {
    const script = fileURLToPath(new URL("./fixtures/file_service.py", import.meta.url));
    const child = spawn(PYTHON, [script, dir, String(PORT.python)], {
      stdio: ["pipe", "pipe", "inherit"],
    });
    py = child;
    await new Promise<void>((resolve, reject) => {
      let out = "";
      child.stdout?.on("data", (d: Buffer) => {
        out += d.toString();
        if (/port \d+/u.test(out)) resolve();
      });
      child.once("exit", (code) => reject(new Error(`the file service exited with ${code}`)));
    });
  }
}, 120_000);

afterAll(async () => {
  py?.stdin?.end();
  py?.kill();
  node?.closeAllConnections();
  await new Promise<void>((resolve) => (node ? node.close(() => resolve()) : resolve()));
  rmSync(dir, { recursive: true, force: true });
});

const serviceUrl = {
  node: () => `http://127.0.0.1:${PORT.node}`,
  uvicorn: () => `http://127.0.0.1:${PORT.python}`,
} as const;

let rigs = 0;

interface Rig {
  request(path: string): Promise<Response>;
  /** One `host.info` round trip, in ms. */
  info(): Promise<number>;
  stop(): Promise<void>;
}

/** Core and a host linked over loopback, or through a `Throttle` for a slow uplink. */
async function rig(url: string, slow?: { upBytesPerSec: number; latencyMs: number }): Promise<Rig> {
  const n = rigs++ % 40;
  const harness = await Harness.start({ bind: `127.0.0.1:${PORT.core + n}` });
  const cluster = harness.cluster();
  const made = cluster.hosts.create({ name: "far-pc", approved: true, capabilities: ["sing"] });
  const throttle =
    slow === undefined
      ? null
      : await Throttle.start(PORT.core + n, { ...slow, listenPort: PORT.throttle + n });
  const api = new FakeApi();
  api.targets.set("sing", { url, headers: {} });
  const link = new CoreLink(api, {
    url: harness.url(),
    hostId: made.host.id,
    key: made.key,
    name: "far-pc",
    platform: process.platform,
    version: "0.1.0",
    retryInitialMs: 20,
    retryMaxMs: 100,
    ...(throttle === null
      ? {}
      : {
          webSocket: () =>
            new WebSocket(`ws://127.0.0.1:${throttle.port}/cluster-link`, {
              perMessageDeflate: false,
              maxPayload: 16 * 1024 * 1024,
            }),
        }),
  });
  link.start();
  await waitUntil(() => link.state === "connected", "the link");
  await waitUntil(() => cluster.registry.pick("sing") !== null, "the report");
  const endpoint: Endpoint = {
    capability: "sing",
    host: "far-pc",
    service: "sing",
    url: "link://far-pc/sing",
    via: "link",
    headers: {},
    healthy: true,
    version: null,
  };
  return {
    request: (path) => cluster.registry.request(endpoint, path),
    info: async () => {
      const t0 = performance.now();
      await cluster.hosts.call("far-pc", "host.info", {}).catch(() => undefined);
      return performance.now() - t0;
    },
    stop: async () => {
      await link.stop();
      await throttle?.stop();
      await harness.stop();
    },
  };
}

interface Got {
  bytes: number;
  sha: string;
  error: unknown;
}

/** Reads a body as the song client does: chunk by chunk, each one handed on before the next. */
async function read(r: Rig, path: string): Promise<Got> {
  const res = await r.request(path);
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  const hash = createHash("sha256");
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      hash.update(value);
      bytes += value.byteLength;
    }
  } catch (error) {
    return { bytes, sha: "", error };
  }
  return { bytes, sha: hash.digest("hex"), error: null };
}

function expectWhole(got: Got, name: string): void {
  const f = files.get(name);
  expect(got.error).toBeNull();
  expect(got.bytes).toBe(f?.size);
  expect(got.sha).toBe(f?.sha);
}

describe("the relay with its real pieces on loopback", () => {
  for (const kind of ["node", "uvicorn"] as const) {
    it.runIf(kind === "node" || PYTHON !== null)(
      `brings two song files from ${kind} at once, byte for byte`,
      async () => {
        const r = await rig(serviceUrl[kind]());
        try {
          const both = await Promise.all([read(r, "/files/song.pcm"), read(r, "/files/song.pcm")]);
          for (const got of both) expectWhole(got, "song.pcm");
          // And the link is still good for the next one.
          expectWhole(await read(r, "/files/song.pcm"), "song.pcm");
        } finally {
          await r.stop();
        }
      },
      60_000,
    );
  }

  it("fails a body the service breaks off, never ends it short", async () => {
    const r = await rig(serviceUrl.node());
    try {
      const got = await read(r, "/files/short");
      expect(got.bytes).toBe(600);
      expect(String(got.error)).toMatch(/aborted the relayed request.*response broke/);
    } finally {
      await r.stop();
    }
  }, 30_000);
});

describe.runIf(BENCH)("bench: the relay on loopback", () => {
  const line = (what: object) =>
    process.stderr.write(`RELAY_LOOPBACK_BENCH ${JSON.stringify(what)}\n`);

  for (const kind of ["node", "uvicorn"] as const) {
    for (const name of ["song.pcm", "big.pcm"]) {
      for (const count of [1, 2]) {
        it.runIf(kind === "node" || PYTHON !== null)(
          `${kind} ${name} × ${count}`,
          async () => {
            const r = await rig(serviceUrl[kind]());
            const infos: number[] = [];
            let done = false;
            const pinger = (async () => {
              while (!done) {
                infos.push(await r.info());
                await new Promise((resolve) => setTimeout(resolve, 100));
              }
            })();
            const t0 = performance.now();
            const got = await Promise.all(
              Array.from({ length: count }, () => read(r, `/files/${name}`)),
            );
            const seconds = (performance.now() - t0) / 1000;
            done = true;
            await pinger;
            await r.stop();
            for (const g of got) expectWhole(g, name);
            const size = files.get(name)?.size ?? 0;
            line({
              service: kind,
              mb: size / MB,
              streams: count,
              seconds: Math.round(seconds * 100) / 100,
              mb_per_s: Math.round(((size * count) / MB / seconds) * 10) / 10,
              worst_info_ms: Math.round(Math.max(0, ...infos)),
            });
          },
          600_000,
        );
      }
    }
  }

  it("host.info while two bodies cross a slow uplink", async () => {
    const mbit = Number(process.env.RELAY_LOOPBACK_BENCH_MBIT ?? 0.64);
    const r = await rig(serviceUrl.node(), { upBytesPerSec: (mbit * 1e6) / 8, latencyMs: 2 });
    const infos: number[] = [];
    const bodies = Promise.all([read(r, "/files/song.pcm"), read(r, "/files/song.pcm")]);
    // Long enough for every queue on the way to fill.
    const until = performance.now() + Number(process.env.RELAY_LOOPBACK_BENCH_SECS ?? 30) * 1000;
    while (performance.now() < until) {
      infos.push(await r.info());
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    await r.stop();
    await bodies.catch(() => {});
    line({
      link_mbit: mbit,
      info_ms: infos.map(Math.round),
      worst_info_ms: Math.round(Math.max(0, ...infos)),
    });
  }, 600_000);
});
