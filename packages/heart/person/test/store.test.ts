// The `heart` plugin's tables: a change writes the row and its event together, the caps come from
// the day's events, the daily pass runs once a day, anchors, the owner's changes, the list, and
// her own state written only when it changed.

import { type Identity, SqliteStore } from "@miyoria/store";
import { openTestDb, type TestDb } from "@miyoria/store/testing";
import { toTimestamp } from "@miyoria/types";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type HeartChangeRequest,
  HeartSelfStore,
  HeartStore,
  heartPersonConfig,
  heartSchema,
  heartTables,
  localDay,
  newPerson,
} from "../src/index.js";

const rules = heartPersonConfig();
/** 2026-11-17 10:00 in her time zone (UTC+8). */
const NOW = Date.UTC(2026, 10, 17, 2, 0, 0);
const DAY = 86_400_000;
const clock = { now: () => NOW };

const up = (field: "bond" | "trust" | "warmth" = "bond"): HeartChangeRequest => ({
  type: "propose",
  field,
  direction: "up",
  quote: "他記得我說過的話",
});

let t: TestDb;
let store: HeartStore;
let identity: Identity;

beforeEach(() => {
  t = openTestDb({ identity: true, plugins: [heartSchema], clock });
  identity = t.identity as Identity;
  store = new HeartStore(t.db, t.events, { rules, clock });
});

afterEach(() => t.close());

function changedCount(person?: string): number {
  return t.events.query({
    types: ["heart.changed"],
    ...(person === undefined ? {} : { personId: person }),
    limit: 1000,
  }).length;
}

describe("apply", () => {
  it("makes the row of someone new and writes the row and its event", () => {
    const applied = store.apply("p1", up());
    expect(applied.created).toBe(true);
    expect(applied.change).toMatchObject({ field: "bond", delta: 3, proposed: 3, cause: "feel" });
    expect(store.get("p1")?.bond).toBe(3);
    const [event] = t.events.query({ types: ["heart.changed"] });
    expect(event?.envelope.id).toBe(applied.event_id);
    expect(event?.envelope.data).toEqual(applied.change);
    expect(store.apply("p1", up()).created).toBe(false);
  });

  it("damps and caps from the day's events, also across store instances", () => {
    const deltas = store.applyAll("p1", [up(), up()]).map((a) => a.change.delta);
    expect(deltas).toEqual([3, 2.25]);
    // Another instance over the same database reads the same ledger from the log.
    const again = new HeartStore(t.db, t.events, { rules, clock });
    expect(again.apply("p1", up()).change.delta).toBeCloseTo(1.6875);
    // Tomorrow starts afresh.
    expect(again.apply("p1", up(), { now: NOW + DAY }).change.delta).toBe(3);
  });

  it("writes nothing when a change throws halfway", () => {
    t.db.tx(() => store.apply("p1", up()));
    expect(() =>
      t.db.tx(() => {
        store.apply("p1", up());
        throw new Error("the caller failed");
      }),
    ).toThrow("the caller failed");
    expect(store.get("p1")?.bond).toBe(3);
    expect(changedCount("p1")).toBe(1);
  });

  it("returns where a bond rise was held, and the next rise after an anchor passes", () => {
    store.upsert({ ...newPerson("p1", toTimestamp(NOW)), bond: 118, tier_floor: 75 });
    const held = store.apply("p1", up());
    expect(held.held).toBe(120);
    expect(held.person.bond).toBe(119.5);
    // The anchor alone does not move the bond.
    const anchored = store.setAnchor("p1", {
      tier: 120,
      note_ref: "01LINE",
      quote: "一起唱完那首歌",
      at: toTimestamp(NOW),
      by: "reflect",
    });
    expect(anchored.bond).toBe(119.5);
    const passed = store.apply("p1", up());
    expect(passed.held).toBeNull();
    expect(passed.person.bond).toBeGreaterThan(120);
    expect(passed.person.tier_floor).toBe(120);
  });

  it("lets the owner set a value, uncapped and unanchored, as an admin change", () => {
    store.applyAll("p1", [up(), up(), up(), up(), up(), up(), up(), up()]);
    const set = store.adminSet("p1", "bond", 300, { quote: "owner" });
    expect(set.change).toMatchObject({ cause: "admin", value_after: 300, reason_quote: "owner" });
    expect(set.person.tier_floor).toBe(300);
    expect(store.get("p1")?.bond).toBe(300);
    expect(() => store.adminSet("p1", "trust", Number.NaN)).toThrow();
  });
});

describe("tiers entered", () => {
  it("are told once committed, only for tiers above the highest one reached", () => {
    const told: { person: string; tiers: string[]; cause: string }[] = [];
    const off = store.onTierEntered((e) =>
      told.push({ person: e.person, tiers: e.tiers.map((t) => t.label), cause: e.cause }),
    );
    // 認識 is where everyone starts: a first small rise enters nothing.
    store.apply("p1", up());
    expect(told).toEqual([]);
    // A jump enters every tier on the way, lowest first.
    store.adminSet("p1", "bond", 50);
    expect(told).toEqual([{ person: "p1", tiers: ["朋友", "好朋友"], cause: "admin" }]);
    // Down and up again past a tier already reached tells nothing; the next new one does.
    store.adminSet("p1", "bond", 10);
    store.adminSet("p1", "bond", 80);
    expect(told.at(-1)).toEqual({ person: "p1", tiers: ["摯友"], cause: "admin" });
    expect(told).toHaveLength(2);
    // A rolled-back write is never told.
    expect(() =>
      t.db.tx(() => {
        store.adminSet("p1", "bond", 130);
        throw new Error("the caller failed");
      }),
    ).toThrow("the caller failed");
    expect(told).toHaveLength(2);
    // Inside a caller's transaction it is told when that commits.
    t.db.tx(() => {
      store.adminSet("p1", "bond", 130);
      expect(told).toHaveLength(2);
    });
    expect(told.at(-1)?.tiers).toEqual(["知心"]);
    off();
    store.adminSet("p1", "bond", 160);
    expect(told).toHaveLength(3);
  });

  it("are not told for the migration or a listener that throws", () => {
    const told: string[] = [];
    store.onTierEntered(() => {
      throw new Error("a broken listener");
    });
    store.onTierEntered((e) => told.push(e.person));
    store.migrateLegacy(
      {
        relationships: [
          {
            profile: "p",
            person: "p9",
            affinity: 200,
            trust: 50,
            familiarity: 40,
            tags: [],
            notes: "",
            call_name: null,
            interactions: 10,
            last_interaction: null,
            updated_at: toTimestamp(NOW),
          },
        ],
        deltas: new Map(),
        cards: [],
        selfState: null,
      },
      { now: NOW },
    );
    expect(store.get("p9")?.tier_floor).toBe(190);
    store.adminSet("p2", "bond", 20);
    expect(told).toEqual(["p2"]);
  });
});

describe("caps of another day", () => {
  it("counts a reflection's corrections against the day it reviewed when told to", () => {
    const yesterday = NOW - DAY;
    // Yesterday's good-direction bond cap (12) used up by her proposals.
    for (let i = 0; i < 40; i++) store.apply("p1", up(), { now: yesterday });
    const correction = {
      anchor: null,
      texts: {},
      proposals: [{ field: "bond" as const, direction: "up" as const, quote: "其實很開心" }],
    };
    const reviewed = store.reflect("p1", correction, { now: NOW, capsAt: yesterday });
    expect(reviewed.changes).toBe(1);
    expect(store.log.history("p1", { limit: 1 })[0]?.change.delta).toBeCloseTo(0, 3);
    // Against today's caps the same correction is a full step.
    store.reflect("p1", correction, { now: NOW });
    expect(store.log.history("p1", { limit: 1 })[0]?.change.delta).toBe(3);
  });
});

describe("anchors", () => {
  it("replace the anchor of the same tier and refuse a tier without one", () => {
    store.apply("p1", up());
    const anchor = { tier: 150, note_ref: null, quote: "a", at: toTimestamp(NOW), by: "admin" };
    store.setAnchor("p1", { ...anchor, by: "admin" });
    store.setAnchor("p1", { ...anchor, tier: 120, by: "reflect" });
    const p = store.setAnchor("p1", { ...anchor, quote: "b", by: "reflect" });
    expect(p.anchors.map((a) => [a.tier, a.quote])).toEqual([
      [120, "a"],
      [150, "b"],
    ]);
    expect(() => store.setAnchor("p1", { ...anchor, tier: 45, by: "admin" })).toThrow();
    expect(() => store.setAnchor("nobody", { ...anchor, by: "admin" })).toThrow();
    expect(store.removeAnchor("p1", 120)?.anchors.map((a) => a.tier)).toEqual([150]);
    expect(store.removeAnchor("nobody", 120)).toBeNull();
    // Anchors write no change.
    expect(changedCount("p1")).toBe(1);
  });
});

describe("applyDecay", () => {
  it("writes one decay change per field moved, and runs once a day", () => {
    store.upsert({
      ...newPerson("p1", toTimestamp(NOW - 30 * DAY)),
      bond: 60,
      tier_floor: 45,
      warmth: 0.2,
      last_interaction: toTimestamp(NOW - 10 * DAY),
      last_seen: toTimestamp(NOW - 10 * DAY),
      decayed_on: localDay(NOW, rules) - 1,
    });
    expect(store.decayDue()).toEqual(["p1"]);
    const first = store.applyDecay("p1");
    expect(first?.changes.find((c) => c.field === "bond")).toMatchObject({
      cause: "decay",
      delta: -1,
      proposed: null,
    });
    expect(changedCount("p1")).toBe(first?.changes.length);
    expect(store.get("p1")?.decayed_on).toBe(localDay(NOW, rules));
    expect(store.decayDue()).toEqual([]);
    expect(store.applyDecay("p1")?.changes).toEqual([]);
    expect(changedCount("p1")).toBe(first?.changes.length);
    expect(store.applyDecay("nobody")).toBeNull();
  });

  it("records the day also when nothing moved", () => {
    store.upsert({ ...newPerson("p1", toTimestamp(NOW)), last_interaction: toTimestamp(NOW) });
    expect(store.applyDecay("p1")?.changes).toEqual([]);
    expect(store.get("p1")?.decayed_on).toBe(localDay(NOW, rules));
  });
});

describe("list", () => {
  it("pages closest first and finds people by name, handle, call name or id", () => {
    const mei = identity.see({ platform: "discord", id: "1" }, "小美").id;
    const owen = identity.see({ platform: "discord", id: "2" }, "Owen").id;
    const at = toTimestamp(NOW);
    store.upsert({ ...newPerson(mei, at), bond: 200, call_name: "美美" });
    store.upsert({ ...newPerson(owen, at), bond: 50 });
    // Someone the migration found whom identity does not know.
    store.upsert({ ...newPerson("ghost", at), bond: 10 });

    const first = store.list({ limit: 2 });
    expect(first.entries.map((e) => e.person.person_id)).toEqual([mei, owen]);
    expect(first.entries[0]?.name).toBe("小美");
    expect(first).toMatchObject({ total: 3, next: 2 });
    const second = store.list({ limit: 2, offset: 2 });
    expect(second.entries.map((e) => [e.person.person_id, e.name])).toEqual([["ghost", null]]);
    expect(second.next).toBeNull();

    const ids = (search: string) => store.list({ search }).entries.map((e) => e.person.person_id);
    expect(ids("owen")).toEqual([owen]);
    expect(ids("美美")).toEqual([mei]);
    expect(ids("ghost")).toEqual(["ghost"]);
    expect(ids("%")).toEqual([]);
    expect(store.list({ search: "小" }).total).toBe(1);
  });
});

describe("evidence and people's requests", () => {
  it("appends evidence for the reflection to read", () => {
    const id = store.appendEvidence({
      person: "p1",
      kind: "voice_together",
      detail: "一起在語音",
      weight: 30,
      at: toTimestamp(NOW),
    });
    const read = store.log.evidence("p1", toTimestamp(NOW - DAY), toTimestamp(NOW + 1));
    expect(read.map((e) => e.id)).toEqual([id]);
  });

  it("moves a row on a merge, and makes two rows one with the closer one leading", () => {
    const at = toTimestamp(NOW);
    const later = toTimestamp(NOW + DAY);
    store.upsert({ ...newPerson("a", at), bond: 10 });
    expect(store.merge("c", "a")).toEqual({ counts: { moved: 1 } });
    expect(store.get("c")?.bond).toBe(10);
    store.upsert({
      ...newPerson("c", at),
      bond: 130,
      trust: 40,
      tier_floor: 120,
      impression: "",
      stance: "會鬧他",
      tags: ["regular"],
      anchors: [{ tier: 120, note_ref: "n1", quote: "第一次一起唱歌", at, by: "reflect" }],
      interactions: 5,
      last_interaction: at,
    });
    store.upsert({
      ...newPerson("b", at),
      bond: 320,
      trust: 70,
      tier_floor: 300,
      impression: "很會照顧人",
      stance: "",
      call_name: "阿B",
      tags: ["owner"],
      anchors: [
        { tier: 120, note_ref: "n2", quote: "幫她修麥克風", at, by: "reflect" },
        { tier: 300, note_ref: "n3", quote: "陪她過生日", at, by: "reflect" },
      ],
      interactions: 7,
      last_interaction: later,
    });
    expect(store.merge("c", "b")).toEqual({ counts: { merged: 1 } });
    expect(store.has("b")).toBe(false);
    expect(store.get("c")).toMatchObject({
      person_id: "c",
      bond: 320,
      trust: 70,
      tier_floor: 300,
      impression: "很會照顧人",
      stance: "會鬧他",
      call_name: "阿B",
      tags: ["owner", "regular"],
      interactions: 12,
      last_interaction: later,
    });
    expect(store.get("c")?.anchors.map((a) => [a.tier, a.note_ref])).toEqual([
      [120, "n2"],
      [300, "n3"],
    ]);
  });
});

describe("HeartSelfStore", () => {
  it("writes her state only when it changed", () => {
    const self = new HeartSelfStore(t.db, { clock });
    expect(self.get()).toBeNull();
    expect(self.save({ joy: 0.4, drives: { social: 0.2, rest: 0.1 } })).toBe(true);
    // The same state with the keys in another order is no change.
    expect(self.save({ drives: { rest: 0.1, social: 0.2 }, joy: 0.4 }, { now: NOW + 60_000 })).toBe(
      false,
    );
    const row = t.db.get("SELECT updated_at FROM heart_self");
    expect(row?.updated_at).toBe(NOW * 1000);
    expect(self.save({ joy: 0.5, drives: { social: 0.2, rest: 0.1 } }, { now: NOW + 1 })).toBe(
      true,
    );
    expect(self.get()).toEqual({ joy: 0.5, drives: { social: 0.2, rest: 0.1 } });
  });
});

describe("the plugin", () => {
  it("counts its rows with relationships and inner, whose wipe takes its kept events", async () => {
    const s = await SqliteStore.open(":memory:", { plugins: [heartTables], clock });
    try {
      const heart = s.plugin(heartTables);
      heart.people.apply("p1", up());
      heart.self.save({ joy: 0.1 });
      const count = async (category: string, part: string) =>
        (await s.profileData.inventory("p")).categories
          .find((c) => c.id === category)
          ?.parts.find((p) => p.id === part)?.count;
      expect(await count("relationships", "heart_person")).toBe(1);
      expect(await count("inner", "heart_self")).toBe(1);
      const changed = () => s.events.query({ types: ["heart.changed"] }).length;
      // The event log alone keeps the record of a change (keep tier)...
      await s.profileData.wipe("p", ["event_log"]);
      expect(changed()).toBe(1);
      // ...which goes when the relationships go with it.
      await s.profileData.wipe("p", ["event_log", "relationships"]);
      expect(changed()).toBe(0);
      expect(heart.people.get("p1")).toBeNull();
    } finally {
      await s.close();
    }
  });
});
