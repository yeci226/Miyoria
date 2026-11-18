// One behaviour suite, run against SQLite in memory and on a file. Every case uses fresh ids, so
// the file runs share one database.

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
// The auth plugin's tables are its own package's (v5-data §8 step 9a); their cases stay here.
import { authTables } from "../../auth/src/tables.js";
// The memory plugin's (step 9b): its cases are its package's, the data categories' stay here.
import { memoryTables } from "../../memory/memory/src/tables.js";
import {
  type AuditEntry,
  type AuthScope,
  type DecisionRecord,
  dataCategory,
  type LogEntry,
  type MemberCardRecord,
  type MemoryFilter,
  type MemoryKind,
  type MemoryRecord,
  type MemoryScope,
  type NodeOverride,
  openStore,
  type Relationship,
  type RelationshipDelta,
  type RoleAssignment,
  type RoleDefinition,
  type RoleMapping,
  type Store,
} from "../src/index.js";

const SECOND = 1000;
const MINUTE = 60 * SECOND;

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
    // A DM is placed by the person she talks with there: their line first (a line of hers in a
    // DM nobody has written in yet is stored, without a place, and not read back here).
    const theirs = entry(profile, ctx, "在嗎", at(Date.now() - 1000));
    const e = entry(profile, ctx, "她說的話", at(Date.now()));
    e.author = account("999");
    e.author_name = "Miyori";
    e.is_self = true;
    e.turn = newId();
    await log.append(theirs);
    await log.append(e);
    expect(await log.recent(profile, ctx, 10)).toEqual([theirs, e]);
    await expect(log.append(e), "duplicate id must fail").rejects.toThrow(/already exists/);
  });

  it("message_log_isolation", async () => {
    const log = store.messages;
    const profile = unique("profile");
    const id = unique("chan");
    const textCtx = channel("guild", id, "channel");
    const voiceCtx = channel("guild", id, "voice");
    const otherGuild = channel("other", id, "channel");
    const now = at(Date.now());
    await log.append(entry(profile, textCtx, "text", now));
    await log.append(entry(profile, voiceCtx, "voice", now));
    await log.append(entry(profile, otherGuild, "other", now));

    // Places apart; profiles are not: one database belongs to one character.
    expect(texts(await log.recent(profile, textCtx, 10))).toEqual(["text"]);
    expect(texts(await log.recent(profile, voiceCtx, 10))).toEqual(["voice"]);
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

  // Persona edits are one set per database, whatever profile a caller names (one database is one
  // character), and the file runs share one database: these cases use sections of their own.
  it("persona_overrides", async () => {
    const overrides = store.personaOverrides;
    const profile = unique("profile");
    const other = unique("profile");
    const style = unique("style");
    const identity = unique("identity");
    const mine = async (p: string) =>
      [...(await overrides.current(p))].filter(([k]) => k === style || k === identity);
    expect(await mine(profile)).toEqual([]);
    expect(await overrides.history(profile, style)).toEqual([]);

    expect(await overrides.set(profile, style, "v1", "panel:owen")).toBe(1);
    expect(await overrides.set(profile, style, "v2", "discord:1")).toBe(2);
    expect(await overrides.set(profile, identity, "id", "panel:owen")).toBe(1);

    expect(await mine(profile)).toEqual([
      [identity, "id"],
      [style, "v2"],
    ]);
    // Another profile edits the same sections.
    expect(await overrides.set(other, style, "v3", "panel:owen")).toBe(3);
    expect(await mine(profile)).toEqual([
      [identity, "id"],
      [style, "v3"],
    ]);

    const history = (await overrides.history(profile, style)).slice(0, 2);
    expect(history.map((o) => [o.version, o.body, o.edited_by])).toEqual([
      [1, "v1", "panel:owen"],
      [2, "v2", "discord:1"],
    ]);
    expect(history.every((o) => o.profile === profile && o.key === style)).toBe(true);
    const [first, second] = history;
    expect(Date.parse(first?.edited_at ?? "")).toBeLessThanOrEqual(
      Date.parse(second?.edited_at ?? ""),
    );
  });

  it("persona_overrides_concurrent", async () => {
    const profile = unique("profile");
    const style = unique("style");
    const versions = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        store.personaOverrides.set(profile, style, `edit ${i}`, "test"),
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

  // Reading decisions and turn outcomes back per place and since a time is pinned in
  // decision-log.test.ts on fresh databases: they are the whole database's (one character).

  // The coin ledger, the wallets, fortune slips, bounties and economy 2.0's
  // documents are the economy plugin's tables (v5-data §8 step 9a):
  // `packages/economy/test/tables.test.ts` pins them.

  // Settings are one key space per database, whatever profile a caller names (one database is
  // one character), so these cases keep their keys under a prefix of their own.
  it("settings", async () => {
    const settings = store.settings;
    const profile = unique("profile");
    const other = unique("profile");
    const ns = `${unique("settings")}/`;
    expect(await settings.get(profile, `${ns}mode:general`)).toBeNull();
    expect((await settings.list(profile, ns)).size).toBe(0);

    const chatty = { mode: "chatty", n: 2 };
    await settings.set(profile, `${ns}mode:general`, "quiet");
    await settings.set(profile, `${ns}mode:general`, chatty);
    await settings.set(profile, `${ns}mode:dm`, [null]);
    expect(await settings.get(profile, `${ns}mode:general`)).toEqual(chatty);
    expect(await settings.get(profile, `${ns}mode:dm`)).toEqual([null]);
    // Another profile reads the same key.
    expect(await settings.get(other, `${ns}mode:general`)).toEqual(chatty);

    // Deleting (`null`; the TS interface has no stored JSON `null`), also of a missing key.
    await settings.set(profile, `${ns}mode:dm`, null);
    await settings.set(profile, `${ns}mode:missing`, null);
    expect(await settings.get(profile, `${ns}mode:dm`)).toBeNull();
    expect(await settings.get(other, `${ns}mode:general`)).toEqual(chatty);
  });

  it("settings_list_prefix", async () => {
    const settings = store.settings;
    const profile = unique("profile");
    const ns = `${unique("settings")}/`;
    const keys = ["mode:b", "mode:a", "mode_x", "modeX:y", "mo%de:1", "other", "MODE:c"];
    for (const [i, key] of keys.entries()) await settings.set(profile, `${ns}${key}`, i);
    // Written under another profile, listed with the rest.
    await settings.set(unique("profile"), `${ns}mode:z`, 0);

    const listed: string[][] = [];
    for (const prefix of ["mode:", "mode_", "mo%", "mo", "mode:a", "nothing", ""]) {
      const found = [...(await settings.list(profile, `${ns}${prefix}`)).keys()];
      listed.push(found.map((k) => k.slice(ns.length)));
    }
    // `_` and `%` are literal, and matching is case-sensitive.
    expect(listed).toEqual([
      ["mode:a", "mode:b", "mode:z"],
      ["mode_x"],
      ["mo%de:1"],
      ["mo%de:1", "mode:a", "mode:b", "mode:z", "modeX:y", "mode_x"],
      ["mode:a"],
      [],
      ["MODE:c", "mo%de:1", "mode:a", "mode:b", "mode:z", "modeX:y", "mode_x", "other"],
    ]);
    const list = await settings.list(profile, `${ns}mode:`);
    expect(list.get(`${ns}mode:a`)).toBe(1);
    expect(list.get(`${ns}mode:b`)).toBe(0);
  });

  it("from_url_memory", async () => {
    const memoryStore = await openStore("memory://");
    try {
      expect((await memoryStore.moduleState.list()).size).toBe(0);
    } finally {
      await memoryStore.close();
    }
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
    const auth = store.plugin(authTables).store;
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
    const auth = store.plugin(authTables).store;
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
    const auth = store.plugin(authTables).store;
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
    // Accounts of this case only: the count is of the whole database (the file runs share one).
    const owen = unique("100");
    const amy = unique("200");
    const theirs = (text: string, context: ContextKey, ms: number, id = owen): LogEntry => ({
      ...entry(profile, context, text, at(ms)),
      author: account(id),
    });
    await store.messages.append(theirs("old", ctx, 0));
    await store.messages.append(theirs("a", ctx, 10_000));
    await store.messages.append(theirs("b", voice, 20_000));
    await store.messages.append(theirs("other", ctx, 30_000, amy));
    await store.messages.append({ ...theirs("her", ctx, 40_000), is_self: true });
    await store.messages.append(theirs("c", ctx, 50_000));
    const got = await store.messages.authoredSince(profile, [account(owen)], at(5_000), 10);
    expect(got.map((e) => e.kind)).toEqual(["channel", "voice", "channel"]);
    expect(Date.parse(got[0]?.ts ?? "")).toBe(Date.parse(at(10_000)));
    expect(await store.messages.authoredSince(profile, [account(owen)], at(5_000), 2)).toHaveLength(
      2,
    );
    expect(await store.messages.authoredSince(profile, [], at(0), 10)).toEqual([]);
    const both = await store.messages.authoredSince(
      profile,
      [account(owen), account(amy)],
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

  it("counts, exports and wipes one profile's data by category", async () => {
    const profile = unique("profile");
    const other = unique("profile");
    const person = unique("person") as PersonId;
    const ctx = channel(unique("g"), "chan", "channel");
    const t0 = Date.UTC(2026, 0, 1);
    // The memories are the character's (one database, no profile column): written once.
    const memories = store.plugin(memoryTables);
    await memories.upsert(memory(profile, "fact", guildScope("g"), "喜歡貓", at(t0)));
    await memories.upsert(memory(profile, "episode", guildScope("g"), "一起玩", at(t0)));
    for (const p of [profile, other]) {
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
      // No chat line, decision or turn outcome: the event log is the whole database's (one
      // character), and the file runs share one database. data.test.ts, chat.test.ts and
      // decision-log.test.ts cover them on fresh ones.
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
    expect(count("relationships")).toBe(3); // relationship, delta, card
    expect(count("call_names")).toBe(1);
    expect(count("inner")).toBe(2);
    expect(count("mood")).toBe(1);
    expect(count("messages")).toBeGreaterThanOrEqual(2); // two watermarks, any chat lines
    await store.decisions.append(decision(profile, ctx, "replied", at(t0)));
    await store.decisions.appendOutcome?.(profile, outcome(ctx, "sent", at(t0)));
    // The whole database's: other cases may have written some on the file.
    expect(
      (await store.profileData.inventory(profile)).categories.find((c) => c.id === "decisions")
        ?.count,
    ).toBeGreaterThanOrEqual(2);
    expect(count("channels")).toBe(2);
    // The whole database's: other cases edit persona sections on the file.
    expect(count("persona")).toBeGreaterThanOrEqual(1);
    expect(count("proposed_tools")).toBe(1);
    expect(count("extensions")).toBe(1);
    const messages = inventory.categories.find((c) => c.id === "messages");
    expect(messages?.parts.map((p) => p.id)).toEqual(["message_log", "memory_watermarks"]);
    expect(messages?.parts.find((p) => p.id === "memory_watermarks")?.count).toBe(2);
    expect(messages?.updated_at).not.toBeNull();

    const backup = await store.profileData.export(profile, ["memories", "messages", "call_names"]);
    expect(backup).toMatchObject({ format: "miyoria.data", version: 1, profile });
    expect(backup.categories).toEqual(["memories", "call_names", "messages"]);
    expect(backup.parts.memory_records).toHaveLength(2);
    expect(backup.parts.memory_records?.[0]).toMatchObject({ kind: "fact", done: false });
    expect(backup.parts.memory_records?.[0]).not.toHaveProperty("embedding");
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
    expect(counts).toMatchObject({
      memory_watermarks: 2,
      conversation_states: 0,
      events: 0,
      event_rollups: 0,
    });
    expect((await store.settings.list(profile, "memory_watermark:")).size).toBe(0);
    expect(await memories.list(profile, { ...baseFilter, limit: 9 })).toHaveLength(2);

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
      // The coins, slips, bounties and documents are the economy plugin's, which
      // this store was not opened with: no tables, nothing to count.
      self_state: 1,
      self_feelings: 1,
      self_cards_migration: 0,
      mind_thoughts: 0,
      mind_digests: 0,
      mind_goals: 0,
      mood: 1,
      decision_log: expect.any(Number),
      turn_outcomes: expect.any(Number),
      channel_modes: 1,
      channel_activeness: 1,
      persona_overrides: expect.any(Number),
      proposed_tools: 1,
      extension_storage: 1,
    });
    expect(await memories.list(profile, { ...baseFilter, limit: 9 })).toEqual([]);
    expect(await store.relationships.get(profile, person)).toBeNull();
    expect(await store.decisions.recent(profile, null, 9)).toEqual([]);
    expect((await store.personaOverrides.current(profile)).size).toBe(0);
    // The file runs share one database: only this case's keys are looked at.
    const seeded = [
      "memory_maintenance_last",
      "memory_watermark:",
      "mood:last",
      "self:",
      "channel_mode:discord:g:c",
      "activeness:discord:g:c",
      "sandbox:tool:t",
      "ext:hello:k",
    ];
    for (const prefix of seeded) {
      expect([...(await store.settings.list(profile, prefix)).keys()], prefix).toEqual([]);
    }
    const after = await store.profileData.inventory(profile);
    for (const c of after.categories) {
      if (!dataCategory(c.id).shared && c.id !== "other_settings") expect(c.count, c.id).toBe(0);
    }

    // Other profiles are untouched, but for the settings (one key space per database) and the
    // memories (one table without a profile column): both are the character's.
    expect(await memories.list(other, { ...baseFilter, limit: 9 })).toEqual([]);
    expect((await store.settings.list(other, "self:")).size).toBe(0);
    expect((await store.relationships.get(other, person))?.call_name).toBe("歐文");

    // Kept categories cannot be wiped; unknown ones are refused.
    await expect(store.profileData.wipe(profile, ["audit"])).rejects.toThrow(/kept/);
    await expect(store.profileData.wipe(profile, ["nope" as never])).rejects.toThrow(/unknown/);
  });

  it("deletes settings by prefix", async () => {
    // Purging the message log (the whole database's) is in message-log.test.ts.
    const profile = unique("profile");
    const ns = `${unique("settings")}/`;
    await store.settings.set(profile, `${ns}a%:1`, 1);
    await store.settings.set(profile, `${ns}a%:2`, 2);
    await store.settings.set(profile, `${ns}ab:3`, 3);
    expect(await store.settings.deletePrefix(profile, `${ns}a%:`)).toBe(2);
    expect([...(await store.settings.list(profile, ns)).keys()]).toEqual([`${ns}ab:3`]);
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
