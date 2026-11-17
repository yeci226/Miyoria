// The event log on `events` (docs/design/v5-data.md §2): the table and its trigger, appending
// with the registry's defaults and identity's places, reading back, redaction, and compaction by
// tier that only ever removes leaves.

import type { EventDraftInput, EventEnvelope } from "@miyoria/contracts/events";
import { newId, toTimestamp } from "@miyoria/types";
import { afterEach, describe, expect, it } from "vitest";
import {
  coreEventRegistry,
  type EventCompaction,
  EventStore,
  resolveCategories,
  SqliteStore,
  sessionScope,
} from "../src/index.js";
import { openTestDb, type TestDb } from "../src/testing.js";

const T0 = Date.UTC(2026, 10, 1, 12);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const TEXT = { platform: "discord", scope: "g1", channel: "c1", kind: "channel" } as const;
const VOICE = { platform: "discord", scope: "g1", channel: "v1", kind: "voice" } as const;
const DM = { platform: "discord", scope: null, channel: "d1", kind: "dm" } as const;
const OWEN = { account: { platform: "discord", id: "100" }, display_name: "Owen" };

let now = T0;
const clock = { now: () => now };
const open: TestDb[] = [];
afterEach(() => {
  for (const t of open.splice(0)) t.close();
  now = T0;
});

function testDb(identity = true): TestDb {
  const t = openTestDb({ identity, clock });
  open.push(t);
  return t;
}

function draft(type: string, at: number, extra: Partial<EventDraftInput> = {}): EventDraftInput {
  return { id: newId(), at: toTimestamp(at), type, data: { n: 1 }, ...extra };
}

describe("the table", () => {
  it("is created by core migration 2, STRICT, with the design's indexes and the trigger", () => {
    const { db, applied } = testDb(false);
    expect(applied.map((m) => `${m.plugin}:${m.version}:${m.name}`)).toEqual([
      "core:1:bookkeeping",
      "core:2:events",
      "core:3:chat",
      "core:4:turns_audit",
      "core:5:llm_calls",
      "core:6:event_cursors",
      "core:7:partial_redaction",
    ]);
    const strict = db.all("SELECT name, strict FROM pragma_table_list WHERE name LIKE 'event%'");
    expect(strict).toEqual(
      expect.arrayContaining([
        { name: "events", strict: 1 },
        { name: "event_rollups", strict: 1 },
      ]),
    );
    const names = db
      .all("SELECT type, name FROM sqlite_schema WHERE tbl_name = 'events' AND sql IS NOT NULL")
      .map((r) => `${r.type}:${r.name}`)
      .sort();
    expect(names).toEqual([
      "index:events_at_idx",
      "index:events_audit_actor_idx",
      "index:events_audit_idx",
      "index:events_chat_account_idx",
      "index:events_chat_session_idx",
      "index:events_decision_idx",
      "index:events_decision_session_idx",
      "index:events_key_idx",
      "index:events_llm_call_idx",
      "index:events_outcome_idx",
      "index:events_outcome_session_idx",
      "index:events_outcome_turn_idx",
      "index:events_parent_idx",
      "index:events_person_idx",
      "index:events_session_idx",
      "index:events_source_idx",
      "index:events_tier_idx",
      "index:events_turn_idx",
      "index:events_type_idx",
      "table:events",
      "trigger:events_append_only",
    ]);
  });

  it("refuses any change but one redaction, and checks scope and tier", () => {
    const { db, events } = testDb(false);
    const e = events.appendNow({ draft: draft("facts.thought", T0), source: "mind" });
    expect(() => db.exec("UPDATE events SET source = 'x'")).toThrow(/append-only/);
    expect(() => db.exec(`UPDATE events SET data = '{"n":2}'`)).toThrow(/append-only/);
    // The redaction marker alone is not enough: every envelope column must stay.
    expect(() =>
      db.exec(
        `UPDATE events SET data = '{"redacted":true}', redacted_at = 1, person_id = 'p' WHERE id = '${e.id}'`,
      ),
    ).toThrow(/append-only/);
    db.exec(`UPDATE events SET data = '{"redacted":true}', redacted_at = 1 WHERE id = '${e.id}'`);
    expect(() =>
      db.exec(`UPDATE events SET data = '{"redacted":true}', redacted_at = 2 WHERE id = '${e.id}'`),
    ).toThrow(/append-only/);
    const insert = (scope: string, tier: string) =>
      db.exec(
        `INSERT INTO events (id, at, type, source, scope, tier, data) VALUES ('${newId()}', 1, 't', 's', '${scope}', '${tier}', '1')`,
      );
    expect(() => insert("guild", "short")).toThrow(/CHECK/);
    expect(() => insert("room", "forever")).toThrow(/CHECK/);
    // Deleting is compaction's business, and allowed.
    db.exec("DELETE FROM events");
  });
});

describe("append", () => {
  it("reads back exactly the envelope it wrote", () => {
    const { events } = testDb();
    const written: EventEnvelope = events.appendNow({
      draft: {
        id: newId(),
        at: "2026-11-14T06:00:00.123456Z",
        type: "facts.observation.said",
        v: 2,
        parent: newId(),
        turn: "turn-1",
        session: "discord:g1:c1",
        space_id: "sp1",
        room_id: "rm1",
        person_id: "pe1",
        account_id: "ac1",
        scope: "public",
        key: "msg:discord:m1",
        data: { text: "嗨", nested: [1, null, { a: true }] },
      },
      source: "platform.discord",
    });
    expect(written.seq).toBe(1);
    expect(written.tier).toBe("long");
    const read = events.get(written.id);
    expect(read?.envelope).toEqual(written);
    expect(read?.envelope.at).toBe("2026-11-14T06:00:00.123456Z");
  });

  it("takes tier and default scope from the registry, then the session's scope", () => {
    const { events } = testDb();
    const one = (type: string, extra: Partial<EventDraftInput> = {}) =>
      events.appendNow({ draft: draft(type, T0, extra), source: "s" });
    // Registered: the type's tier; scope from the session.
    expect(one("facts.observation.ambient")).toMatchObject({ tier: "ambient", scope: "self" });
    expect(one("facts.utterance", { session: "home" })).toMatchObject({
      tier: "long",
      scope: "self",
    });
    expect(one("facts.directive")).toMatchObject({ tier: "keep" });
    // A type's default scope wins over the session's; the producer's wins over both.
    expect(one("privacy.redacted", { session: "discord:g1:c1", space_id: "s" })).toMatchObject({
      tier: "keep",
      scope: "owner",
    });
    expect(one("facts.thought", { scope: "public" })).toMatchObject({ scope: "public" });
    // Not registered: `short`, and the session decides.
    expect(one("nobody.knows", { session: "discord:dm:p1" })).toMatchObject({
      tier: "short",
      scope: "dm",
    });
    expect(sessionScope("discord:g1:c1", "space")).toBe("room");
    expect(sessionScope("discord:dm:voice:p1", null)).toBe("dm");
    expect(sessionScope(null, null)).toBe("self");
  });

  it("uses the registry it was given", () => {
    const { db } = testDb(false);
    const registry = coreEventRegistry();
    const events = new EventStore(db, { registry });
    expect(events.registry).toBe(registry);
    expect(registry.defaults("facts.observation.said")).toEqual({ scope: null, tier: "long" });
  });

  it("writes a batch in one transaction, in order, and stores an id once", () => {
    const { db, events } = testDb(false);
    const a = draft("facts.thought", T0);
    const written = events.append([
      { draft: a, source: "mind" },
      { draft: draft("facts.thought", T0 + 1), source: "mind" },
      { draft: { ...a, data: "again" }, source: "other" },
    ]);
    expect(written.map((e) => e.seq)).toEqual([1, 2, 1]);
    expect(written[2]).toEqual(written[0]);
    expect(db.get("SELECT count(*) AS n FROM events")).toEqual({ n: 2 });
    // One bad event costs the whole batch: nothing of it is stored.
    expect(() =>
      events.append([
        { draft: draft("facts.thought", T0 + 2), source: "mind" },
        { draft: draft("facts.thought", T0 + 3, { scope: "guild" as never }), source: "mind" },
      ]),
    ).toThrow(/unknown scope/);
    expect(db.get("SELECT count(*) AS n FROM events")).toEqual({ n: 2 });
  });

  it("commits with the caller's transaction, or not at all", () => {
    const { db, events } = testDb(false);
    expect(() =>
      db.tx(() => {
        events.appendNow({ draft: draft("facts.thought", T0), source: "economy" });
        throw new Error("the posting failed");
      }),
    ).toThrow("the posting failed");
    expect(events.query()).toEqual([]);
    db.tx(() => events.appendNow({ draft: draft("facts.thought", T0), source: "economy" }));
    expect(events.query()).toHaveLength(1);
  });
});

describe("places and people", () => {
  it("resolves a context and its author through identity, and reads the context back", () => {
    const { events, identity } = testDb();
    const e = events.appendNow({
      draft: draft("facts.observation.said", T0),
      source: "platform.discord",
      context: TEXT,
      author: OWEN,
    });
    const person = identity?.personOf(OWEN.account);
    expect(e).toMatchObject({
      session: "discord:g1:c1",
      person_id: person?.id,
      account_id: identity?.account(OWEN.account)?.id,
      scope: "room",
    });
    expect(e.space_id).not.toBeNull();
    expect(e.room_id).not.toBeNull();
    expect(events.get(e.id)).toMatchObject({ context: TEXT, handle: "Owen" });
  });

  it("keeps the lane: voice, and a DM's person session", () => {
    const { events } = testDb();
    const voice = events.appendNow({
      draft: draft("facts.observation.said", T0),
      source: "voice.asr",
      context: VOICE,
      author: OWEN,
    });
    expect(voice.session).toBe("discord:g1:voice:v1");
    expect(events.get(voice.id)?.context).toEqual(VOICE);
    const dm = events.appendNow({
      draft: draft("facts.observation.said", T0),
      source: "platform.discord",
      context: DM,
      author: OWEN,
    });
    expect(dm.session).toBe(`discord:dm:${dm.person_id}`);
    expect(dm.scope).toBe("dm");
    expect(events.get(dm.id)?.context).toEqual(DM);
    // Her own line in that DM: the place resolves without an author, and names nobody.
    const said = events.appendNow({
      draft: draft("facts.utterance", T0),
      source: "delivery",
      context: DM,
    });
    expect(said).toMatchObject({ session: dm.session, person_id: null, scope: "dm" });
  });

  it("names a person by handle, and leaves a place nobody can resolve empty", () => {
    const { events, identity } = testDb();
    identity?.see(OWEN.account, OWEN.display_name);
    const e = events.appendNow({
      draft: draft("facts.decision", T0),
      source: "agent",
      context: { ...DM, channel: "never-seen" },
      handle: "owen",
    });
    // Still a DM: what is about a DM never reads as her own state.
    expect(e).toMatchObject({ session: null, room_id: null, scope: "dm" });
    expect(e.person_id).toBe(identity?.personOf(OWEN.account)?.id);
    expect(events.get(e.id)).toMatchObject({ context: null, handle: "Owen" });
  });

  it("does without identity", () => {
    const { events } = testDb(false);
    const e = events.appendNow({
      draft: draft("facts.observation.said", T0),
      source: "voice.asr",
      context: VOICE,
      author: OWEN,
      handle: "Owen",
    });
    expect(e).toMatchObject({ session: null, person_id: null, account_id: null });
    expect(events.get(e.id)).toMatchObject({ context: null, handle: null });
  });
});

describe("query", () => {
  it("filters by every field and pages by seq", () => {
    const { events } = testDb();
    const first = events.appendNow({
      draft: draft("facts.observation.said", T0, { key: "msg:1" }),
      source: "platform.discord",
      context: TEXT,
      author: OWEN,
    });
    const second = events.appendNow({
      draft: draft("facts.decision", T0 + HOUR, { parent: first.id, turn: "t1" }),
      source: "agent",
      context: TEXT,
    });
    const third = events.appendNow({
      draft: draft("facts.thought", T0 + 2 * HOUR),
      source: "mind",
    });
    const ids = (q: Parameters<EventStore["query"]>[0]) =>
      events.query(q).map((e) => e.envelope.id);
    expect(ids({})).toEqual([third.id, second.id, first.id]);
    expect(ids({ order: "asc", limit: 2 })).toEqual([first.id, second.id]);
    expect(ids({ types: ["facts.thought", "facts.decision"] })).toEqual([third.id, second.id]);
    expect(ids({ types: [] })).toEqual([]);
    expect(ids({ sources: ["agent"] })).toEqual([second.id]);
    expect(ids({ session: "discord:g1:c1" })).toEqual([second.id, first.id]);
    expect(ids({ context: TEXT })).toEqual([second.id, first.id]);
    expect(ids({ context: VOICE })).toEqual([]);
    expect(ids({ handle: "Owen" })).toEqual([first.id]);
    expect(ids({ handle: "Amy" })).toEqual([]);
    expect(ids({ personId: first.person_id ?? "" })).toEqual([first.id]);
    expect(ids({ key: "msg:1" })).toEqual([first.id]);
    expect(ids({ turn: "t1" })).toEqual([second.id]);
    expect(ids({ parents: [first.id] })).toEqual([second.id]);
    expect(ids({ since: toTimestamp(T0 + HOUR) })).toEqual([third.id, second.id]);
    expect(ids({ until: toTimestamp(T0 + HOUR) })).toEqual([first.id]);
    expect(ids({ after: first.id, order: "asc" })).toEqual([second.id, third.id]);
    expect(ids({ before: third.id })).toEqual([second.id, first.id]);
    expect(ids({ afterSeq: 2 })).toEqual([third.id]);
    expect(ids({ beforeSeq: 2 })).toEqual([first.id]);
  });
});

describe("redact", () => {
  it("keeps the envelope, drops the content and records the redaction", () => {
    now = T0 + HOUR;
    const { events } = testDb();
    const target = events.appendNow({
      draft: draft("facts.observation.said", T0, { data: { text: "別記得這句" } }),
      source: "platform.discord",
      context: TEXT,
      author: OWEN,
    });
    const record = events.redact(target.id, "do_not_remember", "memory");
    expect(record).toMatchObject({
      type: "privacy.redacted",
      source: "memory",
      scope: "owner",
      tier: "keep",
      parent: null,
      session: target.session,
      person_id: target.person_id,
      data: { target: target.id, reason: "do_not_remember" },
      at: toTimestamp(now),
    });
    const back = events.get(target.id)?.envelope;
    expect(back).toEqual({
      ...target,
      redacted_at: toTimestamp(now),
      data: { redacted: true },
    });
    expect(JSON.stringify(events.query())).not.toContain("別記得這句");
    // Once is all: a second call changes nothing and records nothing.
    expect(events.redact(target.id, "again", "memory")).toBeNull();
    expect(events.redact("unknown", "x", "memory")).toBeNull();
    expect(events.query({ types: ["privacy.redacted"] })).toHaveLength(1);
  });

  it("can take only the words of a payload and keep the rest", () => {
    now = T0 + HOUR;
    const { db, events } = testDb(false);
    const person = "p1";
    const quoted = events.appendNow({
      draft: draft("heart.changed", T0, {
        person_id: person,
        data: { person, field: "bond", delta: 3, reason_quote: "他說他家住哪", cause: "feel" },
      }),
      source: "heart",
    });
    const plain = events.appendNow({
      draft: draft("heart.changed", T0, {
        person_id: person,
        data: { person, field: "bond", delta: -1, reason_quote: "", cause: "decay" },
      }),
      source: "heart",
    });
    const other = events.appendNow({
      draft: draft("heart.changed", T0, {
        person_id: "p2",
        data: { person: "p2", field: "bond", delta: 3, reason_quote: "別人的話", cause: "feel" },
      }),
      source: "heart",
    });
    const records = events.redactFields(
      { personId: person, types: ["heart.changed"] },
      ["reason_quote"],
      "forget me",
      "memory",
    );
    expect(records.map((r) => r.data)).toEqual([{ target: quoted.id, reason: "forget me" }]);
    expect(events.get(quoted.id)?.envelope).toEqual({
      ...quoted,
      redacted_at: toTimestamp(now),
      data: {
        person,
        field: "bond",
        delta: 3,
        reason_quote: "",
        cause: "feel",
        redacted: true,
      },
    });
    // Nothing to take: left as it was, no record.
    expect(events.get(plain.id)?.envelope).toEqual(plain);
    expect(events.get(other.id)?.envelope).toEqual(other);
    // Once only, as a whole redaction; and the trigger takes no other payload.
    expect(events.redactFields({ personId: person }, ["reason_quote"], "again", "memory")).toEqual(
      [],
    );
    expect(() =>
      db.exec(
        `UPDATE events SET data = '{"person":"p2","reason_quote":""}', redacted_at = 1 WHERE id = '${other.id}'`,
      ),
    ).toThrow(/append-only/);
    expect(() => events.redactFields({}, ["reason_quote"], "all", "memory")).toThrow(
      /key or a person/,
    );
  });
});

describe("compaction", () => {
  const policy = (at: number, maxRows = 100): EventCompaction => ({
    before: {
      ambient: toTimestamp(at - 14 * DAY),
      short: toTimestamp(at - 90 * DAY),
      long: toTimestamp(at - 365 * DAY),
    },
    maxRows,
  });

  function seed(events: EventStore) {
    const put = (type: string, at: number, parent: string | null = null, source = "facts") =>
      events.appendNow({ draft: draft(type, at, { parent }), source });
    return put;
  }

  it("removes each tier after its time, never `keep`, and counts what went per day", () => {
    const { events } = testDb();
    const put = seed(events);
    const at = T0 + 400 * DAY;
    // Old enough for every tier.
    const ambient = put("facts.observation.ambient", T0, null, "voice.presence");
    const ambient2 = put("facts.observation.ambient", T0 + HOUR, null, "voice.presence");
    const short = put("facts.thought", T0 + DAY, null, "mind");
    const long = put("facts.observation.said", T0 + DAY, null, "platform.discord");
    const keep = put("facts.directive", T0, null, "directive");
    // Too young for their tier.
    const youngAmbient = put("facts.observation.ambient", at - 13 * DAY);
    const youngShort = put("facts.decision", at - 89 * DAY);
    const youngLong = put("facts.utterance", at - 364 * DAY);

    expect(events.compact(policy(at))).toEqual({
      removed: { ambient: 2, short: 1, long: 1 },
      more: true,
    });
    expect(events.compact(policy(at))).toEqual({
      removed: { ambient: 0, short: 0, long: 0 },
      more: false,
    });
    const left = events.query({ order: "asc" }).map((e) => e.envelope.id);
    expect(left).toEqual([keep.id, youngAmbient.id, youngShort.id, youngLong.id]);
    expect(left).not.toContain(ambient.id);
    expect(left).not.toContain(ambient2.id);
    expect(left).not.toContain(short.id);
    expect(left).not.toContain(long.id);
    expect(events.rollups(10)).toEqual([
      {
        day: toTimestamp(T0 + DAY - 12 * HOUR),
        type: "facts.observation.said",
        source: "platform.discord",
        count: 1,
        first_at: toTimestamp(T0 + DAY),
        last_at: toTimestamp(T0 + DAY),
      },
      {
        day: toTimestamp(T0 + DAY - 12 * HOUR),
        type: "facts.thought",
        source: "mind",
        count: 1,
        first_at: toTimestamp(T0 + DAY),
        last_at: toTimestamp(T0 + DAY),
      },
      {
        day: toTimestamp(T0 - 12 * HOUR),
        type: "facts.observation.ambient",
        source: "voice.presence",
        count: 2,
        first_at: toTimestamp(T0),
        last_at: toTimestamp(T0 + HOUR),
      },
    ]);
  });

  it("keeps a row while another names it as parent, then takes the chain leaf first", () => {
    const { events } = testDb();
    const put = seed(events);
    const at = T0 + 100 * DAY;
    // An old ambient observation caused a young decision: it stays while the decision does.
    const heard = put("facts.observation.ambient", T0);
    put("facts.decision", at - DAY, heard.id);
    // An old chain of short rows goes one generation per pass.
    const root = put("facts.thought", T0);
    const mid = put("facts.decision", T0 + 1, root.id);
    const leaf = put("facts.action", T0 + 2, mid.id);
    // A kept row pins its parent forever.
    const ruled = put("facts.thought", T0);
    put("facts.directive", T0, ruled.id);

    const pass = () => events.compact(policy(at)).removed.short;
    const alive = (id: string) => events.get(id) !== null;
    expect(pass()).toBe(1);
    expect([alive(root.id), alive(mid.id), alive(leaf.id)]).toEqual([true, true, false]);
    expect(pass()).toBe(1);
    expect(pass()).toBe(1);
    expect(events.compact(policy(at)).more).toBe(false);
    expect(alive(root.id)).toBe(false);
    expect(alive(heard.id)).toBe(true);
    expect(alive(ruled.id)).toBe(true);
  });

  it("removes at most `maxRows` a pass, the oldest tiers' leaves first", () => {
    const { events } = testDb();
    const put = seed(events);
    const at = T0 + 400 * DAY;
    for (let i = 0; i < 3; i++) put("facts.observation.ambient", T0 + i);
    for (let i = 0; i < 3; i++) put("facts.thought", T0 + i);
    expect(events.compact(policy(at, 4))).toEqual({
      removed: { ambient: 3, short: 1, long: 0 },
      more: true,
    });
    expect(events.compact(policy(at, 4)).removed.short).toBe(2);
  });

  it("removes nothing of a tier whose time is null", () => {
    const { events } = testDb();
    seed(events)("facts.thought", T0);
    const p = policy(T0 + 400 * DAY);
    expect(events.compact({ ...p, before: { ...p.before, short: null } }).more).toBe(false);
    expect(events.query()).toHaveLength(1);
  });
});

describe("the store and its data categories", () => {
  it("opens with the log, counts, exports and deletes it", async () => {
    const store = await SqliteStore.open(":memory:");
    try {
      const e = store.events.appendNow({
        draft: draft("facts.observation.said", T0),
        source: "voice.asr",
        context: VOICE,
        author: OWEN,
      });
      expect(e.session).toBe("discord:g1:voice:v1");
      const inventory = await store.profileData.inventory("miyoria");
      expect(inventory.categories.find((c) => c.id === "event_log")?.count).toBe(1);
      const backup = await store.profileData.export("miyoria", ["event_log"]);
      expect(backup.parts.events?.[0]).toMatchObject({
        type: "facts.observation.said",
        session: "discord:g1:voice:v1",
        data: { n: 1 },
      });
      await store.profileData.wipe("miyoria", ["event_log"]);
      expect(store.events.query()).toEqual([]);
    } finally {
      await store.close();
    }
  });

  it("goes when the messages go: it repeats what people said", () => {
    expect(resolveCategories(["messages"])).toContain("event_log");
  });
});
