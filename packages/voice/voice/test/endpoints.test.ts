// Smart Turn and Silero find the end-of-turn worker in the endpoint registry: the token reaches the
// worker, a worker that gives no answer is reported, no worker means the silence (or the energy
// detector) decides, and the VAD socket looks the worker up again at every reconnect.

import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { FakeEndpoints } from "../../speech/test/endpoints.js";
import { HttpTurnJudge, SileroVad } from "../src/index.js";
import type { SileroSocket } from "../src/silero.js";

const never = new AbortController().signal;

describe("Smart Turn through the registry", () => {
  let server: Server | null = null;
  afterEach(async () => {
    const s = server;
    server = null;
    if (s) await new Promise((resolve) => s.close(resolve));
  });

  async function worker(seen: IncomingHttpHeaders[]): Promise<string> {
    const s = createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        seen.push(req.headers);
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ complete: true, probability: 0.8, inference_ms: 3 }));
      });
    });
    server = s;
    await new Promise<void>((resolve) => s.listen(0, "127.0.0.1", resolve));
    return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
  }

  function judge(endpoints: FakeEndpoints, warnings: string[] = [], now = () => 1_000) {
    return new HttpTurnJudge({
      endpoints,
      timeoutMs: 200,
      now,
      warn: (m) => warnings.push(m),
    });
  }

  it("sends the endpoint's token to the direct `turn` endpoint", async () => {
    const seen: IncomingHttpHeaders[] = [];
    const url = await worker(seen);
    const endpoints = new FakeEndpoints([
      { name: "far", provides: ["turn"], url: "link://far/turn", via: "link" },
      { name: "pc", provides: ["turn"], url, headers: { authorization: "Bearer t1" } },
    ]);
    expect(await judge(endpoints).ask(Int16Array.of(1), 16_000, never)).toEqual({
      complete: true,
      probability: 0.8,
    });
    expect(seen[0]?.authorization).toBe("Bearer t1");
    expect(endpoints.requests).toEqual([{ url, path: "/turn" }]);
  });

  it("no endpoint: no answer, one warning per outage, nothing reported", async () => {
    const seen: IncomingHttpHeaders[] = [];
    const url = await worker(seen);
    const endpoints = new FakeEndpoints();
    const warnings: string[] = [];
    const j = judge(endpoints, warnings);
    expect(await j.ask(Int16Array.of(1), 16_000, never)).toBeNull();
    expect(await j.ask(Int16Array.of(1), 16_000, never)).toBeNull();
    expect(warnings).toEqual(["no end-of-turn worker is known, using the silence"]);
    // It appears (a hostd reported it): asked at once.
    endpoints.set([{ name: "pc", provides: ["turn"], url }]);
    expect(await j.ask(Int16Array.of(1), 16_000, never)).not.toBeNull();
    expect(endpoints.failures).toEqual([]);
  });

  it("a worker that gives no answer is reported to the registry", async () => {
    const endpoints = new FakeEndpoints([
      { name: "voice.turn", provides: ["turn"], url: "http://127.0.0.1:9" },
    ]);
    const warnings: string[] = [];
    expect(await judge(endpoints, warnings).ask(Int16Array.of(1), 16_000, never)).toBeNull();
    expect(endpoints.failures.map((f) => f.endpoint.host)).toEqual(["voice.turn"]);
    expect(warnings[0]).toMatch(/^Smart Turn is not answering, using the silence/);
  });
});

class FakeSocket implements SileroSocket {
  readyState = 1;
  bufferedAmount = 0;
  readonly #listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  constructor(
    readonly url: string,
    readonly headers: Record<string, string>,
  ) {}
  send(): void {}
  close(): void {}
  on(event: string, listener: (...args: unknown[]) => void): void {
    this.#listeners.set(event, [...(this.#listeners.get(event) ?? []), listener]);
  }
  emit(event: string, ...args: unknown[]): void {
    for (const l of this.#listeners.get(event) ?? []) l(...args);
  }
}

describe("Silero through the registry", () => {
  it("connects to the worker the registry has at each reconnect, with its headers", () => {
    let now = 0;
    let worker: { url: string; headers: Record<string, string> } | null = null;
    const sockets: FakeSocket[] = [];
    const vad = new SileroVad({
      worker: () => worker,
      threshold: 0.5,
      now: () => now,
      connect: (url, headers) => {
        const s = new FakeSocket(url, headers);
        sockets.push(s);
        return s;
      },
    });
    const quiet = new Int16Array(512);
    // No worker yet: the energy detector answers, and nothing is connected.
    expect(vad.isSpeech(quiet)).toBe(false);
    expect(sockets).toHaveLength(0);

    worker = { url: "http://10.0.0.2:8006", headers: { authorization: "Bearer v" } };
    now += 1_000;
    vad.isSpeech(quiet);
    expect(sockets.map((s) => [s.url, s.headers])).toEqual([
      ["ws://10.0.0.2:8006/vad", { authorization: "Bearer v" }],
    ]);

    // The worker moved: the next connect goes to the new place.
    (sockets[0] as FakeSocket).emit("open");
    worker = { url: "http://10.0.0.3:9006", headers: {} };
    (sockets[0] as FakeSocket).emit("close");
    now += 1_000;
    vad.isSpeech(quiet);
    expect(sockets.map((s) => s.url)).toEqual(["ws://10.0.0.2:8006/vad", "ws://10.0.0.3:9006/vad"]);
    vad.close();
  });
});
