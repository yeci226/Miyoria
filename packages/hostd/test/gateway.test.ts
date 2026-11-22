// hostd's gateway (v5-hostd §16) on loopback, in front of a small service: who gets in (the
// service's own token for the service, the route token for the probe, the same 401 for anything
// else), what is passed on (the service's own authorization, ranges, the query, WebSocket
// upgrades), what is not (a way out of the service's tree), and the mark on every answer.

import { createServer, type IncomingMessage, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket, { WebSocketServer } from "ws";
import { createGateway, gatewayTarget } from "../src/index.js";

const servers: Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) {
    s.closeAllConnections();
    await new Promise((r) => s.close(() => r(undefined)));
  }
});

function listen(server: Server): Promise<number> {
  servers.push(server);
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port)),
  );
}

/** The service: echoes what it got; `/file` answers ranges; `/ws` is a WebSocket echo. */
async function service(): Promise<{ port: number; seen: IncomingMessage[] }> {
  const seen: IncomingMessage[] = [];
  const server = createServer((req, res) => {
    seen.push(req);
    if (req.url === "/redirect") {
      res.writeHead(302, { location: "http://elsewhere.invalid/" }).end();
      return;
    }
    if ((req.url ?? "").startsWith("/file")) {
      const range = /^bytes=(\d+)-(\d+)$/u.exec(String(req.headers.range ?? ""));
      const body = Buffer.from("0123456789");
      if (range !== null) {
        const from = Number(range[1]);
        const to = Number(range[2]);
        res.writeHead(206, {
          "content-range": `bytes ${from}-${to}/${body.length}`,
          etag: '"v1"',
          connection: "keep-alive",
        });
        res.end(body.subarray(from, to + 1));
        return;
      }
      res.writeHead(200, { etag: '"v1"' }).end(body);
      return;
    }
    let body = "";
    req.on("data", (c: Buffer) => {
      body += c.toString();
    });
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json", "x-service": "yes" });
      res.end(
        JSON.stringify({
          url: req.url,
          method: req.method,
          authorization: req.headers.authorization ?? null,
          body,
        }),
      );
    });
  });
  const wss = new WebSocketServer({ server });
  wss.on("connection", (ws, req) => {
    ws.send(`hello ${req.headers.authorization}`);
    ws.on("message", (data) => ws.send(`echo ${data.toString()}`));
  });
  const port = await listen(server);
  return { port, seen };
}

async function gateway(options: { running?: boolean } = {}) {
  const svc = await service();
  const server = createGateway({
    tls: null,
    host: {
      target: (name) =>
        name === "sing" && options.running !== false
          ? { url: `http://127.0.0.1:${svc.port}`, headers: { authorization: "Bearer inside" } }
          : null,
      tokenOf: (name) => (name === "sing" ? "sing-token" : undefined),
      routeToken: () => "route-token",
    },
  });
  const port = await listen(server);
  return { base: `http://127.0.0.1:${port}`, svc };
}

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

describe("who gets in", () => {
  it("the probe with the route token, with a throughput sample when asked", async () => {
    const { base } = await gateway();
    const ok = await fetch(`${base}/_miyoria/probe`, { headers: auth("route-token") });
    expect(ok.status).toBe(200);
    expect(ok.headers.get("x-miyoria-route")).toBe("gateway");
    expect(await ok.json()).toEqual({ ok: true });
    const sample = await fetch(`${base}/_miyoria/probe?bytes=4096`, {
      headers: auth("route-token"),
    });
    expect((await sample.arrayBuffer()).byteLength).toBe(4096);
    const big = await fetch(`${base}/_miyoria/probe?bytes=9999999`, {
      headers: auth("route-token"),
    });
    expect(big.status).toBe(400);
    // A service's token is not the route token.
    expect((await fetch(`${base}/_miyoria/probe`, { headers: auth("sing-token") })).status).toBe(
      401,
    );
  });

  it("the same 401 for a wrong token, no token, an unknown service and Core", async () => {
    const { base, svc } = await gateway();
    const answers = await Promise.all(
      [
        fetch(`${base}/svc/sing/health`, { headers: auth("wrong") }),
        fetch(`${base}/svc/sing/health`),
        fetch(`${base}/svc/nothing/health`, { headers: auth("sing-token") }),
        fetch(`${base}/svc/core/api/status`, { headers: auth("sing-token") }),
        fetch(`${base}/svc/sing/health`, { headers: auth("route-token") }),
      ].map(async (p) => {
        const r = await p;
        return [r.status, r.headers.get("x-miyoria-route"), await r.text()];
      }),
    );
    for (const a of answers) expect(a).toEqual([401, "gateway", '{"error":"unauthorized"}']);
    expect(svc.seen).toHaveLength(0);
  });

  it("nothing outside the service's tree", () => {
    expect(gatewayTarget("/svc/sing/songs?x=1")).toEqual({ service: "sing", rest: "/songs?x=1" });
    expect(gatewayTarget("/svc/sing")).toEqual({ service: "sing", rest: "/" });
    expect(gatewayTarget("/svc/sing/../core/api")).toBeNull();
    expect(gatewayTarget("/svc/sing/./x")).toBeNull();
    expect(gatewayTarget("/svc/sing//elsewhere")).toBeNull();
    expect(gatewayTarget("/svc/../x")).toBeNull();
    expect(gatewayTarget("/svc/sing/%2e%2e/core")).toBeNull();
    expect(gatewayTarget("/svc/sing/a%2Fb")).toBeNull();
    expect(gatewayTarget("/api/cluster/hosts")).toBeNull();
  });

  it("a stopped service is a 503 of the gateway, after the token", async () => {
    const { base } = await gateway({ running: false });
    const r = await fetch(`${base}/svc/sing/health`, { headers: auth("sing-token") });
    expect(r.status).toBe(503);
    expect(r.headers.get("x-miyoria-route")).toBe("gateway");
  });
});

describe("what is passed on", () => {
  it("the request with the service's own authorization, the query and the body", async () => {
    const { base } = await gateway();
    const r = await fetch(`${base}/svc/sing/jobs?wait=1`, {
      method: "POST",
      headers: { ...auth("sing-token"), "content-type": "application/json" },
      body: '{"q":"song"}',
    });
    expect(r.status).toBe(200);
    expect(r.headers.get("x-service")).toBe("yes");
    expect(r.headers.get("x-miyoria-route")).toBe("gateway");
    expect(await r.json()).toEqual({
      url: "/jobs?wait=1",
      method: "POST",
      authorization: "Bearer inside",
      body: '{"q":"song"}',
    });
  });

  it("ranges both ways, and redirects back without following them", async () => {
    const { base } = await gateway();
    const part = await fetch(`${base}/svc/sing/file`, {
      headers: { ...auth("sing-token"), range: "bytes=2-5", "if-range": '"v1"' },
    });
    expect(part.status).toBe(206);
    expect(part.headers.get("content-range")).toBe("bytes 2-5/10");
    expect(part.headers.get("etag")).toBe('"v1"');
    expect(await part.text()).toBe("2345");
    const moved = await fetch(`${base}/svc/sing/redirect`, {
      headers: auth("sing-token"),
      redirect: "manual",
    });
    expect(moved.status).toBe(302);
    expect(moved.headers.get("location")).toBe("http://elsewhere.invalid/");
  });

  it("WebSocket upgrades, with the service's own authorization", async () => {
    const { base } = await gateway();
    const ws = new WebSocket(`${base.replace("http", "ws")}/svc/sing/ws`, {
      headers: auth("sing-token"),
    });
    const messages: string[] = [];
    await new Promise<void>((resolve, reject) => {
      ws.on("message", (data) => {
        messages.push(data.toString());
        if (messages.length === 1) ws.send("ping");
        else resolve();
      });
      ws.on("error", reject);
    });
    ws.close();
    expect(messages).toEqual(["hello Bearer inside", "echo ping"]);
  });

  it("refuses an upgrade without the token", async () => {
    const { base } = await gateway();
    const status = await new Promise<number>((resolve) => {
      const req = request(`${base}/svc/sing/ws`, {
        headers: { connection: "Upgrade", upgrade: "websocket" },
      });
      req.on("response", (res) => resolve(res.statusCode ?? 0));
      req.on("upgrade", () => resolve(101));
      req.end();
    });
    expect(status).toBe(401);
  });
});
