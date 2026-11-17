// The local API (docs/design/v5-hostd.md §5): `127.0.0.1` on a port the OS picks.
//
//   POST /rpc            one JSON-RPC 2.0 request, one response; with the header
//                        `x-miyoria-stream: lines` the answer is NDJSON: `{"line":"..."}` objects as
//                        the method makes progress (an install), then the JSON-RPC response
//   GET  /logs/<service>?lines=N&follow=1
//                        text lines: the last N, then new ones until the client disconnects
//
// Every request carries `Authorization: Bearer <token>`: the daemon's (the operator) or a running
// service's own.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { HOST_ERROR_CODE } from "@miyoria/contracts/host";
import { type Caller, HostRpcError } from "./api.js";

/** JSON-RPC 2.0 standard error codes. */
export const JSON_RPC = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
} as const;

/** Largest request: a `cluster.fetch` carries up to 8 MiB of body as base64. */
const MAX_BODY = 16 * 1024 * 1024;

export interface LocalApiHandler {
  /** The caller a bearer token stands for, or `null`. */
  authenticate(token: string): Caller | null;
  call(
    method: string,
    params: unknown,
    caller: Caller,
    signal: AbortSignal,
    onLine?: (line: string) => void,
  ): Promise<unknown>;
  hasService(name: string): boolean;
  tailLogs(name: string, lines: number): string[];
  followLogs(name: string, listener: (line: string) => void): () => void;
  /** For the daemon's own log. */
  onError(error: unknown): void;
}

type JsonRpcId = string | number | null;

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
    "cache-control": "no-store",
  });
  res.end(text);
}

function rpcError(id: JsonRpcId, code: number, message: string, data?: unknown) {
  return {
    jsonrpc: "2.0" as const,
    id,
    error: { code, message, ...(data !== undefined ? { data } : {}) },
  };
}

function bearer(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (typeof header !== "string") return null;
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header);
  return match?.[1] ?? null;
}

async function readBody(req: IncomingMessage): Promise<string | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > MAX_BODY) return null;
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function startStream(res: ServerResponse): void {
  res.writeHead(200, {
    "content-type": "application/x-ndjson; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
}

async function handleRpc(
  req: IncomingMessage,
  res: ServerResponse,
  caller: Caller,
  handler: LocalApiHandler,
): Promise<void> {
  const text = await readBody(req);
  if (text === null) {
    sendJson(res, 413, rpcError(null, JSON_RPC.InvalidRequest, "request too large"));
    return;
  }
  let message: unknown;
  try {
    message = JSON.parse(text);
  } catch {
    sendJson(res, 200, rpcError(null, JSON_RPC.ParseError, "parse error"));
    return;
  }
  if (typeof message !== "object" || message === null || Array.isArray(message)) {
    sendJson(res, 200, rpcError(null, JSON_RPC.InvalidRequest, "one request object expected"));
    return;
  }
  const { jsonrpc, id, method, params } = message as Record<string, unknown>;
  const rid: JsonRpcId =
    typeof id === "string" || typeof id === "number" || id === null ? id : null;
  if (jsonrpc !== "2.0" || typeof method !== "string") {
    sendJson(res, 200, rpcError(rid, JSON_RPC.InvalidRequest, "invalid request"));
    return;
  }
  const controller = new AbortController();
  res.on("close", () => {
    if (!res.writableFinished) controller.abort();
  });
  const streaming = req.headers["x-miyoria-stream"] === "lines";
  // A streamed answer is a series of JSON lines; the last one is the JSON-RPC message.
  const send = (status: number, body: unknown) => {
    if (!streaming) {
      sendJson(res, status, body);
      return;
    }
    if (!res.headersSent) startStream(res);
    res.end(`${JSON.stringify(body)}\n`);
  };
  try {
    const result = await handler.call(
      method,
      params ?? {},
      caller,
      controller.signal,
      streaming
        ? (line) => {
            if (!res.headersSent) startStream(res);
            if (!res.writableEnded) res.write(`${JSON.stringify({ line })}\n`);
          }
        : undefined,
    );
    send(200, { jsonrpc: "2.0", id: rid, result: result ?? null });
  } catch (error) {
    if (error instanceof HostRpcError) {
      send(200, rpcError(rid, error.code, error.message, error.data));
      return;
    }
    handler.onError(error);
    send(
      200,
      rpcError(rid, JSON_RPC.InternalError, error instanceof Error ? error.message : String(error)),
    );
  }
}

function handleLogs(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  service: string,
  handler: LocalApiHandler,
): void {
  if (!handler.hasService(service)) {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end(`unknown service ${service}\n`);
    return;
  }
  const asked = Number.parseInt(url.searchParams.get("lines") ?? "100", 10);
  const lines = Number.isFinite(asked) ? Math.min(Math.max(asked, 0), 2000) : 100;
  const follow = ["1", "true", "yes"].includes(url.searchParams.get("follow") ?? "");
  res.writeHead(200, {
    "content-type": "text/plain; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  const tail = lines > 0 ? handler.tailLogs(service, lines) : [];
  if (tail.length > 0) res.write(`${tail.join("\n")}\n`);
  if (!follow) {
    res.end();
    return;
  }
  const unsubscribe = handler.followLogs(service, (line) => {
    res.write(`${line}\n`);
  });
  const done = () => unsubscribe();
  req.on("close", done);
  res.on("close", done);
}

/** The local API server; `listen` is the caller's. */
export function createLocalApi(handler: LocalApiHandler): Server {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const token = bearer(req);
    const caller = token === null ? null : handler.authenticate(token);
    if (caller === null) {
      sendJson(
        res,
        401,
        rpcError(null, HOST_ERROR_CODE.NotAllowed, token === null ? "no token" : "wrong token"),
      );
      return;
    }
    if (url.pathname === "/rpc") {
      if (req.method !== "POST") {
        res.writeHead(405, { allow: "POST" }).end();
        return;
      }
      handleRpc(req, res, caller, handler).catch((error: unknown) => {
        handler.onError(error);
        if (!res.headersSent)
          sendJson(res, 500, rpcError(null, JSON_RPC.InternalError, "internal error"));
        else res.destroy();
      });
      return;
    }
    const logs = /^\/logs\/([^/]+)$/.exec(url.pathname);
    if (logs !== null) {
      if (req.method !== "GET") {
        res.writeHead(405, { allow: "GET" }).end();
        return;
      }
      if (caller.kind !== "operator") {
        sendJson(res, 403, rpcError(null, HOST_ERROR_CODE.NotAllowed, "operator only"));
        return;
      }
      handleLogs(req, res, url, decodeURIComponent(logs[1] as string), handler);
      return;
    }
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end("not found\n");
  });
  // Followed logs keep connections open for a long time.
  server.requestTimeout = 0;
  server.headersTimeout = 10_000;
  return server;
}
