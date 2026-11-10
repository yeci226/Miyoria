// What the EventLog says about one turn: what she said and whether it arrived, and what she did.
// A turn is its lines that name it, plus what those lines caused. A Core with the `turn` filter
// hands exactly that over; an older one ignores it and the turn is cut out of a time window.

import type { Api } from "@/api/endpoints";
import type { E2eRecord, LogEvent, Timestamp } from "@/api/types";
import { laneOf, turnOf } from "@/lib/consciousness";
import { asE2eEvent } from "@/lib/e2e";

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** When a ULID was made (its first ten characters), or `null` if it is not one. */
export function ulidTime(id: string): number | null {
  if (id.length !== 26) return null;
  let t = 0;
  for (const ch of id.slice(0, 10).toUpperCase()) {
    const v = CROCKFORD.indexOf(ch);
    if (v < 0) return null;
    t = t * 32 + v;
  }
  return Number.isSafeInteger(t) ? t : null;
}

/** How a line ended: the log's `delivered` or an undelivered `result`, or neither yet. */
export type LineEnd =
  | { state: "delivered"; at: string }
  | { state: "interrupted" | "failed" | "cancelled"; at: string; reason: string | null }
  | { state: "pending" };

export interface TurnLine {
  /** The `utterance` event. */
  line: LogEvent;
  channel: "voice" | "text" | null;
  said: string;
  end: LineEnd;
}

export interface TurnFacts {
  /** What she decided and thought on the way, oldest first. */
  decisions: LogEvent[];
  lines: TurnLine[];
  /** Actions, their results, steers and what the tasks said, oldest first. */
  actions: LogEvent[];
  /** How many lines of the log belong to the turn at all. */
  total: number;
}

/**
 * The log's lines of one turn. Asks for the turn itself; when the answer names no line of it (a
 * Core that does not know `turn` answers with everything), reads `window` and leaves the cutting
 * to `turnFacts`.
 */
export async function fetchTurnEvents(
  api: Pick<Api, "factEvents">,
  turn: string,
  window: { since: Timestamp; until: Timestamp } | null,
  limit: number,
  signal?: AbortSignal,
): Promise<LogEvent[]> {
  const exact = await api.factEvents({ turn, order: "asc", limit }, { signal });
  if (exact.some((e) => turnOf(e) === turn) || window === null) return exact;
  return api.factEvents({ ...window, order: "asc", limit }, { signal });
}

/** The measurement of a turn's reply in its log lines (the newest, if it was measured twice). */
export function turnE2e(events: readonly LogEvent[], turn: string): E2eRecord | null {
  let found: E2eRecord | null = null;
  for (const e of events) {
    if (turnOf(e) !== turn) continue;
    found = asE2eEvent(e) ?? found;
  }
  return found;
}

const rec = (v: unknown): Record<string, unknown> => (v !== null && typeof v === "object" ? (v as Record<string, unknown>) : {});

const byId = (a: LogEvent, b: LogEvent) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** `events` can be in any order and hold other turns' lines. */
export function turnFacts(events: readonly LogEvent[], turn: string): TurnFacts {
  const mine = new Map<string, LogEvent>();
  for (const e of events) if (turnOf(e) === turn) mine.set(e.id, e);
  // What those lines caused, however far down.
  for (let grew = true; grew; ) {
    grew = false;
    for (const e of events) {
      if (!mine.has(e.id) && e.cause !== null && mine.has(e.cause)) {
        mine.set(e.id, e);
        grew = true;
      }
    }
  }
  const all = [...mine.values()].sort(byId);
  const ends = new Map<string, LogEvent>();
  for (const e of all) {
    if ((e.kind === "delivered" || e.kind === "result") && e.cause !== null) ends.set(e.cause, e);
  }
  const lines: TurnLine[] = [];
  for (const e of all) {
    if (e.kind !== "utterance") continue;
    const body = rec(e.body);
    const end = ends.get(e.id);
    const eb = rec(end?.body);
    const state = typeof eb.delivery === "string" ? eb.delivery : null;
    lines.push({
      line: e,
      channel: body.channel === "voice" || body.channel === "text" ? body.channel : null,
      said: typeof body.said === "string" ? body.said : "",
      end:
        end?.kind === "delivered"
          ? { state: "delivered", at: end.at }
          : end && (state === "interrupted" || state === "failed" || state === "cancelled")
            ? { state, at: end.at, reason: typeof eb.reason === "string" ? eb.reason : null }
            : { state: "pending" },
    });
  }
  const isOutcome = (e: LogEvent) => e.kind === "result" && rec(e.body).turn_outcome !== undefined;
  const isMeasure = (e: LogEvent) => e.kind === "result" && asE2eEvent(e) !== null;
  return {
    decisions: all.filter((e) => e.kind === "decision" || e.kind === "thought"),
    lines,
    actions: all.filter((e) => laneOf(e) === 3 && !isOutcome(e) && !isMeasure(e) && !(e.kind === "result" && typeof rec(e.body).delivery === "string")),
    total: all.length,
  };
}
