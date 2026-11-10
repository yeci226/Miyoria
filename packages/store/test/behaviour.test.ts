// One behaviour suite (port of legacy `tests/behaviour.rs`), run against every backend.
//
// SQLite (in memory and on a file) always runs. PostgreSQL runs only when
// `MIYORIA_TEST_DATABASE_URL` is set; otherwise its tests are skipped. Every case uses fresh
// ids, so it can share a database with other runs.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AccountRef,
  type ContextKey,
  type ContextKind,
  newId,
  type PersonId,
  type ProfileId,
  type Timestamp,
  type TurnOutcomeRecord,
  toTimestamp,
} from "@miyoria/types";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type AuditEntry,
  type AuthScope,
  type Bounty,
  type Deal,
  type DecisionRecord,
  dataCategory,
  type Goal,
  type GoalPledge,
  type LogEntry,
  type MemberCardRecord,
  type MemoryFilter,
  type MemoryHit,
  type MemoryKind,
  type MemoryQuery,
  type MemoryRecord,
  type MemoryScope,
  type NodeOverride,
  openStore,
  type PrunePolicy,
  type Relationship,
  type RelationshipDelta,
  type RoleAssignment,
  type RoleDefinition,
  type RoleMapping,
  type Store,
} from "../src/index.js";

const DB_ENV = "MIYORIA_TEST_DATABASE_URL";

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

function entry(profile: ProfileId, context: ContextKey, text: string, ts: Timestamp): LogEntry {
  return {
    id: newId(),
    profile,
    context,
    author: account("100"),
    author_name: "Owen",
    text,
    is_self: false,
    ts,
    turn: null,
  };
}

const texts = (entries: LogEntry[]) => entries.map((e) => e.text);

function decision(
  profile: ProfileId,
  context: ContextKey,
  reason: string,
  ts: Timestamp,
): DecisionRecord {
  return {
    id: newId(),
    profile,
    ts,
    trace: { turn: newId(), context, respond: false, score: 0.25, reasons: [reason] },
  };
}

const reasons = (records: DecisionRecord[]) => records.map((r) => r.trace.reasons[0]);

function outcome(
  context: ContextKey,
  kind: "sent" | "silence" | "cancelled",
  ts: Timestamp,
  turn: string = newId(),
): TurnOutcomeRecord {
  return {
    turn,
    context,
    reason: "addressed",
    outcome:
      kind === "sent"
        ? { type: "sent", parts: 2 }
        : kind === "silence"
          ? { type: "silence" }
          : { type: "cancelled", cause: "input", by: "Owen" },
    addressed_by: ["Owen"],
    focus: [],
    restarts: 0,
    reasoning: null,
    latency_ms: null,
    at: ts,
  };
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

function relationship(profile: ProfileId, person: PersonId, now: number): Relationship {
  return {
    profile,
    person,
    affinity: 12.5,
    trust: 40,
    familiarity: 7.25,
    tags: ["friend", "regular"],
    notes: "愛開玩笑",
    call_name: "歐文",
    interactions: 9,
    last_interaction: at(now),
    updated_at: at(now),
  };
}

function delta(ts: Timestamp, affinity: number, reason: string): RelationshipDelta {
  return { at: ts, affinity, trust: 0.5, familiarity: 0.25, reason };
}

function role(name: string, rank: number, builtin: boolean): RoleDefinition {
  return { name, rank, grants: ["queue.*", "chat.send"], denies: ["voice.join"], builtin };
}

function assignment(
  who: AccountRef,
  roleName: string,
  scope: AuthScope,
  by: string,
  ts: Timestamp,
): RoleAssignment {
  return { account: who, role: roleName, scope, granted_by: by, at: ts };
}

function guildAuth(guild: string): AuthScope {
  return { type: "guild", platform: "discord", guild };
}

/** Defines every behaviour case against stores made by `open`. */
function behaviour(open: () => Promise<Store>): void {
  let store: Store;
  beforeEach(async () => {
    store = await open();
  });
  afterEach(async () => {
    await store?.close();
  });

  // ---- cases ------------------------------------------------------------------------------

  it("message_log_recent", async () => {
    const log = store.messages;
    const profile = unique("profile");
    const ctx = channel("guild", unique("chan"), "channel");
    const t0 = Date.now();
    // Appended out of order; equal timestamps keep append order.
    for (const [text, secs] of [
      ["b", 2],
      ["a", 1],
      ["c", 3],
      ["d1", 4],
      ["d2", 4],
      ["e", 5],
    ] as const) {
      await log.append(entry(profile, ctx, text, at(t0 + secs * SECOND)));
    }
    expect(texts(await log.recent(profile, ctx, 100))).toEqual(["a", "b", "c", "d1", "d2", "e"]);
    expect(texts(await log.recent(profile, ctx, 3))).toEqual(["d1", "d2", "e"]);
    expect(await log.recent(profile, ctx, 0)).toEqual([]);
  });

  it("message_log_round_trip", async () => {
    const log = store.messages;
    const profile = unique("profile");
    const ctx = channel(null, unique("dm"), "dm");
    const e = entry(profile, ctx, "她說的話", at(Date.now()));
    e.author = account("999");
    e.author_name = "Miyori";
    e.is_self = true;
    e.turn = newId();
    await log.append(e);
    expect(await log.recent(profile, ctx, 10)).toEqual([e]);
    await expect(log.append(e), "duplicate id must fail").rejects.toThrow(/already exists/);
  });

  it("message_log_isolation", async () => {
    const log = store.messages;
    const profile = unique("profile");
    const otherProfile = unique("profile");
    const id = unique("chan");
    const textCtx = channel("guild", id, "channel");
    const voiceCtx = channel("guild", id, "voice");
    const otherGuild = channel("other", id, "channel");
    const now = at(Date.now());
    await log.append(entry(profile, textCtx, "text", now));
    await log.append(entry(profile, voiceCtx, "voice", now));
    await log.append(entry(profile, otherGuild, "other", now));
    await log.append(entry(otherProfile, textCtx, "other profile", now));

    expect(texts(await log.recent(profile, textCtx, 10))).toEqual(["text"]);
    expect(texts(await log.recent(otherProfile, textCtx, 10))).toEqual(["other profile"]);
    const empty = channel("guild", unique("chan"), "channel");
    expect(await log.recent(profile, empty, 10)).toEqual([]);
  });

  it("module_state", async () => {
    const modules = store.moduleState;
    const a = unique("test.a");
    const b = unique("test.b");
    expect(await modules.get(a)).toBeNull();
    await modules.set(a, false);
    await modules.set(b, true);
    expect(await modules.get(a)).toBe(false);
    await modules.set(a, true);
    expect(await modules.get(a)).toBe(true);
    const list = await modules.list();
    expect(list.get(a)).toBe(true);
    expect(list.get(b)).toBe(true);
    const keys = [...list.keys()];
    expect(keys).toEqual([...keys].sort());
  });

  it("persona_overrides", async () => {
    const overrides = store.personaOverrides;
    const profile = unique("profile");
    const other = unique("profile");
    expect((await overrides.current(profile)).size).toBe(0);
    expect(await overrides.history(profile, "style")).toEqual([]);

    expect(await overrides.set(profile, "style", "v1", "panel:owen")).toBe(1);
    expect(await overrides.set(profile, "style", "v2", "discord:1")).toBe(2);
    expect(await overrides.set(profile, "identity", "id", "panel:owen")).toBe(1);
    expect(await overrides.set(other, "style", "else", "panel:owen")).toBe(1);

    const current = await overrides.current(profile);
    expect([...current]).toEqual([
      ["identity", "id"],
      ["style", "v2"],
    ]);

    const history = await overrides.history(profile, "style");
    expect(history.map((o) => [o.version, o.body, o.edited_by])).toEqual([
      [1, "v1", "panel:owen"],
      [2, "v2", "discord:1"],
    ]);
    expect(history.every((o) => o.profile === profile && o.key === "style")).toBe(true);
    const [first, second] = history;
    expect(Date.parse(first?.edited_at ?? "")).toBeLessThanOrEqual(
      Date.parse(second?.edited_at ?? ""),
    );
  });

  it("persona_overrides_concurrent", async () => {
    const profile = unique("profile");
    const versions = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        store.personaOverrides.set(profile, "style", `edit ${i}`, "test"),
      ),
    );
    expect(versions.sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it("people", async () => {
    const people = store.people;
    const owen = account(unique("owen"));
    const other = account(unique("other"));
    expect(await people.personByAccount(owen)).toBeNull();

    const id = await people.upsertAccount(owen, "Owen");
    expect(await people.upsertAccount(owen, "Owen L")).toBe(id);
    const otherId = await people.upsertAccount(other, "Someone");
    expect(otherId).not.toBe(id);

    const person = await people.personByAccount(owen);
    expect(person?.id).toBe(id);
    expect(person?.display_name).toBe("Owen");
    expect(person?.accounts).toHaveLength(1);
    const acc = person?.accounts[0];
    expect(acc?.account).toEqual(owen);
    expect(acc?.display_name).toBe("Owen L");
    expect(Date.parse(acc?.first_seen ?? "")).toBeLessThanOrEqual(Date.parse(acc?.last_seen ?? ""));
  });

  it("people_all", async () => {
    const people = store.people;
    const a1 = account(unique("a1"));
    const a2 = account(unique("a2"));
    const b1 = account(unique("b1"));
    const p1 = await people.upsertAccount(a1, "One");
    const p2 = await people.upsertAccount(b1, "Two");
    await store.identity.linkAccount(a2, p1);
    // A person whose only account moved away is still a person.
    const c1 = account(unique("c1"));
    const p3 = await people.upsertAccount(c1, "Three");
    await store.identity.linkAccount(c1, p2);

    // The database may be shared with other cases: look at ours only.
    const all = await people.all();
    const ours = all.filter((p) => [p1, p2, p3].includes(p.id));
    expect(ours.map((p) => p.id)).toEqual([p1, p2, p3]);
    const [one, two, three] = ours;
    expect(one?.display_name).toBe("One");
    expect(one?.accounts.map((a) => a.account)).toEqual([a1, a2]);
    expect(one).toEqual(await people.personByAccount(a1));
    expect(two?.accounts).toHaveLength(2);
    expect(three?.accounts).toEqual([]);
    for (let i = 1; i < all.length; i++) {
      const prev = all[i - 1] as (typeof all)[number];
      const next = all[i] as (typeof all)[number];
      expect(Date.parse(prev.created_at)).toBeLessThanOrEqual(Date.parse(next.created_at));
    }
  });

  it("decision_log_recent", async () => {
    const log = store.decisions;
    const profile = unique("profile");
    const otherProfile = unique("profile");
    const id = unique("chan");
    const a = channel("guild", id, "channel");
    const b = channel("guild", id, "voice");
    const t0 = Date.now();
    // Appended out of order.
    for (const [reason, ctx, secs] of [
      ["a2", a, 2],
      ["a1", a, 1],
      ["b3", b, 3],
      ["a4", a, 4],
    ] as const) {
      await log.append(decision(profile, ctx, reason, at(t0 + secs * SECOND)));
    }
    await log.append(decision(otherProfile, a, "other", at(t0)));

    expect(reasons(await log.recent(profile, null, 100))).toEqual(["a4", "b3", "a2", "a1"]);
    expect(reasons(await log.recent(profile, null, 2))).toEqual(["a4", "b3"]);
    expect(reasons(await log.recent(profile, a, 100))).toEqual(["a4", "a2", "a1"]);
    expect(reasons(await log.recent(profile, b, 100))).toEqual(["b3"]);
    expect(await log.recent(profile, null, 0)).toEqual([]);
    expect(reasons(await log.recent(otherProfile, null, 100))).toEqual(["other"]);
    const empty = channel("guild", unique("chan"), "channel");
    expect(await log.recent(profile, empty, 10)).toEqual([]);
  });

  it("decision_log_round_trip", async () => {
    const log = store.decisions;
    const profile = unique("profile");
    const ctx = channel(null, unique("dm"), "dm");
    const d = decision(profile, ctx, "被提到了", at(Date.now()));
    d.trace.respond = true;
    d.trace.score = 0.875;
    d.trace.reasons.push("direct message");
    await log.append(d);

    const got = await log.recent(profile, ctx, 10);
    expect(got).toEqual([d]);
    await expect(log.append(d), "duplicate id must fail").rejects.toThrow(/already exists/);
  });

  it("turn_outcomes_round_trip", async () => {
    const log = store.decisions;
    expect(log.appendOutcome).toBeTypeOf("function");
    expect(log.recentOutcomes).toBeTypeOf("function");
    const profile = unique("profile");
    const other = unique("profile");
    const a = channel("guild", unique("chan"), "channel");
    const b = channel("guild", unique("chan"), "voice");
    const t0 = Date.now();
    const sent = outcome(a, "sent", at(t0 + SECOND));
    const silent = outcome(a, "silence", at(t0 + 2 * SECOND));
    const cancelled = outcome(b, "cancelled", at(t0 + 3 * SECOND));
    for (const o of [silent, sent, cancelled]) await log.appendOutcome?.(profile, o);
    await log.appendOutcome?.(other, outcome(a, "sent", at(t0)));

    // Newest first, per context or for the whole profile, and the record comes back as written.
    expect(await log.recentOutcomes?.(profile, null, 10)).toEqual([cancelled, silent, sent]);
    expect(await log.recentOutcomes?.(profile, a, 10)).toEqual([silent, sent]);
    expect(await log.recentOutcomes?.(profile, b, 1)).toEqual([cancelled]);
    expect(await log.recentOutcomes?.(profile, null, 0)).toEqual([]);

    // One row per turn: writing a turn again replaces it ("decided to reply" → "nothing sent").
    const revised: TurnOutcomeRecord = {
      ...sent,
      outcome: { type: "error", error: "provider timeout" },
    };
    await log.appendOutcome?.(profile, revised);
    expect(await log.recentOutcomes?.(profile, a, 10)).toEqual([silent, revised]);
  });

  it("settings", async () => {
    const settings = store.settings;
    const profile = unique("profile");
    const other = unique("profile");
    expect(await settings.get(profile, "mode:general")).toBeNull();
    expect((await settings.list(profile, "")).size).toBe(0);

    const chatty = { mode: "chatty", n: 2 };
    await settings.set(profile, "mode:general", "quiet");
    await settings.set(profile, "mode:general", chatty);
    await settings.set(profile, "mode:dm", [null]);
    await settings.set(other, "mode:general", "other");
    expect(await settings.get(profile, "mode:general")).toEqual(chatty);
    expect(await settings.get(profile, "mode:dm")).toEqual([null]);

    // Deleting (`null`; the TS interface has no stored JSON `null`), also of a missing key,
    // leaves other profiles alone.
    await settings.set(profile, "mode:dm", null);
    await settings.set(profile, "mode:missing", null);
    expect(await settings.get(profile, "mode:dm")).toBeNull();
    expect(await settings.get(other, "mode:general")).toBe("other");
  });

  it("settings_list_prefix", async () => {
    const settings = store.settings;
    const profile = unique("profile");
    const keys = ["mode:b", "mode:a", "mode_x", "modeX:y", "mo%de:1", "other", "MODE:c"];
    for (const [i, key] of keys.entries()) await settings.set(profile, key, i);
    await settings.set(unique("profile"), "mode:z", 0);

    const listed: string[][] = [];
    for (const prefix of ["mode:", "mode_", "mo%", "mo", "mode:a", "nothing", ""]) {
      listed.push([...(await settings.list(profile, prefix)).keys()]);
    }
    // `_` and `%` are literal, and matching is case-sensitive.
    expect(listed).toEqual([
      ["mode:a", "mode:b"],
      ["mode_x"],
      ["mo%de:1"],
      ["mo%de:1", "mode:a", "mode:b", "modeX:y", "mode_x"],
      ["mode:a"],
      [],
      ["MODE:c", "mo%de:1", "mode:a", "mode:b", "modeX:y", "mode_x", "other"],
    ]);
    const list = await settings.list(profile, "mode:");
    expect(list.get("mode:a")).toBe(1);
    expect(list.get("mode:b")).toBe(0);
  });

  it("from_url_memory", async () => {
    const memoryStore = await openStore("memory://");
    try {
      expect((await memoryStore.moduleState.list()).size).toBe(0);
    } finally {
      await memoryStore.close();
    }
  });

  // ---- memory records ---------------------------------------------------------------------

  it("memory_round_trip", async () => {
    const memories = store.memories;
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
    const memories = store.memories;
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
    const foreign = memory(otherProfile, "fact", { type: "global" }, "ramen shop", at(t0));
    await memories.upsert(foreign);
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

    // Every scope listed: all of this profile's records, none of the other profile's.
    const allScopes = scopes.map(([, s]) => s);
    hits = await memories.search(textQuery(profile, allScopes, ["ramen"], 100));
    expect(hits).toHaveLength(scopes.length);
    expect(hitIds(hits).has(foreign.id)).toBe(false);

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
    const memories = store.memories;
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
    const memories = store.memories;
    const profile = unique("profile");
    const otherProfile = unique("profile");
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
    const foreign = mk("ramen", [1, 0, 0], 7);
    foreign.profile = otherProfile;
    for (const r of [both, textOnly, vectorOnly, otherDims, noEmbedding, otherScope, foreign]) {
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

  it("memory_list_filters", async () => {
    const memories = store.memories;
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
    await memories.upsert(memory(otherProfile, "fact", { type: "global" }, "x", at(t0)));

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
  });

  it("memory_touch", async () => {
    const memories = store.memories;
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
    const memories = store.memories;
    const profile = unique("profile");
    const otherProfile = unique("profile");
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
    const foreign = followup(otherProfile, now - HOUR);
    for (const r of [
      later,
      earlier,
      exactlyNow,
      future,
      noDue,
      done,
      superseded,
      notFollowup,
      foreign,
    ]) {
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
    const memories = store.memories;
    const profile = unique("profile");
    const otherProfile = unique("profile");
    const now = Date.now();
    const followup = (p: ProfileId, due: number) => {
      const r = memory(p, "followup", { type: "global" }, "ask", at(now - DAY));
      r.due = at(due);
      return r;
    };
    const fresh = followup(profile, now - 30 * MINUTE);
    const stale = followup(profile, now - 5 * HOUR);
    const ancient = followup(profile, now - 3 * DAY);
    const foreign = followup(otherProfile, now - 5 * HOUR);
    for (const r of [fresh, stale, ancient, foreign]) await memories.upsert(r);

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

    // Closing: everything that became due before the cut-off, in this profile only.
    expect(await memories.expireFollowups(profile, at(now - 4 * HOUR))).toBe(2);
    expect((await memories.get(ancient.id))?.done).toBe(true);
    expect((await memories.get(stale.id))?.done).toBe(true);
    expect((await memories.get(fresh.id))?.done).toBe(false);
    expect(await memories.expireFollowups(profile, at(now - 4 * HOUR))).toBe(0);
    expect(recordIds(await memories.dueFollowups(profile, at(now)))).toEqual([fresh.id]);
    expect(await memories.expireFollowups(profile, at(now - 10 * MINUTE))).toBe(1);
    expect(await memories.dueFollowups(profile, at(now))).toEqual([]);
    expect((await memories.get(foreign.id))?.done).toBe(false);
  });

  it("memory_prune", async () => {
    const memories = store.memories;
    const profile = unique("profile");
    const otherProfile = unique("profile");
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
    const foreign = mk(otherProfile, "episode", old, 0);
    const kept = [important, recentlyUsed, recent, fact, note, followup, foreign];
    const gone = [forgettable, atLimit, staleAccess];
    for (const r of [...gone, ...kept]) await memories.upsert(r);

    expect(await memories.prune(profile, policy)).toBe(3);
    expect(await memories.prune(profile, policy)).toBe(0);
    for (const r of gone) expect(await memories.get(r.id)).toBeNull();
    for (const r of kept) expect(await memories.get(r.id)).not.toBeNull();
  });

  it("memory_delete_by_subject", async () => {
    const memories = store.memories;
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
    const foreign = mk(otherProfile, { type: "global" }, [alice]);
    const gone = [aboutAlice, aboutBoth, aliceScope];
    const kept = [aboutBob, bobScope, unrelated, foreign];
    for (const r of [...gone, ...kept]) await memories.upsert(r);

    expect(await memories.deleteBySubject(profile, alice)).toBe(3);
    expect(await memories.deleteBySubject(profile, alice)).toBe(0);
    for (const r of gone) expect(await memories.get(r.id)).toBeNull();
    for (const r of kept) expect(await memories.get(r.id)).not.toBeNull();
    expect(await memories.deleteBySubject(otherProfile, alice)).toBe(1);
  });

  it("memory_merge_person", async () => {
    const memories = store.memories;
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
    const listed = await memories.list(profile, { ...baseFilter, subject: keep, limit: 10 });
    expect(idSet(listed)).toEqual(new Set([fact.id, both.id, followup.id]));
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
    expect(await memories.deleteBySubject(profile, keep)).toBe(4);
  });

  // ---- relationships and identity ---------------------------------------------------------

  it("relationships", async () => {
    const rel = store.relationships;
    const profile = unique("profile");
    const otherProfile = unique("profile");
    const alice = newId();
    const bob = newId();
    const now = Date.now();
    expect(await rel.get(profile, alice)).toBeNull();
    expect(await rel.list(profile)).toEqual([]);

    const a = relationship(profile, alice, now);
    await rel.upsert(a);
    expect(await rel.get(profile, alice)).toEqual(a);

    // Replaced as a whole, including cleared options.
    a.affinity = -30;
    a.tags = [];
    a.call_name = null;
    a.last_interaction = null;
    a.interactions = 10;
    await rel.upsert(a);
    expect(await rel.get(profile, alice)).toEqual(a);

    const b = relationship(profile, bob, now);
    await rel.upsert(b);
    await rel.upsert(relationship(otherProfile, alice, now));
    const expected = [a, b].sort((x, y) => (x.person < y.person ? -1 : 1));
    expect(await rel.list(profile)).toEqual(expected);
    expect(await rel.list(otherProfile)).toHaveLength(1);

    expect(await rel.delete(profile, alice)).toBe(true);
    expect(await rel.delete(profile, alice)).toBe(false);
    expect(await rel.get(profile, alice)).toBeNull();
    expect(await rel.get(otherProfile, alice)).not.toBeNull();
    expect(await rel.list(profile)).toEqual([b]);
  });

  it("relationship_deltas", async () => {
    const rel = store.relationships;
    const profile = unique("profile");
    const alice = newId();
    const bob = newId();
    const t0 = Date.now();

    // Recorded out of order; equal timestamps keep recording order.
    for (const [secs, reason] of [
      [3, "c"],
      [1, "a"],
      [2, "b1"],
      [2, "b2"],
      [5, "e"],
    ] as const) {
      await rel.recordDelta(profile, alice, delta(at(t0 + secs * SECOND), 1, reason));
    }
    await rel.recordDelta(profile, bob, delta(at(t0), 9, "bob"));
    await rel.recordDelta(unique("profile"), alice, delta(at(t0), 9, "other profile"));

    const reasonsSince = async (secs: number) =>
      (await rel.deltasSince(profile, alice, at(t0 + secs * SECOND))).map((d) => d.reason);
    expect(await reasonsSince(-10)).toEqual(["a", "b1", "b2", "c", "e"]);
    // Inclusive start.
    expect(await reasonsSince(2)).toEqual(["b1", "b2", "c", "e"]);
    expect(await reasonsSince(4)).toEqual(["e"]);
    expect(await reasonsSince(6)).toEqual([]);

    expect(await rel.deltasSince(profile, bob, at(t0 - SECOND))).toEqual([delta(at(t0), 9, "bob")]);

    // Deleting a relationship drops its history.
    await rel.upsert(relationship(profile, alice, t0));
    expect(await rel.delete(profile, alice)).toBe(true);
    expect(await reasonsSince(-10)).toEqual([]);
    expect(await rel.deltasSince(profile, bob, at(t0 - SECOND))).toHaveLength(1);
  });

  it("identity_link_and_merge", async () => {
    const people = store.people;
    const identity = store.identity;
    const a1 = account(unique("a1"));
    const a2 = account(unique("a2"));
    const unseen = account(unique("unseen"));
    const p1 = await people.upsertAccount(a1, "One");
    const p2 = await people.upsertAccount(a2, "Two");

    // An account that was never seen can be linked.
    await identity.linkAccount(unseen, p2);
    let accounts = await identity.accountsOf(p2);
    expect(accounts.map((a) => a.account)).toEqual([a2, unseen]);
    expect((await people.personByAccount(unseen))?.id).toBe(p2);

    // A later sighting keeps the link and sets the name.
    expect(await people.upsertAccount(unseen, "Seen")).toBe(p2);
    accounts = await identity.accountsOf(p2);
    expect(accounts[1]?.display_name).toBe("Seen");

    // Moving an account.
    await identity.linkAccount(unseen, p1);
    await identity.linkAccount(unseen, p1);
    expect(await identity.accountsOf(p1)).toHaveLength(2);
    expect(await identity.accountsOf(p2)).toHaveLength(1);

    await identity.setPersonName(p1, "Renamed");
    expect((await people.personByAccount(a1))?.display_name).toBe("Renamed");

    // Merge: everything of p2 moves to p1 and p2 is gone.
    await identity.mergePeople(p1, p2);
    const person = await people.personByAccount(a2);
    expect(person?.id).toBe(p1);
    expect(person?.display_name).toBe("Renamed");
    expect(person?.accounts).toHaveLength(3);
    expect(await identity.accountsOf(p2)).toEqual([]);
    await expect(identity.mergePeople(p1, p2)).rejects.toThrow(/unknown person/);
    await expect(identity.mergePeople(p2, p1)).rejects.toThrow(/unknown person/);
    await identity.mergePeople(p1, p1);
    expect(await identity.accountsOf(p1)).toHaveLength(3);

    // Unknown people are rejected.
    const ghost = newId();
    await expect(identity.linkAccount(account(unique("x")), ghost)).rejects.toThrow(
      /unknown person/,
    );
    await expect(identity.setPersonName(ghost, "Nobody")).rejects.toThrow(/unknown person/);
    expect(await identity.accountsOf(ghost)).toEqual([]);
  });

  it("identity_link_codes", async () => {
    const identity = store.identity;
    const issuer = account(unique("issuer"));
    const other = account(unique("other"));
    const now = Date.now();

    const code = unique("code");
    await identity.createLinkCode(code, issuer, at(now + 10 * MINUTE));
    expect(await identity.consumeLinkCode(code, at(now))).toEqual(issuer);
    // One use only.
    expect(await identity.consumeLinkCode(code, at(now))).toBeNull();
    expect(await identity.consumeLinkCode(unique("nope"), at(now))).toBeNull();

    // Expired, including exactly at the expiry instant.
    const expired = unique("code");
    await identity.createLinkCode(expired, issuer, at(now + MINUTE));
    expect(await identity.consumeLinkCode(expired, at(now + 2 * MINUTE))).toBeNull();
    // It is gone even for a valid time.
    expect(await identity.consumeLinkCode(expired, at(now))).toBeNull();
    const instant = unique("code");
    await identity.createLinkCode(instant, issuer, at(now));
    expect(await identity.consumeLinkCode(instant, at(now))).toBeNull();
    const almost = unique("code");
    // One microsecond later.
    await identity.createLinkCode(almost, issuer, `${at(now).slice(0, -1)}001Z`);
    expect(await identity.consumeLinkCode(almost, at(now))).toEqual(issuer);

    // Issuing the same code again replaces it.
    const reissued = unique("code");
    for (const who of [issuer, other]) {
      await identity.createLinkCode(reissued, who, at(now + 5 * MINUTE));
    }
    expect(await identity.consumeLinkCode(reissued, at(now))).toEqual(other);
  });

  // ---- authorization and audit ------------------------------------------------------------

  it("auth_roles", async () => {
    const auth = store.auth;
    const name = unique("role");
    const r = role(name, 50, false);
    const find = (roles: RoleDefinition[], n: string) => roles.filter((x) => x.name === n);
    expect(find(await auth.roles(), name)).toEqual([]);

    await auth.upsertRole(r);
    expect(find(await auth.roles(), name)).toEqual([r]);
    r.rank = 70;
    r.grants = ["*"];
    r.denies = [];
    await auth.upsertRole(r);
    expect(find(await auth.roles(), name)).toEqual([r]);

    // Highest rank first, then by name.
    const prefix = unique("ranked");
    const lowB = role(`${prefix}-b`, 10, false);
    const high = role(`${prefix}-z`, 90, false);
    const lowA = role(`${prefix}-a`, 10, false);
    for (const x of [lowB, high, lowA]) await auth.upsertRole(x);
    const ranked = (await auth.roles()).filter((x) => x.name.startsWith(prefix)).map((x) => x.name);
    expect(ranked).toEqual([high.name, lowA.name, lowB.name]);

    // Built-in roles can be edited, not deleted.
    const builtin = role(unique("builtin"), 100, true);
    await auth.upsertRole(builtin);
    await expect(auth.deleteRole(builtin.name)).rejects.toThrow(/is built in/);
    expect(find(await auth.roles(), builtin.name)).toEqual([builtin]);
    const edited = { ...builtin, grants: ["admin.*"] };
    await auth.upsertRole(edited);
    expect(find(await auth.roles(), builtin.name)).toEqual([edited]);

    // Deleting a role also removes what refers to it.
    const who = account(unique("who"));
    const scope = guildAuth(unique("g"));
    const guild = unique("g");
    await auth.assign(assignment(who, name, scope, "test", at(Date.now())));
    await auth.setMapping({ platform: "discord", guild, platform_role: "42", role: name });
    await auth.setOverride({ scope, role: name, node: "voice.join", allow: true });
    expect(await auth.deleteRole(name)).toBe(true);
    expect(await auth.deleteRole(name)).toBe(false);
    expect(find(await auth.roles(), name)).toEqual([]);
    expect(await auth.assignmentsFor(who)).toEqual([]);
    expect(await auth.mappings("discord", guild)).toEqual([]);
    expect((await auth.overrides()).every((o) => o.role !== name)).toBe(true);
  });

  it("auth_assignments", async () => {
    const auth = store.auth;
    const a = account(unique("a"));
    const b = account(unique("b"));
    const roleName = unique("role");
    const global: AuthScope = { type: "global" };
    const guild = guildAuth(unique("g"));
    const chan: AuthScope = { type: "channel", context: channel("g", unique("c"), "channel") };
    const t0 = Date.now();
    expect(await auth.assignmentsFor(a)).toEqual([]);

    const aGlobal = assignment(a, roleName, global, "config", at(t0));
    const aGuild = assignment(a, roleName, guild, "discord:1", at(t0 + SECOND));
    const bGlobal = assignment(b, roleName, global, "discord:1", at(t0 + 2 * SECOND));
    for (const x of [bGlobal, aGuild, aGlobal]) await auth.assign(x);
    // Oldest first.
    expect(await auth.assignmentsFor(a)).toEqual([aGlobal, aGuild]);
    const mine = (await auth.allAssignments()).filter((x) => x.role === roleName);
    expect(mine).toEqual([aGlobal, aGuild, bGlobal]);

    // Same (account, role, scope): replaced.
    const renewed = assignment(a, roleName, global, "discord:2", at(t0 + 3 * SECOND));
    await auth.assign(renewed);
    expect(await auth.assignmentsFor(a)).toEqual([aGuild, renewed]);

    expect(await auth.revoke(a, roleName, chan)).toBe(false);
    expect(await auth.revoke(a, "other-role", global)).toBe(false);
    expect(await auth.revoke(a, roleName, global)).toBe(true);
    expect(await auth.revoke(a, roleName, global)).toBe(false);
    expect(await auth.assignmentsFor(a)).toEqual([aGuild]);
    expect(await auth.assignmentsFor(b)).toEqual([bGlobal]);
  });

  it("auth_mappings_and_overrides", async () => {
    const auth = store.auth;
    const g1 = unique("g");
    const g2 = unique("g");
    const mapping = (guild: string, platformRole: string, r: string): RoleMapping => ({
      platform: "discord",
      guild,
      platform_role: platformRole,
      role: r,
    });
    expect(await auth.mappings("discord", g1)).toEqual([]);

    await auth.setMapping(mapping(g1, "222", "moderator"));
    await auth.setMapping(mapping(g1, "111", "user"));
    await auth.setMapping(mapping(g1, "111", "trusted"));
    await auth.setMapping(mapping(g2, "111", "admin"));
    expect(await auth.mappings("discord", g1)).toEqual([
      mapping(g1, "111", "trusted"),
      mapping(g1, "222", "moderator"),
    ]);
    expect(await auth.mappings("discord", g2)).toEqual([mapping(g2, "111", "admin")]);
    expect(await auth.mappings("twitch", g1)).toEqual([]);
    expect(await auth.removeMapping("discord", g1, "111")).toBe(true);
    expect(await auth.removeMapping("discord", g1, "111")).toBe(false);
    expect(await auth.mappings("discord", g1)).toHaveLength(1);
    expect(await auth.mappings("discord", g2)).toHaveLength(1);

    const roleName = unique("role");
    const guild = guildAuth(g1);
    const chan: AuthScope = { type: "channel", context: channel("g", unique("c"), "voice") };
    const over = (scope: AuthScope, node: string, allow: boolean): NodeOverride => ({
      scope,
      role: roleName,
      node,
      allow,
    });
    const mine = (all: NodeOverride[]) => all.filter((o) => o.role === roleName);
    expect(mine(await auth.overrides())).toEqual([]);

    await auth.setOverride(over(guild, "voice.join", true));
    await auth.setOverride(over(chan, "voice.join", true));
    await auth.setOverride(over(guild, "voice.join", false));
    await auth.setOverride(over(guild, "queue.add", true));
    const got = mine(await auth.overrides());
    expect(got).toHaveLength(3);
    for (const expected of [
      over(guild, "voice.join", false),
      over(chan, "voice.join", true),
      over(guild, "queue.add", true),
    ]) {
      expect(got).toContainEqual(expected);
    }

    expect(await auth.removeOverride(guild, roleName, "missing")).toBe(false);
    expect(await auth.removeOverride(guild, roleName, "voice.join")).toBe(true);
    expect(await auth.removeOverride(guild, roleName, "voice.join")).toBe(false);
    expect(mine(await auth.overrides())).toHaveLength(2);
  });

  it("audit_log", async () => {
    const audit = store.audit;
    const actor = unique("actor");
    const otherActor = unique("actor");
    const t0 = Date.now();
    const auditEntry = (who: string, action: string, secs: number): AuditEntry => ({
      id: newId(),
      at: at(t0 + secs * SECOND),
      actor: who,
      action,
      target: "discord:123",
      detail: { reason: "測試", n: [1, 2], nested: { ok: null } },
      ok: secs % 2 === 0,
    });
    const recent = async (limit: number, who: string | null) =>
      (await audit.recent(limit, who)).map((e) => e.action);
    expect(await recent(10, actor)).toEqual([]);

    // Appended out of order.
    const first = auditEntry(actor, "first", 1);
    for (const e of [
      auditEntry(actor, "third", 3),
      first,
      auditEntry(actor, "fourth", 4),
      auditEntry(actor, "second", 2),
      auditEntry(otherActor, "elsewhere", 2),
    ]) {
      await audit.append(e);
    }
    expect(await recent(10, actor)).toEqual(["fourth", "third", "second", "first"]);
    expect(await recent(2, actor)).toEqual(["fourth", "third"]);
    expect(await recent(0, actor)).toEqual([]);
    expect(await recent(10, otherActor)).toEqual(["elsewhere"]);
    expect(await recent(10, unique("nobody"))).toEqual([]);

    // Without an actor filter the same relative order holds.
    const ours = (await recent(100_000, null)).filter((a) =>
      ["first", "second", "third", "fourth"].includes(a),
    );
    expect(ours.length).toBeGreaterThanOrEqual(4);

    const got = await audit.recent(10, actor);
    expect(got.at(-1)).toEqual(first);
    await expect(audit.append(first), "duplicate id must fail").rejects.toThrow(/already exists/);
  });

  it("counts what someone wrote since a time, theirs only", async () => {
    const profile = unique("profile");
    const ctx = channel("guild", unique("chan"), "channel");
    const voice = channel("guild", unique("chan"), "voice");
    const theirs = (text: string, context: ContextKey, ms: number, id = "100"): LogEntry => ({
      ...entry(profile, context, text, at(ms)),
      author: account(id),
    });
    await store.messages.append(theirs("old", ctx, 0));
    await store.messages.append(theirs("a", ctx, 10_000));
    await store.messages.append(theirs("b", voice, 20_000));
    await store.messages.append(theirs("other", ctx, 30_000, "200"));
    await store.messages.append({ ...theirs("her", ctx, 40_000), is_self: true });
    await store.messages.append(theirs("c", ctx, 50_000));
    const got = await store.messages.authoredSince(profile, [account("100")], at(5_000), 10);
    expect(got.map((e) => e.kind)).toEqual(["channel", "voice", "channel"]);
    expect(Date.parse(got[0]?.ts ?? "")).toBe(Date.parse(at(10_000)));
    expect(
      await store.messages.authoredSince(profile, [account("100")], at(5_000), 2),
    ).toHaveLength(2);
    expect(await store.messages.authoredSince(profile, [], at(0), 10)).toEqual([]);
    const both = await store.messages.authoredSince(
      profile,
      [account("100"), account("200")],
      at(0),
      10,
    );
    expect(both).toHaveLength(5);
  });

  it("member cards: issued, found by serial, counted and deleted per account", async () => {
    const profile = unique("profile");
    const id = unique("acct");
    const linked = unique("acct");
    const serial = () => unique("MYR");
    const card = (who: string, ms: number, n: number): MemberCardRecord => ({
      serial: serial(),
      profile,
      account: account(who),
      person: who === id ? "person-1" : null,
      issued_at: at(ms),
      snapshot: { number: n, affinity: "很好", call_name: null },
    });
    const first = card(id, 10_000, 1);
    const second = card(linked, 20_000, 2);
    // Same instant: the later one is still the latest.
    const third = card(id, 20_000, 3);
    const other = card(unique("acct"), 30_000, 1);
    for (const c of [first, second, third, other]) await store.cards.issue(c);
    await expect(store.cards.issue(first), "duplicate serial must fail").rejects.toThrow(
      /already exists/,
    );

    const got = await store.cards.bySerial(profile, first.serial);
    expect(got).toEqual({ ...first, issued_at: got?.issued_at });
    expect(Date.parse(got?.issued_at ?? "")).toBe(10_000);
    expect(await store.cards.bySerial(unique("profile"), first.serial)).toBeNull();
    expect(await store.cards.bySerial(profile, "MYR-NONE")).toBeNull();

    const both = [account(id), account(linked)];
    const list = await store.cards.listFor(profile, both, 10);
    expect(list.map((c) => c.serial)).toEqual([third.serial, second.serial, first.serial]);
    expect((await store.cards.listFor(profile, both, 1)).map((c) => c.serial)).toEqual([
      third.serial,
    ]);
    expect(await store.cards.listFor(profile, [], 10)).toEqual([]);
    expect(await store.cards.countFor(profile, both)).toBe(3);
    expect(await store.cards.countFor(profile, [account(id)])).toBe(2);
    expect(await store.cards.countSince(profile, both, at(15_000))).toBe(2);
    expect(await store.cards.countSince(profile, [], at(0))).toBe(0);

    expect(await store.cards.deleteFor(profile, both)).toBe(3);
    expect(await store.cards.bySerial(profile, first.serial)).toBeNull();
    expect(await store.cards.countFor(profile, both)).toBe(0);
    expect(await store.cards.bySerial(profile, other.serial)).not.toBeNull();
  });

  it("coins: a wallet's sum, keys once per wallet, caps and the balance in one transaction", async () => {
    const profile = unique("profile");
    const id = unique("acct");
    const linked = unique("acct");
    const other = unique("acct");
    const wallet = [account(id), account(linked)];
    const coin = (who: string, delta: number, reason: string, key: string | null, ms: number) => ({
      id: newId(),
      profile,
      account: account(who),
      delta,
      reason,
      ref: null,
      idem_key: key,
      ts: at(ms),
    });

    const first = await store.coins.post(coin(id, 10, "checkin", "checkin:1", 1_000), { wallet });
    expect(first).toMatchObject({ status: "posted", balance: 10 });
    // The same key from the linked account is the same click.
    const again = await store.coins.post(coin(linked, 10, "checkin", "checkin:1", 2_000), {
      wallet,
    });
    expect(again.status).toBe("duplicate");
    expect(again.status === "duplicate" && again.entry.id).toBe(
      first.status === "posted" && first.entry.id,
    );
    expect(again).toMatchObject({ balance: 10 });
    // Someone else's key is theirs.
    expect(
      (await store.coins.post(coin(other, 5, "checkin", "checkin:1", 2_000), { wallet: [] }))
        .status,
    ).toBe("posted");

    // Caps: the voice cap is 4, the second earning gets what fits, the third nothing.
    const cap = { accounts: wallet, reasons: ["voice"], since: at(0), limit: 4 };
    const capped = { wallet, caps: [cap], partial: true };
    expect(await store.coins.post(coin(id, 3, "voice", "v:1", 3_000), capped)).toMatchObject({
      status: "posted",
      balance: 13,
    });
    const part = await store.coins.post(coin(linked, 3, "voice", "v:2", 4_000), capped);
    expect(part).toMatchObject({ status: "posted", balance: 14 });
    expect(part.status === "posted" && part.entry.delta).toBe(1);
    expect(await store.coins.post(coin(id, 3, "voice", "v:3", 5_000), capped)).toMatchObject({
      status: "capped",
      balance: 14,
    });
    // A cap over everyone (`accounts: null`), not partial.
    const total = { accounts: null, reasons: ["checkin"], since: at(0), limit: 16 };
    expect(
      (await store.coins.post(coin(id, 2, "checkin", null, 5_000), { wallet, caps: [total] }))
        .status,
    ).toBe("capped");

    // Spending needs the coins.
    expect(
      await store.coins.post(coin(id, -20, "feed", "f:1", 6_000), { wallet, covered: true }),
    ).toMatchObject({ status: "short", balance: 14 });
    expect(
      await store.coins.post(coin(linked, -14, "feed", "f:2", 7_000), { wallet, covered: true }),
    ).toMatchObject({ status: "posted", balance: 0 });
    await expect(
      store.coins.post({ ...coin(id, 1.5, "feed", null, 7_000) }, { wallet }),
    ).rejects.toThrow(/whole/);

    expect(await store.coins.balance(profile, wallet)).toBe(0);
    expect(await store.coins.balance(profile, [account(other)])).toBe(5);
    expect(await store.coins.balance(profile, [])).toBe(0);
    expect(await store.coins.balance(unique("profile"), wallet)).toBe(0);

    const all = await store.coins.entries(profile, wallet, { limit: 10 });
    expect(all.map((e) => e.idem_key)).toEqual(["f:2", "v:2", "v:1", "checkin:1"]);
    expect(all[0]).toMatchObject({ delta: -14, reason: "feed", account: account(linked) });
    expect(Date.parse(all[0]?.ts ?? "")).toBe(7_000);
    expect(
      (await store.coins.entries(profile, wallet, { reasons: ["voice"], limit: 10 })).length,
    ).toBe(2);
    expect(
      (await store.coins.entries(profile, wallet, { since: at(3_500), limit: 10 })).length,
    ).toBe(2);
    expect(await store.coins.entries(profile, wallet, { limit: 1 })).toHaveLength(1);
    expect(await store.coins.entries(profile, wallet, { reasons: [], limit: 9 })).toEqual([]);
    expect((await store.coins.byKey(profile, wallet, "v:2"))?.delta).toBe(1);
    expect(await store.coins.byKey(profile, [account(id)], "v:2")).toBeNull();

    // Frames: the latest choice of any account.
    expect(await store.coins.selectedFrame(profile, wallet)).toBeNull();
    await store.coins.selectFrame(profile, account(id), "sakura", at(1_000));
    await store.coins.selectFrame(profile, account(linked), "gold", at(2_000));
    expect(await store.coins.selectedFrame(profile, wallet)).toBe("gold");
    await store.coins.selectFrame(profile, account(linked), null, at(3_000));
    expect(await store.coins.selectedFrame(profile, wallet)).toBeNull();
    expect(await store.coins.selectedFrame(profile, [account(id)])).toBe("sakura");

    // The board is on unless someone left; leaving writes the whole wallet and keeps the frame.
    expect(await store.coins.onBoard(profile, wallet)).toBe(true);
    expect(await store.coins.offBoardAccounts(profile, 10)).toEqual([]);
    await store.coins.setOnBoard(profile, wallet, false);
    expect(await store.coins.onBoard(profile, wallet)).toBe(false);
    expect(await store.coins.onBoard(profile, [account(linked)])).toBe(false);
    expect(await store.coins.onBoard(profile, [account(other)])).toBe(true);
    expect(await store.coins.offBoardAccounts(profile, 10)).toHaveLength(2);
    expect(await store.coins.selectedFrame(profile, [account(id)])).toBe("sakura");
    await store.coins.setOnBoard(profile, wallet, true);
    expect(await store.coins.onBoard(profile, wallet)).toBe(true);
    expect(await store.coins.offBoardAccounts(profile, 10)).toEqual([]);
  });

  it("coins: concurrent spends never take the balance below zero", async () => {
    const profile = unique("profile");
    const id = unique("acct");
    const wallet = [account(id)];
    await store.coins.post(
      {
        id: newId(),
        profile,
        account: account(id),
        delta: 30,
        reason: "checkin",
        ref: null,
        idem_key: null,
        ts: at(1_000),
      },
      { wallet },
    );
    const spends = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        store.coins.post(
          {
            id: newId(),
            profile,
            account: account(id),
            delta: -10,
            reason: "feed",
            ref: null,
            idem_key: `f:${i}`,
            ts: at(2_000 + i),
          },
          { wallet, covered: true },
        ),
      ),
    );
    expect(spends.filter((s) => s.status === "posted")).toHaveLength(3);
    expect(await store.coins.balance(profile, wallet)).toBe(0);
  });

  it("deals: kept per wallet, statuses move once and only from where they were", async () => {
    const profile = unique("profile");
    const id = unique("acct");
    const linked = unique("acct");
    const other = unique("acct");
    const wallet = [account(id), account(linked)];
    const deal = (who: string, ms: number, task: string): Deal => ({
      id: newId(),
      profile,
      account: account(who),
      item: "rice",
      count: 2,
      value: 20,
      task,
      prepaid: false,
      escrow: null,
      status: "open",
      created_at: at(ms),
      done_at: null,
      due_at: null,
      closed_at: null,
    });
    const first = deal(id, 1_000, "meow");
    const second = deal(linked, 2_000, "sing");
    const third = deal(other, 3_000, "dance");
    for (const d of [first, second, third]) await store.deals.create(d);
    expect(await store.deals.get(first.id)).toEqual(first);
    expect(await store.deals.get(newId())).toBeNull();

    // A wallet is every account of the person; newest first.
    const mine = await store.deals.forAccounts(profile, wallet, { limit: 10 });
    expect(mine.map((d) => d.task)).toEqual(["sing", "meow"]);
    expect(await store.deals.forAccounts(profile, wallet, { limit: 1 })).toHaveLength(1);
    expect(await store.deals.forAccounts(profile, wallet, { since: at(1_500), limit: 9 })).toEqual([
      second,
    ]);
    expect(await store.deals.forAccounts(profile, [], { limit: 9 })).toEqual([]);
    expect(await store.deals.forAccounts(profile, wallet, { statuses: [], limit: 9 })).toEqual([]);
    expect(await store.deals.forAccounts(unique("profile"), wallet, { limit: 9 })).toEqual([]);

    // A status moves once, from where it was, with the times it sets.
    const done = { status: "owed" as const, done_at: at(5_000), due_at: at(9_000) };
    expect(await store.deals.transition(first.id, ["open"], done)).toBe(true);
    expect(await store.deals.transition(first.id, ["open"], done)).toBe(false);
    expect(await store.deals.transition(first.id, [], done)).toBe(false);
    expect(await store.deals.transition(newId(), ["open"], done)).toBe(false);
    expect(await store.deals.get(first.id)).toMatchObject({
      status: "owed",
      done_at: at(5_000),
      due_at: at(9_000),
      closed_at: null,
    });
    // Fields left out stay, `null` clears.
    expect(
      await store.deals.transition(first.id, ["owed"], {
        status: "broken",
        closed_at: at(9_500),
        due_at: null,
      }),
    ).toBe(true);
    expect(await store.deals.get(first.id)).toMatchObject({
      status: "broken",
      done_at: at(5_000),
      due_at: null,
      closed_at: at(9_500),
    });

    const open = await store.deals.byStatus(profile, ["open", "owed"], { limit: 10 });
    expect(open.map((d) => d.task)).toEqual(["sing", "dance"]);
    expect(await store.deals.byStatus(profile, ["broken"], { limit: 10 })).toHaveLength(1);
    expect(await store.deals.byStatus(profile, [], { limit: 10 })).toEqual([]);
    expect(await store.deals.byStatus(profile, ["open"], { since: at(2_500), limit: 10 })).toEqual([
      third,
    ]);
    const broken = await store.deals.forAccounts(profile, wallet, {
      statuses: ["broken"],
      limit: 10,
    });
    expect(broken.map((d) => d.id)).toEqual([first.id]);

    // A prepaid deal keeps its escrow row.
    const paid = { ...deal(id, 4_000, "escrowed"), prepaid: true, escrow: newId() };
    await store.deals.create(paid);
    expect(await store.deals.get(paid.id)).toMatchObject({ prepaid: true, escrow: paid.escrow });
  });

  it("goals and bounties: pledges kept per goal, statuses move once and only from where they were", async () => {
    const profile = unique("profile");
    const goal = (ms: number, title: string): Goal => ({
      id: newId(),
      profile,
      title,
      promise: "meow",
      target: 50,
      status: "open",
      created_at: at(ms),
      deadline: at(ms + 5_000),
      closed_at: null,
    });
    const first = goal(1_000, "mic");
    const second = goal(2_000, "lamp");
    for (const g of [first, second]) await store.goals.create(g);
    expect(await store.goals.get(first.id)).toEqual(first);
    expect(await store.goals.get(newId())).toBeNull();
    expect((await store.goals.list(profile, { limit: 9 })).map((g) => g.title)).toEqual([
      "lamp",
      "mic",
    ]);
    expect(await store.goals.list(profile, { statuses: [], limit: 9 })).toEqual([]);
    expect(await store.goals.list(unique("profile"), { limit: 9 })).toEqual([]);

    const pledge = (g: Goal, who: string, amount: number, ms: number): GoalPledge => ({
      id: newId(),
      goal: g.id,
      profile,
      account: account(who),
      amount,
      created_at: at(ms),
    });
    const a = pledge(first, unique("acct"), 20, 1_100);
    const b = pledge(first, unique("acct"), 5, 1_200);
    for (const p of [b, a]) await store.goals.addPledge(p);
    await store.goals.addPledge(pledge(second, unique("acct"), 1, 2_100));
    expect(await store.goals.pledges(first.id)).toEqual([a, b]);
    await expect(store.goals.addPledge(a)).rejects.toThrow();

    const closed = at(3_000);
    expect(
      await store.goals.transition(first.id, ["open"], { status: "reached", closed_at: closed }),
    ).toBe(true);
    expect(await store.goals.transition(first.id, ["open"], { status: "expired" })).toBe(false);
    expect(await store.goals.transition(first.id, [], { status: "open" })).toBe(false);
    expect(await store.goals.get(first.id)).toMatchObject({ status: "reached", closed_at: closed });
    expect(
      (await store.goals.list(profile, { statuses: ["open"], limit: 9 })).map((g) => g.title),
    ).toEqual(["lamp"]);

    const bounty = (ms: number, task: string): Bounty => ({
      id: newId(),
      profile,
      task,
      reward: 30,
      hold: newId(),
      status: "open",
      created_at: at(ms),
      expires_at: at(ms + 5_000),
      closed_at: null,
      winner: null,
    });
    const one = bounty(1_000, "guess");
    const two = bounty(2_000, "draw");
    for (const x of [one, two]) await store.bounties.create(x);
    expect(await store.bounties.get(one.id)).toEqual(one);
    expect((await store.bounties.list(profile, { limit: 9 })).map((x) => x.task)).toEqual([
      "draw",
      "guess",
    ]);
    const winner = account(unique("acct"));
    expect(
      await store.bounties.transition(one.id, ["open"], {
        status: "awarded",
        closed_at: closed,
        winner,
      }),
    ).toBe(true);
    expect(await store.bounties.transition(one.id, ["open"], { status: "cancelled" })).toBe(false);
    expect(await store.bounties.get(one.id)).toMatchObject({ status: "awarded", winner });
    expect(
      (await store.bounties.list(profile, { statuses: ["open"], limit: 9 })).map((x) => x.task),
    ).toEqual(["draw"]);
    expect(await store.bounties.transition(two.id, ["open"], { status: "expired" })).toBe(true);
    expect(await store.bounties.get(two.id)).toMatchObject({ status: "expired", winner: null });
  });

  // ---- TS-specific ------------------------------------------------------------------------

  it("timestamps keep microseconds and are normalized to UTC", async () => {
    const profile = unique("profile");
    const ctx = channel("guild", unique("chan"), "channel");
    const precise = entry(profile, ctx, "precise", "2026-03-10T12:00:00.123456789Z");
    const offset = entry(profile, ctx, "offset", "2026-03-10T20:00:01.5+08:00");
    await store.messages.append(precise);
    await store.messages.append(offset);
    const got = await store.messages.recent(profile, ctx, 10);
    expect(got.map((e) => e.ts)).toEqual([
      "2026-03-10T12:00:00.123456Z",
      "2026-03-10T12:00:01.500Z",
    ]);
    await expect(store.messages.append(entry(profile, ctx, "bad", "yesterday"))).rejects.toThrow(
      /invalid timestamp/,
    );
  });

  it("embeddings read back as the shortest float32 decimals", async () => {
    const r = memory(unique("profile"), "fact", { type: "global" }, "x", at(Date.now()));
    r.embedding = [0.1, 0.9, -1e-7, 3];
    await store.memories.upsert(r);
    expect((await store.memories.get(r.id))?.embedding).toEqual([0.1, 0.9, -1e-7, 3]);
  });

  it("full-text tokens are literal (quotes, operators, CJK)", async () => {
    const profile = unique("profile");
    const scopes: MemoryScope[] = [{ type: "global" }];
    const r = memory(profile, "fact", { type: "global" }, "owen 喜歡 拉麵 or", at(Date.now()));
    await store.memories.upsert(r);
    const search = (tokens: string[]) =>
      store.memories.search(textQuery(profile, scopes, tokens, 10));
    expect(hitIds(await search(["拉麵"]))).toEqual(new Set([r.id]));
    expect(hitIds(await search(["OR"]))).toEqual(new Set([r.id]));
    expect(hitIds(await search(["  Owen  ", "owen"]))).toEqual(new Set([r.id]));
    for (const weird of ['"', 'a"b', "!!", "NEAR(", "*", "-", "x:y", "AND", "NOT"]) {
      expect(await search([weird])).toEqual([]);
    }
    expect(hitIds(await search(['"', "拉麵"]))).toEqual(new Set([r.id]));
  });

  it("counts, exports and wipes one profile's data by category", async () => {
    const profile = unique("profile");
    const other = unique("profile");
    const person = unique("person") as PersonId;
    const ctx = channel(unique("g"), "chan", "channel");
    const t0 = Date.UTC(2026, 0, 1);
    for (const p of [profile, other]) {
      await store.memories.upsert(memory(p, "fact", guildScope("g"), "喜歡貓", at(t0)));
      await store.memories.upsert(memory(p, "episode", guildScope("g"), "一起玩", at(t0)));
      await store.relationships.upsert(relationship(p, person, t0));
      await store.relationships.recordDelta(p, person, delta(at(t0), 1, "nice"));
      await store.cards.issue({
        serial: unique("MYR"),
        profile: p,
        account: account("100"),
        person,
        issued_at: at(t0),
        snapshot: { affinity: "很好" },
      });
      await store.coins.post(
        {
          id: newId(),
          profile: p,
          account: account("100"),
          delta: 10,
          reason: "checkin",
          ref: null,
          idem_key: null,
          ts: at(t0),
        },
        { wallet: [] },
      );
      await store.messages.append(entry(p, ctx, "嗨", at(t0)));
      await store.decisions.append(decision(p, ctx, "replied", at(t0)));
      await store.decisions.appendOutcome?.(p, outcome(ctx, "sent", at(t0)));
      await store.personaOverrides.set(p, "style", "新的口吻", "test");
      for (const [key, value] of [
        ["memory_maintenance_last", "2026-01-01T00:00:00Z"],
        ["memory_watermark:a", { at: 1 }],
        ["memory_watermark:b", { at: 2 }],
        ["mood:last", { v: 1 }],
        ["self:state", { boredom: 0.5 }],
        ["self:feeling:p1", { text: "在意" }],
        ["channel_mode:discord:g:c", "always"],
        ["activeness:discord:g:c", "high"],
        ["sandbox:tool:t", { name: "t" }],
        ["ext:hello:k", 1],
      ] as const) {
        await store.settings.set(p, key, value);
      }
    }
    const inventory = await store.profileData.inventory(profile);
    const count = (id: string) => inventory.categories.find((c) => c.id === id)?.count;
    expect(inventory.profile).toBe(profile);
    expect(count("memories")).toBe(3); // two records + the maintenance key
    expect(inventory.categories.find((c) => c.id === "memories")?.breakdown).toEqual({
      fact: 1,
      episode: 1,
    });
    expect(count("relationships")).toBe(4); // relationship, delta, card, coins
    expect(count("call_names")).toBe(1);
    expect(count("inner")).toBe(2);
    expect(count("mood")).toBe(1);
    expect(count("messages")).toBe(3); // one line + two watermarks
    expect(count("decisions")).toBe(2); // decision log + turn outcome
    expect(count("channels")).toBe(2);
    expect(count("persona")).toBe(1);
    expect(count("proposed_tools")).toBe(1);
    expect(count("extensions")).toBe(1);
    const messages = inventory.categories.find((c) => c.id === "messages");
    expect(messages?.parts.map((p) => [p.id, p.count])).toEqual([
      ["message_log", 1],
      ["memory_watermarks", 2],
    ]);
    expect(messages?.updated_at).not.toBeNull();

    const backup = await store.profileData.export(profile, ["memories", "messages", "call_names"]);
    expect(backup).toMatchObject({ format: "miyoria.data", version: 1, profile });
    expect(backup.categories).toEqual(["memories", "call_names", "messages"]);
    expect(backup.parts.memory_records).toHaveLength(2);
    expect(backup.parts.memory_records?.[0]).toMatchObject({ kind: "fact", done: false });
    expect(backup.parts.memory_records?.[0]).not.toHaveProperty("embedding");
    expect(backup.parts.message_log?.[0]).toMatchObject({ text: "嗨", is_self: false, ts: at(t0) });
    expect(backup.parts.memory_watermarks?.map((r) => [r.key, r.value])).toEqual([
      ["memory_watermark:a", { at: 1 }],
      ["memory_watermark:b", { at: 2 }],
    ]);
    expect(backup.parts.call_names).toEqual([{ person_id: person, call_name: "歐文" }]);

    // Call names are cleared, the relationship stays.
    expect(await store.profileData.wipe(profile, ["call_names"])).toEqual({ call_names: 1 });
    expect((await store.relationships.get(profile, person))?.call_name).toBeNull();

    // Each category alone, then nothing of it is left and the rest is untouched.
    const counts = await store.profileData.wipe(profile, ["messages"]);
    expect(counts).toEqual({
      message_log: 1,
      memory_watermarks: 2,
      conversation_states: 0,
      log_events: 0,
      log_event_rollups: 0,
    });
    expect(await store.messages.recent(profile, ctx, 9)).toEqual([]);
    expect((await store.settings.list(profile, "memory_watermark:")).size).toBe(0);
    expect(await store.memories.list(profile, { ...baseFilter, limit: 9 })).toHaveLength(2);

    expect(
      await store.profileData.wipe(profile, [
        "memories",
        "relationships",
        "inner",
        "mood",
        "decisions",
        "channels",
        "persona",
        "proposed_tools",
        "extensions",
      ]),
    ).toEqual({
      memory_records: 2,
      memory_maintenance: 1,
      relationships: 1,
      relationship_deltas: 1,
      member_cards: 1,
      coin_ledger: 1,
      coin_wallets: 0,
      fortunes: 0,
      deals: 0,
      goals: 0,
      goal_pledges: 0,
      bounties: 0,
      self_state: 1,
      self_feelings: 1,
      self_cards_migration: 0,
      mind_thoughts: 0,
      mind_digests: 0,
      mind_goals: 0,
      mood: 1,
      decision_log: 1,
      turn_outcomes: 1,
      channel_modes: 1,
      channel_activeness: 1,
      persona_overrides: 1,
      proposed_tools: 1,
      extension_storage: 1,
    });
    expect(await store.memories.list(profile, { ...baseFilter, limit: 9 })).toEqual([]);
    expect(await store.relationships.get(profile, person)).toBeNull();
    expect(await store.decisions.recent(profile, null, 9)).toEqual([]);
    expect((await store.personaOverrides.current(profile)).size).toBe(0);
    expect([...(await store.settings.list(profile, "")).keys()]).toEqual([]);
    const after = await store.profileData.inventory(profile);
    for (const c of after.categories) {
      if (!dataCategory(c.id).shared && c.id !== "other_settings") expect(c.count, c.id).toBe(0);
    }

    // Other profiles are untouched.
    expect(await store.memories.list(other, { ...baseFilter, limit: 9 })).toHaveLength(2);
    expect(await store.messages.recent(other, ctx, 9)).toHaveLength(1);
    expect((await store.settings.list(other, "")).size).toBe(10);
    expect((await store.relationships.get(other, person))?.call_name).toBe("歐文");

    // Kept categories cannot be wiped; unknown ones are refused.
    await expect(store.profileData.wipe(profile, ["audit"])).rejects.toThrow(/kept/);
    await expect(store.profileData.wipe(profile, ["nope" as never])).rejects.toThrow(/unknown/);
  });

  it("purges messages and deletes settings by prefix", async () => {
    const profile = unique("profile");
    const ctx = channel(unique("g"), "chan", "channel");
    await store.messages.append(entry(profile, ctx, "a", at(0)));
    await store.messages.append(entry(profile, channel(null, "dm", "dm"), "b", at(0)));
    expect(await store.messages.purge(profile)).toBe(2);
    expect(await store.messages.recent(profile, ctx, 9)).toEqual([]);
    await store.settings.set(profile, "a%:1", 1);
    await store.settings.set(profile, "a%:2", 2);
    await store.settings.set(profile, "ab:3", 3);
    expect(await store.settings.deletePrefix(profile, "a%:")).toBe(2);
    expect([...(await store.settings.list(profile, "")).keys()]).toEqual(["ab:3"]);
  });

  it("scopes match whatever their key order", async () => {
    const profile = unique("profile");
    const guild = unique("g");
    const r = memory(profile, "fact", { type: "guild", platform: "discord", guild }, "x", at(0));
    await store.memories.upsert(r);
    const reordered = JSON.parse(`{"guild":"${guild}","platform":"discord","type":"guild"}`);
    const listed = await store.memories.list(profile, {
      ...baseFilter,
      scope: reordered,
      limit: 9,
    });
    expect(recordIds(listed)).toEqual([r.id]);
  });
}

// ---- backends -----------------------------------------------------------------------------

describe("sqlite (in memory)", () => {
  behaviour(() => openStore("sqlite::memory:"));
});

describe("sqlite (file)", () => {
  const dir = mkdtempSync(join(tmpdir(), "miyoria-store-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  // One file for every case (each case uses fresh ids), reopened per case.
  behaviour(() => openStore(`sqlite:${join(dir, "nested", "behaviour.db")}`));
});

const pgUrl = process.env[DB_ENV];
describe.skipIf(!pgUrl)("postgres", () => {
  behaviour(() => openStore(pgUrl as string));
});

/** The in-memory backend keeps only the newest decisions of each profile. */
it("memory_decision_log_cap", async () => {
  const CAP = 10_000;
  const store = await openStore("memory://");
  try {
    const profile = unique("profile");
    const ctx = channel("guild", "chan", "channel");
    const t0 = Date.now();
    for (let i = 0; i <= CAP; i++) {
      await store.decisions.append(decision(profile, ctx, String(i), at(t0 + i * SECOND)));
    }
    const all = await store.decisions.recent(profile, null, Number.POSITIVE_INFINITY);
    expect(all).toHaveLength(CAP);
    expect(all[0]?.trace.reasons[0]).toBe(String(CAP));
    expect(all[CAP - 1]?.trace.reasons[0]).toBe("1");
  } finally {
    await store.close();
  }
});
