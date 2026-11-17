// `/api/memory*`: browse, search, edit and delete her long-term memories (active profile).
// Searches use the memory engine's hybrid recall when the memory module runs, else the store's
// full-text search; either way over every scope of the profile (an admin view).

import type {
  MemoryItem,
  MemoryPage,
  MemoryRecordView,
  UpdateMemoryRequest,
} from "@miyoria/contracts/api";
import { type MemoryEngine, MemoryEngineKey, tokenString } from "@miyoria/memory/memory";
import {
  type MemoryFilter,
  type MemoryHit,
  type MemoryKind,
  type MemoryRecord,
  type MemoryRecordStore,
  MemoryRecordStoreKey,
  type MemoryScope,
} from "@miyoria/store";
import { isUlid, type ProfileId, toTimestamp } from "@miyoria/types";
import { os } from "./contract.js";
import { ApiError } from "./errors.js";
import { clampLimit, countOf } from "./extract.js";
import { type ApiContext, type ApiState, toJson } from "./state.js";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;
/** Upper bound when collecting the profile's scopes for a search. */
const SCAN_LIMIT = 100_000;
const MAX_CONTENT_CHARS = 4000;

const ALL_KINDS: MemoryKind[] = ["episode", "fact", "self_note", "followup"];

/** A record without its search tokens and embedding vector. */
export function recordView(r: MemoryRecord): MemoryRecordView {
  return {
    id: r.id,
    profile: r.profile,
    kind: r.kind,
    scope: r.scope,
    subjects: r.subjects,
    content: r.content,
    importance: r.importance,
    confidence: r.confidence,
    created_at: r.created_at,
    updated_at: r.updated_at,
    last_accessed: r.last_accessed,
    access_count: r.access_count,
    source_context: r.source_context,
    due: r.due,
    done: r.done,
    superseded_by: r.superseded_by,
    has_embedding: r.embedding !== null && r.embedding.length > 0,
  };
}

interface Records {
  store: MemoryRecordStore;
  profile: ProfileId;
  /** The memory module's engine, when it runs (hybrid search). */
  engine: MemoryEngine | null;
}

/** The memory module's store and profile, else the app's store and the active profile. */
function records(state: ApiState): Records {
  const engine = state.optional(MemoryEngineKey);
  if (engine) return { store: engine.records, profile: engine.profile, engine };
  const store = state.service(MemoryRecordStoreKey, "memory store");
  return { store, profile: state.profile(), engine: null };
}

/** The query of the list, as the handler gets it: the checks of `subject` and `before` are its own. */
interface ListQuery {
  q?: string | undefined;
  kind?: MemoryKind | undefined;
  /** A person's ULID, upper-cased. */
  subject?: string | undefined;
  /** A time (pagination). */
  before?: string | undefined;
  include_superseded?: boolean | undefined;
  limit?: number | undefined;
}

type RawQuery = {
  q?: string | undefined;
  kind?: MemoryKind | undefined;
  subject?: string | undefined;
  before?: string | undefined;
  include_superseded?: "true" | "false" | undefined;
  limit?: string | undefined;
};

const queryError = (message: string) =>
  ApiError.badRequest(`Failed to deserialize query string: ${message}`);

/** What the schema leaves to the handler: `subject` is an ULID, `before` a time. */
function listQuery(raw: RawQuery): ListQuery {
  let subject: string | undefined;
  if (raw.subject !== undefined) {
    subject = raw.subject.toUpperCase();
    if (!isUlid(subject)) throw queryError("subject: invalid ULID");
  }
  if (raw.before !== undefined && Number.isNaN(Date.parse(raw.before))) {
    throw queryError("before: invalid timestamp");
  }
  return {
    q: raw.q,
    kind: raw.kind,
    subject,
    before: raw.before,
    include_superseded:
      raw.include_superseded === undefined ? undefined : raw.include_superseded === "true",
    limit: countOf(raw.limit),
  };
}

function sameScope(a: MemoryScope, b: MemoryScope): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

async function list(state: ApiState, raw: RawQuery): Promise<MemoryPage> {
  const q = listQuery(raw);
  const recs = records(state);
  const { store, profile } = recs;
  const limit = clampLimit(q.limit, DEFAULT_LIMIT, MAX_LIMIT);
  const text = q.q?.trim() ?? "";
  if (text !== "") return search(state, recs, q, text, limit);

  const filter: MemoryFilter = {
    subject: q.subject ?? null,
    scope: null,
    kind: q.kind ?? null,
    before: q.before ?? null,
    include_superseded: q.include_superseded ?? false,
    limit: limit + 1,
  };
  const found = await store.list(profile, filter);
  const more = found.length > limit;
  const kept = found.slice(0, limit);
  const last = kept[kept.length - 1];
  return {
    items: kept.map((r) => ({ record: recordView(r) })),
    next_cursor: more && last ? last.created_at : null,
  };
}

/** Every scope the profile has records in: an admin search may look everywhere. */
async function profileScopes(store: MemoryRecordStore, profile: ProfileId): Promise<MemoryScope[]> {
  const all = await store.list(profile, {
    subject: null,
    scope: null,
    kind: null,
    before: null,
    include_superseded: false,
    limit: SCAN_LIMIT,
  });
  const scopes: MemoryScope[] = [];
  for (const r of all) {
    if (!scopes.some((s) => sameScope(s, r.scope))) scopes.push(r.scope);
  }
  return scopes;
}

/** Search over every scope of the profile. Superseded records are never returned. */
async function search(
  state: ApiState,
  recs: Records,
  q: ListQuery,
  text: string,
  limit: number,
): Promise<MemoryPage> {
  const { store, profile, engine } = recs;
  const before = q.before !== undefined ? Date.parse(q.before) : null;
  const keep = (r: MemoryRecord) =>
    (q.subject === undefined || r.subjects.includes(q.subject)) &&
    (before === null || Date.parse(r.created_at) < before);
  let items: MemoryItem[];
  if (engine) {
    const scopes = await profileScopes(store, profile);
    const kinds = q.kind ? [q.kind] : ALL_KINDS;
    const found = await engine.search(scopes, text, kinds, MAX_LIMIT, toTimestamp(state.now()));
    items = found
      .filter((h) => keep(h.record))
      .slice(0, limit)
      .map((h) => ({
        record: recordView(h.record),
        text_score: h.text_score,
        vector_score: h.vector_score,
        score: h.score,
      }));
  } else {
    const hits = await textSearch(state, store, profile, q, text);
    const score = (h: MemoryHit) => Math.max(h.text_score, h.vector_score ?? 0);
    items = hits
      .filter((h) => keep(h.record))
      .sort(
        (a, b) =>
          score(b) - score(a) || Date.parse(b.record.created_at) - Date.parse(a.record.created_at),
      )
      .slice(0, limit)
      .map((h) => ({
        record: recordView(h.record),
        text_score: h.text_score,
        vector_score: h.vector_score,
      }));
  }
  return { items, next_cursor: null };
}

/** The store's full-text search (no memory module). */
async function textSearch(
  state: ApiState,
  store: MemoryRecordStore,
  profile: ProfileId,
  q: ListQuery,
  text: string,
): Promise<MemoryHit[]> {
  const tokens = state.tokenize(text);
  if (tokens.length === 0) return [];
  const scopes = await profileScopes(store, profile);
  if (scopes.length === 0) return [];
  return store.search({
    profile,
    scopes,
    kinds: q.kind ? [q.kind] : null,
    tokens,
    embedding: null,
    limit: MAX_LIMIT,
  });
}

function unknownMemory(id: string): ApiError {
  return ApiError.notFound(`unknown memory \`${id}\``);
}

/** The record with this id in the profile. */
async function find(
  store: MemoryRecordStore,
  profile: ProfileId,
  id: string,
): Promise<MemoryRecord> {
  const ulid = id.toUpperCase();
  if (!isUlid(ulid)) throw unknownMemory(id);
  const record = await store.get(ulid);
  if (!record || record.profile !== profile) throw unknownMemory(id);
  return record;
}

async function update(
  state: ApiState,
  c: ApiContext,
  id: string,
  body: UpdateMemoryRequest,
): Promise<MemoryRecordView> {
  // A field that is `null` is as good as left out.
  const request: {
    content?: string;
    kind?: MemoryKind;
    importance?: number;
    done?: boolean;
  } = {};
  if (body.content != null) request.content = body.content;
  if (body.kind != null) request.kind = body.kind;
  if (body.importance != null) request.importance = body.importance;
  if (body.done != null) request.done = body.done;
  const content = request.content?.trim();
  if (content === "") throw ApiError.badRequest("`content` must not be empty");
  if (content !== undefined && [...content].length > MAX_CONTENT_CHARS) {
    throw ApiError.badRequest(`\`content\` is longer than ${MAX_CONTENT_CHARS} characters`);
  }
  if (request.importance !== undefined && !(request.importance >= 0 && request.importance <= 1)) {
    throw ApiError.badRequest("`importance` must be between 0 and 1");
  }
  const { store, profile } = records(state);
  const record = { ...(await find(store, profile, id)) };
  if (content !== undefined && content !== record.content) {
    record.content = content;
    record.tokens = tokenString(content);
    // The memory module does not expose its embedder; drop the stale vector rather than keep
    // one that describes the old text.
    record.embedding = null;
  }
  if (request.kind !== undefined) record.kind = request.kind;
  if (request.importance !== undefined) record.importance = request.importance;
  if (request.done !== undefined) record.done = request.done;
  record.updated_at = toTimestamp(state.now());
  let failure: unknown = null;
  try {
    await store.upsert(record);
  } catch (error) {
    failure = error;
  }
  const detail = toJson(request) as Record<string, unknown>;
  if (failure !== null) detail.error = ApiError.internal(failure).message;
  await state.audit(c, "memory.update", record.id, toJson(detail), failure === null);
  if (failure !== null) throw ApiError.internal(failure);
  return recordView(record);
}

async function remove(state: ApiState, c: ApiContext, id: string): Promise<void> {
  const { store, profile } = records(state);
  const record = await find(store, profile, id);
  let removed = false;
  let failure: unknown = null;
  try {
    removed = await store.delete(record.id);
  } catch (error) {
    failure = error;
  }
  const detail = toJson({ kind: record.kind, scope: record.scope, content: record.content });
  await state.audit(c, "memory.delete", record.id, detail, failure === null);
  if (failure !== null) throw ApiError.internal(failure);
  if (!removed) throw unknownMemory(id);
}

/** The memory routes on the route table (`@miyoria/contracts/api`). */
export const memoryRpc = {
  list: os.memory.list.handler(({ input, context }) => list(context.state, input.query)),
  update: os.memory.update.handler(({ input, context }) =>
    update(context.state, context.c, input.params.id, input.body),
  ),
  remove: os.memory.remove.handler(({ input, context }) =>
    remove(context.state, context.c, input.params.id),
  ),
};
