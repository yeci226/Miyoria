// The relay over a slow uplink (2026-11-19: long songs from a friend's machine never arrived in
// 200 s). The real cluster module and the daemon's real `CoreLink` talk through `Throttle`, a
// proxy that paces hostd → Core at a home upload's rate with a latency each way; two big bodies
// come back at once, as the mix and the vocals of a song do.
//
// What is checked is the relay's share of the time, not the machine's speed: the link is the
// bottleneck by construction (a few Mbit/s), so the bodies must take about bytes / rate, and a
// small request in the meantime waits for at most what the relay may queue ahead of it.
//
// `RELAY_BENCH=1` also runs the measurement of the report (2 × 40 MB at 4 Mbit/s with 100 ms
// each way, about three minutes) and prints its numbers.

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
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
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import type { Endpoint } from "../src/index.js";
import { Harness, report, service, waitUntil } from "./helpers.js";
import { Throttle } from "./throttle.js";

const MiB = 1024 * 1024;

class FakeApi implements HostApi {
  services: HostServiceStatus[] = [];
  targets = new Map<string, { url: string; headers: Record<string, string> }>();
  report(): HostReport {
    return report(this.services, "far-pc");
  }
  async call(method: string): Promise<unknown> {
    // `host.info` and the like: an answer that has to come back over the busy link.
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

/** A service whose `/big?size=N` answers N bytes, as fast as it is read. */
async function bigService(): Promise<{ server: Server; url: string }> {
  const block = Buffer.alloc(64 * 1024, 7);
  const server = createServer((req, res) => {
    const size = Number(new URL(req.url ?? "/", "http://x").searchParams.get("size") ?? 0);
    res.writeHead(200, { "content-type": "audio/L16", "content-length": String(size) });
    let at = 0;
    const write = () => {
      while (at < size) {
        const n = Math.min(block.byteLength, size - at);
        at += n;
        if (!res.write(n === block.byteLength ? block : block.subarray(0, n))) {
          res.once("drain", write);
          return;
        }
      }
      res.end();
    };
    write();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

interface Rig {
  harness: Harness;
  throttle: Throttle;
  link: CoreLink;
  server: Server;
  request: (path: string) => Promise<Response>;
  info: () => Promise<number>;
}

let rig: Rig | null = null;

afterEach(async () => {
  const r = rig;
  rig = null;
  if (r === null) return;
  await r.link.stop();
  await r.throttle.stop();
  await r.harness.stop();
  r.server.closeAllConnections();
  await new Promise<void>((resolve) => r.server.close(() => resolve()));
});

async function setup(rate: number, latencyMs: number, queueBytes?: number): Promise<Rig> {
  const svc = await bigService();
  const harness = await Harness.start();
  const cluster = harness.cluster();
  const made = cluster.hosts.create({ name: "far-pc", approved: true, capabilities: ["sing"] });
  const port = Number(new URL(harness.url()).port);
  const throttle = await Throttle.start(port, {
    upBytesPerSec: rate,
    latencyMs,
    ...(queueBytes === undefined ? {} : { queueBytes }),
  });
  const api = new FakeApi();
  api.services = [service({ name: "sing", provides: ["sing"], token: "t" })];
  api.targets.set("sing", { url: svc.url, headers: {} });
  const link = new CoreLink(api, {
    url: harness.url(),
    hostId: made.host.id,
    key: made.key,
    name: "far-pc",
    platform: "win32",
    version: "0.1.0",
    retryInitialMs: 20,
    retryMaxMs: 100,
    // The daemon's own socket options, through the slow path.
    webSocket: () =>
      new WebSocket(`ws://127.0.0.1:${throttle.port}/cluster-link`, {
        perMessageDeflate: false,
        maxPayload: 16 * MiB,
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
  rig = {
    harness,
    throttle,
    link,
    server: svc.server,
    request: (path) => cluster.registry.request(endpoint, path),
    info: async () => {
      const t0 = performance.now();
      await cluster.hosts.call("far-pc", "host.info", {}).catch(() => undefined);
      return performance.now() - t0;
    },
  };
  return rig;
}

interface Measured {
  seconds: number;
  /** Body bytes per second over the whole transfer. */
  rate: number;
  /** Longest round trip of a small request made every second meanwhile, ms. */
  worstInfoMs: number;
}

/** `count` bodies of `size` bytes at once; small requests every second meanwhile. */
async function measure(r: Rig, size: number, count: number): Promise<Measured> {
  let done = false;
  const infos: number[] = [];
  const pinger = (async () => {
    while (!done) {
      infos.push(await r.info());
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  })();
  const t0 = performance.now();
  const bodies = await Promise.all(
    Array.from({ length: count }, async () => {
      const res = await r.request(`/big?size=${size}`);
      return (await res.arrayBuffer()).byteLength;
    }),
  );
  const seconds = (performance.now() - t0) / 1000;
  done = true;
  await pinger;
  for (const n of bodies) expect(n).toBe(size);
  return { seconds, rate: (size * count) / seconds, worstInfoMs: Math.max(0, ...infos) };
}

describe("the relay over a slow uplink", () => {
  it("moves two bodies at the link's rate and keeps small requests answered", async () => {
    // 8 Mbit/s up, 50 ms each way; 2 × 3 MiB: the link alone needs 6.3 s.
    const rate = 1_000_000;
    const r = await setup(rate, 50);
    const m = await measure(r, 3 * MiB, 2);
    // The relay adds little to what the link needs (its window is never the limit at this BDP).
    expect(m.rate).toBeGreaterThan(rate * 0.75);
    // A small request waits behind what the sender queued: bounded by the relay's socket high
    // water, not by the size of the bodies.
    expect(m.worstInfoMs).toBeLessThan(5_000);
  }, 60_000);

  it.runIf(process.env.RELAY_BENCH === "1")(
    "bench: 2 × 40 MB at 4 Mbit/s, 100 ms each way",
    async () => {
      const env = process.env;
      const rate = (Number(env.RELAY_BENCH_MBIT ?? 4) * 1e6) / 8;
      const latency = Number(env.RELAY_BENCH_LATENCY_MS ?? 100);
      const queue = Number(env.RELAY_BENCH_QUEUE_KIB ?? 256) * 1024;
      const r = await setup(rate, latency, queue);
      const m = await measure(r, Number(env.RELAY_BENCH_MB ?? 40) * 1000 * 1000, 2);
      const line = {
        link_mbit: (rate * 8) / 1e6,
        latency_ms: latency,
        queue_kib: queue / 1024,
        seconds: Math.round(m.seconds * 10) / 10,
        relay_mbit: Math.round(((m.rate * 8) / 1e6) * 100) / 100,
        efficiency: Math.round((m.rate / rate) * 1000) / 1000,
        worst_info_ms: Math.round(m.worstInfoMs),
      };
      process.stderr.write(`RELAY_BENCH ${JSON.stringify(line)}\n`);
    },
    600_000,
  );
});
