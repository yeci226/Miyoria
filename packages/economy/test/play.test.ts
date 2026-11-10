// Coins for taking part: what an activity pays, its keys, the two daily limits, and who earns.

import type { JsonValue } from "@miyoria/types";
import { describe, expect, it } from "vitest";
import { ALICE, ALICE_TWO, BOB, balance, rig as baseRig, CAROL, DAVE, DAY } from "./rig.js";

/** Quests pay coins of their own when a game is played: keep them out of these sums. */
const rig = (config: Record<string, JsonValue> = {}) => baseRig({ quest_reward: 0, ...config });

describe("play awards", () => {
  it("pays what the activity is worth, once per key", async () => {
    const r = await rig();
    const first = await r.economy.v2.play.award(ALICE, "game_join", "g1");
    expect(first).toEqual({ status: "paid", paid: 5 });
    expect(await r.economy.v2.play.award(ALICE, "game_join", "g1")).toEqual({
      status: "duplicate",
      paid: 0,
    });
    expect(await r.economy.v2.play.award(ALICE, "game_join", "g2")).toMatchObject({ paid: 5 });
    expect(await balance(r, ALICE)).toBe(10);
    const wallet = await r.economy.wallet(ALICE);
    expect(wallet.recent[0]?.label).toBe("加入遊戲");
  });

  it("pays nothing for an activity nobody configured, or one set to 0", async () => {
    const r = await rig({ play_rewards: { game_join: 0, quiz: 4 } });
    expect(await r.economy.v2.play.award(ALICE, "game_join", "a")).toEqual({
      status: "off",
      paid: 0,
    });
    expect(await r.economy.v2.play.award(ALICE, "made_up", "a")).toEqual({
      status: "off",
      paid: 0,
    });
    expect(await r.economy.v2.play.award(ALICE, "quiz", "a")).toMatchObject({ paid: 4 });
    expect(await r.economy.v2.play.award(ALICE, "quiz", "")).toEqual({ status: "off", paid: 0 });
  });

  it("pays strangers and the blocked nothing", async () => {
    const r = await rig();
    expect(await r.economy.v2.play.award(DAVE, "game_join", "a")).toEqual({
      status: "stranger",
      paid: 0,
    });
    expect(await r.economy.v2.play.award(CAROL, "game_join", "a")).toEqual({
      status: "stranger",
      paid: 0,
    });
    expect(await balance(r, CAROL)).toBe(0);
  });

  it("stops one activity after its daily count, and starts again tomorrow", async () => {
    const r = await rig({ play_per_activity_per_day: 3, play_cap: 1000 });
    for (let i = 0; i < 3; i++) {
      expect((await r.economy.v2.play.award(ALICE, "headpat", `p${i}`)).status).toBe("paid");
    }
    expect(await r.economy.v2.play.award(ALICE, "headpat", "p3")).toEqual({
      status: "capped",
      paid: 0,
    });
    // Another activity is counted on its own.
    expect((await r.economy.v2.play.award(ALICE, "game_join", "g")).status).toBe("paid");
    r.clock.at += DAY;
    expect((await r.economy.v2.play.award(ALICE, "headpat", "p4")).status).toBe("paid");
  });

  it("holds all play together to play_cap, paying the last award in part", async () => {
    const r = await rig({ play_cap: 12 });
    expect(await r.economy.v2.play.award(ALICE, "game_finish", "a")).toMatchObject({ paid: 10 });
    // 10 + 5 would be 15: only 2 fits.
    expect(await r.economy.v2.play.award(ALICE, "game_join", "a")).toEqual({
      status: "paid",
      paid: 2,
    });
    expect(await r.economy.v2.play.award(ALICE, "game_join", "b")).toEqual({
      status: "capped",
      paid: 0,
    });
    expect(await balance(r, ALICE)).toBe(12);
  });

  it("counts the cap over every account of one person", async () => {
    const r = await rig({ play_cap: 8 });
    await r.economy.v2.play.award(ALICE, "game_join", "a");
    expect(await r.economy.v2.play.award(ALICE_TWO, "game_join", "b")).toMatchObject({ paid: 3 });
    expect(await r.economy.v2.play.award(BOB, "game_join", "a")).toMatchObject({ paid: 5 });
  });
});
