// Achievements and titles: paid once off the ledger, found again after a daily cap, per person and
// not per account, and never ranking anybody.

import { describe, expect, it } from "vitest";
import { longestStreak } from "../src/achievements.js";
import { ALICE, ALICE_TWO, BOB, balance, CAROL, DAVE, DAY, fund, rig } from "./rig.js";

describe("achievements", () => {
  it("longestStreak finds the best run of consecutive days", () => {
    expect(longestStreak(new Set())).toBe(0);
    expect(longestStreak(new Set([1, 2, 3, 7, 8, 9, 10, 20]))).toBe(4);
  });

  it("pays a first check-in once, and shows the title", async () => {
    const r = await rig();
    await r.economy.checkin(ALICE);
    // 10 for the check-in, 10 for "first check-in".
    expect(await balance(r, ALICE)).toBe(20);
    const view = await r.economy.v2.achievements(ALICE);
    expect(view.titles).toEqual(["新面孔"]);
    expect(view.achievements.find((a) => a.id === "first_checkin")?.unlocked_at).not.toBeNull();
    expect(view.achievements.find((a) => a.id === "streak_7")?.unlocked_at).toBeNull();
    // Looking again pays nothing more.
    await r.economy.v2.achievements(ALICE);
    expect(await balance(r, ALICE)).toBe(20);
    expect((await r.economy.wallet(ALICE)).recent.map((l) => l.label)).toContain("達成成就");
    // She knows, silently.
    expect(r.observed.some((o) => o.summary.includes("第一次簽到"))).toBe(true);
  });

  it("reaches the 7-day streak by checking in seven days running", async () => {
    const r = await rig({ achievement_cap: 1000 });
    for (let day = 0; day < 7; day++) {
      await r.economy.checkin(ALICE);
      r.clock.at += DAY;
    }
    const view = await r.economy.v2.achievements(ALICE);
    expect(view.titles).toContain("常客");
    expect(view.titles).not.toContain("全勤");
  });

  it("counts the person, not the account", async () => {
    const r = await rig();
    await r.economy.checkin(ALICE);
    await r.economy.checkin(ALICE_TWO).catch(() => null); // the same day: refused
    const before = await balance(r, ALICE);
    await r.economy.v2.achievements(ALICE_TWO);
    expect(await balance(r, ALICE)).toBe(before);
  });

  it("waits for tomorrow when the day's cap is reached, then pays what was waiting", async () => {
    const r = await rig({ achievement_cap: 10 });
    await r.economy.checkin(ALICE);
    await r.economy.feed(ALICE, "rice", 1, "f1").catch(() => null);
    await fund(r, ALICE, 50);
    await r.economy.feed(ALICE, "rice", 1, "f2");
    const view = await r.economy.v2.achievements(ALICE);
    const paid = view.achievements.filter((a) => a.unlocked_at !== null).map((a) => a.id);
    // Only one fits in 10; the other has not been paid yet.
    expect(paid).toHaveLength(1);
    r.clock.at += DAY;
    const next = await r.economy.v2.achievements(ALICE);
    expect(next.achievements.filter((a) => a.unlocked_at !== null)).toHaveLength(2);
  });

  it("is found for a stranger as nothing, and a blocked person earns none", async () => {
    const r = await rig();
    for (const who of [DAVE, CAROL]) {
      expect(await r.economy.v2.achievements(who)).toEqual({ achievements: [], titles: [] });
    }
  });

  it("pays a big reward and a title for a complete series", async () => {
    const r = await rig({
      achievement_cap: 1000,
      collection_series: [
        {
          id: "s",
          label: "小系列",
          title: "小收藏家",
          items: [
            { id: "x", label: "X", rarity: "N" },
            { id: "y", label: "Y", rarity: "R" },
          ],
        },
      ],
    });
    await r.economy.v2.recordCard(BOB, "c1", ["x"]);
    expect((await r.economy.v2.achievements(BOB)).titles).not.toContain("小收藏家");
    const before = await balance(r, BOB);
    await r.economy.v2.recordCard(BOB, "c2", ["y"]);
    const view = await r.economy.v2.achievements(BOB);
    expect(view.titles).toContain("小收藏家");
    expect(view.achievements.find((a) => a.id === "series:s")).toMatchObject({ reward: 30 });
    // 30 for the series, plus whatever else the two cards reached (first draw does not count).
    expect(await balance(r, BOB)).toBeGreaterThanOrEqual(before + 30);
  });

  it("is reached by playing games", async () => {
    const r = await rig({ achievement_cap: 1000, quest_reward: 0 });
    await r.economy.v2.play.award(BOB, "game_join", "g1");
    await r.economy.v2.achievements(BOB);
    expect((await r.economy.v2.achievements(BOB)).titles).toContain("玩家");
  });
});
