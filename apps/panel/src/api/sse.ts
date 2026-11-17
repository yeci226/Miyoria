// The admin event stream (`GET /api/events`), followed through the route table's typed client:
// oRPC reads the Server-Sent Events, and the request goes through `ApiClient.send` like every
// other call, so it carries the bearer token or the session cookie and the CSRF header
// (`EventSource` could send neither). This file keeps the stream open: it reconnects with backoff
// and says how the connection is doing.

import type { ApiRpc } from "@miyoria/contracts/api";
import { getEventMeta } from "@orpc/client";
import type { BusEnvelope } from "../lib/events";
import { describeError, isApiError } from "./http";

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
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(t);
      resolve();
    }, { once: true });
  });

/** Exponential backoff with jitter: 1 s, 2 s, 4 s … capped. */
export function backoff(attempt: number, maxMs = 30_000): number {
  const base = Math.min(maxMs, 1000 * 2 ** Math.max(0, attempt - 1));
  return Math.round(base * (0.8 + Math.random() * 0.4));
}

/**
 * Follows `GET /api/events` until `signal` aborts, reconnecting with backoff (or after the
 * server's `retry:`), with the last event's id. A 401 or a missing endpoint stops for good
 * (retrying would not help).
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
    try {
      const stream = await rpc.events(
        { query: topics ? { topics } : {} },
        { signal, ...(lastId ? { lastEventId: lastId } : {}) },
      );
      onStatus?.({ state: "open" });
      attempt = 0;
      const stop = () => void stream.return().catch(() => undefined);
      signal.addEventListener("abort", stop, { once: true });
      try {
        for await (const env of stream) {
          const meta = getEventMeta(env);
          if (meta?.retry !== undefined) retry = meta.retry;
          lastId = meta?.id ?? lastId;
          if (isEnvelope(env)) onEnvelope(env);
        }
      } finally {
        signal.removeEventListener("abort", stop);
      }
      error = "串流已中斷";
    } catch (e) {
      if (signal.aborted) break;
      if (isApiError(e) && (e.status === 401 || e.status === 404)) {
        onStatus?.({ state: "closed", error: describeError(e) });
        return;
      }
      error = describeError(e);
    }
    if (signal.aborted) break;
    const inMs = retry ?? backoff(Math.max(1, attempt), opts.maxDelayMs);
    onStatus?.({ state: "retrying", attempt, inMs, error });
    await sleep(inMs, signal);
  }
  onStatus?.({ state: "closed" });
}
