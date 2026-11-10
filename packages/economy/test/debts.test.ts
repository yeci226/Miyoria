// Who owes her a meal: a broken deal she remembers for owe_days, until they feed her.

import type { AccountRef } from "@miyoria/types";
import { newId, toTimestamp } from "@miyoria/types";
import { describe, expect, it } from "vitest";
import { ALICE, ALICE_TWO, BOB, rig as baseRig, DAY, type Rig } from "./rig.js";

const rig = () => baseRig({ achievement_cap: 0, play_rewards: {}, quest_reward: 0 });

async function broken(r: Rig, account: AccountRef, task = "唱一首歌"): Promise<void> {
  const at = toTimestamp(r.clock.at);
  await r.store.deals.create({
    id: newId(),
    profile: "p",
    account,
    item: "rice",
    count: 1,
    value: 10,
    task,
    prepaid: false,
    escrow: null,
    status: "broken",
    created_at: at,
    done_at: at,
    due_at: null,
    closed_at: at,
  });
}

async function feed(r: Rig, account: AccountRef): Promise<void> {
  await r.store.coins.post(
    {
      id: newId(),
      profile: "p",
      account,
      delta: -10,
      reason: "feed",
      ref: "rice",
      idem_key: null,
      ts: toTimestamp(r.clock.at),
    },
    { wallet: [account], covered: false },
  );
}

describe("owing her a meal", () => {
  it("is remembered with the name and the promise, once per person", async () => {
    const r = await rig();
    await broken(r, ALICE);
    await broken(r, ALICE_TWO, "再唱一首");
    const lines = await r.economy.purse.owedMeals();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("Alice");
    expect(await r.economy.purse.describe()).toContain("欠你一頓飯");
  });

  it("is cleared when they feed her, and forgotten after owe_days", async () => {
    const r = await rig();
    await broken(r, ALICE);
    await broken(r, BOB);
    r.clock.at += 1000;
    await feed(r, ALICE);
    const lines = await r.economy.purse.owedMeals();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("Bob");
    r.clock.at += 15 * DAY;
    expect(await r.economy.purse.owedMeals()).toEqual([]);
    expect(await r.economy.purse.describe()).not.toContain("欠你一頓飯");
  });
});
