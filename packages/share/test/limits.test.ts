import { describe, expect, it } from "vitest";
import { type ShareConfig, ShareConfigSchema } from "../src/config.js";
import { Limits } from "../src/limits.js";

const config = (extra: Partial<ShareConfig> = {}): ShareConfig =>
  ShareConfigSchema.parse({ quiet_hours: "", ...extra });

/** Local time on 2026-11-`day`. */
const at = (day: number, hour: number, minute = 0) =>
  new Date(2026, 10, day, hour, minute).getTime();

describe("ShareConfigSchema", () => {
  it("has the agreed defaults", () => {
    expect(ShareConfigSchema.parse({})).toEqual({
      when: "anytime",
      max_per_day: 3,
      min_gap_mins: 120,
      browse_per_day: 6,
      posts: 10,
      quiet_hours: "01:00-08:00",
      channels: [],
      exclude: [],
      keep_hours: 24,
    });
  });

  it("refuses quiet hours it cannot read", () => {
    for (const bad of ["1-8", "25:00-08:00", "01:00", "01:60-02:00"]) {
      expect(() => ShareConfigSchema.parse({ quiet_hours: bad })).toThrow();
    }
  });

  it("an empty value turns quiet hours off", () => {
    const limits = new Limits(ShareConfigSchema.parse({ quiet_hours: "" }));
    expect(limits.quiet(at(4, 3))).toBe(false);
  });
});

describe("quiet hours", () => {
  it("quiet handles a range over midnight", () => {
    const limits = new Limits(config({ quiet_hours: "23:00-02:00" }));
    expect(limits.quiet(at(4, 23, 30))).toBe(true);
    expect(limits.quiet(at(5, 0, 30))).toBe(true);
    expect(limits.quiet(at(5, 2))).toBe(false);
    expect(limits.quiet(at(5, 12))).toBe(false);
  });

  it("a range within a day ends at its end", () => {
    const limits = new Limits(config({ quiet_hours: "01:00-08:00" }));
    expect(limits.quiet(at(4, 0, 59))).toBe(false);
    expect(limits.quiet(at(4, 1))).toBe(true);
    expect(limits.quiet(at(4, 7, 59))).toBe(true);
    expect(limits.quiet(at(4, 8))).toBe(false);
  });
});

describe("limits", () => {
  it("canBrowse is false at browse_per_day", () => {
    const limits = new Limits(config({ browse_per_day: 2 }));
    limits.noteRound(at(4, 10));
    expect(limits.canBrowse(at(4, 10))).toBe(true);
    limits.noteRound(at(4, 11));
    expect(limits.canBrowse(at(4, 11))).toBe(false);
  });

  it("canBrowse is false at max_per_day", () => {
    const limits = new Limits(config({ max_per_day: 1, min_gap_mins: 0 }));
    limits.notePost(at(4, 10));
    expect(limits.canBrowse(at(4, 12))).toBe(false);
  });

  it("canBrowse is false inside the gap", () => {
    const limits = new Limits(config({ min_gap_mins: 120 }));
    limits.notePost(at(4, 10));
    expect(limits.canBrowse(at(4, 11, 59))).toBe(false);
    expect(limits.canBrowse(at(4, 12))).toBe(true);
  });

  it("canBrowse is false while quiet", () => {
    const limits = new Limits(config({ quiet_hours: "01:00-08:00" }));
    expect(limits.canBrowse(at(4, 3))).toBe(false);
  });

  it("canBrowse is false while paused", () => {
    const limits = new Limits(config());
    limits.pause("login");
    expect(limits.paused).toBe("login");
    expect(limits.canBrowse(at(4, 12))).toBe(false);
    limits.resume();
    expect(limits.canBrowse(at(4, 12))).toBe(true);
  });

  it("canPost is false at max_per_day and inside the gap", () => {
    const limits = new Limits(config({ max_per_day: 2, min_gap_mins: 60 }));
    expect(limits.canPost(at(4, 10))).toBe(true);
    limits.notePost(at(4, 10));
    expect(limits.canPost(at(4, 10, 30))).toBe(false);
    expect(limits.canPost(at(4, 11))).toBe(true);
    limits.notePost(at(4, 11));
    expect(limits.canPost(at(4, 20))).toBe(false);
  });

  it("counts reset on a new local day", () => {
    const limits = new Limits(config({ max_per_day: 1, browse_per_day: 1, min_gap_mins: 0 }));
    limits.noteRound(at(4, 23));
    limits.notePost(at(4, 23));
    expect(limits.canBrowse(at(4, 23, 59))).toBe(false);
    expect(limits.canBrowse(at(5, 0))).toBe(true);
    expect(limits.canPost(at(5, 0))).toBe(true);
  });

  it("pause reports only the first transition", () => {
    const limits = new Limits(config());
    expect(limits.pause("login")).toBe(true);
    expect(limits.pause("login")).toBe(false);
    expect(limits.pause("no_posts")).toBe(false);
    limits.resume();
    expect(limits.pause("no_posts")).toBe(true);
  });

  it("noteEmpty says when three rounds in a row found nothing", () => {
    const limits = new Limits(config());
    expect(limits.noteEmpty()).toBe(false);
    expect(limits.noteEmpty()).toBe(false);
    limits.noteFound();
    expect(limits.noteEmpty()).toBe(false);
    expect(limits.noteEmpty()).toBe(false);
    expect(limits.noteEmpty()).toBe(true);
  });

  it("a restored state keeps today's counts", () => {
    const first = new Limits(config({ browse_per_day: 1 }));
    first.noteRound(at(4, 10));
    first.pause("login");
    const again = new Limits(config({ browse_per_day: 1 }), first.snapshot());
    expect(again.paused).toBe("login");
    again.resume();
    expect(again.canBrowse(at(4, 11))).toBe(false);
  });

  it("unreadable state starts empty", () => {
    const limits = new Limits(config(), { day: 3, posts: "many" });
    expect(limits.snapshot()).toMatchObject({ posts: 0, rounds: 0, pause: null });
  });
});
