// The sweep on a schedule, and the cheap check that a session has a transcript.

import { afterEach, describe, expect, it } from "vitest";
import { TranscriptSweepSchedule } from "../src/index.js";
import { DAY, own, type Rig, ROOM, rig, said } from "./helpers.js";

const rigs: Rig[] = [];
afterEach(async () => {
  for (const r of rigs.splice(0)) await r.store.close();
});

describe("TranscriptSweepSchedule", () => {
  it("sweeps once after its first wait and then once per period, with its retention", async () => {
    const r = await rig();
    rigs.push(r);
    r.t.append(ROOM, [said("Owen", "一"), own("二")]);
    r.t.compact(ROOM, 2, "一和二");
    r.t.append(ROOM, [said("Owen", "三")]);
    const schedule = new TranscriptSweepSchedule(r.t, r.clock, {
      everyMs: DAY,
      firstMs: 60_000,
      retention: { coveredDays: 10, idleDays: 100 },
    });
    expect(schedule.tick()).toBeNull();
    r.clock.tick(60_000);
    // Covered, but not yet past its days.
    expect(schedule.tick()).toEqual({ entries: 0, sessions: 0 });
    expect(schedule.tick()).toBeNull();
    r.clock.tick(11 * DAY);
    expect(schedule.tick()).toEqual({ entries: 2, sessions: 0 });
    // The live tail is never touched.
    expect(r.t.tail(ROOM).entries.map((e) => e.content)).toEqual(["三"]);
    expect(schedule.tick()).toBeNull();
  });
});

describe("started", () => {
  it("is true once anything was appended to the session", async () => {
    const r = await rig();
    rigs.push(r);
    expect(r.t.started(ROOM)).toBe(false);
    r.t.append(ROOM, [said("Owen", "一")]);
    expect(r.t.started(ROOM)).toBe(true);
    expect(r.t.started("elsewhere")).toBe(false);
  });
});
