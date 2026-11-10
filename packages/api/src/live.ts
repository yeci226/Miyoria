// The live page's routes (docs/design/v4-plan.md §9.2). The `live` module decides what of her is
// public and counts the pats; this file only carries them.
//
// * `GET /api/public/live`: Server-Sent Events, for anyone. `event:` is the `LiveEvent`'s `type`
//   and `data:` the whole event as JSON, starting with `hello` (the full snapshot). A plain
//   `EventSource` can follow it: it needs no header, and the cookie is not read.
// * `POST /api/member/live/pat` `{}`: a head-pat from the logged-in person, as themselves only.
//
// Both go away with `[modules.api.public] enabled = false`, and answer 503 while the `live` module
// is not running.

import { errorMessage, getLogger } from "@miyoria/kernel";
import { type LiveEvent, type LiveFeed, LiveFeedKey } from "@miyoria/types";
import { z } from "zod";
import { ApiError } from "./errors.js";
import { readJson } from "./extract.js";
import { clientKey, tooMany } from "./public.js";
import { json, param, type Route } from "./route.js";
import type { ApiContext, ApiState } from "./state.js";

const log = getLogger("api.live");

/** Keep-alive comment interval: proxies close a stream that says nothing for long. */
export const LIVE_KEEP_ALIVE_MS = 15_000;
/** How long a page waits before it reconnects (SSE `retry:`). */
export const LIVE_RETRY_MS = 5_000;
/** Streams one client may hold open at once: a few tabs, not a crowd from one address. */
export const LIVE_STREAMS_PER_CLIENT = 4;
/** Events a stream may fall behind by before it is closed: a reader that stopped reading. */
const MAX_BEHIND = 256;

const NOT_RUNNING = "live page is not available";
export const PATS_CLOSED = "摸頭還沒開放";

/** Open streams per client, per running `api` module. */
const streams = new WeakMap<ApiState, Map<string, number>>();

function openStreams(state: ApiState): Map<string, number> {
  let map = streams.get(state);
  if (!map) {
    map = new Map();
    streams.set(state, map);
  }
  return map;
}

function feedOf(state: ApiState): LiveFeed {
  const feed = state.optional(LiveFeedKey);
  if (!feed) throw ApiError.unavailable(NOT_RUNNING);
  return feed;
}

/** One SSE message. */
export function sseMessage(event: LiveEvent): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

const STREAM_HEADERS = {
  "content-type": "text/event-stream; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  // nginx and the like buffer a response unless told otherwise; a feed must not be buffered.
  "x-accel-buffering": "no",
};

/** `GET /api/public/live`. */
function liveStream(state: ApiState, c: ApiContext): Response {
  const feed = feedOf(state);
  const client = clientKey(c);
  const wait = state.publicSide.admit(client);
  if (wait !== null) return tooMany(wait);
  if (c.req.method === "HEAD") return new Response(null, { status: 200, headers: STREAM_HEADERS });
  const open = openStreams(state);
  if ((open.get(client) ?? 0) >= LIVE_STREAMS_PER_CLIENT) return tooMany(LIVE_RETRY_MS);

  const encoder = new TextEncoder();
  const requestSignal = c.req.raw.signal;
  let unfollow: (() => void) | null = null;
  let keepAlive: ReturnType<typeof setInterval> | undefined;
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    unfollow?.();
    clearInterval(keepAlive);
    requestSignal.removeEventListener("abort", finish);
    const left = (open.get(client) ?? 1) - 1;
    if (left <= 0) open.delete(client);
    else open.set(client, left);
  };
  let full = false;
  const stream = new ReadableStream<Uint8Array>({
    // Runs inside the constructor, so `full` is known before the response is.
    start(controller) {
      const push = (text: string) => {
        if (done) return;
        if ((controller.desiredSize ?? 0) < -MAX_BEHIND) {
          finish();
          controller.close();
          return;
        }
        try {
          controller.enqueue(encoder.encode(text));
        } catch {
          finish();
        }
      };
      unfollow = feed.follow((event) => push(sseMessage(event)));
      if (unfollow === null) {
        full = true;
        return;
      }
      open.set(client, (open.get(client) ?? 0) + 1);
      push(`retry: ${LIVE_RETRY_MS}\n\n`);
      push(sseMessage({ type: "hello", snapshot: feed.snapshot() }));
      keepAlive = setInterval(() => push(":\n\n"), LIVE_KEEP_ALIVE_MS);
      requestSignal.addEventListener("abort", finish, { once: true });
    },
    cancel() {
      finish();
    },
  });
  if (full) {
    void stream.cancel().catch(() => undefined);
    return new ApiError(503, "too many people are watching; try again soon").toResponse();
  }
  return new Response(stream, { status: 200, headers: STREAM_HEADERS });
}

/**
 * Empty, or where on the picture (both coordinates, 0..1): the session says who pats, nothing in
 * the request can.
 */
const Unit = z.number().finite().min(0).max(1);
const PatSchema = z.union([z.object({}).strict(), z.object({ x: Unit, y: Unit }).strict()]);

// ---- her picture ------------------------------------------------------------------------------

/** What a file of the picture may be called: no dots first, no slashes, a media extension. */
const VIDEO_FILE = /^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,127}$/;
const VIDEO_EXTENSIONS = new Set(["m3u8", "mp4", "m4s", "ts", "aac"]);
/** The only query parameters LL-HLS needs, and what they may hold. */
const VIDEO_QUERY: Readonly<Record<string, RegExp>> = {
  _HLS_msn: /^\d{1,9}$/,
  _HLS_part: /^\d{1,9}$/,
  _HLS_skip: /^(YES|v2)$/,
};
/** Proxied requests one client may have running at once; LL-HLS asks for several parts a second. */
export const VIDEO_PER_CLIENT = 6;
/** Per viewer allowed, for everyone together. */
export const VIDEO_PER_VIEWER = 3;
/** A blocking playlist reload holds for a few seconds; nothing upstream may hold longer. */
export const VIDEO_UPSTREAM_MS = 20_000;

const videoBusy = new WeakMap<ApiState, { total: number; clients: Map<string, number> }>();

function busyOf(state: ApiState): { total: number; clients: Map<string, number> } {
  let busy = videoBusy.get(state);
  if (!busy) {
    busy = { total: 0, clients: new Map() };
    videoBusy.set(state, busy);
  }
  return busy;
}

/** The upstream URL of `file` with the query the proxy lets through, or `null` for a bad name. */
export function videoUrl(base: string, file: string, search: URLSearchParams): string | null {
  if (!VIDEO_FILE.test(file) || file.includes("..")) return null;
  const extension = file.slice(file.lastIndexOf(".") + 1).toLowerCase();
  if (!file.includes(".") || !VIDEO_EXTENSIONS.has(extension)) return null;
  const query = new URLSearchParams();
  for (const [name, pattern] of Object.entries(VIDEO_QUERY)) {
    const value = search.get(name);
    if (value !== null && pattern.test(value)) query.set(name, value);
  }
  const text = query.toString();
  return `${base}${file}${text === "" ? "" : `?${text}`}`;
}

/** `GET|HEAD /api/public/live/video/:file`: her picture from MediaMTX, carried as it is. */
async function video(state: ApiState, c: ApiContext): Promise<Response> {
  const info = feedOf(state).video();
  if (info === null || !info.on) throw ApiError.notFound("no picture");
  const url = videoUrl(info.upstream, param(c, "file"), new URL(c.req.url).searchParams);
  if (url === null) throw ApiError.notFound("no such file");

  const busy = busyOf(state);
  const client = clientKey(c);
  const mine = busy.clients.get(client) ?? 0;
  if (mine >= VIDEO_PER_CLIENT || busy.total >= info.max_viewers * VIDEO_PER_VIEWER) {
    return tooMany(1_000);
  }
  busy.total += 1;
  busy.clients.set(client, mine + 1);
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    busy.total -= 1;
    const left = (busy.clients.get(client) ?? 1) - 1;
    if (left <= 0) busy.clients.delete(client);
    else busy.clients.set(client, left);
  };

  let upstream: Response;
  try {
    const headers: Record<string, string> = { authorization: `Bearer ${info.secret}` };
    const accept = c.req.header("accept");
    if (accept) headers.accept = accept.slice(0, 200);
    upstream = await fetch(url, {
      method: c.req.method === "HEAD" ? "HEAD" : "GET",
      headers,
      redirect: "manual",
      signal: AbortSignal.any([c.req.raw.signal, AbortSignal.timeout(VIDEO_UPSTREAM_MS)]),
    });
  } catch {
    release();
    return new ApiError(502, "the picture is not reachable").toResponse();
  }
  if (!upstream.ok) {
    release();
    await upstream.body?.cancel().catch(() => undefined);
    // A 404 stays one; whatever else went wrong upstream (a refused secret, a redirect) is ours.
    if (upstream.status === 404) throw ApiError.notFound("no such file");
    return new ApiError(502, "the picture is not available").toResponse();
  }
  const headers = new Headers({ "x-content-type-options": "nosniff" });
  for (const name of ["content-type", "cache-control", "content-length"]) {
    const value = upstream.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  if (c.req.method === "HEAD" || upstream.body === null) {
    release();
    await upstream.body?.cancel().catch(() => undefined);
    return new Response(null, { status: 200, headers });
  }
  const reader = upstream.body.getReader();
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { value, done } = await reader.read();
        if (done) {
          release();
          controller.close();
        } else controller.enqueue(value);
      } catch (error) {
        release();
        controller.error(error);
      }
    },
    cancel(reason) {
      release();
      return reader.cancel(reason).catch(() => undefined);
    },
  });
  return new Response(body, { status: 200, headers });
}

/** `POST /api/member/live/pat`. */
async function pat(state: ApiState, c: ApiContext): Promise<Response> {
  const session = c.get("member");
  const body = await readJson(c, PatSchema);
  const feed = feedOf(state);
  const spot = "x" in body ? { x: body.x, y: body.y } : undefined;
  let outcome: Awaited<ReturnType<LiveFeed["pat"]>>;
  try {
    outcome = await feed.pat({
      account: session.account,
      name: session.name,
      ...(spot ? { spot } : {}),
    });
  } catch (error) {
    log.warn({ error: errorMessage(error) }, "a pat failed");
    throw ApiError.unavailable(NOT_RUNNING);
  }
  if (outcome.status === "closed") throw new ApiError(403, PATS_CLOSED);
  if (outcome.status === "too_many") return tooMany(outcome.wait_ms);
  return json({ pats: outcome.pats });
}

/** The live page's routes; none when `[modules.api.public] enabled` is off. */
export function liveRoutes(state: ApiState): Route[] {
  if (!state.publicSide.config.enabled) return [];
  return [
    {
      method: "GET",
      path: "/api/public/live",
      public: true,
      handler: (c) => liveStream(state, c),
    },
    {
      method: "GET",
      path: "/api/public/live/video/:file",
      public: true,
      handler: (c) => video(state, c),
    },
    { method: "POST", path: "/api/member/live/pat", member: true, handler: (c) => pat(state, c) },
  ];
}
