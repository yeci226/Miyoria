// Her room: pledges add up, are cut to what is missing, are counted once, keep no ranking and finish
// the item with an event; and her tools.

import type { JsonValue } from "@miyoria/types";
import { describe, expect, it } from "vitest";
import { v2Capabilities } from "../src/v2-tools.js";
import { ALICE, BOB, balance, rig as baseRig, CAROL, fund, rejects, say } from "./rig.js";

const rig = (config: Record<string, JsonValue> = {}) =>
  baseRig({
    achievement_cap: 0,
    play_rewards: {},
    quest_reward: 0,
    quest_bonus: 0,
    room_items: [{ id: "lamp", label: "魚燈", kind: "furniture", price: 150 }],
    ...config,
  });

describe("funding", () => {
  it("adds up, counts a backer once, never says who", async () => {
    const r = await rig();
    await fund(r, ALICE, 200);
    await fund(r, BOB, 200);
    await r.economy.v2.fundRoom(ALICE, "lamp", 40, "a");
    await r.economy.v2.fundRoom(ALICE, "魚燈", 10, "b");
    const x = await r.economy.v2.fundRoom(BOB, "lamp", 30, "c");
    expect(x.item).toMatchObject({ funded: 80, backers: 2, placed: false });
    expect(JSON.stringify(await r.economy.v2.room())).not.toMatch(/Alice|Bob|"1"|"2"/);
    expect(await balance(r, ALICE)).toBe(150);
  });

  it("the same key is one pledge", async () => {
    const r = await rig();
    await fund(r, ALICE, 100);
    await r.economy.v2.fundRoom(ALICE, "lamp", 40, "k");
    const again = await r.economy.v2.fundRoom(ALICE, "lamp", 40, "k");
    expect(again).toMatchObject({ duplicate: true, charged: 40 });
    expect(again.item.funded).toBe(40);
    expect(await balance(r, ALICE)).toBe(60);
  });

  it("is cut to what is missing, finishes with an event, then is full", async () => {
    const r = await rig();
    await fund(r, ALICE, 500);
    await r.economy.v2.fundRoom(ALICE, "lamp", 100, "a");
    const last = await r.economy.v2.fundRoom(ALICE, "lamp", 100, "b");
    expect(last).toMatchObject({ charged: 50, item: { funded: 150, placed: true } });
    expect(await balance(r, ALICE)).toBe(350);
    expect(r.bus.filter((e) => JSON.stringify(e).includes("economy.room.placed"))).toHaveLength(1);
    await rejects(r.economy.v2.fundRoom(ALICE, "lamp", 10, "c"), 409, /湊齊/);
    expect((await r.economy.v2.room())[0]?.placed).toBe(true);
  });

  it("refuses what it should", async () => {
    const r = await rig({ room_pledge_max: 50 });
    await fund(r, ALICE, 100);
    await rejects(r.economy.v2.fundRoom(ALICE, "lamp", 0, "a"), 400);
    await rejects(r.economy.v2.fundRoom(ALICE, "lamp", 51, "b"), 400);
    await rejects(r.economy.v2.fundRoom(ALICE, "nothing", 10, "c"), 409);
    await rejects(r.economy.v2.fundRoom(CAROL, "lamp", 10, "d"), 403);
    await rejects(r.economy.v2.fundRoom(BOB, "lamp", 10, "e"), 402);
    expect(await balance(r, ALICE)).toBe(100);
  });
});

describe("her tools", () => {
  it("shows the room and takes a pledge from the speaker", async () => {
    const r = await rig();
    await fund(r, ALICE, 100);
    const caps = v2Capabilities(r.economy);
    expect((await say(r, caps, "check_room", ALICE, "m1")).text).toContain("0 / 150");
    const done = await say(r, caps, "fund_room", ALICE, "m2", { item: "lamp", amount: 30 });
    expect(done.data).toMatchObject({ done: true, charged: 30, placed: false });
    expect(await balance(r, ALICE)).toBe(70);
  });
});
