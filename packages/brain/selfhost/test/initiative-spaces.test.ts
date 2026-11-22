// Her inbox across servers (phase 6, docs/design/v5-places.md): `initiative` v2 gives every row
// the Space it came from, a run sees only its own Space's items and items of none, and a voice
// event of one server never reaches a run in another one.

import { transcriptTables } from "@miyoria/memory/transcript";
import { identitySchema, migrate, SqliteStore } from "@miyoria/store";
import { openTestDb, type TestDb } from "@miyoria/store/testing";
import { type ContextKey, Events, toTimestamp } from "@miyoria/types";
import { afterEach, describe, expect, it } from "vitest";
import { initiativeSchema } from "../src/initiative-migrations.js";
import { initiativeTables } from "../src/initiative-store.js";
import { mention, Rig, says, stopRigs, textOf, until } from "./harness.js";

const dbs: TestDb[] = [];
const stores: SqliteStore[] = [];
afterEach(async () => {
  await stopRigs();
  for (const t of dbs.splice(0)) t.close();
  for (const s of stores.splice(0)) await s.close();
});

const AT = 1_700_000_000_000_000;
const ctxJson = (platform: string, scope: string | null, channel: string, kind = "channel") =>
  JSON.stringify({ platform, scope, channel, kind });

describe("initiative v2", () => {
  it("gives each row the Space of its place, keeps home rows without one, and loses no row", () => {
    const t = openTestDb({
      identity: true,
      plugins: [{ ...initiativeSchema, migrations: initiativeSchema.migrations.slice(0, 1) }],
    });
    dbs.push(t);
    const identity = t.identity;
    if (!identity) throw new Error("identity");
    const A = identity.seenSpace("discord", "gA", "A");
    const B = identity.seenSpace("discord", "gB", "B");
    const item = (key: string, context: string | null) =>
      t.db.run(
        `INSERT INTO initiative_inbox (key, kind, session, context, text, created_at)
         VALUES ($key, 'world', NULL, $context, 'x', $at)`,
        { key, context, at: AT },
      );
    item("a", ctxJson("discord", "gA", "a1"));
    item("b", ctxJson("discord", "gB", "b1", "voice"));
    item("home", null);
    item("dm", ctxJson("discord", null, "d1", "dm"));
    item("unknown", ctxJson("discord", "gZ", "z1"));
    t.db.run(
      `INSERT INTO initiative_schedules (id, note, due, context, source, created_at, updated_at)
       VALUES ('s1', 'n', $at, $context, 'schedule', $at, $at),
              ('s2', 'n', $at, NULL, 'schedule', $at, $at)`,
      { at: AT, context: ctxJson("discord", "gB", "b1") },
    );
    expect(migrate(t.db, [identitySchema, initiativeSchema]).map((m) => m.version)).toEqual([2]);
    const rows = t.db.all("SELECT key, space_id FROM initiative_inbox ORDER BY key") as {
      key: string;
      space_id: string | null;
    }[];
    expect(rows).toEqual([
      { key: "a", space_id: A },
      { key: "b", space_id: B },
      { key: "dm", space_id: null },
      { key: "home", space_id: null },
      { key: "unknown", space_id: null },
    ]);
    expect(t.db.all("SELECT id, space_id FROM initiative_schedules ORDER BY id")).toEqual([
      { id: "s1", space_id: B },
      { id: "s2", space_id: null },
    ]);
    // Running it again does nothing.
    expect(migrate(t.db, [identitySchema, initiativeSchema])).toEqual([]);
  });
});

describe("the inbox per Space", () => {
  it("shows a run its place's items and home items of its Space or of none", async () => {
    const store = await SqliteStore.open(":memory:", { plugins: [initiativeTables] });
    stores.push(store);
    const author = { account: { platform: "discord", id: "1" }, display_name: "1" };
    const A = store.persons.resolve(
      { platform: "discord", scope: "gA", channel: "a1", kind: "channel" },
      author,
    ).space_id;
    const B = store.persons.resolve(
      { platform: "discord", scope: "gB", channel: "b1", kind: "channel" },
      author,
    ).space_id;
    const tables = store.plugin(initiativeTables);
    const add = (key: string, session: string | null, space: string | null | undefined) =>
      tables.addItem({
        key,
        kind: "world",
        session,
        context: null,
        text: key,
        person: null,
        at: Date.parse("2026-11-22T00:00:00Z"),
        ...(space === undefined ? {} : { space_id: space }),
      });
    add("A-home", null, A);
    add("B-home", null, B);
    add("none", null, null);
    add("A-here", "discord:gA:a1", A);
    const keys = (session: string, space: string | null) =>
      tables.unseenFor(session, 10, space).map((r) => r.key);
    expect(keys("discord:gA:a1", A)).toEqual(["A-home", "none", "A-here"]);
    expect(keys("discord:gB:b1", B)).toEqual(["B-home", "none"]);
    expect(keys("discord:dm:p1", null)).toEqual(["none"]);
    // A schedule gets its place's Space from identity.
    const row = tables.addSchedule({
      id: "S1",
      note: "n",
      due: 0,
      daily: null,
      context: { platform: "discord", scope: "gB", channel: "b1", kind: "channel" },
      person: null,
      for_account: null,
      source: "schedule",
      at: 0,
    });
    expect(row.space_id).toBe(B);
  });

  it("keeps a voice event of one server out of a run in another one", async () => {
    const db = await SqliteStore.open(":memory:", {
      plugins: [transcriptTables, initiativeTables],
    });
    const author = { account: { platform: "test", id: "x" }, display_name: "x" };
    const A1: ContextKey = { platform: "test", scope: "guild", channel: "c1", kind: "channel" };
    const B1: ContextKey = { platform: "test", scope: "guildB", channel: "b1", kind: "channel" };
    const VB: ContextKey = { platform: "test", scope: "guildB", channel: "vb", kind: "voice" };
    db.persons.resolve(A1, author);
    db.persons.resolve(B1, author);
    const rig = await Rig.create({ store: db });
    const salient = (context: ContextKey | null, detail: string, key: string) =>
      ({
        kind: "channel_active",
        key,
        account: null,
        person: null,
        display_name: null,
        context,
        detail,
        score: 0.8,
        count: 1,
        first_at: toTimestamp(Date.parse("2026-11-17T06:00:00Z")),
        at: toTimestamp(Date.now()),
      }) as never;
    rig.sup.bus.publish("world", Events.WorldSalient, salient(VB, "B 的語音頻道熱鬧起來了", "kb"));
    rig.sup.bus.publish("world", Events.WorldSalient, salient(null, "一件不屬於哪裡的事", "kn"));
    await until(
      () => db.plugin(initiativeTables).unseen().length === 2,
      3_000,
      "the two inbox items",
    );
    rig.model.push(says("嗨"), says("哈囉"));
    rig.say(mention(A1, "amy", "@她 你好"));
    await until(() => rig.sink.texts().length === 1, 3_000, "the answer in A");
    const inA = textOf(rig.model.requests[0]);
    expect(inA).toContain("一件不屬於哪裡的事");
    expect(inA).not.toContain("B 的語音頻道熱鬧起來了");
    rig.say(mention(B1, "amy", "@她 你好"));
    await until(() => rig.sink.texts().length === 2, 3_000, "the answer in B");
    expect(textOf(rig.model.requests[1])).toContain("B 的語音頻道熱鬧起來了");
  });
});
