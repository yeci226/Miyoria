// Her weekly shop: a shelf that holds still for a week and changes with the next, titles bought
// once, collectibles in the album, her share, the same key one sale, and her tools.

import type { JsonValue } from "@miyoria/types";
import { describe, expect, it } from "vitest";
import { v2Capabilities } from "../src/v2-tools.js";
import { ALICE, BOB, balance, rig as baseRig, CAROL, DAY, fund, rejects, say } from "./rig.js";

const rig = (config: Record<string, JsonValue> = {}) =>
  baseRig({
    achievement_cap: 0,
    play_rewards: {},
    quest_reward: 0,
    quest_bonus: 0,
    shop_slots: 20,
    ...config,
  });

describe("the shelf", () => {
  it("holds still within a week, and a smaller shelf changes with the week", async () => {
    const r = await rig({ shop_slots: 3 });
    const ids = () => r.economy.v2.shopDesk.stock().map((s) => s.id);
    const first = ids();
    expect(first).toHaveLength(3);
    r.clock.at += DAY;
    const sameWeek = Math.floor(r.economy.today() / 7) === Math.floor((r.economy.today() - 1) / 7);
    if (sameWeek) expect(ids()).toEqual(first);
    const seen = new Set(first.join());
    for (let w = 1; w <= 8; w++) {
      r.clock.at += 7 * DAY;
      seen.add(ids().join());
    }
    expect(seen.size).toBeGreaterThan(1);
  });

  it("shows a stranger the shelf without owning anything", async () => {
    const r = await rig();
    const v = await r.economy.v2.shop(CAROL);
    expect(v.member).toBe(false);
    expect(v.items.length).toBeGreaterThan(0);
  });
});

describe("buying", () => {
  it("a title is bought once, shows in titles, and a share goes to her purse", async () => {
    const r = await rig();
    await fund(r, ALICE, 200);
    const b = await r.economy.v2.buyFromShop(ALICE, "title_regular", "k1");
    expect(b).toMatchObject({ charged: 60, balance: 140, duplicate: false });
    expect(await r.economy.purse.balance()).toBe(30);
    expect((await r.economy.v2.achievements(ALICE)).titles).toContain("常客");
    expect(await r.economy.v2.buyFromShop(ALICE, "稱號「常客」", "k1")).toMatchObject({
      duplicate: true,
    });
    expect(await balance(r, ALICE)).toBe(140);
    await rejects(r.economy.v2.buyFromShop(ALICE, "title_regular", "k2"), 409, /已經有/);
    expect(await balance(r, ALICE)).toBe(140);
    // The title is the person's, not one account's.
    expect(
      (await r.economy.v2.shop(ALICE)).items.find((i) => i.id === "title_regular")?.owned,
    ).toBe(true);
  });

  it("a collectible goes into the album", async () => {
    const r = await rig();
    await fund(r, ALICE, 100);
    await r.economy.v2.buyFromShop(ALICE, "item_foxtail", "k");
    const album = await r.economy.v2.album(ALICE);
    const owned = album.series.flatMap((s) => s.items).find((i) => i.id === "hand_foxtail");
    expect(owned?.owned).toBe(1);
    expect(await balance(r, ALICE)).toBe(55);
  });

  it("refuses what it should", async () => {
    const r = await rig({ shop_slots: 1 });
    await fund(r, ALICE, 5);
    const on = r.economy.v2.shopDesk.stock()[0];
    const off = r.economy.config.shop_catalog.find((s) => s.id !== on?.id);
    await rejects(r.economy.v2.buyFromShop(ALICE, off?.id ?? "", "a"), 409, /上架/);
    await rejects(r.economy.v2.buyFromShop(ALICE, on?.id ?? "", "b"), 402);
    await rejects(r.economy.v2.buyFromShop(CAROL, on?.id ?? "", "c"), 403);
    expect(await balance(r, ALICE)).toBe(5);
    expect(await r.economy.purse.balance()).toBe(0);
    expect(await balance(r, BOB)).toBe(0);
  });
});

describe("her tools", () => {
  it("shows the shelf and sells to the speaker", async () => {
    const r = await rig();
    await fund(r, ALICE, 100);
    const caps = v2Capabilities(r.economy);
    expect((await say(r, caps, "check_shop", ALICE, "m1")).text).toContain("title_regular");
    const done = await say(r, caps, "buy_from_shop", ALICE, "m2", { item: "title_fishfan" });
    expect(done.data).toMatchObject({ done: true, charged: 60, balance: 40 });
  });
});
