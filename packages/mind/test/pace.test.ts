import { describe, expect, it } from "vitest";
import { CallLog, heartbeatMs, localDay, mindConfig, type Pace, urgeOf } from "../src/index.js";

const MIN = 60_000;
const config = mindConfig();
const idle: Pace = { urge: 0, emptyStreak: 0, quiet: false, budget: "ok" };
const mins = (p: Partial<Pace>) => (heartbeatMs({ ...idle, ...p }, config) ?? 0) / MIN;

describe("Plan heartbeat", () => {
  it("is 10–20 minutes when nothing goes on", () => {
    expect(mins({})).toBe(15);
    expect(mins({})).toBeGreaterThanOrEqual(10);
    expect(mins({})).toBeLessThanOrEqual(20);
  });

  it("gets faster with boredom or a drive gap, down to the floor (~3–5 minutes)", () => {
    expect(mins({ urge: 0.5 })).toBeLessThan(mins({}));
    expect(mins({ urge: 1 })).toBe(4);
    expect(urgeOf(0.2, { social: 0.1 })).toBe(0);
    expect(urgeOf(0.9, {})).toBeCloseTo(6 / 7);
    expect(urgeOf(0, { play: 1 })).toBe(1);
    expect(urgeOf(0, { rest: 1 })).toBe(0);
  });

  it("leans with how she feels, inside the same limits", () => {
    expect(mins({ initiative: 0.4 })).toBeLessThan(mins({}));
    expect(mins({ initiative: -0.4 })).toBeGreaterThan(mins({}));
    expect(mins({ initiative: 0 })).toBe(mins({}));
    expect(mins({ initiative: Number.NaN })).toBe(mins({}));
    // However she feels, she keeps thinking, and no faster than the floor.
    expect(mins({ urge: 1, initiative: 1 })).toBe(config.min_heartbeat_mins);
    expect(mins({ emptyStreak: 8, initiative: -1 })).toBeLessThanOrEqual(config.max_heartbeat_mins);
    expect(heartbeatMs({ ...idle, initiative: -100 }, config)).not.toBeNull();
  });

  it("gets sparser after empty runs, bounded by max_heartbeat_mins", () => {
    const series = [0, 1, 2, 3, 4, 8].map((n) => mins({ emptyStreak: n }));
    for (let i = 1; i < series.length; i++) {
      expect(series[i]).toBeGreaterThanOrEqual(series[i - 1] as number);
    }
    expect(series[1]).toBe(22.5);
    expect(series.at(-1)).toBe(30);
    // Boredom still speeds a sparse heartbeat up, but empty runs win over a mild urge.
    expect(mins({ urge: 1, emptyStreak: 2 })).toBeCloseTo(8.44, 2);
  });

  it("is sparser in quiet hours and on a degraded budget, none when exhausted", () => {
    expect(mins({ urge: 1, quiet: true })).toBe(11.25);
    expect(mins({ urge: 1, budget: "degraded" })).toBe(11.25);
    expect(heartbeatMs({ ...idle, budget: "exhausted" }, config)).toBeNull();
  });

  it("never comes faster than min_interval_secs", () => {
    const fast = mindConfig({ min_heartbeat_mins: 0.1, min_interval_secs: 300 });
    expect(heartbeatMs({ ...idle, urge: 1 }, fast)).toBe(5 * MIN);
  });
});

describe("call log", () => {
  it("enforces the minimum interval and the hourly cap", () => {
    const log = new CallLog(3, 45_000);
    const t0 = Date.parse("2026-11-02T12:00:00Z");
    expect(log.waitMs(t0)).toBe(0);
    log.record(t0);
    expect(log.waitMs(t0 + 10_000)).toBe(35_000);
    log.record(t0 + 60_000);
    log.record(t0 + 120_000);
    expect(log.waitMs(t0 + 180_000)).toBe(60 * MIN - 180_000);
    expect(log.lastHour(t0 + 180_000)).toBe(3);
    expect(new CallLog(0, 0).waitMs(t0)).toBe(Number.POSITIVE_INFINITY);
  });

  it("knows her local day", () => {
    expect(localDay(Date.parse("2026-11-02T17:30:00Z"), 480)).toEqual({
      day: "2026-11-03",
      hour: 1,
    });
  });
});
