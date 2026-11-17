// The migration on fixture data shaped like the old records: a relationship with deltas, a
// feeling card, the hearts of `self:state`, and people who are in only one of them.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Relationship, type RelationshipDelta, SqliteStore } from "@miyoria/store";
import { type JsonValue, toTimestamp } from "@miyoria/types";
import { describe, expect, it } from "vitest";
import {
  applyBond,
  heartPersonConfig,
  heartTables,
  type LegacyInput,
  migrateLegacy,
  parseLegacyHearts,
  warmthBaseline,
} from "../src/index.js";
import { type CardRecord, emptyExtras } from "../src/old-cards.js";

const rules = heartPersonConfig();
const NOW = Date.UTC(2026, 10, 17, 2, 0, 0);
const at = (daysAgo: number) => toTimestamp(NOW - daysAgo * 86_400_000);

function rel(person: string, overrides: Partial<Relationship> = {}): Relationship {
  return {
    profile: "default",
    person,
    affinity: 0,
    trust: 10,
    familiarity: 0,
    tags: [],
    notes: "",
    call_name: null,
    interactions: 0,
    last_interaction: null,
    updated_at: at(1),
    ...overrides,
  };
}

function card(person: string, text: string, f: (c: CardRecord) => void = () => {}): CardRecord {
  const record: CardRecord = {
    person,
    text,
    updated_at: at(1),
    by: "reflect",
    extras: emptyExtras(),
  };
  f(record);
  return record;
}

const selfState: JsonValue = {
  at: at(0),
  boredom: 0.2,
  hearts: {
    at: at(0),
    people: {
      mei: {
        name: "小美",
        romance: 0.42,
        emotions: { missing: 0.3, resentment: 0.2, gratitude: 0.5 },
        last_seen: at(2),
        last_together: at(3),
      },
      ghost: {
        name: "路人",
        romance: 0.05,
        emotions: { jealousy: 0.1 },
        last_seen: at(9),
        last_together: null,
      },
      broken: "not an object",
    },
    crush: { person: "mei", since: at(5) },
  },
};

const deltas: RelationshipDelta[] = [
  { at: at(10), affinity: 1, trust: 0.5, familiarity: 0, reason: "rule: thanks" },
  { at: at(4), affinity: 2, trust: 0, familiarity: 0.3, reason: "appraisal: warm" },
];

function input(): LegacyInput {
  return {
    relationships: [
      rel("mei", {
        affinity: 260,
        trust: 70,
        familiarity: 55,
        tags: ["regular"],
        notes: "常聊遊戲",
        call_name: "小美",
        interactions: 340,
        last_interaction: null,
      }),
      rel("owen", {
        affinity: 20,
        trust: 90,
        familiarity: 80,
        tags: ["owner"],
        interactions: 999,
        last_interaction: at(0),
      }),
      rel("troll", { affinity: -60, trust: 2, tags: ["blocked"], notes: "愛找碴" }),
    ],
    deltas: new Map([["mei", deltas]]),
    cards: [
      card("mei", "她很會照顧人。", (c) => {
        c.extras.stance = "嘴硬但會讓著她";
        c.extras.stance_level = 255;
        c.extras.public_feeling = "跟你玩遊戲很開心";
        c.extras.handle = "mei#1";
        c.extras.legacy = {
          romance: 0.1,
          knowledge: [{ id: "k1", kind: "person", title: "小美" }],
        };
      }),
      // Only a card: its numbers stand in.
      card("solo", "", (c) => {
        c.extras.call_name = "阿獨";
        c.extras.snapshot = {
          affinity: 130,
          trust: 30,
          familiarity: 20,
          owner: false,
          blocked: false,
          interactions: 12,
          last_interaction: at(6),
        };
      }),
    ],
    selfState,
  };
}

describe("migrateLegacy", () => {
  it("carries the numbers, words and tags over", () => {
    const { rows, skipped } = migrateLegacy(input(), () => false, rules, NOW);
    expect(rows.map((r) => r.person_id)).toEqual(["ghost", "mei", "owen", "solo", "troll"]);
    expect(skipped).toEqual([]);
    const mei = rows.find((r) => r.person_id === "mei");
    expect(mei).toMatchObject({
      bond: 260,
      trust: 70,
      familiarity: 55,
      tags: ["regular"],
      impression: "她很會照顧人。",
      stance: "嘴硬但會讓著她",
      public_feeling: "跟你玩遊戲很開心",
      call_name: "小美",
      interactions: 340,
      // The newest delta stands in for the missing last interaction.
      last_interaction: at(4),
      last_seen: at(2),
      last_together: at(3),
      longing: 0.3,
      grudge: 0.2,
      tier_floor: 240,
      decayed_on: null,
      created_at: toTimestamp(NOW),
    });
    expect(mei?.warmth).toBeCloseTo(warmthBaseline(260));
    // Ease and rapport start from how well she knows them (familiarity 55), not from zero.
    expect(mei?.respect).toBe(0);
    expect(mei?.ease).toBeCloseTo(0.44);
    expect(mei?.rapport).toBeCloseTo(0.33);
  });

  it("keeps what has no new home in legacy, romance among it", () => {
    const { rows } = migrateLegacy(input(), () => false, rules, NOW);
    const mei = rows.find((r) => r.person_id === "mei");
    expect(mei?.legacy).toEqual({
      migrated_at: toTimestamp(NOW),
      romance: 0.42,
      notes: "常聊遊戲",
      knowledge: [{ id: "k1", kind: "person", title: "小美" }],
      emotions: { gratitude: 0.5 },
      crush: true,
      name: "小美",
      handle: "mei#1",
      stance_level: 255,
      deltas: { count: 2, first_at: at(10), last_at: at(4) },
      from: ["relationships", "relationship_deltas", "self:feeling", "self:state"],
    });
    const ghost = rows.find((r) => r.person_id === "ghost");
    expect(ghost?.legacy).toMatchObject({
      romance: 0.05,
      emotions: { jealousy: 0.1 },
      from: ["self:state"],
    });
    expect(ghost?.last_seen).toBe(at(9));
    // The social notes are the impression when she wrote no feeling.
    expect(rows.find((r) => r.person_id === "troll")?.impression).toBe("愛找碴");
  });

  it("takes a card's numbers when there is no relationship", () => {
    const solo = migrateLegacy(input(), () => false, rules, NOW).rows.find(
      (r) => r.person_id === "solo",
    );
    expect(solo).toMatchObject({
      bond: 130,
      trust: 30,
      familiarity: 20,
      call_name: "阿獨",
      interactions: 12,
      last_interaction: at(6),
      tier_floor: 120,
    });
  });

  it("grandfathers the tiers already reached, so nobody is held back", () => {
    const { rows } = migrateLegacy(input(), () => false, rules, NOW);
    const mei = rows.find((r) => r.person_id === "mei");
    expect(mei?.anchors.map((a) => a.tier)).toEqual([120, 150, 190, 240]);
    expect(mei?.anchors.every((a) => a.by === "migrate" && a.note_ref === null)).toBe(true);
    // Back from a fall, the old tiers let the bond through; the next one still needs a memory.
    if (mei === undefined) throw new Error("no mei");
    expect(applyBond({ ...mei, bond: 100 }, 150, rules).bond).toBe(250);
    expect(applyBond(mei, 50, rules)).toMatchObject({ bond: 299.5, held: 300 });
  });

  it("applies the owner's rules and leaves people she dislikes below 0", () => {
    const { rows } = migrateLegacy(input(), () => false, rules, NOW);
    const owen = rows.find((r) => r.person_id === "owen");
    expect(owen).toMatchObject({ bond: 30, trust: 100, tier_floor: 15, anchors: [] });
    const troll = rows.find((r) => r.person_id === "troll");
    expect(troll).toMatchObject({ bond: -60, tier_floor: 0, tags: ["blocked"] });
    expect(troll?.warmth).toBeCloseTo(warmthBaseline(-60));
  });

  it("writes one migrate change per person", () => {
    const { rows, changes } = migrateLegacy(input(), () => false, rules, NOW);
    expect(changes).toHaveLength(rows.length);
    expect(changes.find((c) => c.person === "mei")).toEqual({
      person: "mei",
      field: "bond",
      delta: 260,
      value_after: 260,
      proposed: null,
      reason_quote: "",
      cause: "migrate",
    });
  });

  it("is safe to run twice", () => {
    const first = migrateLegacy(input(), () => false, rules, NOW);
    const done = new Set(first.rows.map((r) => r.person_id));
    const second = migrateLegacy(input(), (p) => done.has(p), rules, NOW + 60_000);
    expect(second.rows).toEqual([]);
    expect(second.changes).toEqual([]);
    expect(second.skipped).toEqual([...done].sort());
  });

  it("copes with nothing to migrate and a state without hearts", () => {
    const empty = { relationships: [], deltas: new Map(), cards: [], selfState: null };
    expect(migrateLegacy(empty, () => false, rules, NOW)).toEqual({
      rows: [],
      changes: [],
      skipped: [],
    });
    expect(parseLegacyHearts({ at: at(0) }).size).toBe(0);
    expect(parseLegacyHearts([1, 2]).size).toBe(0);
  });
});

describe("HeartStore.migrateLegacy", () => {
  it("writes through the store on a database file, and a second run changes nothing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "heart-migrate-"));
    const path = join(dir, "miyoria.db");
    const clock = { now: () => NOW };
    try {
      let store = await SqliteStore.open(path, { plugins: [heartTables], clock });
      const first = store.plugin(heartTables).people.migrateLegacy(input());
      expect(first.rows.map((r) => r.person_id)).toEqual(["ghost", "mei", "owen", "solo", "troll"]);
      await store.close();

      // Opened again, later: the rows and their events are there, and nothing more is written.
      store = await SqliteStore.open(path, {
        plugins: [heartTables],
        clock: { now: () => NOW + 60_000 },
      });
      const people = store.plugin(heartTables).people;
      const snapshot = () => ({
        rows: people.list({ limit: 200 }).entries.map((e) => e.person),
        events: store.events
          .query({ types: ["heart.changed"], limit: 1000 })
          .map((e) => e.envelope.id),
      });
      const before = snapshot();
      expect(before.rows).toHaveLength(5);
      expect(before.events).toHaveLength(5);
      expect(people.get("mei")).toEqual(first.rows.find((r) => r.person_id === "mei"));
      const second = people.migrateLegacy(input());
      expect(second.rows).toEqual([]);
      expect(second.skipped).toEqual(["ghost", "mei", "owen", "solo", "troll"]);
      expect(snapshot()).toEqual(before);
      await store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
