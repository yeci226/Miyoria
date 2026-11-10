// The migration into person cards: nothing is lost, running it again changes nothing, and what
// she wrote with reference codes is not guessed at.

import { Supervisor } from "@miyoria/kernel";
import {
  MemorySettingsStore,
  PeopleStoreKey,
  type Relationship,
  type RelationshipStore,
  RelationshipStoreKey,
  SettingsStoreKey,
} from "@miyoria/store";
import { AffectStateKey, SelfStateKey, toTimestamp } from "@miyoria/types";
import { afterEach, describe, expect, it } from "vitest";
import { selfConfig } from "../src/config.js";
import { temperament } from "../src/emotions.js";
import { SelfEngine } from "../src/engine.js";
import { FeelingsBook } from "../src/feelings.js";
import { MIGRATION_KEY, migrateCards, seedAttachment } from "../src/migrate.js";
import { SelfModule, STATE_KEY } from "../src/module.js";
import { T0 } from "./helpers.js";

const profile = "p";

function relationship(person: string, extra: Partial<Relationship> = {}): Relationship {
  return {
    profile,
    person,
    affinity: 0,
    trust: 10,
    familiarity: 0,
    tags: [],
    notes: "",
    call_name: null,
    interactions: 0,
    last_interaction: null,
    updated_at: toTimestamp(T0),
    ...extra,
  };
}

function relStore(rows: Relationship[]): RelationshipStore {
  return {
    list: async () => rows.map((r) => structuredClone(r)),
  } as unknown as RelationshipStore;
}

/** A store with the older records: hearts in `self:state`, feelings, knowledge docs, a mood. */
async function oldStore() {
  const store = new MemorySettingsStore();
  const engine = new SelfEngine(selfConfig(), T0, temperament().temperament);
  engine.hearts.seen("owen", "Owen", true, T0);
  // Romance she felt for Owen (the old way: many small days).
  for (let d = 10; d > 0; d--) engine.hearts.romance("owen", 0.06, T0 - d * 86_400_000);
  engine.hearts.feel("owen", "gratitude", 0.4, T0);
  await store.set(profile, STATE_KEY, engine.toJson());
  await store.set(profile, "self:feeling:owen", {
    text: "Owen 很可靠。",
    updated_at: toTimestamp(T0),
    by: "self",
  });
  await store.set(profile, "self:feeling:amy", {
    text: "u7 常常在。她人很好。",
    updated_at: toTimestamp(T0),
    by: "self",
  });
  await store.set(profile, "mood:last", {
    valence: 0.3,
    arousal: 0.4,
    energy: 0.6,
    at: toTimestamp(T0),
  });
  await store.set(profile, "knowledge:doc:d1", {
    id: "d1",
    subject: { type: "person", person: "owen" },
    kind: "人物卡",
    title: "Owen",
    content: { 喜歡: ["音遊"] },
  });
  await store.set(profile, "knowledge:doc:d2", {
    id: "d2",
    subject: { type: "topic", name: "MC" },
    kind: "計畫",
    title: "MC",
    content: {},
  });
  return store;
}

const rels = [
  relationship("owen", {
    affinity: 80,
    trust: 100,
    familiarity: 35,
    tags: ["owner"],
    notes: "他是我的主人。",
    call_name: "歐文",
    interactions: 600,
  }),
  relationship("amy", {
    affinity: 60,
    familiarity: 12,
    notes: "Amy 很溫柔。u3 也是。",
    interactions: 20,
  }),
  relationship("bob", { affinity: 10, familiarity: 2, tags: ["blocked"] }),
];

async function run(store: MemorySettingsStore, now = T0 + 1000) {
  const engine = new SelfEngine(selfConfig(), T0, temperament().temperament);
  const loaded = await store.get(profile, STATE_KEY);
  if (loaded !== null) engine.restore(loaded, T0);
  const feelings = new FeelingsBook(store, profile, 500);
  await feelings.load();
  const report = await migrateCards({
    store,
    profile,
    feelings,
    hearts: engine.hearts,
    relationships: relStore(rels),
    handleOf: (person) => (person === "owen" ? "Owen" : null),
    names: new Map([
      ["amy", "Amy"],
      ["bob", "Bob"],
      ["owen", "Owen"],
    ]),
    persist: async () => {
      await store.set(profile, STATE_KEY, engine.toJson());
    },
    now,
  });
  return { report, engine, feelings };
}

async function dump(store: MemorySettingsStore) {
  const out: Record<string, unknown> = {};
  for (const prefix of ["self:", "knowledge:", "mood:"]) {
    for (const [k, v] of await store.list(profile, prefix)) out[k] = v;
  }
  return out;
}

describe("person card migration", () => {
  it("merges relationships, hearts, feelings and knowledge into cards without deleting anything", async () => {
    const store = await oldStore();
    const before = await dump(store);
    const { report, engine, feelings } = await run(store);
    expect(report).toMatchObject({ people: 3, migrated: 3, skipped: 0 });

    // Her feeling is kept as she wrote it; the social impression fills in where she wrote none.
    expect(feelings.get("owen")?.text).toBe("Owen 很可靠。");
    expect(feelings.record("owen")?.extras).toMatchObject({
      handle: "Owen",
      call_name: "歐文",
      snapshot: {
        affinity: 80,
        trust: 100,
        familiarity: 35,
        owner: true,
        blocked: false,
        interactions: 600,
      },
      legacy: {
        notes: "他是我的主人。",
        knowledge: [{ id: "d1", kind: "人物卡", title: "Owen" }],
      },
    });
    expect(feelings.record("owen")?.extras.legacy.romance).toBeGreaterThan(0.3);
    // Attachment is what the romance was.
    expect(engine.hearts.romanceOf("owen")).toBeGreaterThan(0.3);

    // A person with no heart yet gets a small attachment from how much she likes them: never a crush.
    expect(engine.hearts.has("amy")).toBe(true);
    expect(engine.hearts.romanceOf("amy")).toBeCloseTo(seedAttachment(60), 6);
    expect(engine.hearts.romanceOf("amy")).toBeLessThan(0.35);
    expect(engine.hearts.crush(T0)?.person).toBe("owen");
    // A blocked person is flagged.
    expect(feelings.record("bob")?.extras.snapshot?.blocked).toBe(true);

    // Reference codes in old text are dropped, not guessed at (the sentence goes, the rest stays).
    expect(feelings.get("amy")?.text).toBe("她人很好。");
    expect(report.dropped).toBeGreaterThan(0);
    expect(feelings.record("amy")?.extras.legacy.notes).toBe("Amy 很溫柔。");
    expect(JSON.stringify(await dump(store))).not.toMatch(
      /(?<![A-Za-z0-9_])u[0-9]+(?![A-Za-z0-9_])/,
    );

    // Nothing was deleted: every old key is still there, with the old fields it had.
    const after = await dump(store);
    for (const key of Object.keys(before)) expect(after, key).toHaveProperty(key);
    expect(after["mood:last"]).toEqual(before["mood:last"]);
    expect(after["knowledge:doc:d1"]).toEqual(before["knowledge:doc:d1"]);
    expect(after["self:feeling:owen"]).toMatchObject({ text: "Owen 很可靠。", by: "self" });
    // The old mood is kept in the marker (the mood is derived now).
    expect(after[MIGRATION_KEY]).toMatchObject({
      version: 1,
      people: 3,
      legacy_mood: { valence: 0.3 },
    });
  });

  it("is idempotent: a second run changes nothing", async () => {
    const store = await oldStore();
    await run(store);
    const once = JSON.stringify(await dump(store));
    const second = await run(store, T0 + 99_999);
    expect(second.report).toMatchObject({ migrated: 0, skipped: 3 });
    expect(JSON.stringify(await dump(store))).toBe(once);
    // Attachment is not seeded twice either.
    expect(second.engine.hearts.romanceOf("amy")).toBeCloseTo(seedAttachment(60), 6);
  });

  it("finishes what a crashed run did not", async () => {
    const store = await oldStore();
    // Owen's card is done, the rest are not.
    await store.set(profile, "self:feeling:owen", {
      text: "Owen 很可靠。",
      updated_at: toTimestamp(T0),
      by: "self",
      card: { v: 1, handle: "Owen", migrated_at: toTimestamp(T0) },
    });
    const { report, feelings } = await run(store);
    expect(report).toMatchObject({ migrated: 2, skipped: 1 });
    expect(feelings.record("amy")?.extras.migrated_at).not.toBeNull();
  });

  it("two people with one name get Owen and Owen#2", async () => {
    const store = new MemorySettingsStore();
    const engine = new SelfEngine(selfConfig(), T0, temperament().temperament);
    const feelings = new FeelingsBook(store, profile, 500);
    await migrateCards({
      store,
      profile,
      feelings,
      hearts: engine.hearts,
      relationships: relStore([relationship("a"), relationship("b")]),
      handleOf: () => null,
      names: new Map([
        ["a", "Owen"],
        ["b", "Owen"],
      ]),
      now: T0,
    });
    expect([feelings.record("a")?.extras.handle, feelings.record("b")?.extras.handle]).toEqual([
      "Owen",
      "Owen#2",
    ]);
  });

  it("works with nothing to migrate and without a social store", async () => {
    const store = new MemorySettingsStore();
    const engine = new SelfEngine(selfConfig(), T0, temperament().temperament);
    const feelings = new FeelingsBook(store, profile, 500);
    const report = await migrateCards({
      store,
      profile,
      feelings,
      hearts: engine.hearts,
      relationships: null,
      handleOf: () => null,
      names: new Map(),
      now: T0,
    });
    expect(report).toEqual({ people: 0, migrated: 0, skipped: 0, dropped: 0 });
  });
});

describe("the module runs it at start", () => {
  const cleanup: (() => Promise<void>)[] = [];
  afterEach(async () => {
    for (const fn of cleanup.splice(0)) await fn();
  });

  it("serves the merged cards through the affect service", async () => {
    const store = await oldStore();
    const sup = new Supervisor();
    cleanup.push(() => sup.stopAll());
    sup.services.provide("app", SettingsStoreKey, store);
    sup.services.provide("app", RelationshipStoreKey, relStore(rels));
    sup.services.provide("app", PeopleStoreKey, {
      all: async () => [
        { id: "owen", display_name: "Owen", created_at: toTimestamp(T0), accounts: [] },
        { id: "amy", display_name: "Amy", created_at: toTimestamp(T0), accounts: [] },
      ],
    } as never);
    await sup.register(new SelfModule(profile, { clock: { now: () => T0 + 5000 } }), null, true);
    await sup.startAll();
    const affect = sup.services.require(AffectStateKey);
    const owen = affect.card("owen");
    // No social module here: the stored snapshot stands in for the numbers.
    expect(owen).toMatchObject({
      handle: "Owen",
      affinity: 80,
      familiarity: 35,
      label: "摯友",
      owner: true,
      feeling: "Owen 很可靠。",
    });
    expect(owen?.attachment).toBeGreaterThan(0.3);
    expect(affect.cards().map((c) => c.handle)).toContain("Amy");
    // The old reads still work.
    expect(sup.services.require(SelfStateKey).feeling("owen")?.text).toBe("Owen 很可靠。");
    expect(sup.services.require(SelfStateKey).crush()?.person).toBe("owen");
    expect(await store.get(profile, MIGRATION_KEY)).toMatchObject({ version: 1 });
  });
});
