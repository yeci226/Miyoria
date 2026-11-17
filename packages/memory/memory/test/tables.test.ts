// The memory plugin's tables (`src/tables.ts`), moved from the store's behaviour suite with
// them (docs/design/v5-data.md §8 step 9b): every case on a fresh database, in memory and on a
// file. One database is one character: the profile a caller names is not part of any key, so the
// cases that once kept two profiles apart now pin that both names read the same records.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  type MemoryFilter,
  type MemoryHit,
  type MemoryKind,
  type MemoryQuery,
  type MemoryRecord,
  type MemoryScope,
  type PrunePolicy,
  SqliteStore,
} from "@miyoria/store";
import {
  type AccountRef,
  type ContextKey,
  type ContextKind,
  newId,
  type PersonId,
  type ProfileId,
  type Timestamp,
  toTimestamp,
} from "@miyoria/types";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { embeddingValues } from "../src/stored.js";
import { memoryTables } from "../src/tables.js";
import { tablesOf } from "./helpers.js";

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function unique(prefix: string): string {
  return `${prefix}-${newId()}`;
}

function account(id: string): AccountRef {
  return { platform: "discord", id };
}

function channel(scope: string | null, id: string, kind: ContextKind): ContextKey {
  return { platform: "discord", scope, channel: id, kind };
}

/** Milliseconds since the epoch → `Timestamp`. */
function at(ms: number): Timestamp {
  return toTimestamp(ms);
}

function memory(
  profile: ProfileId,
  kind: MemoryKind,
  scope: MemoryScope,
  tokens: string,
  createdAt: Timestamp,
): MemoryRecord {
  return {
    id: newId(),
    profile,
    kind,
    scope,
    subjects: [],
    content: `content of ${tokens}`,
    tokens,
    embedding: null,
    importance: 0.5,
    confidence: 0.75,
    created_at: createdAt,
    updated_at: createdAt,
    last_accessed: null,
    access_count: 0,
    source_context: null,
    source: null,
    origin: "unknown",
    source_events: [],
    due: null,
    done: false,
    superseded_by: null,
  };
}

function guildScope(guild: string): MemoryScope {
  return { type: "guild", platform: "discord", guild };
}

function textQuery(
  profile: ProfileId,
  scopes: MemoryScope[],
  tokens: string[],
  limit: number,
): MemoryQuery {
  return { profile, scopes, kinds: null, tokens, embedding: null, limit };
}

const hitIds = (hits: MemoryHit[]) => new Set(hits.map((h) => h.record.id));
const idSet = (records: MemoryRecord[]) => new Set(records.map((r) => r.id));
const recordIds = (records: MemoryRecord[]) => records.map((r) => r.id);
const near = (a: number, b: number) => Math.abs(a - b) < 1e-4;

const baseFilter: MemoryFilter = {
  subject: null,
  scope: null,
  kind: null,
  before: null,
  include_superseded: false,
  limit: 0,
};

/** Defines every case against stores made by `open`, a fresh database each. */
function tables(open: () => Promise<{ store: SqliteStore; done: () => void }>): void {
  let store: SqliteStore;
  let done: () => void;
  beforeEach(async () => {
    ({ store, done } = await open());
  });
  afterEach(async () => {
    await store?.close();
    done?.();
  });

  // ---- memory records ---------------------------------------------------------------------

  it("memory_round_trip", async () => {
    const memories = tablesOf(store);
    const profile = unique("profile");
    const t0 = Date.now();
    const r = memory(profile, "fact", { type: "person", person: newId() }, "owen ramen", at(t0));
    r.content = "Owen 喜歡拉麵";
    r.subjects = [newId(), newId()];
    r.embedding = [0.25, -0.5, 1.5];
    r.importance = 0.875;
    r.last_accessed = at(t0 + 5 * SECOND);
    r.access_count = 3;
    r.source_context = channel("guild", unique("chan"), "voice");
    r.source = { account: { platform: "discord", id: "1234" }, name: "Owen" };
    r.origin = "told";
    r.source_events = [newId(), `msg:${newId()}`];
    r.due = at(t0 + HOUR);
    await memories.upsert(r);
    expect(await memories.get(r.id)).toEqual(r);

    // Upsert replaces the whole record.
    r.content = "changed";
    r.embedding = null;
    r.done = true;
    r.superseded_by = newId();
    r.scope = { type: "global" };
    await memories.upsert(r);
    expect(await memories.get(r.id)).toEqual(r);

    expect(await memories.delete(r.id)).toBe(true);
    expect(await memories.delete(r.id)).toBe(false);
    expect(await memories.get(r.id)).toBeNull();
    expect(await memories.get(newId())).toBeNull();

    // Sub-microsecond precision is dropped, and an empty embedding means "none".
    const precise = memory(profile, "episode", { type: "global" }, "x", at(t0));
    precise.created_at = `${at(t0).slice(0, -1)}000789Z`;
    precise.embedding = [];
    await memories.upsert(precise);
    const got = await memories.get(precise.id);
    expect(got?.created_at).toBe(at(t0));
    expect(got?.embedding).toBeNull();

    const bad = memory(profile, "episode", { type: "global" }, "x", at(t0));
    bad.embedding = [1, Number.NaN];
    await expect(memories.upsert(bad)).rejects.toThrow(/non-finite/);
  });

  it("memory_search_scopes", async () => {
    const memories = tablesOf(store);
    const profile = unique("profile");
    const otherProfile = unique("profile");
    const t0 = Date.now();
    const chanId = unique("chan");
    const scopes: [string, MemoryScope][] = [
      ["global", { type: "global" }],
      ["guild", guildScope(unique("g"))],
      ["other_guild", guildScope(unique("g"))],
      ["channel", { type: "channel", context: channel("g", chanId, "channel") }],
      ["voice", { type: "channel", context: channel("g", chanId, "voice") }],
      ["dm", { type: "dm", account: account(unique("a")) }],
      ["person", { type: "person", person: newId() }],
    ];
    const byName = new Map<string, MemoryRecord>();
    for (const [i, [name, scope]] of scopes.entries()) {
      const kind: MemoryKind = i % 2 === 0 ? "fact" : "episode";
      const r = memory(profile, kind, scope, "ramen shop", at(t0 + i * SECOND));
      await memories.upsert(r);
      byName.set(name, r);
    }
    const rec = (name: string) => byName.get(name) as MemoryRecord;
    const scopeOf = (name: string) => rec(name).scope;

    let hits = await memories.search(
      textQuery(profile, [scopeOf("global"), scopeOf("guild")], ["ramen"], 10),
    );
    expect(hitIds(hits)).toEqual(idSet([rec("global"), rec("guild")]));
    expect(hits.every((h) => h.text_score > 0)).toBe(true);
    expect(hits.every((h) => h.vector_score === null)).toBe(true);

    // A channel scope is not its voice counterpart, a guild is not another guild.
    hits = await memories.search(textQuery(profile, [scopeOf("channel")], ["ramen"], 10));
    expect(hitIds(hits)).toEqual(idSet([rec("channel")]));
    hits = await memories.search(textQuery(profile, [scopeOf("voice")], ["ramen"], 10));
    expect(hitIds(hits)).toEqual(idSet([rec("voice")]));

    // Every scope listed: every record. One database is one character: another profile's name
    // finds the same ones.
    const allScopes = scopes.map(([, s]) => s);
    hits = await memories.search(textQuery(profile, allScopes, ["ramen"], 100));
    expect(hits).toHaveLength(scopes.length);
    const other = await memories.search(textQuery(otherProfile, allScopes, ["ramen"], 100));
    expect(hitIds(other)).toEqual(hitIds(hits));

    // Nothing listed, nothing found; limit caps text hits.
    expect(await memories.search(textQuery(profile, [], ["ramen"], 10))).toEqual([]);
    expect(await memories.search(textQuery(profile, allScopes, ["ramen"], 3))).toHaveLength(3);
    expect(await memories.search(textQuery(profile, allScopes, ["ramen"], 0))).toEqual([]);

    // Kinds restrict; matching ignores case; no tokens and no embedding find nothing; unknown
    // tokens find nothing.
    const q = textQuery(profile, allScopes, ["RAMEN"], 100);
    q.kinds = ["episode"];
    hits = await memories.search(q);
    expect(hits).toHaveLength(3);
    expect(hits.every((h) => h.record.kind === "episode")).toBe(true);
    q.kinds = [];
    expect(await memories.search(q)).toEqual([]);
    expect(await memories.search(textQuery(profile, allScopes, [], 10))).toEqual([]);
    expect(await memories.search(textQuery(profile, allScopes, ["sushi"], 10))).toEqual([]);
  });

  it("memory_search_superseded", async () => {
    const memories = tablesOf(store);
    const profile = unique("profile");
    const t0 = at(Date.now());
    const old = memory(profile, "fact", { type: "global" }, "ramen", t0);
    old.embedding = [1, 0];
    const fresh = memory(profile, "fact", { type: "global" }, "ramen", t0);
    fresh.embedding = [1, 0];
    await memories.upsert(old);
    await memories.upsert(fresh);

    const q = textQuery(profile, [{ type: "global" }], ["ramen"], 10);
    q.embedding = [1, 0];
    expect(hitIds(await memories.search(q)).size).toBe(2);

    old.superseded_by = fresh.id;
    await memories.upsert(old);
    expect(hitIds(await memories.search(q))).toEqual(new Set([fresh.id]));

    // Still stored, and listed on request.
    expect(await memories.get(old.id)).toEqual(old);
    const filter = { ...baseFilter, limit: 10 };
    expect(recordIds(await memories.list(profile, filter))).toEqual([fresh.id]);
    expect(await memories.list(profile, { ...filter, include_superseded: true })).toHaveLength(2);
  });

  it("memory_search_vector_and_text", async () => {
    const memories = tablesOf(store);
    const profile = unique("profile");
    const t0 = Date.now();
    const scope = guildScope(unique("g"));
    const mk = (tokens: string, embedding: number[] | null, secs: number) => {
      const r = memory(profile, "fact", scope, tokens, at(t0 + secs * SECOND));
      r.embedding = embedding;
      return r;
    };
    const both = mk("ramen noodles", [1, 0, 0], 1);
    const textOnly = mk("ramen", [0, 1, 0], 2);
    const vectorOnly = mk("sushi", [0.9, 0.1, 0], 3);
    const otherDims = mk("sushi", [1, 0], 4);
    const noEmbedding = mk("cat", null, 5);
    const otherScope = mk("ramen", [1, 0, 0], 6);
    otherScope.scope = guildScope(unique("g"));
    for (const r of [both, textOnly, vectorOnly, otherDims, noEmbedding, otherScope]) {
      await memories.upsert(r);
    }

    let q = textQuery(profile, [scope], ["ramen"], 2);
    q.embedding = [1, 0, 0];
    let hits = await memories.search(q);
    // Two text hits and two vector hits, merged by id.
    expect(hitIds(hits)).toEqual(idSet([both, textOnly, vectorOnly]));
    const find = (r: MemoryRecord) => hits.find((h) => h.record.id === r.id) as MemoryHit;
    const merged = find(both);
    expect(merged.text_score).toBeGreaterThan(0);
    expect(near(merged.vector_score ?? Number.NaN, 1)).toBe(true);
    const onlyText = find(textOnly);
    expect(onlyText.text_score).toBeGreaterThan(0);
    expect(onlyText.vector_score).toBeNull();
    const onlyVector = find(vectorOnly);
    expect(onlyVector.text_score).toBe(0);
    const cosine = 0.9 / Math.sqrt(0.9 * 0.9 + 0.1 * 0.1);
    expect(near(onlyVector.vector_score ?? Number.NaN, cosine)).toBe(true);

    // Vector only: nearest first, same dimension only, limit applies.
    q = textQuery(profile, [scope], [], 2);
    q.embedding = [1, 0, 0];
    hits = await memories.search(q);
    hits.sort((a, b) => (b.vector_score ?? 0) - (a.vector_score ?? 0));
    expect(hits.map((h) => h.record.id)).toEqual([both.id, vectorOnly.id]);
    expect(hits.every((h) => h.text_score === 0)).toBe(true);

    q.embedding = [1, 0];
    expect(hitIds(await memories.search(q))).toEqual(new Set([otherDims.id]));
    q.embedding = [1, 0, 0, 0];
    expect(await memories.search(q)).toEqual([]);
    q.embedding = [1, Number.POSITIVE_INFINITY];
    await expect(memories.search(q)).rejects.toThrow(/non-finite/);
  });

  it("memory_search_vector_sees_every_write", async () => {
    const memories = tablesOf(store);
    const profile = unique("profile");
    const t0 = Date.now();
    const scope = guildScope(unique("g"));
    const mk = (embedding: number[], secs: number) => {
      const r = memory(profile, "fact", scope, "x", at(t0 + secs * SECOND));
      r.embedding = embedding;
      return r;
    };
    const nearest = async (embedding: number[], limit = 1, scopes = [scope]) => {
      const q = textQuery(profile, scopes, [], limit);
      q.embedding = embedding;
      const hits = await memories.search(q);
      hits.sort((x, y) => (y.vector_score ?? 0) - (x.vector_score ?? 0));
      return hits.map((h) => h.record.id);
    };
    const a = mk([1, 0, 0], 1);
    const b = mk([0.9, 0.1, 0], 2);
    for (const r of [a, b]) await memories.upsert(r);
    expect(await nearest([1, 0, 0])).toEqual([a.id]);

    // Every write between two searches is seen: superseded, inserted, a new vector, deleted.
    await memories.upsert({ ...a, superseded_by: b.id });
    expect(await nearest([1, 0, 0])).toEqual([b.id]);
    const c = mk([1, 0, 0], 3);
    await memories.upsert(c);
    expect(await nearest([1, 0, 0])).toEqual([c.id]);
    await memories.upsert({ ...c, embedding: [0, 0, 1] });
    expect(await nearest([1, 0, 0])).toEqual([b.id]);
    expect(await memories.delete(b.id)).toBe(true);
    expect(await nearest([1, 0, 0])).toEqual([c.id]);

    // Touching and closing do not change what is compared; merging people moves a scope.
    await memories.touch([c.id], at(t0 + 10 * SECOND));
    expect(await nearest([0, 0, 1])).toEqual([c.id]);
    const keep = newId();
    const absorb = newId();
    const theirs = mk([0, 1, 0], 4);
    theirs.scope = { type: "person", person: absorb };
    await memories.upsert(theirs);
    const keepScope: MemoryScope[] = [{ type: "person", person: keep }];
    expect(await nearest([0, 1, 0], 1, keepScope)).toEqual([]);
    await memories.mergePerson(keep, absorb);
    expect(await nearest([0, 1, 0], 1, keepScope)).toEqual([theirs.id]);

    // Equal scores: the newest first, and the limit keeps those.
    const older = mk([0, 0, 1], 5);
    const newer = mk([0, 0, 1], 6);
    for (const r of [older, newer]) await memories.upsert(r);
    const q = textQuery(profile, [scope], [], 2);
    q.embedding = [0, 0, 1];
    expect((await memories.search(q)).map((h) => h.record.id)).toEqual([newer.id, older.id]);
  });

  it("memory_list_filters", async () => {
    const memories = tablesOf(store);
    const profile = unique("profile");
    const otherProfile = unique("profile");
    const t0 = Date.now();
    const alice = newId();
    const bob = newId();
    const guild = guildScope(unique("g"));
    const mk = (kind: MemoryKind, scope: MemoryScope, subjects: PersonId[], secs: number) => {
      const r = memory(profile, kind, scope, "x", at(t0 + secs * SECOND));
      r.subjects = subjects;
      return r;
    };
    const a = mk("episode", guild, [alice], 1);
    const b = mk("fact", { type: "global" }, [alice, bob], 2);
    const c = mk("fact", guild, [bob], 3);
    const d = mk("self_note", { type: "global" }, [], 4);
    for (const r of [a, b, c, d]) await memories.upsert(r);

    const list = async (filter: Partial<MemoryFilter>) =>
      recordIds(await memories.list(profile, { ...baseFilter, limit: 100, ...filter }));
    expect(await list({})).toEqual([d.id, c.id, b.id, a.id]);
    expect(await list({ limit: 2 })).toEqual([d.id, c.id]);
    expect(await list({ limit: 0 })).toEqual([]);
    expect(await list({ subject: alice })).toEqual([b.id, a.id]);
    expect(await list({ scope: guild })).toEqual([c.id, a.id]);
    expect(await list({ kind: "fact" })).toEqual([c.id, b.id]);
    expect(await list({ before: c.created_at })).toEqual([b.id, a.id]);
    expect(await list({ subject: bob, kind: "fact", scope: guild })).toEqual([c.id]);
    // One database is one character: another profile's name lists the same records.
    const others = await memories.list(otherProfile, { ...baseFilter, limit: 100 });
    expect(recordIds(others)).toEqual([d.id, c.id, b.id, a.id]);

    // `count` selects what `list` selects and ignores the limit.
    const count = (filter: Partial<MemoryFilter>) =>
      memories.count?.(profile, { ...baseFilter, limit: 1, ...filter });
    expect(await count({})).toBe(4);
    expect(await count({ subject: alice })).toBe(2);
    expect(await count({ scope: guild })).toBe(2);
    expect(await count({ kind: "fact" })).toBe(2);
    expect(await count({ before: c.created_at })).toBe(2);
    expect(await count({ subject: bob, kind: "fact", scope: guild })).toBe(1);
    expect(await count({ subject: newId() })).toBe(0);
  });

  it("memory_list_about_and_missing_embeddings", async () => {
    const memories = tablesOf(store);
    const profile = unique("profile");
    const t0 = Date.now();
    const alice = newId();
    const bob = newId();
    const carol = newId();
    const mk = (subjects: PersonId[], secs: number, embedding: number[] | null = null) => {
      const r = memory(profile, "fact", { type: "global" }, "x", at(t0 + secs * SECOND));
      r.subjects = subjects;
      r.embedding = embedding;
      return r;
    };
    const a1 = mk([alice], 1, [0.1, 0.2]);
    const a2 = mk([alice], 2);
    const ab = mk([alice, bob], 3);
    const b1 = mk([bob], 4, [0.3, 0.4]);
    const a3 = mk([alice], 5);
    const gone = mk([alice], 6);
    gone.superseded_by = a3.id;
    const c1 = mk([carol], 7);
    for (const r of [a1, a2, ab, b1, a3, gone, c1]) await memories.upsert(r);

    // Each person's newest `limitEach`, as `list` by subject gives them, once each, newest first.
    const about = async (people: PersonId[], each: number) =>
      recordIds((await memories.listAbout?.(profile, people, each)) ?? []);
    const bySubject = async (person: PersonId, limit: number) =>
      recordIds(await memories.list(profile, { ...baseFilter, subject: person, limit }));
    expect(await bySubject(alice, 2)).toEqual([a3.id, ab.id]);
    expect(await bySubject(bob, 2)).toEqual([b1.id, ab.id]);
    expect(await about([alice, bob], 2)).toEqual([a3.id, b1.id, ab.id]);
    expect(await about([alice, bob, alice], 1)).toEqual([a3.id, b1.id]);
    expect(await about([alice], 100)).toEqual([a3.id, ab.id, a2.id, a1.id]);
    expect(await about([alice], Number.POSITIVE_INFINITY)).toEqual([a3.id, ab.id, a2.id, a1.id]);
    expect(await about([alice], 0)).toEqual([]);
    expect(await about([], 5)).toEqual([]);
    expect(await about([newId()], 5)).toEqual([]);

    // Not superseded, no vector, newest first.
    const missing = async (limit: number) =>
      recordIds((await memories.missingEmbeddings?.(profile, limit)) ?? []);
    expect(await missing(10)).toEqual([c1.id, a3.id, ab.id, a2.id]);
    expect(await missing(2)).toEqual([c1.id, a3.id]);
    expect(await missing(0)).toEqual([]);
  });

  it("memory_embedding_read_late_is_the_same", async () => {
    const memories = tablesOf(store);
    const profile = unique("profile");
    const t0 = Date.now();
    const r = memory(profile, "fact", { type: "global" }, "late", at(t0));
    r.embedding = [0.1, -0.2, 0.3];
    await memories.upsert(r);
    const stored = (await memories.get(r.id))?.embedding;
    expect(stored).toHaveLength(3);

    // A listed record keeps its vector when written back without anyone reading it.
    const [listed] = await memories.list(profile, { ...baseFilter, limit: 10 });
    expect(listed?.id).toBe(r.id);
    if (!listed) return;
    listed.importance = 0.9;
    await memories.upsert(listed);
    expect((await memories.get(r.id))?.embedding).toEqual(stored);

    // Copies carry it, and setting it replaces it.
    const [again] = await memories.list(profile, { ...baseFilter, limit: 10 });
    if (!again) return;
    expect({ ...again }.embedding).toEqual(stored);
    expect(JSON.parse(JSON.stringify(again)).embedding).toEqual(stored);
    const [replaced] = await memories.list(profile, { ...baseFilter, limit: 10 });
    if (!replaced) return;
    replaced.embedding = null;
    expect(replaced.embedding).toBeNull();
    expect(Object.keys(replaced)).toEqual(Object.keys(r));
  });

  it("memory_embedding_values_skip_decoding", async () => {
    const memories = tablesOf(store);
    const profile = unique("profile");
    const r = memory(profile, "fact", { type: "global" }, "values", at(Date.now()));
    r.embedding = [0.1, -0.2, 0.3];
    await memories.upsert(r);

    // The stored float32 values come out without decoding `embedding` into decimals.
    const [listed] = await memories.list(profile, { ...baseFilter, limit: 10 });
    if (!listed) throw new Error("not listed");
    const values = embeddingValues(listed);
    expect(Array.from(values ?? [])).toEqual([0.1, -0.2, 0.3].map(Math.fround));
    expect(Object.getOwnPropertyDescriptor(listed, "embedding")?.get).toBeDefined();
    // Reading it afterwards still gives the shortest decimals.
    expect(listed.embedding).toEqual([0.1, -0.2, 0.3]);

    // Once replaced, the values follow the property.
    const [replaced] = await memories.list(profile, { ...baseFilter, limit: 10 });
    if (!replaced) throw new Error("not listed");
    replaced.embedding = [1, 2];
    expect(embeddingValues(replaced)).toEqual([1, 2]);
    replaced.embedding = null;
    expect(embeddingValues(replaced)).toBeNull();
    expect(embeddingValues({ embedding: [0.5] })).toEqual([0.5]);
  });

  it("memory_touch", async () => {
    const memories = tablesOf(store);
    const profile = unique("profile");
    const t0 = Date.now();
    const a = memory(profile, "fact", { type: "global" }, "a", at(t0));
    const b = memory(profile, "fact", { type: "global" }, "b", at(t0));
    await memories.upsert(a);
    await memories.upsert(b);

    const t1 = at(t0 + MINUTE);
    const t2 = at(t0 + 2 * MINUTE);
    await memories.touch([a.id, a.id, newId()], t1);
    await memories.touch([a.id], t2);
    await memories.touch([], t2);
    const a2 = await memories.get(a.id);
    expect(a2?.access_count).toBe(2);
    expect(a2?.last_accessed).toBe(t2);
    const b2 = await memories.get(b.id);
    expect(b2?.access_count).toBe(0);
    expect(b2?.last_accessed).toBeNull();
  });

  it("memory_due_followups", async () => {
    const memories = tablesOf(store);
    const profile = unique("profile");
    const now = Date.now();
    const followup = (p: ProfileId, due: number | null) => {
      const r = memory(p, "followup", { type: "global" }, "ask", at(now - DAY));
      r.due = due === null ? null : at(due);
      return r;
    };
    const later = followup(profile, now - HOUR);
    const earlier = followup(profile, now - 5 * HOUR);
    const exactlyNow = followup(profile, now);
    const future = followup(profile, now + HOUR);
    const noDue = followup(profile, null);
    const done = followup(profile, now - 2 * HOUR);
    done.done = true;
    const superseded = followup(profile, now - 3 * HOUR);
    superseded.superseded_by = newId();
    const notFollowup = followup(profile, now - 4 * HOUR);
    notFollowup.kind = "fact";
    for (const r of [later, earlier, exactlyNow, future, noDue, done, superseded, notFollowup]) {
      await memories.upsert(r);
    }

    // Newest due first: the oldest are the ones nobody brought up in time.
    expect(recordIds(await memories.dueFollowups(profile, at(now)))).toEqual([
      exactlyNow.id,
      later.id,
      earlier.id,
    ]);
    expect(recordIds(await memories.dueFollowups(profile, at(now + 2 * HOUR)))).toEqual([
      future.id,
      exactlyNow.id,
      later.id,
      earlier.id,
    ]);
    expect(await memories.dueFollowups(profile, at(now - 2 * DAY))).toEqual([]);
  });

  it("memory_followups_age_cap_and_expiry", async () => {
    const memories = tablesOf(store);
    const profile = unique("profile");
    const now = Date.now();
    const followup = (p: ProfileId, due: number) => {
      const r = memory(p, "followup", { type: "global" }, "ask", at(now - DAY));
      r.due = at(due);
      return r;
    };
    const fresh = followup(profile, now - 30 * MINUTE);
    const stale = followup(profile, now - 5 * HOUR);
    const ancient = followup(profile, now - 3 * DAY);
    for (const r of [fresh, stale, ancient]) await memories.upsert(r);

    // The age cap leaves the old ones out, without closing them.
    expect(recordIds(await memories.dueFollowups(profile, at(now), 2 * HOUR))).toEqual([fresh.id]);
    expect(recordIds(await memories.dueFollowups(profile, at(now), 6 * HOUR))).toEqual([
      fresh.id,
      stale.id,
    ]);
    expect(recordIds(await memories.dueFollowups(profile, at(now), null))).toEqual([
      fresh.id,
      stale.id,
      ancient.id,
    ]);

    // Closing: everything that became due before the cut-off.
    expect(await memories.expireFollowups(profile, at(now - 4 * HOUR))).toBe(2);
    expect((await memories.get(ancient.id))?.done).toBe(true);
    expect((await memories.get(stale.id))?.done).toBe(true);
    expect((await memories.get(fresh.id))?.done).toBe(false);
    expect(await memories.expireFollowups(profile, at(now - 4 * HOUR))).toBe(0);
    expect(recordIds(await memories.dueFollowups(profile, at(now)))).toEqual([fresh.id]);
    expect(await memories.expireFollowups(profile, at(now - 10 * MINUTE))).toBe(1);
    expect(await memories.dueFollowups(profile, at(now))).toEqual([]);
  });

  it("memory_prune", async () => {
    const memories = tablesOf(store);
    const profile = unique("profile");
    const now = Date.now();
    const old = now - 90 * DAY;
    const policy: PrunePolicy = {
      created_before: at(now - 30 * DAY),
      max_importance: 0.25,
      not_accessed_since: at(now - 14 * DAY),
    };
    const mk = (p: ProfileId, kind: MemoryKind, created: number, importance: number) => {
      const r = memory(p, kind, { type: "global" }, "x", at(created));
      r.importance = importance;
      return r;
    };
    const forgettable = mk(profile, "episode", old, 0.125);
    const atLimit = mk(profile, "episode", old, 0.25);
    const staleAccess = mk(profile, "episode", old, 0);
    staleAccess.last_accessed = at(now - 60 * DAY);
    const important = mk(profile, "episode", old, 0.5);
    const recentlyUsed = mk(profile, "episode", old, 0);
    recentlyUsed.last_accessed = at(now - DAY);
    const recent = mk(profile, "episode", now - DAY, 0);
    const fact = mk(profile, "fact", old, 0);
    const note = mk(profile, "self_note", old, 0);
    const followup = mk(profile, "followup", old, 0);
    const kept = [important, recentlyUsed, recent, fact, note, followup];
    const gone = [forgettable, atLimit, staleAccess];
    for (const r of [...gone, ...kept]) await memories.upsert(r);

    expect(await memories.prune(profile, policy)).toBe(3);
    expect(await memories.prune(profile, policy)).toBe(0);
    for (const r of gone) expect(await memories.get(r.id)).toBeNull();
    for (const r of kept) expect(await memories.get(r.id)).not.toBeNull();
  });

  it("memory_delete_by_subject", async () => {
    const memories = tablesOf(store);
    const profile = unique("profile");
    const otherProfile = unique("profile");
    const t0 = at(Date.now());
    const alice = newId();
    const bob = newId();
    const mk = (p: ProfileId, scope: MemoryScope, subjects: PersonId[]) => {
      const r = memory(p, "fact", scope, "x", t0);
      r.subjects = subjects;
      return r;
    };
    const aboutAlice = mk(profile, { type: "global" }, [alice]);
    const aboutBoth = mk(profile, guildScope(unique("g")), [bob, alice]);
    const aliceScope = mk(profile, { type: "person", person: alice }, []);
    const aboutBob = mk(profile, { type: "global" }, [bob]);
    const bobScope = mk(profile, { type: "person", person: bob }, [bob]);
    const unrelated = mk(profile, { type: "global" }, []);
    // One database is one character: what another profile's name wrote goes too.
    const foreign = mk(otherProfile, { type: "global" }, [alice]);
    const gone = [aboutAlice, aboutBoth, aliceScope, foreign];
    const kept = [aboutBob, bobScope, unrelated];
    for (const r of [...gone, ...kept]) await memories.upsert(r);

    expect(await memories.deleteBySubject(profile, alice)).toBe(4);
    expect(await memories.deleteBySubject(profile, alice)).toBe(0);
    for (const r of gone) expect(await memories.get(r.id)).toBeNull();
    for (const r of kept) expect(await memories.get(r.id)).not.toBeNull();
    expect(await memories.deleteBySubject(otherProfile, alice)).toBe(0);
  });

  it("memory_merge_person", async () => {
    const memories = tablesOf(store);
    const profile = unique("profile");
    const otherProfile = unique("profile");
    const t0 = at(Date.now());
    const keep = newId();
    const absorb = newId();
    const bob = newId();
    const mk = (p: ProfileId, scope: MemoryScope, subjects: PersonId[], kind: MemoryKind) => {
      const r = memory(p, kind, scope, "ramen shop", t0);
      r.subjects = subjects;
      r.embedding = [1, 0, 0];
      return r;
    };
    const fact = mk(profile, { type: "global" }, [bob, absorb], "fact");
    const both = mk(profile, guildScope(unique("g")), [absorb, bob, keep], "episode");
    const scoped = mk(profile, { type: "person", person: absorb }, [], "self_note");
    const followup = mk(profile, { type: "person", person: absorb }, [absorb], "followup");
    const foreign = mk(otherProfile, { type: "dm", account: account("x") }, [absorb], "fact");
    const untouched = mk(profile, { type: "person", person: bob }, [bob], "fact");
    for (const r of [fact, both, scoped, followup, foreign, untouched]) await memories.upsert(r);

    expect(await memories.mergePerson(keep, absorb)).toBe(5);
    expect(await memories.mergePerson(keep, absorb)).toBe(0);
    expect(await memories.mergePerson(keep, keep)).toBe(0);

    const read = async (r: MemoryRecord) => (await memories.get(r.id)) as MemoryRecord;
    expect((await read(fact)).subjects).toEqual([bob, keep]);
    expect((await read(both)).subjects, "no duplicates, first occurrence kept").toEqual([
      keep,
      bob,
    ]);
    expect((await read(scoped)).scope).toEqual({ type: "person", person: keep });
    expect((await read(followup)).scope).toEqual({ type: "person", person: keep });
    expect((await read(followup)).subjects).toEqual([keep]);
    expect((await read(foreign)).subjects, "every profile").toEqual([keep]);
    expect((await read(foreign)).scope).toEqual({ type: "dm", account: account("x") });
    expect((await read(untouched)).subjects).toEqual([bob]);
    expect((await read(untouched)).scope).toEqual(untouched.scope);
    const after = await read(fact);
    expect(after.tokens).toBe(fact.tokens);
    expect(after.embedding).toEqual([1, 0, 0]);
    expect(Date.parse(after.updated_at)).toBe(Date.parse(fact.updated_at));

    // Indexes still agree: filters, scope lookups, full text and vectors see the new person.
    // `foreign` too: another profile's name, the same character's records.
    const listed = await memories.list(profile, { ...baseFilter, subject: keep, limit: 10 });
    expect(idSet(listed)).toEqual(new Set([fact.id, both.id, followup.id, foreign.id]));
    expect(await memories.list(profile, { ...baseFilter, subject: absorb, limit: 10 })).toEqual([]);
    const keepScope: MemoryScope = { type: "person", person: keep };
    const absorbScope: MemoryScope = { type: "person", person: absorb };
    const scopedList = await memories.list(profile, { ...baseFilter, scope: keepScope, limit: 10 });
    expect(idSet(scopedList)).toEqual(new Set([scoped.id, followup.id]));
    const text = await memories.search(textQuery(profile, [keepScope], ["ramen"], 10));
    expect(hitIds(text)).toEqual(new Set([scoped.id, followup.id]));
    expect(await memories.search(textQuery(profile, [absorbScope], ["ramen"], 10))).toEqual([]);
    const vector = await memories.search({
      ...textQuery(profile, [keepScope], [], 10),
      embedding: [1, 0, 0],
    });
    expect(hitIds(vector)).toEqual(new Set([scoped.id, followup.id]));
    expect(vector.every((h) => near(h.vector_score ?? 0, 1))).toBe(true);
    // The other profile's name wrote `foreign`: the same character's, so it goes too.
    expect(await memories.deleteBySubject(profile, keep)).toBe(5);
  });

  it("embeddings read back as the shortest float32 decimals", async () => {
    const r = memory(unique("profile"), "fact", { type: "global" }, "x", at(Date.now()));
    r.embedding = [0.1, 0.9, -1e-7, 3];
    await tablesOf(store).upsert(r);
    expect((await tablesOf(store).get(r.id))?.embedding).toEqual([0.1, 0.9, -1e-7, 3]);
  });

  it("full-text tokens are literal (quotes, operators, CJK)", async () => {
    const profile = unique("profile");
    const scopes: MemoryScope[] = [{ type: "global" }];
    const r = memory(profile, "fact", { type: "global" }, "owen 喜歡 拉麵 or", at(Date.now()));
    await tablesOf(store).upsert(r);
    const search = (tokens: string[]) =>
      tablesOf(store).search(textQuery(profile, scopes, tokens, 10));
    expect(hitIds(await search(["拉麵"]))).toEqual(new Set([r.id]));
    expect(hitIds(await search(["OR"]))).toEqual(new Set([r.id]));
    expect(hitIds(await search(["  Owen  ", "owen"]))).toEqual(new Set([r.id]));
    for (const weird of ['"', 'a"b', "!!", "NEAR(", "*", "-", "x:y", "AND", "NOT"]) {
      expect(await search([weird])).toEqual([]);
    }
    expect(hitIds(await search(['"', "拉麵"]))).toEqual(new Set([r.id]));
  });

  it("scopes match whatever their key order", async () => {
    const profile = unique("profile");
    const guild = unique("g");
    const r = memory(profile, "fact", { type: "guild", platform: "discord", guild }, "x", at(0));
    await tablesOf(store).upsert(r);
    const reordered = JSON.parse(`{"guild":"${guild}","platform":"discord","type":"guild"}`);
    const listed = await tablesOf(store).list(profile, {
      ...baseFilter,
      scope: reordered,
      limit: 9,
    });
    expect(recordIds(listed)).toEqual([r.id]);
  });
}

describe("sqlite (in memory)", () => {
  tables(async () => ({
    store: await SqliteStore.open(":memory:", { plugins: [memoryTables] }),
    done: () => {},
  }));
});

describe("whose database it is", () => {
  it("a record looked up by id reports the profile set at start, before any other call", async () => {
    const dir = mkdtempSync(join(tmpdir(), "miyoria-memory-"));
    try {
      const file = join(dir, "memory.db");
      const first = await SqliteStore.open(file, { plugins: [memoryTables] });
      const r = memory("p", "fact", { type: "person", person: newId() }, "ramen", at(Date.now()));
      await first.plugin(memoryTables).upsert(r);
      await first.close();
      // A new start: nothing has named a profile on these tables yet.
      const second = await SqliteStore.open(file, { plugins: [memoryTables] });
      const tables = second.plugin(memoryTables);
      expect((await tables.get(r.id))?.profile).toBe("");
      tables.forProfile("deepseek-chan");
      expect((await tables.get(r.id))?.profile).toBe("deepseek-chan");
      await second.close();
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
    }
  });
});

describe("sqlite (file)", () => {
  tables(async () => {
    const dir = mkdtempSync(join(tmpdir(), "miyoria-memory-"));
    return {
      store: await SqliteStore.open(join(dir, "memory.db"), { plugins: [memoryTables] }),
      done: () => rmSync(dir, { recursive: true, force: true, maxRetries: 5 }),
    };
  });
});

// ---- one file, two connections, the vector counter (from the store's `sqlite.test.ts`) ---------

function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "miyoria-memory-"));
  return fn(dir).finally(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5 }));
}

describe("vectors on a file", () => {
  it("vector search sees memories another connection changed", () =>
    withTempDir(async (dir) => {
      const path = join(dir, "vectors.db");
      const store = await SqliteStore.open(path, { plugins: [memoryTables] });
      try {
        const profile = "p" as ProfileId;
        const now = toTimestamp(Date.now());
        const record = (embedding: number[]): MemoryRecord => ({
          id: newId(),
          profile,
          kind: "fact",
          scope: { type: "global" },
          subjects: [],
          content: "x",
          tokens: "x",
          embedding,
          importance: 0.5,
          confidence: 1,
          created_at: now,
          updated_at: now,
          last_accessed: null,
          access_count: 0,
          source_context: null,
          source: null,
          origin: "experienced",
          source_events: [],
          due: null,
          done: false,
          superseded_by: null,
        });
        const a = record([1, 0]);
        const b = record([0.5, 0.5]);
        for (const r of [a, b]) await tablesOf(store).upsert(r);
        const nearest = async () => {
          const hits = await tablesOf(store).search({
            profile,
            scopes: [{ type: "global" }],
            kinds: null,
            tokens: [],
            embedding: [1, 0],
            limit: 1,
          });
          return hits.map((h) => h.record.id);
        };
        expect(await nearest()).toEqual([a.id]);
        // Kept decoded in this process; a write elsewhere bumps the counter all the same.
        const raw = new DatabaseSync(path);
        raw.prepare("DELETE FROM memory_records WHERE id = ?").run(a.id);
        raw.close();
        expect(await nearest()).toEqual([b.id]);
      } finally {
        await store.close();
      }
    }));

  it("only changes vector search compares by invalidate the decoded vectors", () =>
    withTempDir(async (dir) => {
      const path = join(dir, "version.db");
      const store = await SqliteStore.open(path, { plugins: [memoryTables] });
      const raw = new DatabaseSync(path);
      const version = () =>
        (raw.prepare("SELECT n FROM memory_vector_version WHERE id = 1").get() as { n: number }).n;
      try {
        const now = toTimestamp(Date.now());
        const later = toTimestamp(Date.now() + 60_000);
        const record: MemoryRecord = {
          id: newId(),
          profile: "p" as ProfileId,
          kind: "followup",
          scope: { type: "global" },
          subjects: [],
          content: "x",
          tokens: "x",
          embedding: [0.25, 0.5],
          importance: 0.5,
          confidence: 1,
          created_at: now,
          updated_at: now,
          last_accessed: null,
          access_count: 0,
          source_context: null,
          source: null,
          origin: "experienced",
          source_events: [],
          due: null,
          done: false,
          superseded_by: null,
        };
        const memories = tablesOf(store);
        await memories.upsert(record);
        const before = version();
        // An upsert names every column; reinforcing, scheduling, citing or closing a memory
        // leaves the vector and what it is filtered by as they were.
        await memories.upsert({ ...record, importance: 0.9, confidence: 0.8 });
        await memories.upsert({ ...record, due: later, updated_at: later });
        await memories.upsert({ ...record, source_events: [newId()] });
        await memories.upsert({ ...record, done: true });
        await memories.touch([record.id], later);
        expect(version()).toBe(before);
        await memories.upsert({ ...record, embedding: [0.5, 0.25] });
        expect(version()).toBe(before + 1);
        await memories.upsert({ ...record, embedding: null });
        await memories.upsert({ ...record, embedding: null });
        expect(version()).toBe(before + 2);
      } finally {
        raw.close();
        await store.close();
      }
    }));
});

// ---- provenance (from the store's `memory-provenance.test.ts`) ------------------------------

describe("memory provenance", () => {
  it("a record written without provenance reads back as unknown", async () => {
    const store = await SqliteStore.open(":memory:");
    try {
      await tablesOf(store).upsert({
        id: "01NOPROVENANCE00000000000",
        profile: "p",
        kind: "fact",
        scope: { type: "global" },
        subjects: [],
        content: "x",
        tokens: "x",
        embedding: null,
        importance: 0.5,
        confidence: 0.5,
        created_at: "2026-10-01T00:00:00.000000Z",
        updated_at: "2026-10-01T00:00:00.000000Z",
        last_accessed: null,
        access_count: 0,
        source_context: null,
        source: null,
        due: null,
        done: false,
        superseded_by: null,
      });
      const back = await tablesOf(store).get("01NOPROVENANCE00000000000");
      expect(back?.origin).toBe("unknown");
      expect(back?.source_events).toEqual([]);
    } finally {
      await store.close();
    }
  });
});
