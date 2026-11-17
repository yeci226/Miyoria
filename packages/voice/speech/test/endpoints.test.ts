// `http-worker` providers find their worker in the endpoint registry: a provider with a `url` calls
// its own static entry, one without calls whatever the registry has; no endpoint counts as a
// failed provider; the endpoint's token reaches the worker; a request that got no answer is
// reported to the registry.

import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { errorMessage } from "@miyoria/runtime/kernel";
import type { JsonValue } from "@miyoria/types";
import { afterEach, describe, expect, it } from "vitest";
import {
  type AudioBuf,
  NO_HINT,
  SpeechConfigSchema,
  SpeechModule,
  speechEntryName,
  ttsRequest,
} from "../src/index.js";
import { FakeEndpoints } from "./endpoints.js";

const servers: Server[] = [];

afterEach(async () => {
  for (const s of servers.splice(0)) {
    s.closeAllConnections();
    await new Promise<void>((resolve) => s.close(() => resolve()));
  }
});

/** A worker that answers `/asr` with its own name and `/tts` with a little PCM. */
async function worker(name: string): Promise<{ url: string; headers: IncomingHttpHeaders[] }> {
  const headers: IncomingHttpHeaders[] = [];
  const server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      headers.push(req.headers);
      if (req.url === "/asr") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ text: name }));
      } else if (req.url === "/tts") {
        res.writeHead(200, { "x-sample-rate": "16000" });
        res.write(Buffer.from([1, 0]));
        setTimeout(() => res.end(Buffer.from([2, 0])), 5);
      } else res.writeHead(404).end();
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, headers };
}

/** A port nothing listens on. */
async function deadUrl(): Promise<string> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return `http://127.0.0.1:${port}`;
}

function tone(): AudioBuf {
  return { sampleRate: 16_000, samples: new Int16Array(320) };
}

function build(speech: Record<string, JsonValue>, endpoints: FakeEndpoints) {
  return SpeechModule.withDefaultFactories(SpeechConfigSchema.parse(speech)).buildService({
    endpoints,
  });
}

describe("http-worker providers and the endpoint registry", () => {
  it("a provider with a url calls its own entry; one without calls the registry's", async () => {
    const local = await worker("local");
    const shared = await worker("shared");
    const endpoints = new FakeEndpoints([
      // What a hostd reported comes first in the registry: only the provider without `url` uses it.
      { name: "main-pc", provides: ["asr"], url: shared.url },
      { name: speechEntryName("asr", "local"), provides: ["asr"], url: local.url },
    ]);
    const pinned = build(
      { asr: { local: { kind: "http-worker", url: local.url } }, asr_chain: ["local"] },
      endpoints,
    );
    expect((await pinned.transcribe(tone(), NO_HINT))[1].text).toBe("local");
    const anyAsr = build({ asr: { any: { kind: "http-worker" } } }, endpoints);
    expect((await anyAsr.transcribe(tone(), NO_HINT))[1].text).toBe("shared");
  });

  it("two providers with a url stay two places, in the chain's order", async () => {
    const a = await worker("a");
    const b = await worker("b");
    const endpoints = new FakeEndpoints([
      { name: "speech.asr.remote", provides: ["asr"], url: b.url },
      { name: "speech.asr.local", provides: ["asr"], url: a.url },
    ]);
    const svc = build(
      {
        asr: {
          local: { kind: "http-worker", url: a.url },
          remote: { kind: "http-worker", url: b.url },
        },
        asr_chain: ["local", "remote"],
      },
      endpoints,
    );
    expect(await svc.transcribe(tone(), NO_HINT)).toMatchObject(["local", { text: "a" }]);
  });

  it("a provider with no endpoint fails like a worker that does not answer: the chain moves on", async () => {
    const b = await worker("b");
    const endpoints = new FakeEndpoints([{ name: "speech.asr.b", provides: ["asr"], url: b.url }]);
    const svc = build(
      {
        asr: {
          a: { kind: "http-worker", url: "http://unused" },
          b: { kind: "http-worker", url: b.url },
        },
        asr_chain: ["a", "b"],
      },
      endpoints,
    );
    expect(await svc.transcribe(tone(), NO_HINT)).toMatchObject(["b", { text: "b" }]);

    const alone = build({ asr: { a: { kind: "http-worker", url: "http://unused" } } }, endpoints);
    const error = await alone.transcribe(tone(), NO_HINT).then(
      () => "no error",
      (e: unknown) => errorMessage(e),
    );
    expect(error).toBe("no endpoint for `speech.asr.a` in the endpoint registry");

    const none = build({ tts: { q: { kind: "http-worker" } } }, new FakeEndpoints());
    await expect(none.synthesize(ttsRequest("x"))).rejects.toThrow(
      "no TTS worker is known to the endpoint registry",
    );
  });

  it("only direct endpoints, and only healthy ones, are used for speech", async () => {
    const w = await worker("w");
    const endpoints = new FakeEndpoints([
      { name: "far", provides: ["asr"], url: "link://far/asr", via: "link" },
      { name: "sick", provides: ["asr"], url: "http://127.0.0.1:9", healthy: false },
      { name: "near", provides: ["asr"], url: w.url },
    ]);
    const svc = build({ asr: { any: { kind: "http-worker" } } }, endpoints);
    expect((await svc.transcribe(tone(), NO_HINT))[1].text).toBe("w");
  });

  it("sends the endpoint's token, and streams TTS through the registry's request", async () => {
    const w = await worker("w");
    const endpoints = new FakeEndpoints([
      {
        name: "speech.tts.q",
        provides: ["tts"],
        url: w.url,
        headers: { authorization: "Bearer service-token" },
      },
      {
        name: "speech.asr.a",
        provides: ["asr"],
        url: w.url,
        headers: { authorization: "Bearer service-token" },
      },
    ]);
    const svc = build(
      {
        asr: { a: { kind: "http-worker", url: w.url } },
        tts: { q: { kind: "http-worker", url: w.url } },
      },
      endpoints,
    );
    await svc.transcribe(tone(), NO_HINT);
    const [, stream] = await svc.synthesize(ttsRequest("hi"));
    const samples: number[] = [];
    for await (const chunk of stream) samples.push(...chunk.samples);
    expect(samples).toEqual([1, 2]);
    expect(w.headers.map((h) => h.authorization)).toEqual([
      "Bearer service-token",
      "Bearer service-token",
    ]);
    expect(String(w.headers[1]?.["content-type"])).toBe("application/json");
    expect(endpoints.requests.map((r) => r.path)).toEqual(["/asr", "/tts"]);
  });

  it("reports an endpoint that gave no answer to the registry, not one that answered an error", async () => {
    const dead = await deadUrl();
    const endpoints = new FakeEndpoints([{ name: "speech.asr.a", provides: ["asr"], url: dead }]);
    const svc = build({ asr: { a: { kind: "http-worker", url: dead } } }, endpoints);
    await expect(svc.transcribe(tone(), NO_HINT)).rejects.toThrow(/request to .*\/asr failed/);
    expect(endpoints.failures.map((f) => f.endpoint.host)).toEqual(["speech.asr.a"]);

    const w = await worker("w");
    endpoints.set([{ name: "speech.tts.q", provides: ["tts"], url: `${w.url}/nothing-here` }]);
    const tts = build({ tts: { q: { kind: "http-worker", url: w.url } } }, endpoints);
    await expect(tts.synthesize(ttsRequest("x"))).rejects.toThrow(/404/);
    expect(endpoints.failures).toHaveLength(1);
  });
});
