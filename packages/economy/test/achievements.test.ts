// Achievements and titles: paid once off the ledger, found again after a daily cap, per person and
// not per account, and never ranking anybody.

import { type AccountRef, toTimestamp } from "@miyoria/types";
import { describe, expect, it } from "vitest";
import { longestStreak } from "../src/achievements.js";
import { ledgerOf, walletOf } from "./ledger.js";
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

  it("keeps the ones of drawing collectibles for whoever has them, and pays them no more", async () => {
    const r = await rig({ achievement_cap: 1000 });
    const post = (who: AccountRef, reason: string, delta: number, ref: string) =>
      ledgerOf(r.store).post({
        id: `${who.id}-${reason}-${ref}`,
        person: walletOf(r.store, who),
        delta,
        reason,
        ref,
        idem_key: null,
        ts: toTimestamp(r.clock.at - DAY),
      });
    await fund(r, BOB, 100);
    await post(BOB, "draw", -30, "glasses_black");
    await post(BOB, "achievement", 10, "first_draw");
    await post(BOB, "achievement", 30, "series:glasses");
    await post(BOB, "achievement", 30, "series:custom");
    const view = await r.economy.v2.achievements(BOB);
    expect(view.achievements.filter((a) => a.unlocked_at !== null)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "first_draw", label: "第一次抽收藏", title: "抽卡新手" }),
        expect.objectContaining({ id: "series:glasses", title: "眼鏡收藏家", reward: 30 }),
        expect.objectContaining({ id: "series:custom", label: "集齊一個收藏系列" }),
      ]),
    );
    expect(view.titles).toEqual(expect.arrayContaining(["抽卡新手", "眼鏡收藏家", "收藏家"]));
    // Someone who never had them is not shown them, and an old draw no longer reaches one.
    await fund(r, ALICE, 100);
    await post(ALICE, "draw", -30, "glasses_round");
    const alice = await r.economy.v2.achievements(ALICE);
    expect(alice.achievements.map((a) => a.id)).not.toContain("first_draw");
    expect(alice.achievements.some((a) => a.id.startsWith("series:"))).toBe(false);
  });

  it("is reached by playing games", async () => {
    const r = await rig({ achievement_cap: 1000, quest_reward: 0 });
    await r.economy.v2.play.award(BOB, "game_join", "g1");
    await r.economy.v2.achievements(BOB);
    expect((await r.economy.v2.achievements(BOB)).titles).toContain("玩家");
  });

  it("still lists a title her shop sold before it went", async () => {
    const r = await rig();
    expect(
      await r.economy.docs().create({
        id: "title:old",
        kind: "title",
        owner: ALICE,
        status: "held",
        version: 1,
        data: { title: "常客", source: "x" },
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }),
    ).toBe(true);
    expect((await r.economy.v2.achievements(ALICE)).titles).toContain("常客");
    expect((await r.economy.v2.achievements(ALICE_TWO)).titles).toContain("常客");
    expect((await r.economy.v2.achievements(BOB)).titles).not.toContain("常客");
  });
});
