// What a service of a host may ask Core for through its hostd: `cluster.llm` and `cluster.fetch`.
// Who may call what (Core decides, from the host's approval, its last report and the table of
// uses), the rate limit and the body caps, and both calls end to end through the real link
// client (`CoreLink`) with a fake LLM function and a tiny HTTP server as the ASR endpoint.

import { createServer, type IncomingMessage, type Server } from "node:http";
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
import { systemClock } from "@miyoria/types";
import { afterEach, describe, expect, it } from "vitest";
import {
  type CallerHost,
  ClusterCalls,
  type ClusterComplete,
  type ClusterCompletion,
  EndpointRegistry,
} from "../src/index.js";
import { approvedHost, FakeHost, Harness, report, service, waitUntil } from "./helpers.js";

let harness: Harness | null = null;
const hosts: FakeHost[] = [];
const links: CoreLink[] = [];
const servers: Server[] = [];

afterEach(async () => {
  for (const link of links.splice(0)) await link.stop();
  for (const host of hosts.splice(0)) await host.close().catch(() => undefined);
  await harness?.stop();
  harness = null;
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  }
});

/** A tiny HTTP server; `handle` answers each request with its body read. */
async function httpServer(
  handle: (req: IncomingMessage, body: Buffer) => { status?: number; body: string | Buffer },
): Promise<string> {
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const out = handle(req, Buffer.concat(chunks));
      res.writeHead(out.status ?? 200, { "content-type": "application/json", "x-extra": "1" });
      res.end(out.body);
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const echoLlm: ClusterComplete = async (_services, request) =>
  `${request.host}/${request.service}: ${request.messages.at(-1)?.content ?? ""}`;

/** A raw host that reports `services` and waits until Core has read the report. */
async function reportingHost(
  h: Harness,
  credentials: { id: string; key: string },
  services: HostServiceStatus[],
): Promise<FakeHost> {
  const host = await FakeHost.connect(h.url(), { host: credentials.id, key: credentials.key });
  hosts.push(host);
  host.peer.notify("host.report", report(services));
  // A request after the notification: Core reads the socket in order.
  await host.peer.request("cluster.guard", {});
  return host;
}

const ask = (host: FakeHost, params: object) =>
  host.peer.request("cluster.llm", {
    purpose: "fast",
    messages: [{ role: "user", content: "which song?" }],
    ...params,
  });

describe("who may ask Core", () => {
  it("refuses a pending host, an unknown service, one that provides nothing approved, and what the table does not allow", async () => {
    harness = await Harness.start({}, { module: { complete: echoLlm } });
    const h = harness;
    const cluster = h.cluster();
    const services = [
      service({ name: "sing", provides: ["sing"] }),
      service({ name: "tts", provides: ["tts"] }),
    ];

    const pending = cluster.hosts.create({ name: "new-pc" });
    const stranger = await reportingHost(h, { id: pending.host.id, key: pending.key }, services);
    await expect(ask(stranger, { service: "sing" })).rejects.toMatchObject({
      code: HOST_ERROR_CODE.NotAllowed,
      message: expect.stringMatching(/not approved/),
    });

    const host = await reportingHost(h, approvedHost(cluster, "pc", ["sing", "asr"]), services);
    await expect(ask(host, {})).rejects.toMatchObject({ code: HOST_ERROR_CODE.NotAllowed });
    await expect(ask(host, { service: "ghost" })).rejects.toMatchObject({
      code: HOST_ERROR_CODE.NotAllowed,
      message: expect.stringMatching(/reports no service/),
    });
    // `tts` runs there, but the host is not approved for what it provides.
    await expect(ask(host, { service: "tts" })).rejects.toMatchObject({
      code: HOST_ERROR_CODE.NotAllowed,
      message: expect.stringMatching(/nothing the host is approved for/),
    });
    await expect(ask(host, { service: "sing", purpose: "chat" })).rejects.toMatchObject({
      code: HOST_ERROR_CODE.NotAllowed,
    });
    await expect(
      host.peer.request("cluster.fetch", {
        capability: "tts",
        method: "POST",
        path: "/tts",
        service: "sing",
      }),
    ).rejects.toMatchObject({ code: HOST_ERROR_CODE.NotAllowed });
    await expect(ask(host, { service: "sing", messages: [] })).rejects.toMatchObject({
      code: -32602,
    });

    expect(await ask(host, { service: "sing" })).toEqual({ text: "pc/sing: which song?" });
  });

  it("the table and the purposes are options", async () => {
    harness = await Harness.start(
      {},
      {
        module: {
          complete: echoLlm,
          uses: { tts: { llm: ["chat"] } },
          llmPurposes: ["chat"],
        },
      },
    );
    const cluster = harness.cluster();
    const host = await reportingHost(harness, approvedHost(cluster, "pc", ["sing", "tts"]), [
      service({ name: "sing", provides: ["sing"] }),
      service({ name: "tts", provides: ["tts"] }),
    ]);
    await expect(ask(host, { service: "sing" })).rejects.toMatchObject({
      code: HOST_ERROR_CODE.NotAllowed,
    });
    expect(await ask(host, { service: "tts", purpose: "chat" })).toEqual({
      text: "pc/tts: which song?",
    });
  });

  it("limits completions per host", async () => {
    harness = await Harness.start(
      {},
      { module: { complete: echoLlm, llmRate: { calls: 2, window_ms: 60_000 } } },
    );
    const cluster = harness.cluster();
    const host = await reportingHost(harness, approvedHost(cluster, "pc", ["sing"]), [
      service({ name: "sing", provides: ["sing"] }),
    ]);
    await ask(host, { service: "sing" });
    await ask(host, { service: "sing" });
    await expect(ask(host, { service: "sing" })).rejects.toMatchObject({
      code: HOST_ERROR_CODE.RateLimited,
    });
    // Refused requests are not counted against another host.
    const other = await reportingHost(harness, approvedHost(cluster, "pc2", ["sing"]), [
      service({ name: "sing", provides: ["sing"] }),
    ]);
    expect(await ask(other, { service: "sing" })).toEqual({ text: "pc2/sing: which song?" });
  });

  it("without an LLM function a completion is unavailable", async () => {
    harness = await Harness.start();
    const host = await reportingHost(harness, approvedHost(harness.cluster(), "pc", ["sing"]), [
      service({ name: "sing", provides: ["sing"] }),
    ]);
    await expect(ask(host, { service: "sing" })).rejects.toMatchObject({
      code: HOST_ERROR_CODE.Unavailable,
    });
  });
});

describe("cluster.resolve", () => {
  const ASR_TOKEN = "asr-secret";
  const TTS_TOKEN = "tts-secret";
  const registry = () =>
    new EndpointRegistry({
      static: {
        "main-asr": { provides: ["asr"], url: "http://10.0.0.5:8003", token: ASR_TOKEN },
        "main-tts": { provides: ["tts"], url: "http://10.0.0.5:8002", token: TTS_TOKEN },
      },
    });
  const calls = (uses?: Record<string, { resolve?: string[]; fetch?: string[] }>) =>
    new ClusterCalls({
      registry: registry(),
      complete: null,
      clock: systemClock,
      ...(uses === undefined ? {} : { uses }),
    });
  const host = (fields: Partial<CallerHost> = {}): CallerHost => ({
    name: "friend-pc",
    approved: true,
    capabilities: ["lyrics", "sing"],
    services: [
      service({ name: "lyrics", provides: ["lyrics"] }),
      service({ name: "sing", provides: ["sing"] }),
      service({ name: "tts", provides: ["tts"] }),
    ],
    ...fields,
  });

  /** What a refusal carried, so no token can hide in it. */
  function refusal(fn: () => unknown): { code: number; text: string } {
    try {
      fn();
    } catch (error) {
      return {
        code: (error as { code: number }).code,
        text: JSON.stringify(error, Object.getOwnPropertyNames(error)),
      };
    }
    throw new Error("expected a refusal");
  }

  it("gives a granted service the capability's endpoints with their token", () => {
    const c = calls({ lyrics: { resolve: ["asr"] } });
    const got = c.resolve(host(), { capability: "asr", service: "lyrics" });
    expect(got.endpoints).toMatchObject([
      {
        host: "main-asr",
        url: "http://10.0.0.5:8003",
        headers: { authorization: `Bearer ${ASR_TOKEN}` },
      },
    ]);
    // Only that capability's: the other service's token is not in the answer.
    expect(JSON.stringify(got)).not.toContain(TTS_TOKEN);
  });

  it("refuses everything else, and the refusal carries no endpoint or token", () => {
    const granted = calls({ lyrics: { resolve: ["asr"] } });
    const cases: Array<[CallerHost, unknown]> = [
      // A capability it was not granted.
      [host(), { capability: "tts", service: "lyrics" }],
      // A service of the host the table grants nothing.
      [host(), { capability: "asr", service: "sing" }],
      // No service named (hostd adds it): the operator's own call.
      [host(), { capability: "asr" }],
      // A service the host does not report.
      [host(), { capability: "asr", service: "ghost" }],
      // It runs, but the host is not approved for what it provides.
      [host({ capabilities: ["sing"] }), { capability: "asr", service: "lyrics" }],
      // A host that is not approved.
      [host({ approved: false }), { capability: "asr", service: "lyrics" }],
    ];
    for (const [caller, params] of cases) {
      const r = refusal(() => granted.resolve(caller, params));
      expect(r.code).toBe(HOST_ERROR_CODE.NotAllowed);
      expect(r.text).not.toContain(ASR_TOKEN);
      expect(r.text).not.toContain(TTS_TOKEN);
      expect(r.text).not.toContain("10.0.0.5");
    }
    expect(refusal(() => granted.resolve(host(), { service: "lyrics" })).code).toBe(-32602);
  });

  it("by default nothing may resolve, not even what a service may fetch", () => {
    // `sing` may fetch from `asr` (DEFAULT_CLUSTER_USES): that never hands it the ASR token.
    const r = refusal(() => calls().resolve(host(), { capability: "asr", service: "sing" }));
    expect(r.code).toBe(HOST_ERROR_CODE.NotAllowed);
    expect(r.text).not.toContain(ASR_TOKEN);
  });
});

describe("cluster.fetch", () => {
  const caller: CallerHost = {
    name: "pc",
    approved: true,
    capabilities: ["sing"],
    services: [service({ name: "sing", provides: ["sing"] })],
  };

  function calls(registry: EndpointRegistry, options: { max?: number; timeoutMs?: number } = {}) {
    return new ClusterCalls({
      registry,
      complete: null,
      clock: systemClock,
      ...(options.max === undefined ? {} : { maxBodyBytes: options.max }),
      ...(options.timeoutMs === undefined ? {} : { fetchTimeoutMs: options.timeoutMs }),
    });
  }

  const fetchParams = (body: Buffer) => ({
    capability: "asr",
    method: "POST",
    path: "/asr",
    body: body.toString("base64"),
    service: "sing",
  });

  it("caps the request body and the answer", async () => {
    const url = await httpServer((_req, body) => ({ body: "x".repeat(body.length) }));
    const registry = new EndpointRegistry({ static: { asr: { provides: ["asr"], url } } });
    const c = calls(registry, { max: 100 });
    const signal = new AbortController().signal;
    await expect(c.fetch(caller, fetchParams(Buffer.alloc(101)), signal)).rejects.toMatchObject({
      code: HOST_ERROR_CODE.TooLarge,
      message: expect.stringMatching(/request body/),
    });
    const ok = await c.fetch(caller, fetchParams(Buffer.alloc(100)), signal);
    expect(Buffer.from(ok.body, "base64").length).toBe(100);
    // An answer over the cap: the server doubles nothing here, so ask for a larger one.
    const big = await httpServer(() => ({ body: "y".repeat(101) }));
    const bigCalls = calls(
      new EndpointRegistry({ static: { asr: { provides: ["asr"], url: big } } }),
      { max: 100 },
    );
    await expect(
      bigCalls.fetch(caller, fetchParams(Buffer.alloc(1)), signal),
    ).rejects.toMatchObject({
      code: HOST_ERROR_CODE.TooLarge,
      message: expect.stringMatching(/answer/),
    });
  });

  it("is unavailable without an endpoint, and when the endpoint does not answer in time", async () => {
    const signal = new AbortController().signal;
    await expect(
      calls(new EndpointRegistry()).fetch(caller, fetchParams(Buffer.alloc(1)), signal),
    ).rejects.toMatchObject({ code: HOST_ERROR_CODE.Unavailable });

    const silent = createServer(() => {
      // never answers
    });
    servers.push(silent);
    await new Promise<void>((resolve) => silent.listen(0, "127.0.0.1", () => resolve()));
    const url = `http://127.0.0.1:${(silent.address() as AddressInfo).port}`;
    const registry = new EndpointRegistry({ static: { asr: { provides: ["asr"], url } } });
    await expect(
      calls(registry, { timeoutMs: 200 }).fetch(caller, fetchParams(Buffer.alloc(1)), signal),
    ).rejects.toMatchObject({
      code: HOST_ERROR_CODE.Unavailable,
      message: expect.stringMatching(/no answer within/),
    });
    // The endpoint that failed rests.
    expect(registry.pick("asr")).toBeNull();
  });

  it("refuses a body that is not base64", async () => {
    const registry = new EndpointRegistry({
      static: { asr: { provides: ["asr"], url: "http://127.0.0.1:9" } },
    });
    await expect(
      calls(registry).fetch(
        caller,
        { ...fetchParams(Buffer.alloc(1)), body: "not base64!" },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: -32602 });
  });
});

/** A daemon's API as the link needs it: services the test sets, and the client Core gives. */
class LinkedApi implements HostApi {
  services: HostServiceStatus[] = [];
  client: ClusterClient | null = null;

  report(): HostReport {
    return report(this.services, "pc");
  }

  async call(method: string): Promise<unknown> {
    throw new HostRpcError(-32601, `not here: ${method}`);
  }

  onEvent(_listener: (event: HostServiceEvent) => void): () => void {
    return () => {};
  }

  followLogs(): () => void {
    return () => {};
  }

  target(): null {
    return null;
  }

  setGuardSource(_source: GuardSource | null): void {}

  setClusterClient(client: ClusterClient | null): void {
    this.client = client;
  }
}

describe("end to end through the link", () => {
  it("a completion and an ASR request, with the endpoint's own token", async () => {
    const asked: ClusterCompletion[] = [];
    harness = await Harness.start(
      {},
      {
        module: {
          complete: async (_services, request) => {
            asked.push(request);
            return '{"is_song": true}';
          },
        },
      },
    );
    const h = harness;
    const cluster = h.cluster();
    const seen: Array<{ auth: string | undefined; type: string | undefined; body: Buffer }> = [];
    const asrUrl = await httpServer((req, body) => {
      seen.push({ auth: req.headers.authorization, type: req.headers["content-type"], body });
      return { body: JSON.stringify({ text: "heard it" }) };
    });
    const made = approvedHost(cluster, "pc", ["sing", "asr"]);
    const api = new LinkedApi();
    api.services = [
      service({ name: "sing", provides: ["sing"] }),
      service({ name: "asr", provides: ["asr"], url: asrUrl, token: "asr-token" }),
    ];
    const link = new CoreLink(api, {
      url: h.url(),
      hostId: made.id,
      key: made.key,
      name: "pc",
      platform: "linux",
      version: "0.1.0",
      retryInitialMs: 20,
      retryMaxMs: 100,
    });
    links.push(link);
    link.start();
    await waitUntil(() => cluster.registry.pick("asr") !== null, "the report");
    const client = api.client as ClusterClient;

    expect(
      await client.call("cluster.llm", {
        purpose: "fast",
        messages: [
          { role: "system", content: "rules" },
          { role: "user", content: "which song?" },
        ],
        max_tokens: 200,
        json: true,
        service: "sing",
      }),
    ).toEqual({ text: '{"is_song": true}' });
    expect(asked).toEqual([
      {
        purpose: "fast",
        messages: [
          { role: "system", content: "rules" },
          { role: "user", content: "which song?" },
        ],
        max_tokens: 200,
        json: true,
        host: "pc",
        service: "sing",
      },
    ]);

    const form = Buffer.from("--b\r\ncontent of a clip\r\n--b--\r\n");
    const answer = (await client.call("cluster.fetch", {
      capability: "asr",
      method: "POST",
      path: "/asr",
      headers: { "content-type": "multipart/form-data; boundary=b", authorization: "Bearer mine" },
      body: form.toString("base64"),
      service: "sing",
    })) as { status: number; headers: Record<string, string>; body: string };
    expect(answer.status).toBe(200);
    expect(answer.headers["x-extra"]).toBe("1");
    expect(JSON.parse(Buffer.from(answer.body, "base64").toString("utf8"))).toEqual({
      text: "heard it",
    });
    // The endpoint's own token, never the caller's.
    expect(seen).toEqual([
      { auth: "Bearer asr-token", type: "multipart/form-data; boundary=b", body: form },
    ]);
  });
});
