// The arbiter's HTTP calls to the speech services, against small local servers: the descriptor's
// paths, the bodies, the service's token, timeouts, and errors as the arbiter expects them.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import type { Tenant } from "../src/arbiter/index.js";
import { HttpPeerClient, PeerError } from "../src/index.js";

const servers: Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) {
    s.closeAllConnections();
    await new Promise((r) => s.close(() => r(undefined)));
  }
});

interface Seen {
  method: string;
  url: string;
  auth: string | undefined;
  type: string | undefined;
  body: string;
}

function listen(
  handler: (req: IncomingMessage, res: ServerResponse, body: string) => void,
): Promise<{ port: number; seen: Seen[] }> {
  const seen: Seen[] = [];
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => {
        body += c;
      });
      req.on("end", () => {
        seen.push({
          method: req.method ?? "",
          url: req.url ?? "",
          auth: req.headers.authorization,
          type: req.headers["content-type"],
          body,
        });
        handler(req, res, body);
      });
    });
    servers.push(server);
    server.listen(0, "127.0.0.1", () => {
      const a = server.address();
      resolve({ port: typeof a === "object" && a !== null ? a.port : 0, seen });
    });
  });
}

const json = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
};

const tenant: Tenant = {
  name: "tts",
  url: "http://127.0.0.1:8002",
  offload: "/gpu/offload",
  reload: "/gpu/reload",
  busy: "/gpu/busy",
  health: "/healthz",
};

function client(port: number | null) {
  return new HttpPeerClient((name) =>
    port === null || name !== "tts"
      ? null
      : { url: `http://127.0.0.1:${port}/`, headers: { authorization: "Bearer tts-token" } },
  );
}

describe("HttpPeerClient", () => {
  it("calls the descriptor's paths with the bodies and the service's token", async () => {
    const { port, seen } = await listen((req, res) => {
      if (req.url === "/gpu/busy") return json(res, 200, { busy: 2 });
      if (req.url === "/healthz") return json(res, 200, { status: "ok", offloaded: true });
      json(res, 200, { state: req.url === "/gpu/offload" ? "offloaded" : "ready" });
    });
    const peers = client(port);
    expect(await peers.offload(tenant, { reason: "sing", max_s: 60 }, 5)).toEqual({
      state: "offloaded",
    });
    expect(await peers.reload(tenant, 5)).toEqual({ state: "ready" });
    expect(await peers.busy(tenant, 0.5)).toEqual({ busy: 2 });
    expect(await peers.health(tenant, 2)).toEqual({ status: "ok", offloaded: true });
    expect(seen).toEqual([
      {
        method: "POST",
        url: "/gpu/offload",
        auth: "Bearer tts-token",
        type: "application/json",
        body: '{"reason":"sing","max_s":60}',
      },
      {
        method: "POST",
        url: "/gpu/reload",
        auth: "Bearer tts-token",
        type: "application/json",
        body: "{}",
      },
      { method: "GET", url: "/gpu/busy", auth: "Bearer tts-token", type: undefined, body: "" },
      { method: "GET", url: "/healthz", auth: "Bearer tts-token", type: undefined, body: "" },
    ]);
  });

  it("throws on a status that is not 2xx and on a body that is not JSON; other JSON is {}", async () => {
    const { port } = await listen((req, res) => {
      if (req.url === "/gpu/offload") return json(res, 503, { error: "loading" });
      if (req.url === "/gpu/reload") return json(res, 200, "not json");
      json(res, 200, [1, 2]);
    });
    const peers = client(port);
    await expect(peers.offload(tenant, { reason: "sing", max_s: 60 }, 5)).rejects.toThrow(
      /HTTP 503/,
    );
    await expect(peers.reload(tenant, 5)).rejects.toThrow(/not JSON/);
    expect(await peers.busy(tenant, 1)).toEqual({});
  });

  it("gives up after the timeout it is given", async () => {
    const { port } = await listen((_req, res) => {
      setTimeout(() => json(res, 200, { busy: 0 }), 1500);
    });
    const started = Date.now();
    const error = await client(port)
      .busy(tenant, 0.2)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PeerError);
    expect((error as Error).message).toMatch(/no answer within 0.2 s/);
    expect(Date.now() - started).toBeLessThan(1200);
  });

  it("throws for a service that is not running or does not answer", async () => {
    await expect(client(null).health(tenant, 1)).rejects.toThrow(/tts is not running/);
    const { port } = await listen(() => {});
    const closed = servers.pop() as Server;
    await new Promise((r) => closed.close(() => r(undefined)));
    await expect(client(port).health(tenant, 1)).rejects.toBeInstanceOf(PeerError);
  });
});
