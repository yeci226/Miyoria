// The `identity` plugin: persons, handles, choices, links, merges, link codes and the resolver
// from a `ContextKey` (docs/design/v5-data.md §4), and the old store interfaces over it.

import { openTestDb, type TestDb } from "@miyoria/store/testing";
import type { AccountRef, ContextKey, PersonId } from "@miyoria/types";
import { eq, sql } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { accounts, persons, sessions, spaceMembers } from "../src/identity/schema.js";
import {
  GLOBAL_SETTINGS_PROFILE,
  HOME_SESSION,
  type Identity,
  linkCodeHash,
  SpacePlaces,
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

  it("handles: a changed nickname keeps the handle and is listed as a name they go by now", async () => {
    const s = await store();
    const owen = await s.people.upsertAccount(acct("1"), "Owen");
    // The same account seen again under a new server nickname.
    await s.people.upsertAccount(acct("1"), "Model-9 Lumen");
    expect((await s.people.personByAccount(acct("1")))?.id).toBe(owen);
    const entry = s.handles.list().find((e) => e.person === owen);
    expect(entry?.handle).toBe("Owen");
    expect(entry?.display_name).toBe("Owen");
    expect(entry?.names).toEqual(["Model-9 Lumen"]);
    expect(s.handles.resolve("Owen")?.names).toEqual(["Model-9 Lumen"]);
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

describe("places", () => {
  function places() {
    const o = open();
    return { ...o, places: new SpacePlaces(o.t.db, o.id) };
  }
  const say = (id: Identity, guild: string, channel: string, account: string, name = account) =>
    id.resolve(ctx(guild, channel, "channel"), { account: acct(account), display_name: name });

  it("has no primary before she sees a server, and the first one she sees is it", () => {
    const { places: p, id } = places();
    expect(p.primary()).toBeNull();
    expect(p.spaces()).toEqual([]);
    const a = say(id, "gA", "c1", "1").space_id as string;
    const b = p.seen("discord", "gB", "Guild B");
    expect(p.primary()).toMatchObject({ id: a, external_id: "gA", primary: true });
    expect(p.spaces().map((s) => [s.external_id, s.name, s.primary])).toEqual([
      ["gA", "gA", true],
      ["gB", "Guild B", false],
    ]);
    expect(p.space(b)).toMatchObject({ external_id: "gB", primary: false });
    expect(p.ofGuild("discord", "gB")?.id).toBe(b);
    expect(p.ofGuild("discord", "nope")).toBeNull();
    expect(p.space("nope")).toBeNull();
  });

  it("leaving keeps the rows; the primary stays where it was, and coming back clears the mark", () => {
    const { places: p, id, t } = places();
    const a = p.seen("discord", "gA", "A");
    const b = p.seen("discord", "gB", "B");
    p.left("discord", "gA");
    expect(p.primary()).toBeNull();
    expect(p.spaces().map((s) => s.id)).toEqual([b]);
    expect(p.space(a)).toBeNull();
    expect(t.db.get("SELECT COUNT(*) AS n FROM spaces")).toEqual({ n: 2 });
    // A new server while the primary is away does not take its place.
    p.seen("discord", "gC", "C");
    expect(t.db.all("SELECT external_id FROM spaces WHERE is_primary = 1")).toEqual([
      { external_id: "gA" },
    ]);
    // A message from it means she is there again.
    say(id, "gA", "c1", "1");
    expect(p.primary()?.id).toBe(a);
    p.left("discord", "unknown");
  });

  it("knows members by person, their spaces, and a member who left until they speak again", () => {
    const { places: p, id } = places();
    const a = say(id, "gA", "c1", "1", "Owen").space_id as string;
    const b = say(id, "gB", "c2", "1", "Owen").space_id as string;
    say(id, "gB", "c2", "2", "Ann");
    const owen = id.personOf(acct("1"))?.id as PersonId;
    const ann = id.personOf(acct("2"))?.id as PersonId;
    expect([...p.members(b)].sort()).toEqual([owen, ann].sort());
    expect([...p.members(a)]).toEqual([owen]);
    expect(p.spacesOf(owen).map((s) => s.id)).toEqual([a, b]);
    expect(p.spacesOf(ann).map((s) => s.id)).toEqual([b]);
    expect(p.isMember(ann, b)).toBe(true);
    expect(p.isMember(ann, a)).toBe(false);
    expect(p.isMember(ann, "")).toBe(false);

    p.memberLeft(b, acct("2"));
    expect(p.isMember(ann, b)).toBe(false);
    expect(p.spacesOf(ann)).toEqual([]);
    expect([...p.members(b)]).toEqual([owen]);
    say(id, "gB", "c2", "2", "Ann");
    expect(p.isMember(ann, b)).toBe(true);
    // A space she left is not one of theirs, though they are still its members.
    p.left("discord", "gB");
    expect(p.spacesOf(owen).map((s) => s.id)).toEqual([a]);
    expect(p.isMember(owen, b)).toBe(true);
  });

  it("finds where a context is without writing, and which space a channel is in", () => {
    const { places: p, id, t } = places();
    const author = { account: acct("1"), display_name: "Owen" };
    expect(p.at(ctx("g", "c", "channel"))).toBeNull();
    const place = id.resolve(ctx("g", "c", "channel"), author);
    const thread = id.resolve(ctx("g", "t", "thread"), author, { parent: "c" });
    const rows = Number(t.db.get("SELECT COUNT(*) AS n FROM rooms")?.n);
    expect(p.at(ctx("g", "c", "channel"))).toEqual({
      space_id: place.space_id,
      room_id: place.room_id,
      parent_room_id: null,
      session: "discord:g:c",
    });
    expect(p.at(ctx("g", "t", "thread"))).toEqual({
      space_id: place.space_id,
      room_id: thread.room_id,
      parent_room_id: place.room_id,
      session: "discord:g:c:t",
    });
    expect(p.at(ctx("g", "unknown", "channel"))).toBeNull();
    expect(Number(t.db.get("SELECT COUNT(*) AS n FROM rooms")?.n)).toBe(rows);
    expect(p.room(thread.room_id)).toEqual({
      id: thread.room_id,
      platform: "discord",
      external_id: "t",
      space_id: place.space_id,
      parent_id: place.room_id,
      kind: "thread",
      name: null,
    });
    expect(p.room("nope")).toBeNull();
    expect(p.channelSpace("discord", "c")).toBe(place.space_id);
    expect(p.channelSpace("discord", "unknown")).toBeNull();
  });

  it("reports new spaces and rooms, not the same ones seen again", () => {
    const { places: p, id } = places();
    const seen: string[] = [];
    const stop = p.onChange((c) => seen.push(`${c.kind}:${c.room_id === null ? "-" : "r"}`));
    say(id, "gA", "c1", "1");
    say(id, "gA", "c1", "1");
    p.seen("discord", "gA", "Renamed");
    p.left("discord", "gA");
    stop();
    p.seen("discord", "gA", "Back");
    expect(seen).toEqual(["space:-", "room:r", "space:-", "space:-"]);
  });
});

describe("memberSeen: acting in a space without writing there", () => {
  function rig() {
    const clock = { at: T0 };
    const t = openTestDb({ identity: true, clock: { now: () => clock.at } });
    opened.push(t);
    const id = t.identity as Identity;
    return { t, id, clock, places: new SpacePlaces(t.db, id) };
  }
  const member = (t: TestDb, space: string, account: string) =>
    t.db.get(
      "SELECT m.left_at, m.last_seen FROM space_members m JOIN accounts a ON a.id = m.account_id " +
        "WHERE m.space_id = $space AND a.external_id = $account",
      { space, account },
    );
  const changes = (t: TestDb) => Number(t.db.get("SELECT total_changes() AS n")?.n);

  it("makes someone who never wrote a person and a member, once, as a message would", () => {
    const { t, id, places: p } = rig();
    const space = p.seen("discord", "gA", "A");
    p.memberSeen(space, acct("7"), "Dana");
    const dana = id.personOf(acct("7"));
    expect(dana).toMatchObject({ name: "Dana" });
    expect(p.isMember(dana?.id as PersonId, space)).toBe(true);
    expect([...p.members(space)]).toEqual([dana?.id]);
    expect(p.spacesOf(dana?.id as PersonId).map((s) => s.id)).toEqual([space]);
    expect(member(t, space, "7")).toEqual({ left_at: null, last_seen: T0 * 1000 });
    // The same again, at once: nothing is written.
    const before = changes(t);
    p.memberSeen(space, acct("7"), "Dana");
    p.memberSeen(space, acct("7"));
    expect(changes(t)).toBe(before);
    expect(t.db.get("SELECT COUNT(*) AS n FROM space_members")).toEqual({ n: 1 });
    expect(t.db.get("SELECT COUNT(*) AS n FROM persons")).toEqual({ n: 1 });
  });

  it("writes a current membership again only after a minute, or when the name changed", () => {
    const { t, clock, places: p } = rig();
    const space = p.seen("discord", "gA", "A");
    p.memberSeen(space, acct("7"), "Dana");
    clock.at = T0 + 59_000;
    p.memberSeen(space, acct("7"), "Dana");
    expect(member(t, space, "7")).toMatchObject({ last_seen: T0 * 1000 });
    clock.at = T0 + 60_000;
    p.memberSeen(space, acct("7"), "Dana");
    expect(member(t, space, "7")).toMatchObject({ last_seen: (T0 + 60_000) * 1000 });
    clock.at = T0 + 61_000;
    p.memberSeen(space, acct("7"), "Dana 2");
    expect(member(t, space, "7")).toMatchObject({ last_seen: (T0 + 61_000) * 1000 });
    expect(t.db.get("SELECT display_name FROM accounts WHERE external_id = '7'")).toEqual({
      display_name: "Dana 2",
    });
  });

  it("brings back a member who left, at once, and leaves other spaces alone", () => {
    const { t, id, clock, places: p } = rig();
    const a = p.seen("discord", "gA", "A");
    const b = p.seen("discord", "gB", "B");
    id.resolve(ctx("gA", "c1", "channel"), { account: acct("7"), display_name: "Dana" });
    const dana = id.personOf(acct("7"))?.id as PersonId;
    clock.at = T0 + 1_000;
    p.memberLeft(a, acct("7"));
    expect(p.isMember(dana, a)).toBe(false);
    // Within the minute: a left membership is never "current".
    clock.at = T0 + 2_000;
    p.memberSeen(a, acct("7"), "Dana");
    expect(p.isMember(dana, a)).toBe(true);
    expect(member(t, a, "7")).toEqual({ left_at: null, last_seen: (T0 + 2_000) * 1000 });
    expect(p.isMember(dana, b)).toBe(false);
    expect(member(t, b, "7")).toBeUndefined();
  });

  it("ignores a space it does not know, and keeps a name the account already has", () => {
    const { t, id, places: p } = rig();
    p.memberSeen("nope", acct("7"), "Dana");
    p.memberSeen("", acct("7"), "Dana");
    expect(t.db.get("SELECT COUNT(*) AS n FROM accounts")).toEqual({ n: 0 });
    const space = p.seen("discord", "gA", "A");
    id.see(acct("8"), "Erin");
    p.memberSeen(space, acct("8"));
    expect(id.personOf(acct("8"))).toMatchObject({ name: "Erin" });
    expect(t.db.get("SELECT display_name FROM accounts WHERE external_id = '8'")).toEqual({
      display_name: "Erin",
    });
  });
});
