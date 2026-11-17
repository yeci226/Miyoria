import { CapabilityError } from "@miyoria/gate/actions";
import { SqliteStore } from "@miyoria/store";
import type { ContextKey } from "@miyoria/types";
import { afterEach, describe, expect, it } from "vitest";
import { initiativeTables, parseWhen, ScheduleBook, scheduleKey } from "../src/index.js";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const OFFSET = 480;
/** 2026-11-17 14:00 at UTC+8. */
const T0 = Date.UTC(2026, 10, 17, 6, 0, 0);
const C1: ContextKey = { platform: "test", scope: "g", channel: "c1", kind: "channel" };

const stores: SqliteStore[] = [];
afterEach(async () => {
  for (const s of stores.splice(0)) await s.close();
});

async function book(now: { t: number }, parseAt: ((s: string) => number | null) | null = null) {
  const store = await SqliteStore.open(":memory:", { plugins: [initiativeTables] });
  stores.push(store);
  return new ScheduleBook({
    store: store.plugin(initiativeTables),
    now: () => now.t,
    offsetMinutes: OFFSET,
    limits: { max: 3, perPerson: 1, maxDays: 30 },
    parseAt: parseAt === null ? null : (s) => parseAt(s),
  });
}

describe("when", () => {
  it("reads relative times, a clock time and a daily time", () => {
    expect(parseWhen("30m", T0, OFFSET, null)).toEqual({ due: T0 + 30 * MIN, daily: null });
    expect(parseWhen("in 2h", T0, OFFSET, null)).toEqual({ due: T0 + 2 * HOUR, daily: null });
    expect(parseWhen("45分鐘後", T0, OFFSET, null)).toEqual({ due: T0 + 45 * MIN, daily: null });
    expect(parseWhen("2小時後", T0, OFFSET, null)).toEqual({ due: T0 + 2 * HOUR, daily: null });
    // 20:00 local today.
    expect(parseWhen("20:00", T0, OFFSET, null)).toEqual({ due: T0 + 6 * HOUR, daily: null });
    // 08:00 local is past: tomorrow.
    expect(parseWhen("daily 08:00", T0, OFFSET, null)).toEqual({
      due: T0 + 18 * HOUR,
      daily: "08:00",
    });
    expect(parseWhen("每天 8:05", T0, OFFSET, null)?.daily).toBe("08:05");
    expect(parseWhen("下禮拜", T0, OFFSET, null)).toBeNull();
    expect(parseWhen("25:00", T0, OFFSET, null)).toBeNull();
  });

  it("hands absolute times to remind_me's parser", () => {
    const seen: string[] = [];
    const at = parseWhen("2026-11-18 20:00", T0, OFFSET, (s) => {
      seen.push(s);
      return T0 + DAY;
    });
    expect(seen).toEqual(["2026-11-18 20:00"]);
    expect(at).toEqual({ due: T0 + DAY, daily: null });
  });
});

describe("the schedule book", () => {
  it("hands out what is due once; a daily one moves to its next day", async () => {
    const now = { t: T0 };
    const b = await book(now);
    const once = b.set({ when: { due: T0 + 30 * MIN, daily: null }, note: "看烤箱", context: C1 });
    const daily = b.set({
      when: parseWhen("daily 15:00", T0, OFFSET, null) as never,
      note: "喝水",
      context: null,
    });
    expect(scheduleKey(once)).toMatch(/^S[0-9A-Z]{5}$/);
    expect(b.takeDue()).toEqual([]);
    now.t = T0 + 61 * MIN;
    const due = b.takeDue();
    expect(due.map((r) => [r.note, r.fired])).toEqual([
      ["看烤箱", 1],
      ["喝水", 1],
    ]);
    expect(b.takeDue()).toEqual([]);
    expect(b.open().map((r) => [r.id, r.due])).toEqual([
      [daily.id, new Date(T0 + 25 * HOUR).toISOString()],
    ]);
    now.t = T0 + 25 * HOUR + MIN;
    expect(b.takeDue().map((r) => [r.note, r.fired])).toEqual([["喝水", 2]]);
  });

  it("drops a one-off time missed by more than a day, without handing it out", async () => {
    const now = { t: T0 };
    const b = await book(now);
    b.set({ when: { due: T0 + MIN, daily: null }, note: "過期的", context: C1 });
    now.t = T0 + 2 * DAY;
    expect(b.takeDue()).toEqual([]);
    expect(b.open()).toEqual([]);
  });

  it("refuses a time past, too far or over the cap, in her words", async () => {
    const now = { t: T0 };
    const b = await book(now);
    expect(() => b.set({ when: { due: T0 - MIN, daily: null }, note: "x", context: C1 })).toThrow(
      "這個時間已經過了",
    );
    expect(() =>
      b.set({ when: { due: T0 + 31 * DAY, daily: null }, note: "x", context: C1 }),
    ).toThrow("30 天");
    for (const i of [1, 2, 3])
      b.set({ when: { due: T0 + i * MIN, daily: null }, note: `${i}`, context: C1 });
    expect(() =>
      b.set({ when: { due: T0 + 9 * MIN, daily: null }, note: "x", context: C1 }),
    ).toThrow("上限 3");
  });

  it("serves remind_me: set, list, the person's cap, cancel by key", async () => {
    const now = { t: T0 };
    const b = await book(now);
    const owen = { platform: "test", id: "owen" };
    const r = b.reminders.set({
      what: "提醒 Owen 交報告",
      due: T0 + HOUR,
      daily: false,
      context: C1,
      person: "Owen",
      for_account: owen,
    });
    expect(r.key).toMatch(/^R[0-9A-Z]{5}$/);
    expect(b.reminders.list().map((x) => x.what)).toEqual(["提醒 Owen 交報告"]);
    expect(b.reminders.of(owen)).toHaveLength(1);
    expect(() =>
      b.reminders.set({
        what: "再一個",
        due: T0 + HOUR,
        daily: false,
        context: C1,
        person: null,
        for_account: owen,
      }),
    ).toThrow(CapabilityError);
    expect(b.reminders.cancel(r.key.toLowerCase())).toBe(true);
    expect(b.reminders.list()).toEqual([]);
  });
});
