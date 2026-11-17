import { openTestDb, type TestDb } from "@miyoria/store/testing";
import { type Timestamp, toTimestamp } from "@miyoria/types";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applyChange,
  changeWrite,
  dayStart,
  evidenceWrite,
  type HeartChange,
  HeartLog,
  heartPersonConfig,
  localDay,
  newPerson,
} from "../src/index.js";

const rules = heartPersonConfig();
/** 2026-11-17 10:00 in her time zone (UTC+8). */
const NOW = Date.UTC(2026, 10, 17, 2, 0, 0);
const TODAY = localDay(NOW, rules);

function change(overrides: Partial<HeartChange> = {}): HeartChange {
  return {
    person: "p1",
    field: "bond",
    delta: 1,
    value_after: 1,
    proposed: 1,
    reason_quote: "",
    cause: "feel",
    ...overrides,
  };
}

let t: TestDb;
let log: HeartLog;

beforeEach(() => {
  t = openTestDb();
  log = new HeartLog(t.events, rules);
});

afterEach(() => t.close());

function write(c: HeartChange, at: Timestamp): string {
  return t.events.appendNow(changeWrite(c, at)).id;
}

describe("heart.changed on the log", () => {
  it("is the owner's, kept forever, and names the person", () => {
    write(change(), toTimestamp(NOW));
    const [row] = t.events.query({ types: ["heart.changed"] });
    expect(row?.envelope).toMatchObject({
      type: "heart.changed",
      person_id: "p1",
      scope: "owner",
      tier: "keep",
      source: "heart",
    });
  });

  it("pages a person's history newest first", () => {
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push(write(change({ delta: i }), toTimestamp(NOW + i * 1000)));
    write(change({ person: "p2" }), toTimestamp(NOW));
    const first = log.history("p1", { limit: 2 });
    expect(first.map((e) => e.change.delta)).toEqual([4, 3]);
    const second = log.history("p1", { limit: 2, before: first.at(-1)?.id as string });
    expect(second.map((e) => e.change.delta)).toEqual([2, 1]);
    expect(log.history("p1").map((e) => e.id)).toEqual([...ids].reverse());
    expect(log.history("p2")).toHaveLength(1);
  });

  it("leaves a redacted change out", () => {
    const id = write(change(), toTimestamp(NOW));
    write(change({ delta: 2 }), toTimestamp(NOW + 1000));
    t.events.redact(id, "test", "test");
    expect(log.history("p1").map((e) => e.change.delta)).toEqual([2]);
  });

  it("builds the day's ledger from her local day only", () => {
    const start = dayStart(TODAY, rules);
    write(change({ delta: 6, proposed: 6 }), toTimestamp(start - 1000)); // yesterday, 23:59:59
    write(change({ delta: 6, proposed: 6 }), toTimestamp(start)); // today, 00:00
    write(change({ delta: -18, proposed: -18 }), toTimestamp(NOW));
    write(change({ delta: 0, proposed: 6 }), toTimestamp(NOW + 1000)); // capped to nothing
    write(change({ delta: -1, proposed: null, cause: "decay" }), toTimestamp(NOW));
    write(change({ field: "trust", delta: 1, proposed: 1, cause: "reflect" }), toTimestamp(NOW));
    write(change({ delta: 6 }), toTimestamp(dayStart(TODAY + 1, rules))); // tomorrow
    const ledger = log.dayLedger("p1", NOW);
    expect(ledger.day).toBe(TODAY);
    expect(ledger.fields.bond).toEqual({ up: 6, down: 18, proposed_up: 2, proposed_down: 1 });
    expect(ledger.fields.trust).toEqual({ up: 1, down: 0, proposed_up: 0, proposed_down: 0 });
    // The same day read late at night gives the same ledger.
    expect(log.dayLedger("p1", dayStart(TODAY + 1, rules) - 1)).toEqual(ledger);
  });

  it("caps a proposal with what the log says today", () => {
    let p = newPerson("p1", toTimestamp(NOW));
    for (let i = 0; i < 3; i++) {
      const applied = applyChange(
        p,
        { type: "propose", field: "bond", direction: "up", quote: "" },
        log.dayLedger("p1", NOW),
        rules,
        NOW,
      );
      write(applied.change, toTimestamp(NOW + i));
      p = applied.person;
    }
    expect(p.bond).toBe(3 + 2.25 + 1.6875);
  });
});

describe("heart.evidence on the log", () => {
  it("is read back for a day, oldest first, in the session's scope", () => {
    const at = (h: number) => toTimestamp(dayStart(TODAY, rules) + h * 3_600_000);
    t.events.appendNow(
      evidenceWrite({
        person: "p1",
        kind: "voice_together",
        detail: "語音一小時",
        weight: 60,
        at: at(20),
      }),
    );
    t.events.appendNow(
      evidenceWrite({ person: "p1", kind: "gift", detail: "送了一碗飯", weight: 10, at: at(9) }),
    );
    t.events.appendNow(
      evidenceWrite({
        person: "p1",
        kind: "heard_song",
        detail: "聽了一首歌",
        weight: null,
        at: at(25),
      }),
    );
    const day = log.evidence("p1", at(0), at(24));
    expect(day.map((e) => e.evidence.kind)).toEqual(["gift", "voice_together"]);
    const [row] = t.events.query({ types: ["heart.evidence"], limit: 1 });
    expect(row?.envelope).toMatchObject({ scope: "self", tier: "long", person_id: "p1" });
  });
});
