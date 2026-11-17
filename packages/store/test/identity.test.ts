// The `identity` plugin: persons, handles, choices, links, merges, link codes and the resolver
// from a `ContextKey` (docs/design/v5-data.md §4), and the old store interfaces over it.

import { openTestDb, type TestDb } from "@miyoria/store/testing";
import type { AccountRef, ContextKey } from "@miyoria/types";
import { eq, sql } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { accounts, persons, sessions, spaceMembers } from "../src/identity/schema.js";
import {
  GLOBAL_SETTINGS_PROFILE,
  HOME_SESSION,
  type Identity,
  linkCodeHash,
  SqliteStore,
} from "../src/index.js";

const T0 = Date.UTC(2026, 10, 14, 12);
const acct = (id: string): AccountRef => ({ platform: "discord", id });
const ctx = (scope: string | null, channel: string, kind: ContextKey["kind"]): ContextKey => ({
  platform: "discord",
  scope,
  channel,
  kind,
});

const opened: TestDb[] = [];
const stores: SqliteStore[] = [];
afterEach(async () => {
  for (const t of opened.splice(0)) t.close();
  for (const s of stores.splice(0)) await s.close();
});

function open(): { t: TestDb; id: Identity } {
  let now = T0;
  const t = openTestDb({ identity: true, clock: { now: () => now++ } });
  opened.push(t);
  return { t, id: t.identity as Identity };
}

async function store(): Promise<SqliteStore> {
  const s = await SqliteStore.open(":memory:");
  stores.push(s);
  return s;
}

describe("persons and accounts", () => {
  it("makes a person on first sight, with a handle from the name", () => {
    const { t, id } = open();
    const owen = id.see(acct("1"), "Owen");
    expect(owen).toMatchObject({ name: "Owen", handle: "Owen", merged_into: null, prefs: {} });
    expect(id.account(acct("1"))).toMatchObject({
      person_id: owen.id,
      display_name: "Owen",
      linked_by: "first_sight",
      is_self: false,
    });
    // Seen again under another name: the account follows, the person and handle stay.
    expect(id.see(acct("1"), "Owen L").id).toBe(owen.id);
    expect(id.account(acct("1"))?.display_name).toBe("Owen L");
    expect(id.person(owen.id)).toMatchObject({ name: "Owen", handle: "Owen" });
    // Times are microseconds in the table and `Timestamp`s in the row type.
    const raw = Number(t.db.get("SELECT first_seen FROM accounts")?.first_seen);
    expect(raw % 1000).toBe(0);
    expect(id.account(acct("1"))?.first_seen).toBe(new Date(raw / 1000).toISOString());
  });

  it("gives a second person with the same name a suffix, ignoring case", () => {
    const { id } = open();
    expect(id.see(acct("1"), "Owen").handle).toBe("Owen");
    expect(id.see(acct("2"), "Owen").handle).toBe("Owen#2");
    expect(id.see(acct("3"), "owen").handle).toBe("owen#3");
    expect(id.see(acct("4"), "u1").handle).toBe("u1#2");
    expect(id.personByHandle("OWEN#2")?.handle).toBe("Owen#2");
  });

  it("names a person made before they spoke when they first speak", () => {
    const { id } = open();
    // A choice made before speaking (`/me privacy` from a slash command) makes the person.
    id.setPref(acct("9"), "privacy", { presence: false });
    expect(id.personOf(acct("9"))).toMatchObject({ name: "9", handle: "9" });
    const seen = id.see(acct("9"), "Mikoto");
    expect(seen).toMatchObject({
      name: "Mikoto",
      handle: "Mikoto",
      prefs: { privacy: { presence: false } },
    });
    // Only once: a later name changes nothing.
    expect(id.see(acct("9"), "Misaka")).toMatchObject({ name: "Mikoto", handle: "Mikoto" });
  });

  it("links accounts, merges persons and keeps the absorbed id resolving", () => {
    const { id } = open();
    const a = id.see(acct("1"), "One");
    const b = id.see(acct("2"), "Two");
    id.setPref(acct("1"), "voice_consent", true);
    id.setPref(acct("2"), "voice_consent", false);
    id.setPref(acct("2"), "privacy", { dm: false });
    id.link(acct("3"), b.id, "code");
    expect(id.account(acct("3"))).toMatchObject({ person_id: b.id, linked_by: "code" });

    id.merge(a.id, b.id);
    expect(id.accountsOf(a.id).map((x) => x.external_id)).toEqual(["1", "2", "3"]);
    expect(id.personRow(b.id)?.merged_into).toBe(a.id);
    expect(id.person(b.id)?.id).toBe(a.id);
    expect(id.persons().map((p) => p.id)).toEqual([a.id]);
    // The kept person's choices win; the absorbed one's fill the gaps.
    expect(id.person(a.id)?.prefs).toEqual({ voice_consent: true, privacy: { dm: false } });
    // An absorbed person is not a person to link or merge any more.
    expect(() => id.merge(a.id, b.id)).toThrow(/unknown person/);
    expect(() => id.link(acct("4"), b.id, "owner")).toThrow(/unknown person/);
    // A merge of a merge points straight at the survivor.
    const c = id.see(acct("5"), "Three");
    id.merge(c.id, a.id);
    expect(id.personRow(b.id)?.merged_into).toBe(c.id);
    expect(id.person(b.id)?.id).toBe(c.id);
  });

  it("stores link codes hashed, uses them once, and refuses them at expiry", () => {
    const { t, id } = open();
    const at = (ms: number) => new Date(T0 + ms).toISOString();
    id.createLinkCode("ABC123", acct("7"), at(60_000));
    // The account never spoke: it exists without a person.
    expect(id.account(acct("7"))).toMatchObject({ person_id: null, display_name: "7" });
    expect(t.db.all("SELECT code_hash FROM link_codes")).toEqual([
      { code_hash: linkCodeHash("ABC123") },
    ]);
    expect(id.consumeLinkCode("ABC123", at(60_000))).toBeNull();
    id.createLinkCode("ABC123", acct("7"), at(60_000));
    expect(id.consumeLinkCode("ABC123", at(0))).toEqual(acct("7"));
    expect(id.consumeLinkCode("ABC123", at(0))).toBeNull();
    // Speaking later makes the person of that account.
    expect(id.see(acct("7"), "Seven").handle).toBe("Seven");
  });
});

describe("resolve", () => {
  it("makes the space, room, session and membership of a channel", () => {
    const { t, id } = open();
    const author = { account: acct("1"), display_name: "Owen" };
    const place = id.resolve(ctx("g", "c", "channel"), author, { space_name: "Guild" });
    expect(place).toMatchObject({ session: "discord:g:c", lane: "text" });
    expect(place.person_id).toBe(id.personOf(acct("1"))?.id);
    expect(t.db.get("SELECT name FROM spaces WHERE id = $id", { id: place.space_id })).toEqual({
      name: "Guild",
    });
    const members = t.db.orm.select().from(spaceMembers).all();
    expect(members).toEqual([
      expect.objectContaining({ space_id: place.space_id, roles: [], nick: null }),
    ]);
    // The same place again is the same rows; the session's `last_at` moves.
    const before = t.db.orm.select().from(sessions).get();
    const again = id.resolve(ctx("g", "c", "channel"), author);
    expect(again).toEqual(place);
    const after = t.db.orm.select().from(sessions).get();
    expect(Date.parse(after?.last_at ?? "")).toBeGreaterThan(Date.parse(before?.last_at ?? ""));
    expect(t.db.get("SELECT COUNT(*) AS n FROM rooms")).toEqual({ n: 1 });
  });

  it("gives a voice channel's voice lane its own session in the same room", () => {
    const { t, id } = open();
    const text = id.resolve(ctx("g", "v", "channel"));
    const voice = id.resolve(ctx("g", "v", "voice"));
    expect(voice).toMatchObject({ session: "discord:g:voice:v", lane: "voice" });
    expect(voice.room_id).toBe(text.room_id);
    // Seen as voice once, it is a voice room; text does not turn it back.
    id.resolve(ctx("g", "v", "channel"));
    expect(t.db.get("SELECT kind FROM rooms")).toEqual({ kind: "voice" });
  });

  it("keys a thread by its channel, once the platform said which", () => {
    const { t, id } = open();
    const thread = id.resolve(ctx("g", "t1", "thread"), null, { parent: "c" });
    expect(thread.session).toBe("discord:g:c:t1");
    // Later events need not repeat the parent.
    expect(id.resolve(ctx("g", "t1", "thread")).session).toBe("discord:g:c:t1");
    const rows = t.db.all(
      "SELECT external_id, kind, parent_id IS NOT NULL AS child FROM rooms ORDER BY external_id",
    );
    expect(rows).toEqual([
      { external_id: "c", kind: "text", child: 0 },
      { external_id: "t1", kind: "thread", child: 1 },
    ]);
  });

  it("keys a DM by the person: two accounts, one session, the last room to reply through", () => {
    const { t, id } = open();
    const first = id.resolve(ctx(null, "dm-1", "dm"), { account: acct("1"), display_name: "Owen" });
    const person = first.person_id as string;
    expect(first).toMatchObject({ space_id: null, session: `discord:dm:${person}` });
    id.link(acct("2"), person, "code");
    const second = id.resolve(ctx(null, "dm-2", "dm"), {
      account: acct("2"),
      display_name: "Owen alt",
    });
    expect(second.session).toBe(first.session);
    expect(second.room_id).not.toBe(first.room_id);
    const session = t.db.orm.select().from(sessions).where(eq(sessions.key, first.session)).get();
    expect(session).toMatchObject({ room_id: second.room_id, person_id: person, space_id: null });
    // Without an author, a known DM room still finds its person.
    expect(id.resolve(ctx(null, "dm-1", "dm")).session).toBe(first.session);
    expect(() => id.resolve(ctx(null, "dm-9", "dm"))).toThrow(/only with its author/);
    expect(t.db.get("SELECT COUNT(*) AS n FROM space_members")).toEqual({ n: 0 });
  });

  it("has her home session", () => {
    const { t, id } = open();
    expect(id.home()).toBe(HOME_SESSION);
    expect(id.home()).toBe(HOME_SESSION);
    expect(t.db.all("SELECT key, lane FROM sessions")).toEqual([{ key: "home", lane: "home" }]);
  });
});

describe("one connection, one transaction", () => {
  it("rolls Drizzle and raw SQL back together", () => {
    const { t, id } = open();
    expect(() =>
      t.db.tx(() => {
        id.see(acct("1"), "Owen"); // Drizzle, in a savepoint of this transaction
        t.db.run("UPDATE persons SET name = 'raw'"); // raw SQL
        expect(t.db.orm.select({ name: persons.name }).from(persons).get()).toEqual({
          name: "raw",
        });
        throw new Error("abort");
      }),
    ).toThrow("abort");
    expect(t.db.get("SELECT COUNT(*) AS n FROM persons")).toEqual({ n: 0 });
    expect(t.db.inTransaction).toBe(false);
  });

  it("rolls back only the failed savepoint inside a transaction", () => {
    const { t, id } = open();
    t.db.tx(() => {
      id.see(acct("1"), "Owen");
      expect(() =>
        t.db.tx(() => {
          t.db.orm.update(persons).set({ name: "lost" }).run();
          // A foreign key failure inside the nested part.
          id.link(acct("2"), "ghost", "owner");
        }),
      ).toThrow(/unknown person/);
      expect(t.db.inTransaction).toBe(true);
    });
    expect(id.personOf(acct("1"))?.name).toBe("Owen");
    expect(id.account(acct("2"))).toBeNull();
  });

  it("reads what the same transaction wrote, through either side", () => {
    const { t } = open();
    t.db.tx(() => {
      t.db.orm
        .insert(persons)
        .values({ id: "p", name: "n", handle: "h", created_at: "2026-11-14T00:00:00.000Z" })
        .run();
      expect(t.db.get("SELECT handle FROM persons")).toEqual({ handle: "h" });
      t.db.run('UPDATE persons SET prefs = json(\'{"privacy":{"dm":false}}\')');
      expect(t.db.orm.select({ prefs: persons.prefs }).from(persons).get()?.prefs).toEqual({
        privacy: { dm: false },
      });
      expect(t.db.orm.select({ n: sql<number>`count(*)` }).from(accounts).get()).toEqual({ n: 0 });
    });
  });
});

describe("the old interfaces over identity", () => {
  it("handles: one per person, exact resolve, list oldest first", async () => {
    const s = await store();
    const owen = await s.people.upsertAccount(acct("1"), "Owen");
    await s.identity.linkAccount(acct("9"), owen);
    expect(s.handles.ofAccount(acct("1"), "Whatever")).toBe("Owen");
    // Every account of a person has the person's handle.
    expect(s.handles.ofAccount(acct("9"), "Owen alt")).toBe("Owen");
    // First sight through the directory makes the person.
    expect(s.handles.ofAccount(acct("2"), "Owen")).toBe("Owen#2");
    expect((await s.people.personByAccount(acct("2")))?.display_name).toBe("Owen");
    expect(s.handles.ofPerson(owen)).toBe("Owen");
    expect(s.handles.resolve("Owen#2")?.account).toEqual(acct("2"));
    expect(s.handles.resolve("owen")).toBeNull();
    expect(s.handles.list().map((e) => [e.handle, e.account?.id])).toEqual([
      ["Owen", "1"],
      ["Owen#2", "2"],
    ]);
    // Someone not in this database gets a name that is free, never stored.
    const ghost = {
      id: "x",
      display_name: "Owen",
      created_at: "2026-01-01T00:00:00Z",
      accounts: [],
    };
    expect(s.handles.ensurePerson(ghost)).toBe("Owen#3");
    expect(s.handles.list()).toHaveLength(2);
  });

  it("keeps a person's choices in persons.prefs, not in the settings table", async () => {
    const s = await store();
    const owen = await s.people.upsertAccount(acct("1"), "Owen");
    await s.identity.linkAccount(acct("2"), owen);
    await s.settings.set(GLOBAL_SETTINGS_PROFILE, "privacy:discord:1", { presence: false });
    await s.settings.set(GLOBAL_SETTINGS_PROFILE, "voice_consent:discord:3", false);
    await s.settings.set(GLOBAL_SETTINGS_PROFILE, "queue:state", { items: [] });
    // One person, one choice: the other account reads it too.
    expect(await s.settings.get(GLOBAL_SETTINGS_PROFILE, "privacy:discord:2")).toEqual({
      presence: false,
    });
    expect(s.persons.person(owen)?.prefs).toEqual({ privacy: { presence: false } });
    // Choosing before speaking made a person for account 3.
    expect(s.persons.personOf(acct("3"))?.prefs).toEqual({ voice_consent: false });
    // Only `queue:state` went to the settings rows.
    const rows = await s.profileData.export("p", ["other_settings", "queue"]);
    expect(rows.parts.queue?.map((r) => r.key)).toEqual(["queue:state"]);
    // Whatever profile a caller names: one database is one character.
    await s.settings.set("p", "privacy:discord:1", { presence: true });
    expect(await s.settings.get(GLOBAL_SETTINGS_PROFILE, "privacy:discord:2")).toEqual({
      presence: true,
    });
    expect(s.persons.person(owen)?.prefs).toEqual({ privacy: { presence: true } });

    expect([...(await s.settings.list(GLOBAL_SETTINGS_PROFILE, "")).keys()]).toEqual([
      "privacy:discord:1",
      "privacy:discord:2",
      "queue:state",
      "voice_consent:discord:3",
    ]);
    expect([
      ...(await s.settings.list(GLOBAL_SETTINGS_PROFILE, "privacy:discord:2")).keys(),
    ]).toEqual(["privacy:discord:2"]);
    expect(await s.settings.deletePrefix(GLOBAL_SETTINGS_PROFILE, "privacy:")).toBe(1);
    expect(await s.settings.get(GLOBAL_SETTINGS_PROFILE, "privacy:discord:1")).toBeNull();
    await s.settings.set(GLOBAL_SETTINGS_PROFILE, "voice_consent:discord:3", null);
    expect(s.persons.personOf(acct("3"))?.prefs).toEqual({});
    // Clearing a choice of someone unknown makes nobody.
    await s.settings.set(GLOBAL_SETTINGS_PROFILE, "privacy:discord:77", null);
    expect(s.persons.account(acct("77"))).toBeNull();
  });

  it("wipes and exports people with their places and choices", async () => {
    const s = await store();
    s.persons.resolve(ctx("g", "c", "channel"), { account: acct("1"), display_name: "Owen" });
    await s.settings.set(GLOBAL_SETTINGS_PROFILE, "privacy:discord:1", { dm: false });
    const backup = await s.profileData.export("p", ["people", "privacy"]);
    expect(backup.parts.people).toEqual([
      expect.objectContaining({ name: "Owen", handle: "Owen", prefs: { privacy: { dm: false } } }),
    ]);
    expect(backup.parts.privacy).toEqual([
      { person_id: s.persons.personOf(acct("1"))?.id, value: { dm: false } },
    ]);
    expect(backup.parts.sessions?.map((r) => r.key)).toEqual(["discord:g:c"]);
    const counts = await s.profileData.wipe("p", ["people", "privacy"]);
    expect(counts).toMatchObject({
      privacy: 1,
      people: 1,
      accounts: 1,
      spaces: 1,
      rooms: 1,
      sessions: 1,
      space_members: 1,
    });
    expect(await s.people.all()).toEqual([]);
  });
});
