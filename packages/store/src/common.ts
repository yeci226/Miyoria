// Helpers shared by the backends: canonical lookup keys, microsecond timestamps, embeddings.

import {
  type AccountRef,
  type ContextKey,
  isMemoryOrigin,
  type MemoryOrigin,
  type Timestamp,
} from "@miyoria/types";
import type {
  AuthScope,
  CoinCap,
  CoinRule,
  MemoryKind,
  MemoryScope,
  MemorySource,
} from "./records.js";

/** Every failure of a backend (bad input, constraint violations, broken rows). */
export class StoreError extends Error {
  override readonly name = "StoreError";
}

/** Decisions kept per profile by the in-memory backend; older ones are dropped. */
export const MAX_DECISIONS = 10_000;

/** At most this many distinct query tokens are used for a text search. */
export const MAX_QUERY_TOKENS = 64;

export const MEMORY_KINDS: readonly MemoryKind[] = ["episode", "fact", "self_note", "followup"];

// ---- canonical JSON keys ----------------------------------------------------------------
// Rust used `serde_json::to_string` of the value as lookup key (fields in declaration order).
// These rebuild the same text whatever key order the caller's object has.

function canonicalContext(context: ContextKey): ContextKey {
  return {
    platform: context.platform,
    scope: context.scope ?? null,
    channel: context.channel,
    kind: context.kind,
  };
}

function canonicalAccount(account: AccountRef): AccountRef {
  return { platform: account.platform, id: account.id };
}

/** Canonical lookup key of a context. */
export function contextLookupKey(context: ContextKey): string {
  return JSON.stringify(canonicalContext(context));
}

/** Column text of a memory's source (`null` stays `NULL`). */
export function memorySourceJson(source: MemorySource | null): string | null {
  if (source === null) return null;
  return JSON.stringify({
    account: { platform: source.account.platform, id: source.account.id },
    name: source.name,
  });
}

export function canonicalMemoryScope(scope: MemoryScope): MemoryScope {
  switch (scope.type) {
    case "global":
      return { type: "global" };
    case "guild":
      return { type: "guild", platform: scope.platform, guild: scope.guild };
    case "channel":
      return { type: "channel", context: canonicalContext(scope.context) };
    case "dm":
      return { type: "dm", account: canonicalAccount(scope.account) };
    case "person":
      return { type: "person", person: scope.person };
    default:
      throw new StoreError(`unknown memory scope \`${JSON.stringify(scope)}\``);
  }
}

export function memoryScopeKey(scope: MemoryScope): string {
  return JSON.stringify(canonicalMemoryScope(scope));
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

export function memoryKind(kind: string): MemoryKind {
  if ((MEMORY_KINDS as readonly string[]).includes(kind)) return kind as MemoryKind;
  throw new StoreError(`unknown value \`${kind}\``);
}

/** A stored origin; anything else (a newer build's value) reads as `unknown`. */
export function memoryOrigin(value: string): MemoryOrigin {
  return isMemoryOrigin(value) ? value : "unknown";
}

/** The evidence ids of a stored `source_events` array (anything that is not text is dropped). */
export function sourceEvents(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
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
 * dropped (timestamps are stored with PostgreSQL's precision). Also accepts PostgreSQL's text
 * output (`2026-03-10 12:00:00.123456+00`). A missing offset means UTC.
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

/** Saturates at `u32::MAX`, like the Rust records. */
export function u32(n: number): number {
  return Math.min(Math.max(0, n), 4_294_967_295);
}

// ---- embeddings -------------------------------------------------------------------------

/**
 * Validates an embedding for storage or search: empty means "none", and every component must
 * be a finite float32.
 */
export function cleanEmbedding(embedding: readonly number[] | null | undefined): number[] | null {
  if (embedding == null || embedding.length === 0) return null;
  if (!embedding.every((x) => Number.isFinite(Math.fround(x)))) {
    throw new StoreError("embedding contains a non-finite value");
  }
  return [...embedding];
}

/**
 * The shortest decimal that rounds to the same float32, so a stored `0.1` reads back as `0.1`
 * (what Rust's `f32` and pgvector print) instead of `0.10000000149011612`.
 */
export function shortestF32(x: number): number {
  for (let precision = 1; precision < 9; precision++) {
    const candidate = Number(x.toPrecision(precision));
    if (Math.fround(candidate) === x) return candidate;
  }
  return x;
}

export function encodeEmbedding(embedding: readonly number[]): Uint8Array {
  const buffer = new ArrayBuffer(embedding.length * 4);
  const view = new DataView(buffer);
  embedding.forEach((x, i) => {
    view.setFloat32(i * 4, x, true);
  });
  return new Uint8Array(buffer);
}

export function decodeEmbedding(bytes: Uint8Array): Float32Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = new Float32Array(Math.floor(bytes.byteLength / 4));
  for (let i = 0; i < out.length; i++) out[i] = view.getFloat32(i * 4, true);
  return out;
}

export function embeddingFromF32(values: ArrayLike<number>): number[] {
  return Array.from(values, shortestF32);
}

/** The stored float32 values of records whose `embedding` has not been decoded yet. */
interface PendingEmbedding {
  read: () => Float32Array;
  values?: Float32Array;
}
const pendingEmbeddings = new WeakMap<object, PendingEmbedding>();

function pendingValues(pending: PendingEmbedding): Float32Array {
  pending.values ??= pending.read();
  return pending.values;
}

/**
 * Makes `record.embedding` decode on first read instead of with the row. Most reads (lists, the
 * prompt's person lines) never look at it, and `embeddingFromF32` costs about a millisecond per
 * thousand dimensions. The first read or write leaves a plain property; the key keeps its place.
 * `read` gives the stored float32 values, which `embeddingValues` hands out without decoding.
 */
export function lazyEmbedding<T extends { embedding: number[] | null }>(
  record: T,
  read: () => Float32Array,
): T {
  const pending: PendingEmbedding = { read };
  pendingEmbeddings.set(record, pending);
  const settle = (value: number[] | null): number[] | null => {
    pendingEmbeddings.delete(record);
    try {
      Object.defineProperty(record, "embedding", {
        value,
        writable: true,
        enumerable: true,
        configurable: true,
      });
    } catch {
      // A frozen record keeps the accessor; it still returns the decoded value below.
    }
    return value;
  };
  let decoded: number[] | undefined;
  Object.defineProperty(record, "embedding", {
    get: () => {
      decoded ??= embeddingFromF32(pendingValues(pending));
      return settle(decoded);
    },
    set: (value: number[] | null) => {
      settle(value);
    },
    enumerable: true,
    configurable: true,
  });
  return record;
}

/**
 * A record's embedding for arithmetic such as cosine: the stored float32 values while
 * `record.embedding` is still undecoded (so ranking never pays for the shortest-decimal
 * conversion), otherwise `record.embedding` itself. Leaves `record.embedding` undecoded.
 */
export function embeddingValues(record: { embedding: number[] | null }): ArrayLike<number> | null {
  const pending = pendingEmbeddings.get(record);
  if (pending !== undefined) return pendingValues(pending);
  return record.embedding;
}

/** Cosine similarity; 0 when either vector has no length. */
export function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i] as number;
    const y = b[i] as number;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** Search tokens: trimmed, lowercased, non-empty, distinct, sorted, at most 64. */
export function queryTokens(tokens: readonly string[]): string[] {
  const set = new Set(tokens.map((t) => t.trim().toLowerCase()).filter((t) => t.length > 0));
  return [...set].sort().slice(0, MAX_QUERY_TOKENS);
}

// ---- coins ------------------------------------------------------------------------------

/** `accounts` without repeats, with `account` in it. */
export function walletWith(account: AccountRef, accounts: readonly AccountRef[]): AccountRef[] {
  const same = (a: AccountRef, b: AccountRef) => a.platform === b.platform && a.id === b.id;
  const out = accounts.filter((a, i) => accounts.findIndex((b) => same(a, b)) === i);
  if (!out.some((a) => same(a, account))) out.push(account);
  return out;
}

/**
 * The delta a rule lets through: earnings stop at every cap (`partial`: what still fits), `null`
 * when nothing does. `used` sums a cap so far.
 */
export function allowedDelta(
  delta: number,
  rule: CoinRule,
  used: (cap: CoinCap) => number,
): number | null {
  if (delta <= 0) return delta;
  let out = delta;
  for (const cap of rule.caps ?? []) {
    const room = cap.limit - used(cap);
    if (out <= room) continue;
    if (!rule.partial || room <= 0) return null;
    out = room;
  }
  return out;
}

/** `allowedDelta` for a backend whose sums are async. */
export async function allowedDeltaAsync(
  delta: number,
  rule: CoinRule,
  used: (cap: CoinCap) => Promise<number>,
): Promise<number | null> {
  if (delta <= 0) return delta;
  const sums = new Map<CoinCap, number>();
  for (const cap of rule.caps ?? []) sums.set(cap, await used(cap));
  return allowedDelta(delta, rule, (cap) => sums.get(cap) ?? 0);
}
