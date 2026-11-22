// The admin event stream (`GET /api/events`), followed through the route table's typed client:
// oRPC reads the Server-Sent Events, and the request goes through `ApiClient.send` like every
// other call, so it carries the bearer token or the session cookie and the CSRF header
// (`EventSource` could send neither). This file keeps the stream open: it reconnects with backoff
// and says how the connection is doing.

import type { ApiRpc } from "@miyoria/contracts/api";
import { getEventMeta } from "@orpc/client";
import type { BusEnvelope } from "../lib/events";
import { describeError, isApiError } from "./http";
import { type Death, watchdog } from "./watchdog";

/** Whether a streamed value is a bus envelope at all (a Core of another version may differ). */
function isEnvelope(value: unknown): value is BusEnvelope {
  const v = value as Partial<BusEnvelope> | null;
  return typeof v === "object" && v !== null && typeof v.id === "string" && typeof v.at === "string" && typeof v.type === "string";
}

export type StreamStatus =
  | { state: "connecting"; attempt: number }
  | { state: "open" }
  | { state: "retrying"; attempt: number; inMs: number; error: string }
  | { state: "closed"; error?: string };

export interface StreamOptions {
  /** Topic patterns, e.g. `["agent.*", "voice.*"]`; empty = everything. */
  topics?: string[];
  onEnvelope: (env: BusEnvelope) => void;
  onStatus?: (status: StreamStatus) => void;
  signal: AbortSignal;
  /** Backoff cap. */
  maxDelayMs?: number;
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(t);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const t = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });

/** A stream that stayed open this long counts as working: the next reconnect starts over. */
const STABLE_MS = 10_000;

/** Exponential backoff with jitter: 1 s, 2 s, 4 s … capped. */
export function backoff(attempt: number, maxMs = 30_000): number {
  const base = Math.min(maxMs, 1000 * 2 ** Math.max(0, attempt - 1));
  return Math.round(base * (0.8 + Math.random() * 0.4));
}

/**
 * Follows `GET /api/events` until `signal` aborts, reconnecting with backoff (or after the
 * server's `retry:`), with the last event's id. A 401 or a missing endpoint stops for good
 * (retrying would not help). A stream silent for `SILENT_MS` (`watchdog.ts`) is dead and is
 * reconnected like a broken one; after the page slept it is reconnected once, at once. The stream
 * itself is unchanged: its other readers (the CLI, extensions) see no new kind of event.
 */
export async function streamEvents(rpc: ApiRpc, opts: StreamOptions): Promise<void> {
  const { signal, onEnvelope, onStatus } = opts;
  const topics = opts.topics?.filter(Boolean).join(",");
  let attempt = 0;
  let lastId: string | undefined;

  while (!signal.aborted) {
    attempt += 1;
    onStatus?.({ state: "connecting", attempt });
    let retry: number | undefined;
    let error: string;
    let openedAt: number | null = null;
    // Silence (not even the 15 s comment, seen as bytes) for `SILENT_MS`: dead, whatever the socket says.
    const inner = new AbortController();
    const both = AbortSignal.any([signal, inner.signal]);
    let death: Death | null = null;
    const dog = watchdog((why) => {
      death = why;
      inner.abort();
    });
    try {
      const stream = await rpc.events(
        { query: topics ? { topics } : {} },
        { signal: both, context: { onActivity: dog.seen }, ...(lastId ? { lastEventId: lastId } : {}) },
      );
      onStatus?.({ state: "open" });
      openedAt = Date.now();
      const stop = () => void stream.return().catch(() => undefined);
      both.addEventListener("abort", stop, { once: true });
      try {
        for await (const env of stream) {
          dog.seen();
          const meta = getEventMeta(env);
          if (meta?.retry !== undefined) retry = meta.retry;
          lastId = meta?.id ?? lastId;
          if (isEnvelope(env)) onEnvelope(env);
        }
      } finally {
        both.removeEventListener("abort", stop);
      }
      error = "串流已中斷";
    } catch (e) {
      if (signal.aborted) break;
      if (death === null && isApiError(e) && (e.status === 401 || e.status === 404)) {
        onStatus?.({ state: "closed", error: describeError(e) });
        return;
      }
      error = describeError(e);
    } finally {
      dog.stop();
    }
    if (signal.aborted) break;
    if (death === "asleep") {
      // The page slept: reconnect once, now, as a fresh start (no backoff, no storm).
      attempt = 0;
      onStatus?.({ state: "retrying", attempt: 1, inMs: 0, error: "重新連線" });
      continue;
    }
    if (death === "silent") error = "串流沒有回應";
    // A stream that is closed as soon as it opens backs off like one that never opens.
    if (openedAt !== null && Date.now() - openedAt >= STABLE_MS) attempt = 0;
    const inMs = retry ?? backoff(Math.max(1, attempt), opts.maxDelayMs);
    onStatus?.({ state: "retrying", attempt, inMs, error });
    await sleep(inMs, signal);
  }
  onStatus?.({ state: "closed" });
}
