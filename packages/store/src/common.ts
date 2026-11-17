// Helpers shared by the store's tables: canonical lookup keys, microsecond timestamps. The memory
// plugin's (scopes, vectors) are its own (`@miyoria/memory/memory` `stored.ts`).

import type { ContextKey, Timestamp } from "@miyoria/types";
import type { AuthScope } from "./records.js";

/** Every failure of a backend (bad input, constraint violations, broken rows). */
export class StoreError extends Error {
  override readonly name = "StoreError";
}

// ---- canonical JSON keys ----------------------------------------------------------------
// The lookup key is the value's JSON text with fields in declaration order (existing rows use
// it). These rebuild the same text whatever key order the caller's object has.

function canonicalContext(context: ContextKey): ContextKey {
  return {
    platform: context.platform,
    scope: context.scope ?? null,
    channel: context.channel,
    kind: context.kind,
  };
}

export function authScopeKey(scope: AuthScope): string {
  switch (scope.type) {
    case "global":
      return JSON.stringify({ type: "global" });
    case "guild":
      return JSON.stringify({ type: "guild", platform: scope.platform, guild: scope.guild });
    case "channel":
      return JSON.stringify({ type: "channel", context: canonicalContext(scope.context) });
    default:
      throw new StoreError(`unknown auth scope \`${JSON.stringify(scope)}\``);
  }
}

export function parseJson<T>(text: string, what: string): T {
  try {
    return JSON.parse(text) as T;
  } catch (cause) {
    throw new StoreError(`invalid ${what} JSON in database`, { cause });
  }
}

// ---- timestamps -------------------------------------------------------------------------

const RFC3339 =
  /^(\d{4})-(\d{2})-(\d{2})[Tt ](\d{2}):(\d{2}):(\d{2})(?:[.,](\d+))?\s*(Z|z|[+-]\d{2}(?::?\d{2})?)?$/;

/**
 * Microseconds since the Unix epoch of an RFC 3339 timestamp; sub-microsecond digits are
 * dropped (timestamps are stored as integer microseconds). Also accepts a space instead of `T`
 * and a short offset (`2026-03-10 12:00:00.123456+00`). A missing offset means UTC.
 */
export function toMicros(ts: Timestamp): number {
  const m = RFC3339.exec(ts);
  if (!m) throw new StoreError(`invalid timestamp \`${ts}\``);
  const [, y, mo, d, h, mi, s, frac = "", offset = "Z"] = m;
  let ms = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s));
  if (offset !== "Z" && offset !== "z") {
    const sign = offset.startsWith("-") ? -1 : 1;
    const digits = offset.slice(1).replace(":", "");
    const minutes = Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2, 4) || "0");
    ms -= sign * minutes * 60_000;
  }
  if (Number.isNaN(ms)) throw new StoreError(`invalid timestamp \`${ts}\``);
  return ms * 1000 + Number(frac.slice(0, 6).padEnd(6, "0"));
}

/**
 * RFC 3339 UTC text of epoch microseconds: `toISOString()` form, with six fraction digits
 * only when there are sub-millisecond digits (so millisecond timestamps round-trip unchanged).
 */
export function fromMicros(micros: number): Timestamp {
  const ms = Math.floor(micros / 1000);
  const sub = micros - ms * 1000;
  const iso = new Date(ms).toISOString();
  return sub === 0 ? iso : `${iso.slice(0, -1)}${String(sub).padStart(3, "0")}Z`;
}

/** Truncates a timestamp to microseconds and normalizes it to UTC text. */
export function normalizeTimestamp(ts: Timestamp): Timestamp {
  return fromMicros(toMicros(ts));
}

export function optionalMicros(ts: Timestamp | null | undefined): number | null {
  return ts == null ? null : toMicros(ts);
}

export function optionalTimestamp(micros: number | null): Timestamp | null {
  return micros === null ? null : fromMicros(micros);
}

// ---- limits -----------------------------------------------------------------------------

/** A `limit` argument as a non-negative integer, `null` for "no limit" (Infinity). */
export function sqlLimit(limit: number): number | null {
  if (Number.isNaN(limit)) return 0;
  if (!Number.isFinite(limit) || limit >= Number.MAX_SAFE_INTEGER) {
    return limit > 0 ? null : 0;
  }
  return Math.max(0, Math.floor(limit));
}

/** Saturates at 4,294,967,295. */
export function u32(n: number): number {
  return Math.min(Math.max(0, n), 4_294_967_295);
}
