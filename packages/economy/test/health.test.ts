// The health table: coins issued against recovered per day, a week's ratio and the inflation warning.

import { describe, expect, it } from "vitest";
import { type LedgerDayTotal, LedgerStatsKey } from "../src/health.js";
import { rig as baseRig, type Rig } from "./rig.js";

const rig = () => baseRig({ achievement_cap: 0, health_days: 7 });

function provide(r: Rig, rows: (today: number) => LedgerDayTotal[]): void {
  r.services.provide("test", LedgerStatsKey, {
    dailyTotals: async () => rows(r.economy.today()),
  });
}

describe("health", () => {
  it("is not available, and invents nothing, without a store of totals", async () => {
    const r = await rig();
    expect(await r.economy.v2.health()).toMatchObject({
      available: false,
      days: [],
      warn: null,
    });
  });

  it("adds up issued and recovered per day and ignores what only moves coins around", async () => {
    const r = await rig();
    provide(r, (t) => [
      { day: t, reason: "checkin", positive: 100, negative: 0 },
      { day: t, reason: "feed", positive: 0, negative: 40 },
      { day: t, reason: "transfer_out", positive: 0, negative: 999 },
      { day: t, reason: "bet_win", positive: 999, negative: 0 },
      { day: t - 1, reason: "play", positive: 50, negative: 0 },
      { day: t - 1, reason: "draw", positive: 0, negative: 50 },
      { day: t - 30, reason: "checkin", positive: 7, negative: 0 },
    ]);
    const v = await r.economy.v2.health();
    expect(v.available).toBe(true);
    expect(v.days).toHaveLength(7);
    const today = v.days.at(-1);
    expect(today).toMatchObject({ issued: 100, recovered: 40, ratio: 0.4 });
    expect(v.days.at(-2)).toMatchObject({ issued: 50, recovered: 50, ratio: 1 });
    expect(v.days[0]).toMatchObject({ issued: 0, recovered: 0, ratio: null });
    expect(v.week).toEqual({ issued: 150, recovered: 90, ratio: 0.6 });
    expect(v.warn).toBeNull();
  });

  it("warns when less than health_warn_ratio came back in the week", async () => {
    const r = await rig();
    provide(r, (t) => [
      { day: t, reason: "talked", positive: 200, negative: 0 },
      { day: t, reason: "shop", positive: 0, negative: 20 },
    ]);
    const v = await r.economy.v2.health();
    expect(v.week.ratio).toBe(0.1);
    expect(v.warn).toContain("通貨膨脹");
  });
});
