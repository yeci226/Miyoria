// hostd's gateway (docs/design/v5-hostd.md §16): the one HTTP(S) entry of this machine for the
// `direct` and `tunnel` routes. `<route url>/svc/<service>/<path>` reaches a service of this
// machine, `/_miyoria/probe` answers Core's probes. Nothing else is served.
//
// Every request needs a bearer token: a service's own token for that service (what Core sends to
// a service anyway, which only Core and this daemon know), the route token for the probe. A
// request without the right token gets the same 401 whatever it named, so a stranger learns
// nothing about what runs here. The gateway serves workers only: never Core's own service, never
// a node, so no route can reach Core's API through it.
//
// Requests are passed on with the service's own authorization, hop-by-hop headers removed;
// redirects are passed back, never followed; WebSocket upgrades are passed through. Every answer
// the gateway makes carries `x-miyoria-route: gateway`, so Core can tell it from one made by a
// tunnel's edge or a proxy in between. Tokens are never logged.

import { randomBytes, timingSafeEqual } from "node:crypto";
import {
  createServer as createHttpServer,
  request as httpRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { createServer as createHttpsServer } from "node:https";
import type { Duplex } from "node:stream";
import { HOST_ROUTE } from "@miyoria/contracts/host";

/** What the gateway needs of the daemon. */
export interface GatewayHost {
  /** The service's base URL on this machine and the headers it wants, while it runs. */
  target(service: string): { url: string; headers: Record<string, string> } | null;
  /** The token a request for this service must carry; `undefined`: the gateway does not serve it. */
  tokenOf(service: string): string | undefined;
  /** The token of Core's probes. */
  routeToken(): string;
}

export interface GatewayLogger {
  info(fields: object, message: string): void;
  warn(fields: object, message: string): void;
}

export interface GatewayOptions {
  host: GatewayHost;
  /** PEM contents: the gateway speaks HTTPS itself. `null`: plain HTTP (loopback only). */
  tls: { cert: string | Buffer; key: string | Buffer } | null;
  logger?: GatewayLogger;
}

/** Headers that belong to one connection, not to the request or answer. */
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
  "authorization",
]);

const MARK = { [HOST_ROUTE.GATEWAY_HEADER]: "gateway" } as const;

/** An answer this large or larger is logged with its size and time. */
const LOGGED_BYTES = 1_000_000;

/** The sample bytes of the throughput probe: random, so nothing in between can compress them. */
let SAMPLE: Buffer | null = null;
function sample(): Buffer {
  SAMPLE ??= randomBytes(HOST_ROUTE.MAX_SAMPLE_BYTES);
  return SAMPLE;
}

function bearerOf(headers: IncomingHttpHeaders): string | null {
  const raw = headers.authorization;
  if (typeof raw !== "string") return null;
  const m = /^Bearer\s+(\S+)$/iu.exec(raw.trim());
  return m === null ? null : (m[1] as string);
}

function same(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** `/svc/<name>/<rest>?<query>` → the service and what follows it; `null` for anything else. */
export function gatewayTarget(url: string): { service: string; rest: string } | null {
  if (!url.startsWith(HOST_ROUTE.SERVICE_PREFIX)) return null;
  const after = url.slice(HOST_ROUTE.SERVICE_PREFIX.length);
  const m = /^([A-Za-z0-9][A-Za-z0-9._-]*)(\/[^?#]*)?(\?[^#]*)?$/u.exec(after);
  if (m === null) return null;
  const rest = `${m[2] ?? "/"}${m[3] ?? ""}`;
  // No way out of the service's own tree, not even spelled with escapes.
  const path = m[2] ?? "";
  if (/(^|\/)\.\.?(\/|$)/u.test(path) || /%2e|%2f|%5c|\\/iu.test(path) || rest.startsWith("//")) {
    return null;
  }
  return { service: m[1] as string, rest };
}

function forwardHeaders(
  incoming: IncomingHttpHeaders,
  own: Record<string, string>,
): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  const listed = String(incoming.connection ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s !== "");
  for (const [name, value] of Object.entries(incoming)) {
    if (value === undefined || HOP_BY_HOP.has(name) || listed.includes(name)) continue;
    out[name] = value;
  }
  for (const [name, value] of Object.entries(own)) out[name.toLowerCase()] = value;
  return out;
}

function answerHeaders(incoming: IncomingHttpHeaders): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(incoming)) {
    if (value === undefined || HOP_BY_HOP.has(name)) continue;
    out[name] = value;
  }
  return { ...out, ...MARK };
}

function json(res: ServerResponse, status: number, body: object): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(text),
    "cache-control": "no-store",
    ...MARK,
  });
  res.end(text);
}

const UNAUTHORIZED = { error: "unauthorized" };

/** Who may come in for `url`: the service and its target, the probe, or nobody. */
type Admit =
  | {
      kind: "service";
      service: string;
      rest: string;
      target: { url: string; headers: Record<string, string> };
    }
  | { kind: "probe"; bytes: number }
  | { kind: "stopped"; service: string }
  | { kind: "refused"; status: number };

function admit(host: GatewayHost, req: IncomingMessage): Admit {
  const url = req.url ?? "/";
  const token = bearerOf(req.headers);
  const path = url.split("?")[0] as string;
  if (path === HOST_ROUTE.PROBE_PATH) {
    if (token === null || !same(token, host.routeToken())) return { kind: "refused", status: 401 };
    if (req.method !== "GET" && req.method !== "HEAD") return { kind: "refused", status: 405 };
    const raw = new URL(url, "http://gateway").searchParams.get("bytes");
    const n = raw === null ? 0 : Number(raw);
    if (!Number.isInteger(n) || n < 0 || n > HOST_ROUTE.MAX_SAMPLE_BYTES) {
      return { kind: "refused", status: 400 };
    }
    return { kind: "probe", bytes: n };
  }
  const found = gatewayTarget(url);
  if (found === null) return { kind: "refused", status: token === null ? 401 : 404 };
  const expected = host.tokenOf(found.service);
  if (token === null || expected === undefined || !same(token, expected)) {
    return { kind: "refused", status: 401 };
  }
  const target = host.target(found.service);
  if (target === null) return { kind: "stopped", service: found.service };
  return { kind: "service", service: found.service, rest: found.rest, target };
}

/** The gateway's server: HTTPS with `tls`, else HTTP. Not listening yet. */
export function createGateway(options: GatewayOptions): Server {
  const { host, logger } = options;
  const onRequest = (req: IncomingMessage, res: ServerResponse) => {
    const a = admit(host, req);
    switch (a.kind) {
      case "refused":
        req.resume();
        json(res, a.status, a.status === 401 ? UNAUTHORIZED : { error: "not here" });
        return;
      case "stopped":
        req.resume();
        json(res, 503, { error: `${a.service} is not running` });
        return;
      case "probe": {
        req.resume();
        if (a.bytes === 0) {
          json(res, 200, { ok: true });
          return;
        }
        res.writeHead(200, {
          "content-type": "application/octet-stream",
          "content-length": a.bytes,
          "cache-control": "no-store, no-transform",
          ...MARK,
        });
        res.end(req.method === "HEAD" ? undefined : sample().subarray(0, a.bytes));
        return;
      }
      case "service":
        forward(req, res, a, logger);
        return;
    }
  };
  const server = options.tls
    ? createHttpsServer({ cert: options.tls.cert, key: options.tls.key }, onRequest)
    : createHttpServer(onRequest);
  // Long transfers: only the head has a deadline.
  server.requestTimeout = 0;
  server.headersTimeout = 30_000;
  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) =>
    upgrade(host, req, socket, head, logger),
  );
  server.on("clientError", (_error, socket) => {
    if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
  });
  return server;
}

function forward(
  req: IncomingMessage,
  res: ServerResponse,
  a: Extract<Admit, { kind: "service" }>,
  logger: GatewayLogger | undefined,
): void {
  const base = new URL(a.target.url);
  const started = Date.now();
  const out = httpRequest(
    {
      protocol: base.protocol,
      hostname: base.hostname.replace(/^\[|\]$/gu, ""),
      port: base.port,
      method: req.method,
      path: `${base.pathname.replace(/\/+$/u, "")}${a.rest}`,
      headers: forwardHeaders(req.headers, a.target.headers),
    },
    (answer) => {
      res.writeHead(answer.statusCode ?? 502, answer.statusMessage, answerHeaders(answer.headers));
      let bytes = 0;
      answer.on("data", (chunk: Buffer) => {
        bytes += chunk.byteLength;
      });
      answer.on("end", () => {
        if (bytes < LOGGED_BYTES) return;
        const seconds = Math.max(0.001, (Date.now() - started) / 1000);
        logger?.info(
          {
            service: a.service,
            method: req.method,
            status: answer.statusCode,
            bytes,
            seconds: Math.round(seconds * 10) / 10,
            mb_s: Math.round((bytes / 1e6 / seconds) * 100) / 100,
          },
          "gateway answer sent",
        );
      });
      answer.on("error", () => res.destroy());
      answer.pipe(res);
    },
  );
  out.on("error", (error) => {
    logger?.warn({ service: a.service, err: error.message }, "gateway cannot reach the service");
    if (!res.headersSent) json(res, 502, { error: `${a.service} did not answer` });
    else res.destroy();
  });
  res.on("close", () => {
    if (!res.writableFinished) out.destroy();
  });
  req.on("aborted", () => out.destroy());
  req.pipe(out);
}

function refuseUpgrade(socket: Duplex, status: number, text: string): void {
  if (!socket.writable) return;
  socket.end(
    `HTTP/1.1 ${status} ${text}\r\n${HOST_ROUTE.GATEWAY_HEADER}: gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
  );
}

function upgrade(
  host: GatewayHost,
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  logger: GatewayLogger | undefined,
): void {
  const a = admit(host, req);
  if (a.kind !== "service") {
    if (a.kind === "refused") refuseUpgrade(socket, a.status, "Refused");
    else if (a.kind === "stopped") refuseUpgrade(socket, 503, "Service Unavailable");
    else refuseUpgrade(socket, 400, "Bad Request");
    return;
  }
  const base = new URL(a.target.url);
  const headers = forwardHeaders(req.headers, a.target.headers);
  headers.connection = "Upgrade";
  if (typeof req.headers.upgrade === "string") headers.upgrade = req.headers.upgrade;
  const out = httpRequest({
    protocol: base.protocol,
    hostname: base.hostname.replace(/^\[|\]$/gu, ""),
    port: base.port,
    method: req.method,
    path: `${base.pathname.replace(/\/+$/u, "")}${a.rest}`,
    headers,
  });
  out.on("upgrade", (answer, upstream, upstreamHead) => {
    const lines = [
      `HTTP/1.1 ${answer.statusCode ?? 101} ${answer.statusMessage ?? "Switching Protocols"}`,
    ];
    for (const [name, value] of Object.entries(answer.headers)) {
      if (value === undefined) continue;
      for (const v of Array.isArray(value) ? value : [value]) lines.push(`${name}: ${v}`);
    }
    lines.push(`${HOST_ROUTE.GATEWAY_HEADER}: gateway`);
    socket.write(`${lines.join("\r\n")}\r\n\r\n`);
    if (upstreamHead.byteLength > 0) socket.write(upstreamHead);
    if (head.byteLength > 0) upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
    const end = () => {
      upstream.destroy();
      socket.destroy();
    };
    upstream.on("error", end);
    socket.on("error", end);
    upstream.on("close", end);
    socket.on("close", end);
  });
  out.on("response", (answer) => {
    // The service did not switch protocols: its answer, then the end.
    answer.resume();
    refuseUpgrade(socket, answer.statusCode ?? 502, answer.statusMessage ?? "Bad Gateway");
  });
  out.on("error", (error) => {
    logger?.warn({ service: a.service, err: error.message }, "gateway cannot reach the service");
    refuseUpgrade(socket, 502, "Bad Gateway");
  });
  out.end();
}
