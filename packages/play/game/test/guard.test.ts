import { describe, expect, it } from "vitest";
import {
  activeGuard,
  afterSuccess,
  GameConfigSchema,
  guardAfter,
  guardNote,
  withheld,
} from "../src/index.js";

const cfg = GameConfigSchema.parse({});

describe("failure guard", () => {
  it("withholds the low-level actions for failure_guard_secs", () => {
    const guard = guardAfter(cfg, "附近看不到鐵礦", 1_000);
    expect(guard).toMatchObject({ actions: ["goto", "mine", "look", "attack"], until: 46_000 });
    expect(withheld(guard, "mine", 2_000)).toBe(true);
    expect(withheld(guard, "goto", 2_000)).toBe(true);
    expect(withheld(guard, "obtain", 2_000)).toBe(false);
    expect(withheld(guard, "explore", 2_000)).toBe(false);
    // it runs out
    expect(withheld(guard, "mine", 46_000)).toBe(false);
    expect(activeGuard(guard, 46_000)).toBeNull();
  });

  it("ends early when another method works", () => {
    const guard = guardAfter(cfg, "x", 0);
    expect(afterSuccess(guard, "explore", 1_000)).toBeNull();
    expect(afterSuccess(guard, "mine", 1_000)).toBe(guard);
  });

  it("tells her what is withheld and for how long", () => {
    const guard = guardAfter(cfg, "附近看不到鐵礦", 0);
    expect(guardNote(guard, 10_000)).toBe(
      "暫時不能用 goto、mine、look、attack(還有 35 秒):上一個動作失敗了(附近看不到鐵礦)。換個方法(例如 obtain 缺的東西、explore)或換個目標,不要重試同一件事。",
    );
    expect(guardNote(guard, 60_000)).toBeNull();
    expect(guardNote(null, 0)).toBeNull();
  });

  it("can be turned off", () => {
    expect(guardAfter(GameConfigSchema.parse({ failure_guard_secs: 0 }), "x", 0)).toBeNull();
    expect(guardAfter(GameConfigSchema.parse({ guarded_actions: [] }), "x", 0)).toBeNull();
  });
});
