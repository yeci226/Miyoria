// Her schedules and inbox in the store's data page and in "forget me".

import { hookCounts, SqliteStore } from "@miyoria/store";
import { afterEach, describe, expect, it } from "vitest";
import { initiativeTables } from "../src/index.js";

const stores: SqliteStore[] = [];

afterEach(async () => {
  for (const s of stores.splice(0)) await s.close();
});

async function open() {
  const store = await SqliteStore.open(":memory:", { plugins: [initiativeTables] });
  stores.push(store);
  return { store, tables: store.plugin(initiativeTables) };
}

const AT = Date.parse("2026-11-17T06:00:00Z");

describe("the initiative tables in the store", () => {
  it("are counted and exported on the data page under her initiative", async () => {
    const { store, tables } = await open();
    tables.addSchedule({
      id: "S1",
      note: "看看大家",
      due: AT,
      daily: null,
      context: null,
      person: null,
      for_account: null,
      source: "schedule",
      at: AT,
    });
    tables.addItem({
      key: "world:k:1",
      kind: "world",
      session: null,
      context: null,
      text: "有人開台",
      person: null,
      at: AT,
    });
    const inv = await store.profileData.inventory("p");
    const parts = inv.categories.find((c) => c.id === "initiative")?.parts ?? [];
    expect(parts.filter((p) => p.id.startsWith("initiative_")).map((p) => [p.id, p.count])).toEqual(
      [
        ["initiative_schedules", 1],
        ["initiative_inbox", 1],
      ],
    );
    const backup = await store.profileData.export("p", ["initiative"]);
    expect(backup.parts.initiative_schedules).toHaveLength(1);
    expect(backup.parts.initiative_inbox).toHaveLength(1);
  });

  it("forget me deletes what is about or from that person and keeps the rest", async () => {
    const { store, tables } = await open();
    const owen = await store.people.upsertAccount({ platform: "test", id: "100" }, "Owen");
    const amy = await store.people.upsertAccount({ platform: "test", id: "200" }, "Amy");
    const handleOf = (id: string) => store.persons.personRow(id)?.handle ?? "";
    const schedule = (id: string, person: string | null, asked: string | null) =>
      tables.addSchedule({
        id,
        note: id,
        due: AT,
        daily: null,
        context: null,
        person,
        for_account: asked === null ? null : { platform: "test", id: asked },
        source: asked === null ? "schedule" : "remind_me",
        at: AT,
      });
    schedule("ABOUT", handleOf(owen), null);
    schedule("ASKED", null, "100");
    schedule("AMYS", handleOf(amy), "200");
    schedule("OWN", null, null);
    const item = (key: string, person: string | null) =>
      tables.addItem({
        key,
        kind: "world",
        session: null,
        context: null,
        text: key,
        person,
        at: AT,
      });
    item("about-owen", handleOf(owen).toUpperCase());
    item("about-amy", handleOf(amy));
    item("nobody", null);

    expect(store.personData.participants()).toContain("initiative");
    const result = store.personData.forget(owen, { reason: "forget me", source: "test" });
    expect(hookCounts(result, "initiative")).toEqual({ schedules: 2, inbox: 1 });
    expect(
      tables
        .openSchedules()
        .map((s) => s.id)
        .sort(),
    ).toEqual(["AMYS", "OWN"]);
    expect(tables.unseen().map((i) => i.key)).toEqual(["about-amy", "nobody"]);
  });
});
