// How a memory record is stored (`tables.ts`): the canonical JSON text of its scope, context and
// source (the lookup keys rows are matched by), its float32 vector and the late decoding of it.

import type { MemoryKind, MemoryScope, MemorySource } from "@miyoria/store";
import { StoreError } from "@miyoria/store";
import {
  type AccountRef,
  type ContextKey,
  isMemoryOrigin,
  type MemoryOrigin,
} from "@miyoria/types";

/** At most this many distinct query tokens are used for a text search. */
export const MAX_QUERY_TOKENS = 64;

export const MEMORY_KINDS: readonly MemoryKind[] = ["episode", "fact", "self_note", "followup"];

// ---- canonical JSON keys ----------------------------------------------------------------
// The lookup key is the value's JSON text with fields in declaration order. These rebuild the same
// text whatever key order the caller's object has.

/** A context with its fields in declaration order. */
export function canonicalContext(context: ContextKey): ContextKey {
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

/** A memory's source with its fields in declaration order (`null` stays `null`). */
export function canonicalSource(source: MemorySource | null): MemorySource | null {
  if (source === null) return null;
  return { account: canonicalAccount(source.account), name: source.name };
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

/** Search tokens: trimmed, lowercased, non-empty, distinct, sorted, at most 64. */
export function queryTokens(tokens: readonly string[]): string[] {
  const set = new Set(tokens.map((t) => t.trim().toLowerCase()).filter((t) => t.length > 0));
  return [...set].sort().slice(0, MAX_QUERY_TOKENS);
}

/** An FTS5 query string matching any of the tokens (each one a quoted phrase). */
export function ftsMatch(tokens: readonly string[]): string {
  return tokens.map((t) => `"${t.replaceAll('"', '""')}"`).join(" OR ");
}

/** A `limit` argument as a non-negative integer, `null` for "no limit" (Infinity). */
export function sqlLimit(limit: number): number | null {
  if (Number.isNaN(limit)) return 0;
  if (!Number.isFinite(limit) || limit >= Number.MAX_SAFE_INTEGER) {
    return limit > 0 ? null : 0;
  }
  return Math.max(0, Math.floor(limit));
}

/** `null` limits are "no limit", SQLite's `LIMIT -1`. */
export function limitParam(limit: number): number {
  return sqlLimit(limit) ?? -1;
}

/** Saturates at 4,294,967,295. */
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
 * instead of `0.10000000149011612`.
 */
export function shortestF32(x: number): number {
  for (let precision = 1; precision < 9; precision++) {
    const candidate = Number(x.toPrecision(precision));
    if (Math.fround(candidate) === x) return candidate;
  }
  return x;
}

/** Little-endian float32 components, as the `embedding` column holds them. */
export function encodeEmbedding(embedding: readonly number[]): Uint8Array {
  const buffer = new ArrayBuffer(embedding.length * 4);
  const view = new DataView(buffer);
  embedding.forEach((x, i) => {
    view.setFloat32(i * 4, x, true);
  });
  return new Uint8Array(buffer);
}

/** Whether this machine stores numbers little-endian, as the blobs are. */
const LITTLE_ENDIAN = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

/** A copy of the stored values (never a view of `bytes`, which the driver may reuse). */
export function decodeEmbedding(bytes: Uint8Array): Float32Array {
  const length = Math.floor(bytes.byteLength / 4);
  // One memory copy instead of a `getFloat32` call per value (about 20 times faster). The
  // Uint8Array `slice` copies even for a Node `Buffer`, whose own `slice` is a view of its pool.
  if (LITTLE_ENDIAN) {
    return new Float32Array(Uint8Array.prototype.slice.call(bytes, 0, length * 4).buffer);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = new Float32Array(length);
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
