// Module `heart` (docs/design/v5-heart.md §2.9): it owns the store's `heart` plugin, puts its config
// section's rules in force, moves the old records over once, runs the daily pass by her local day
// on its clock, and provides `HeartKey`; through it her `feel` is applied by the rules and the lines
// people say are counted.

import { Supervisor } from "@miyoria/runtime/kernel";
import { SqliteStore, StoreKey } from "@miyoria/store";
import { type Clock, HeartKey, type JsonObject, toTimestamp } from "@miyoria/types";
import { afterEach, describe, expect, it } from "vitest";
import {
  HeartModule,
  HeartService,
  heartTables,
  localDay,
  MIGRATED_KEY,
  migrateOnStart,
  runDecay,
} from "../src/index.js";

/** 2026-11-17 10:00 in her time zone (UTC+8): what day it is never depends on the machine. */
const T0 = Date.UTC(2026, 10, 17, 2, 0, 0);
const DAY = 86_400_000;
const PROFILE = "p";

class ManualClock implements Clock {
  constructor(public at = T0) {}
  now(): number {
    return this.at;
  }
}

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f();
});

async function openStore(clock: Clock): Promise<SqliteStore> {
  const store = await SqliteStore.open(":memory:", { plugins: [heartTables], clock });
  cleanup.push(() => store.close());
  return store;
}

async function oldRecords(store: SqliteStore): Promise<void> {
  const at = toTimestamp(T0 - 3 * DAY);
  await store.relationships.upsert({
    profile: PROFILE,
    person: "owen",
    affinity: 60,
    trust: 40,
    familiarity: 30,
    tags: ["owner"],
    notes: "",
    call_name: "歐文",
    interactions: 12,
    last_interaction: at,
    updated_at: at,
  });
  await store.relationships.upsert({
    profile: PROFILE,
    person: "amy",
    affinity: 20,
    trust: 10,
    familiarity: 8,
    tags: [],
    notes: "愛聊遊戲",
    call_name: null,
    interactions: 3,
    last_interaction: at,
    updated_at: at,
  });
  await store.settings.set(PROFILE, "self:state", {
    hearts: { people: { amy: { romance: 0.2, emotions: { missing: 0.3 } } } },
  });
}

async function startModule(
  store: SqliteStore,
  clock: ManualClock,
  config: JsonObject | null = null,
) {
  const sup = new Supervisor();
  cleanup.push(() => sup.stopAll());
  sup.services.provide("app", StoreKey, store);
  await sup.register(new HeartModule(PROFILE, { clock }), config, true);
  await sup.startAll();
  return sup;
}

describe("the migration on start", () => {
  it("moves the old records once, and never again", async () => {
    const clock = new ManualClock();
    const store = await openStore(clock);
    await oldRecords(store);
    const people = store.plugin(heartTables).people;
    const log = { lines: [] as unknown[], info: (o: unknown) => log.lines.push(o) };
    const deps = {
      people,
      settings: store.settings,
      relationships: store.relationships,
      profile: PROFILE,
      now: clock.now(),
      log,
    };
    const first = await migrateOnStart(deps);
    expect(first?.rows.map((r) => r.person_id)).toEqual(["amy", "owen"]);
    expect(people.get("amy")).toMatchObject({ bond: 20, impression: "愛聊遊戲", longing: 0.3 });
    expect(log.lines).toEqual([
      { rows: 2, skipped: 0, relationships: 2, cards: 0, self_state: true },
    ]);
    expect(await store.settings.get(PROFILE, MIGRATED_KEY)).toMatchObject({ rows: 2 });
    // Run again, and again once everyone was forgotten: nothing moves back.
    expect(await migrateOnStart(deps)).toBeNull();
    people.forgetPerson(["amy", "owen"], "forget me", "memory");
    expect(await migrateOnStart(deps)).toBeNull();
    expect(people.get("amy")?.impression).toBe("");
  });

  it("moves the people without a row also when the table has rows already", async () => {
    const clock = new ManualClock();
    const store = await openStore(clock);
    await oldRecords(store);
    const people = store.plugin(heartTables).people;
    // Someone counted on an earlier start whose migration failed.
    people.seen("zed", { text: "hi", directed: true, together: true, at: T0 });
    people.seen("amy", { text: "hi", directed: true, together: true, at: T0 });
    const deps = {
      people,
      settings: store.settings,
      relationships: store.relationships,
      profile: PROFILE,
      now: T0,
      log: { info: () => undefined },
    };
    const result = await migrateOnStart(deps);
    expect(result?.rows.map((r) => r.person_id)).toEqual(["owen"]);
    expect(people.get("owen")?.bond).toBe(60);
    // Amy had a row: hers stays as it was.
    expect(people.get("amy")?.bond).toBe(0);
    expect(await store.settings.get(PROFILE, MIGRATED_KEY)).toMatchObject({ rows: 1 });
  });

  it("does not record a migration that failed, and the next start tries again", async () => {
    const clock = new ManualClock();
    const store = await openStore(clock);
    await oldRecords(store);
    const people = store.plugin(heartTables).people;
    let broken = true;
    const deps = {
      people,
      settings: store.settings,
      relationships: {
        list: async (profile: string) => {
          if (broken) throw new Error("disk went away");
          return store.relationships.list(profile);
        },
        deltasSince: store.relationships.deltasSince.bind(store.relationships),
      },
      profile: PROFILE,
      now: T0,
      log: { info: () => undefined },
    };
    await expect(migrateOnStart(deps)).rejects.toThrow(/disk went away/);
    expect(await store.settings.get(PROFILE, MIGRATED_KEY)).toBeNull();
    broken = false;
    expect((await migrateOnStart(deps))?.rows).toHaveLength(2);
    expect(await store.settings.get(PROFILE, MIGRATED_KEY)).not.toBeNull();
  });

  it("runs from the module's start, and the module provides the heart", async () => {
    const clock = new ManualClock();
    const store = await openStore(clock);
    await oldRecords(store);
    const sup = await startModule(store, clock);
    const heart = sup.services.require(HeartKey);
    expect(heart.view("owen")).toMatchObject({ bond: 60, owner: true, call_name: "歐文" });
    await sup.stopAll();
    // A restart does not move them again.
    const again = await startModule(store, clock);
    expect(again.services.require(HeartKey).view("amy")?.bond).toBe(20);
    expect(store.plugin(heartTables).people.list().total).toBe(2);
  });

  it("puts its section's rules in force", async () => {
    const clock = new ManualClock();
    const store = await openStore(clock);
    await startModule(store, clock, { bond_gain_caps: [[0, 40]], decay_check_mins: 5 });
    expect(store.plugin(heartTables).people.rules.bond_gain_caps).toEqual([[0, 40]]);
  });
});

describe("the daily pass", () => {
  it("runs once per person and local day, on the clock it is given", async () => {
    const clock = new ManualClock();
    const store = await openStore(clock);
    const people = store.plugin(heartTables).people;
    people.adminSet("amy", "bond", 50, { now: T0 - 20 * DAY });
    people.seen("amy", { text: "hi", directed: true, together: true, at: T0 - 20 * DAY });
    const today = localDay(T0, people.rules);
    const first = await runDecay(people, T0);
    expect(first.people).toBe(1);
    expect(first.changes).toBeGreaterThan(0);
    expect(people.get("amy")?.decayed_on).toBe(today);
    const bond = people.get("amy")?.bond ?? 0;
    // The same day again: nothing.
    expect(await runDecay(people, T0 + 3_600_000)).toEqual({ people: 0, changes: 0 });
    // The next local day: once more, a point of bond less (more than a week without contact).
    expect((await runDecay(people, T0 + DAY)).people).toBe(1);
    expect(people.get("amy")?.bond).toBeCloseTo(bond - 1);
    expect(people.get("amy")?.decayed_on).toBe(today + 1);
  });
});

describe("the daily pass over many people", () => {
  it("lets the rest of the process run between batches", async () => {
    const clock = new ManualClock();
    const store = await openStore(clock);
    const people = store.plugin(heartTables).people;
    for (let i = 0; i < 120; i++) people.adminSet(`p${String(i).padStart(3, "0")}`, "bond", 10);
    const order: string[] = [];
    const done = await runDecay(people, T0, {
      batch: 50,
      pause: async () => {
        order.push(`pause after ${people.decayDue(T0).length} left`);
      },
    });
    expect(done.people).toBe(120);
    expect(order).toEqual(["pause after 70 left", "pause after 20 left"]);
  });
});

describe("the heart as the others see it", () => {
  it("applies her proposals by the rules with the turn, and never for a blocked person", async () => {
    const clock = new ManualClock();
    const store = await openStore(clock);
    const people = store.plugin(heartTables).people;
    const heart = new HeartService(people, clock);
    const quote = "他記得我想吃的東西";
    const up = { field: "bond" as const, direction: "up" as const, quote };
    expect(heart.feel("owen", [up, up, up, up], { turn: "t1" })).toBe(4);
    // Damped by the store's ledger: 3 + 2.25 + 1.6875 + 1.265625.
    expect(people.get("owen")?.bond).toBeCloseTo(8.203125);
    const events = store.events?.query({ types: ["heart.changed"], personId: "owen" }) ?? [];
    expect(events.map((e) => e.envelope.turn)).toEqual(["t1", "t1", "t1", "t1"]);
    // A whole day of proposals never passes the day's cap.
    for (let i = 0; i < 40; i++) heart.feel("owen", [up], { turn: `t${i + 2}` });
    expect(people.get("owen")?.bond).toBeLessThanOrEqual(12);
    people.upsert({ ...(people.get("owen") ?? fail()), tags: ["blocked"] });
    expect(heart.feel("owen", [up], { turn: "tx" })).toBe(0);
  });

  it("counts a line: when she saw them, talked, was with them; familiarity grows", async () => {
    const clock = new ManualClock();
    const store = await openStore(clock);
    const people = store.plugin(heartTables).people;
    const heart = new HeartService(people, clock);
    heart.seen("amy", { text: "大家好", directed: false, together: false, at: T0 });
    expect(people.get("amy")).toMatchObject({
      interactions: 0,
      last_seen: toTimestamp(T0),
      last_interaction: null,
      last_together: null,
    });
    const before = people.get("amy")?.familiarity ?? 0;
    heart.seen("amy", { text: "米優妳今天在幹嘛", directed: true, together: false, at: T0 + 1 });
    expect(people.get("amy")).toMatchObject({
      interactions: 1,
      last_interaction: toTimestamp(T0 + 1),
      last_together: toTimestamp(T0 + 1),
    });
    expect(people.get("amy")?.familiarity).toBeGreaterThan(before);
    // No change event for counting.
    expect(store.events?.query({ types: ["heart.changed"] }) ?? []).toEqual([]);
  });

  it("knows the one she cares about most, above the threshold", async () => {
    const clock = new ManualClock();
    const store = await openStore(clock);
    const people = store.plugin(heartTables).people;
    const heart = new HeartService(people, clock);
    people.adminSet("amy", "bond", 20);
    people.adminSet("owen", "bond", 60);
    people.adminSet("owen", "warmth", 0.3);
    expect(heart.mostCared()?.person).toBe("owen");
    expect(heart.mostCared(["amy"])).toBeNull();
    expect(heart.cares("nobody")).toBe(0);
  });
});

describe("forget me", () => {
  it("takes them for someone she has just met and takes out what she made of their words", async () => {
    const clock = new ManualClock();
    const store = await openStore(clock);
    const people = store.plugin(heartTables).people;
    const amy = await store.people.upsertAccount({ platform: "discord", id: "1" }, "Amy");
    const heart = new HeartService(people, clock);
    heart.feel(amy, [{ field: "bond", direction: "up", quote: "她說她住在台南" }], {
      turn: "t1",
    });
    heart.evidence({
      person: amy,
      kind: "played_together",
      detail: "一起玩了〈她家附近的店〉",
      weight: null,
    });
    people.adminSet(amy, "bond", 130);
    people.setAnchor(amy, {
      tier: 120,
      note_ref: "n1",
      quote: "她說她小時候養過貓",
      at: toTimestamp(T0),
      by: "reflect",
    });
    people.edit(amy, {
      impression: "住台南的工程師",
      stance: "會鬧她",
      unfinished: "她換工作的事",
      jokes: "貓",
      dislikes: "遲到",
      public_feeling: "很好聊",
      call_name: "阿咪",
      tags: ["regular"],
    });
    const before = people.get(amy) ?? fail();
    const result = store.personData.forget(amy, { reason: "forget me", source: "memory" });
    expect(result.hooks.find((h) => h.plugin === "heart")?.counts).toEqual({
      people: 1,
      changes: 1,
      evidence: 1,
    });
    const after = people.get(amy) ?? fail();
    // What they built goes; the tags stay.
    expect(before.bond).toBe(130);
    expect(after).toMatchObject({
      bond: 0,
      trust: 10,
      familiarity: 0,
      tier_floor: 0,
      anchors: [],
      tags: ["regular"],
      call_name: null,
      interactions: 0,
    });
    expect(after).toMatchObject({
      impression: "",
      stance: "",
      unfinished: "",
      jokes: "",
      dislikes: "",
      public_feeling: null,
    });
    // The log keeps the numbers of the change and loses the words.
    const history = people.log.history(amy);
    expect(history.every((h) => h.change.reason_quote === "")).toBe(true);
    expect(history.at(-1)?.change).toMatchObject({ field: "bond", delta: 3, cause: "feel" });
    // The reset is on the log as a change of its own.
    expect(history[0]?.change).toMatchObject({ field: "bond", value_after: 0, cause: "admin" });
    expect(people.log.recentEvidence(amy)[0]?.evidence).toMatchObject({
      kind: "played_together",
      detail: "",
    });
    const all = JSON.stringify(store.events?.query({ limit: 1000 }) ?? []);
    for (const words of ["台南", "她家附近", "養過貓", "很好聊"]) expect(all).not.toContain(words);
    // Today's caps still count the change that was made.
    expect(people.log.dayLedger(amy, T0).fields.bond.up).toBe(3);
  });
});

describe("forget me, when she holds something against them", () => {
  it("keeps a bond below zero, the grudge and the blocked tag", async () => {
    const clock = new ManualClock();
    const store = await openStore(clock);
    const people = store.plugin(heartTables).people;
    const bob = await store.people.upsertAccount({ platform: "discord", id: "2" }, "Bob");
    people.adminSet(bob, "bond", -40);
    people.adminSet(bob, "grudge", 0.6);
    people.adminSet(bob, "trust", 3);
    people.adminSet(bob, "warmth", -0.5);
    people.adminSet(bob, "rapport", 0.4);
    people.edit(bob, { tags: ["blocked"], impression: "一直洗頻" });
    store.personData.forget(bob, { reason: "forget me", source: "memory" });
    expect(people.get(bob)).toMatchObject({
      bond: -40,
      grudge: 0.6,
      trust: 3,
      warmth: -0.5,
      rapport: 0,
      tags: ["blocked"],
      impression: "",
    });
  });

  it("leaves the owner the owner's floors", async () => {
    const clock = new ManualClock();
    const store = await openStore(clock);
    const people = store.plugin(heartTables).people;
    const owner = await store.people.upsertAccount({ platform: "discord", id: "3" }, "Owner");
    people.edit(owner, { tags: ["owner"] });
    people.adminSet(owner, "bond", 400);
    store.personData.forget(owner, { reason: "forget me", source: "memory" });
    expect(people.get(owner)).toMatchObject({ bond: 30, trust: 100, tags: ["owner"] });
  });
});

function fail(): never {
  throw new Error("no row");
}
