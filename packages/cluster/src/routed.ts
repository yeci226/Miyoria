// A request to a service of a host with routes (docs/design/v5-hostd.md §16): over the best route
// for the work, and over the next one when a route fails and sending again is safe.
//
// Safe to send again: the request never left (the connection was refused, the name did not
// resolve, the relay refused before sending, a tunnel's edge answered for a gateway that is down),
// or its method is idempotent (GET, HEAD, OPTIONS, PUT, DELETE); and in both cases a body that can
// be sent twice (not a stream). Anything else fails with the route's error and the caller's own
// failover applies, exactly as before (a song's submit is never sent twice).
//
// A download (`GET` answered 200 or 206 with a validator, a known length and byte ranges) is
// resumable: when its body breaks, the rest is asked for with `range` and `if-range` from the
// byte where it stopped, over the next route, and the caller reads one unbroken body. Over a route
// with a body limit (a tunnel) it travels in ranges under the limit from the start. A file that
// changed in between (the validator no longer matches) fails the body; nothing is mixed.

import { HOST_ROUTE } from "@miyoria/contracts/host";
import type { RouteChoice, RouteTable, RouteWork } from "./routes.js";
import { ClusterError } from "./tables.js";

/** The part of an endpoint a routed request needs. */
export interface RoutedEndpoint {
  host: string;
  service: string;
  capability: string;
  headers: Record<string, string>;
}

export interface RoutedDeps {
  table: RouteTable;
  /** For `tailnet`, `direct` and `tunnel` routes. */
  fetch: typeof fetch;
  /** For the relay; `null` while there is none. */
  relay(endpoint: RoutedEndpoint, path: string, init: RequestInit): Promise<Response> | null;
  now(): number;
}

/** No route took the request. `sent: false`: nothing reached the host. */
export class RouteError extends ClusterError {
  override name = "RouteError";
  readonly sent: boolean;

  constructor(message: string, options: { cause?: unknown; sent?: boolean } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.sent = options.sent ?? true;
  }
}

/** A resumed download found the file changed. */
export class TransferChangedError extends ClusterError {
  override name = "TransferChangedError";
}

const IDEMPOTENT = new Set(["GET", "HEAD", "OPTIONS", "PUT", "DELETE"]);

/** Errors of a connection that never opened: the request was not sent. */
const NOT_CONNECTED = new Set([
  "ECONNREFUSED",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EHOSTDOWN",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EADDRNOTAVAIL",
  "UND_ERR_CONNECT_TIMEOUT",
]);

/** Whether a failed request never left Core (looks through `cause` and `AggregateError`s). */
export function neverSent(error: unknown, depth = 0): boolean {
  if (depth > 4 || typeof error !== "object" || error === null) return false;
  const e = error as { code?: unknown; cause?: unknown; errors?: unknown; name?: unknown };
  if (e.name === "RelayUnavailableError") return true;
  if (
    (e.name === "RelayError" || e.name === "RouteError") &&
    (e as { sent?: unknown }).sent === false
  ) {
    return true;
  }
  if (typeof e.code === "string" && NOT_CONNECTED.has(e.code)) return true;
  if (Array.isArray(e.errors) && e.errors.length > 0) {
    return e.errors.every((inner) => neverSent(inner, depth + 1));
  }
  return neverSent(e.cause, depth + 1);
}

/** A body's size (`null`: unknown) and whether it can be sent twice. */
export function bodyOf(body: RequestInit["body"]): { bytes: number | null; replayable: boolean } {
  if (body === undefined || body === null) return { bytes: 0, replayable: true };
  if (typeof body === "string") return { bytes: Buffer.byteLength(body), replayable: true };
  if (body instanceof ArrayBuffer) return { bytes: body.byteLength, replayable: true };
  if (ArrayBuffer.isView(body)) return { bytes: body.byteLength, replayable: true };
  if (typeof Blob !== "undefined" && body instanceof Blob) {
    return { bytes: body.size, replayable: true };
  }
  if (body instanceof URLSearchParams) {
    return { bytes: Buffer.byteLength(body.toString()), replayable: true };
  }
  if (typeof FormData !== "undefined" && body instanceof FormData) {
    return { bytes: null, replayable: true };
  }
  return { bytes: null, replayable: false };
}

function join(url: string, path: string): string {
  if (path === "") return url;
  return `${url.replace(/\/+$/u, "")}/${path.replace(/^\/+/u, "")}`;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The endpoint's headers under the caller's, then `over`: the caller's win over the endpoint's. */
function headersOf(
  base: Record<string, string>,
  own: RequestInit["headers"],
  over: Record<string, string | null> = {},
): Headers {
  const headers = new Headers(base);
  if (own !== undefined) for (const [name, value] of new Headers(own)) headers.set(name, value);
  for (const [name, value] of Object.entries(over)) {
    if (value === null) headers.delete(name);
    else headers.set(name, value);
  }
  return headers;
}

interface Sent {
  response: Response;
  choice: RouteChoice;
  started: number;
}

/**
 * One request over the best route that takes it, then the next while the failure allows another
 * try. Marks each route it used good or bad. `over` changes headers for this attempt.
 */
async function attempt(
  deps: RoutedDeps,
  endpoint: RoutedEndpoint,
  path: string,
  init: RequestInit,
  work: RouteWork,
  over: Record<string, string | null> = {},
): Promise<Sent> {
  const { table } = deps;
  const body = bodyOf(init.body);
  const method = (init.method ?? "GET").toUpperCase();
  const plan = table.plan(endpoint.host, endpoint.service, work, { bytes: body.bytes });
  if (plan.length === 0) {
    throw new RouteError(
      `no route of \`${endpoint.host}\` takes this request to \`${endpoint.service}\``,
      { sent: false },
    );
  }
  let last: unknown = null;
  for (const [i, choice] of plan.entries()) {
    // A body that cannot be sent twice gets one try.
    if (i > 0 && !body.replayable) break;
    const { route } = choice;
    const started = deps.now();
    let response: Response;
    try {
      if (choice.url === null) {
        const relayed = deps.relay(endpoint, path, {
          ...init,
          headers: headersOf({}, init.headers, over),
        });
        if (relayed === null) {
          throw new RouteError("the cluster module's relay is not running", { sent: false });
        }
        response = await relayed;
      } else {
        response = await deps.fetch(join(choice.url, path), {
          ...init,
          headers: headersOf(endpoint.headers, init.headers, over),
          redirect: "manual",
        });
      }
    } catch (error) {
      if (init.signal?.aborted) throw error;
      table.failed(endpoint.host, route.name, messageOf(error));
      last = error;
      if (!neverSent(error) && !IDEMPOTENT.has(method)) throw error;
      continue;
    }
    const viaGateway = route.kind === "direct" || route.kind === "tunnel";
    if (viaGateway && response.headers.get(HOST_ROUTE.GATEWAY_HEADER) !== "gateway") {
      // Something in between answered: the gateway did not (Cloudflare's 502 or 530 while the
      // tunnel is down). 524 is the edge's timeout of an answer the gateway was still making.
      table.failed(endpoint.host, route.name, `中間的服務回了 HTTP ${response.status}`);
      if (response.status === 524 || i === plan.length - 1) return { response, choice, started };
      await response.body?.cancel().catch(() => undefined);
      last = new RouteError(
        `${route.name} answered HTTP ${response.status} without the gateway behind it`,
        { sent: false },
      );
      continue;
    }
    table.ok(endpoint.host, route.name);
    return { response, choice, started };
  }
  throw last ?? new RouteError("no route answered", { sent: false });
}

/** A response whose body, read to its end, is a sample of the route; a broken body marks it bad. */
function watched(deps: RoutedDeps, endpoint: RoutedEndpoint, sent: Sent): Response {
  const { response, choice } = sent;
  const body = response.body;
  if (body === null) return response;
  const headAt = deps.now();
  let bytes = 0;
  const reader = body.getReader();
  const stream = new ReadableStream<Uint8Array>({
    pull: async (controller) => {
      try {
        const next = await reader.read();
        if (next.done) {
          if (bytes >= 1024 * 1024) {
            deps.table.sample(endpoint.host, choice.route.name, bytes, deps.now() - headAt);
          }
          controller.close();
          return;
        }
        bytes += next.value.byteLength;
        controller.enqueue(next.value);
      } catch (error) {
        deps.table.failed(endpoint.host, choice.route.name, `傳到一半斷了:${messageOf(error)}`);
        controller.error(error);
      }
    },
    cancel: (reason) => reader.cancel(reason),
  });
  return new Response(stream, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

/** `bytes=N-` → N; `null` for no header; `-1` for a range this layer does not continue. */
function openRange(header: string | null): number | null {
  if (header === null) return null;
  const m = /^bytes=(\d+)-$/u.exec(header.trim());
  return m === null ? -1 : Number(m[1]);
}

/** `bytes a-b/total` → its numbers; `null` when unreadable or the total is unknown. */
function contentRange(header: string | null): { from: number; to: number; total: number } | null {
  const m = /^bytes\s+(\d+)-(\d+)\/(\d+)$/u.exec((header ?? "").trim());
  return m === null ? null : { from: Number(m[1]), to: Number(m[2]), total: Number(m[3]) };
}

/** Attempts a download may take in all, the first one included, before it fails. */
const MAX_ATTEMPTS = 5;
/** Kept under a body limit, for headers and framing. */
const LIMIT_MARGIN = 64 * 1024;

/**
 * A request to a host with routes. `GET` downloads are resumable (see the head of this file);
 * everything else is one `attempt` with its failover.
 */
export async function routedRequest(
  deps: RoutedDeps,
  endpoint: RoutedEndpoint,
  path: string,
  init: RequestInit,
  work: RouteWork,
): Promise<Response> {
  const method = (init.method ?? "GET").toUpperCase();
  const asked = openRange(new Headers(init.headers).get("range"));
  if (method !== "GET" || asked === -1) {
    return watched(deps, endpoint, await attempt(deps, endpoint, path, init, work));
  }
  const start = asked ?? 0;
  const chunkFor = (choice: RouteChoice | undefined): number | null => {
    const limit = choice?.route.maxBodyBytes ?? null;
    if (limit === null) return null;
    const wanted = Math.floor(deps.table.config.chunk_mb * 1024 * 1024);
    const room = limit > 2 * LIMIT_MARGIN ? limit - LIMIT_MARGIN : Math.floor(limit / 2);
    return Math.max(1, Math.min(wanted, room));
  };
  const firstChoice = deps.table.plan(endpoint.host, endpoint.service, work)[0];
  const firstChunk = chunkFor(firstChoice);
  const first = await attempt(
    deps,
    endpoint,
    path,
    init,
    work,
    firstChunk === null ? {} : { range: `bytes=${start}-${start + firstChunk - 1}` },
  );
  const res = first.response;
  const validator = res.headers.get("etag") ?? res.headers.get("last-modified");
  let total: number | null = null;
  let offset: number;
  if (res.status === 206) {
    const range = contentRange(res.headers.get("content-range"));
    if (range === null || range.from !== start) return watched(deps, endpoint, first);
    total = range.total;
    offset = range.from;
  } else if (res.status === 200 && start === 0) {
    const length = res.headers.get("content-length");
    total = length !== null && /^\d+$/u.test(length.trim()) ? Number(length.trim()) : null;
    offset = 0;
    // A 200 can only be continued when the service said it takes ranges.
    if ((res.headers.get("accept-ranges") ?? "").toLowerCase() !== "bytes") total = null;
  } else {
    return watched(deps, endpoint, first);
  }
  if (validator === null || total === null || res.body === null) {
    return watched(deps, endpoint, first);
  }
  const end = total;
  const tag = validator;
  let current: Sent = first;
  let reader = res.body.getReader();
  let partStart = deps.now();
  let partBytes = 0;
  let attempts = 1;
  const signal = init.signal ?? undefined;

  const next = async (): Promise<void> => {
    for (;;) {
      if (signal?.aborted) throw signal.reason;
      attempts += 1;
      if (attempts > MAX_ATTEMPTS) {
        throw new RouteError(
          `the download from \`${endpoint.host}\` broke ${MAX_ATTEMPTS - 1} times at byte ${offset} of ${end}`,
        );
      }
      const choice = deps.table.plan(endpoint.host, endpoint.service, work)[0];
      const chunk = chunkFor(choice);
      const last = chunk === null ? "" : `${Math.min(end, offset + chunk) - 1}`;
      let sent: Sent;
      try {
        sent = await attempt(deps, endpoint, path, init, work, {
          range: `bytes=${offset}-${last}`,
          "if-range": tag,
        });
      } catch (error) {
        if (signal?.aborted) throw error;
        continue;
      }
      const r = sent.response;
      const range = r.status === 206 ? contentRange(r.headers.get("content-range")) : null;
      if (range === null || range.from !== offset || range.total !== end || r.body === null) {
        await r.body?.cancel().catch(() => undefined);
        throw new TransferChangedError(
          `the file at \`${endpoint.service}\` on \`${endpoint.host}\` changed while it was being fetched (HTTP ${r.status})`,
        );
      }
      current = sent;
      reader = r.body.getReader();
      partStart = deps.now();
      partBytes = 0;
      return;
    }
  };

  const stream = new ReadableStream<Uint8Array>({
    pull: async (controller) => {
      for (;;) {
        let chunk: Awaited<ReturnType<ReadableStreamDefaultReader<Uint8Array>["read"]>>;
        try {
          chunk = await reader.read();
        } catch (error) {
          if (signal?.aborted) {
            controller.error(error);
            return;
          }
          deps.table.failed(
            endpoint.host,
            current.choice.route.name,
            `傳到一半斷了:${messageOf(error)}`,
          );
          try {
            await next();
          } catch (failure) {
            controller.error(failure);
            return;
          }
          continue;
        }
        if (!chunk.done) {
          offset += chunk.value.byteLength;
          partBytes += chunk.value.byteLength;
          if (offset > end) {
            controller.error(
              new RouteError(`more than ${end} bytes came from \`${endpoint.host}\``),
            );
            return;
          }
          controller.enqueue(chunk.value);
          return;
        }
        if (partBytes >= 1024 * 1024) {
          deps.table.sample(
            endpoint.host,
            current.choice.route.name,
            partBytes,
            deps.now() - partStart,
          );
        }
        if (offset >= end) {
          controller.close();
          return;
        }
        // The part ended: a range under the limit, or a body that ended short.
        try {
          await next();
        } catch (failure) {
          controller.error(failure);
          return;
        }
      }
    },
    cancel: (reason) => reader.cancel(reason),
  });
  const headers = new Headers(res.headers);
  headers.delete("content-range");
  headers.set("content-length", String(end - start));
  if (asked !== null) headers.set("content-range", `bytes ${start}-${end - 1}/${end}`);
  return new Response(stream, {
    status: asked !== null ? 206 : 200,
    statusText: asked !== null ? "Partial Content" : "OK",
    headers,
  });
}
