// Commissions: the price is held, hers only when she delivers (a share), and whole again when she
// declines or does not get to it; the limits, the screen, the bus and her tools and `/me commission`.

import type { JsonValue } from "@miyoria/types";
import { describe, expect, it } from "vitest";
import { v2Capabilities } from "../src/v2-tools.js";
import { ALICE, BOB, balance, rig as baseRig, CAROL, DAY, fund, rejects, say } from "./rig.js";

const rig = (config: Record<string, JsonValue> = {}) =>
  baseRig({ achievement_cap: 0, play_rewards: {}, quest_reward: 0, quest_bonus: 0, ...config });

const topics = (bus: unknown[], topic: string) =>
  bus.filter((e) => JSON.stringify(e).includes(`"${topic}"`));

describe("asking", () => {
  it("charges the price, once per key, and tells her and the bus", async () => {
    const r = await rig();
    await fund(r, ALICE, 100);
    const a = await r.economy.v2.commission(ALICE, "poem", "寫一首關於雨的詩", "k1");
    expect(a).toMatchObject({ kind: "poem", price: 40, balance: 60, duplicate: false });
    expect(await r.economy.v2.commission(ALICE, "poem", "寫一首關於雨的詩", "k1")).toMatchObject({
      duplicate: true,
      id: a.id,
    });
    expect(await balance(r, ALICE)).toBe(60);
    expect(topics(r.bus, "economy.commission")).toHaveLength(1);
    expect(r.observed.some((o) => o.summary.includes("寫一首關於雨的詩"))).toBe(true);
    expect((await r.economy.v2.commissionsWaiting()).map((c) => c.id)).toEqual([a.id]);
  });

  it("refuses what it should and leaves the coins alone", async () => {
    const r = await rig({ commissions_per_day: 2, commissions_open: 5 });
    await fund(r, ALICE, 100);
    await rejects(r.economy.v2.commission(ALICE, "poem", "", "a"), 400);
    await rejects(r.economy.v2.commission(ALICE, "poem", "BADWORD", "b"), 400, /審查/);
    await rejects(r.economy.v2.commission(CAROL, "poem", "hi", "c"), 403);
    await rejects(r.economy.v2.commission(BOB, "tool", "x".repeat(10), "d"), 402);
    await r.economy.v2.commission(ALICE, "name", "取名字", "e");
    await r.economy.v2.commission(ALICE, "name", "取名字", "f");
    await rejects(r.economy.v2.commission(ALICE, "name", "取名字", "g"), 429, /最多/);
    expect(await balance(r, ALICE)).toBe(40);
  });

  it("a kind priced 0 is off, and only so many wait for her", async () => {
    const r = await rig({
      commission_prices: { poem: 10, name: 0 },
      commissions_open: 1,
      commissions_per_day: 9,
    });
    await fund(r, ALICE, 100);
    await rejects(r.economy.v2.commission(ALICE, "name", "x", "a"), 400);
    expect(r.economy.v2.commissionMenu()).toEqual([{ kind: "poem", label: "寫一首詩", price: 10 }]);
    await r.economy.v2.commission(ALICE, "poem", "x", "b");
    await rejects(r.economy.v2.commission(ALICE, "poem", "x", "c"), 429, /滿了/);
  });
});

describe("answering", () => {
  it("delivering pays her a share, the rest leaves, and the bus carries the result", async () => {
    const r = await rig();
    await fund(r, ALICE, 100);
    const a = await r.economy.v2.commission(ALICE, "poem", "詩", "k");
    const done = await r.economy.v2.deliverCommission(a.id, "雨落在窗上");
    expect(done).toMatchObject({ status: "delivered", result: "雨落在窗上" });
    expect(await r.economy.purse.balance()).toBe(20);
    expect(await balance(r, ALICE)).toBe(60);
    expect(topics(r.bus, "economy.commission.done")).toHaveLength(1);
    await rejects(r.economy.v2.deliverCommission(a.id, "again"), 409);
    expect(await r.economy.purse.balance()).toBe(20);
    expect((await r.economy.v2.commissions(ALICE))[0]).toMatchObject({ status: "delivered" });
  });

  it("what she hands in passes the same screen", async () => {
    const r = await rig();
    await fund(r, ALICE, 100);
    const a = await r.economy.v2.commission(ALICE, "poem", "詩", "k");
    await rejects(r.economy.v2.deliverCommission(a.id, "BADWORD"), 400, /審查/);
    expect((await r.economy.v2.commissionsWaiting()).length).toBe(1);
  });

  it("declining gives the whole price back, once", async () => {
    const r = await rig();
    await fund(r, ALICE, 200);
    const a = await r.economy.v2.commission(ALICE, "tool", "做個東西", "k");
    expect(await balance(r, ALICE)).toBe(80);
    const d = await r.economy.v2.declineCommission(a.id, "做不到");
    expect(d).toMatchObject({ status: "declined", note: "做不到" });
    expect(await balance(r, ALICE)).toBe(200);
    expect(await r.economy.purse.balance()).toBe(0);
    await rejects(r.economy.v2.declineCommission(a.id, ""), 409);
    expect(await balance(r, ALICE)).toBe(200);
  });

  it("gives back what she did not get to in commission_days", async () => {
    const r = await rig({ commission_days: 2 });
    await fund(r, ALICE, 100);
    await r.economy.v2.commission(ALICE, "poem", "詩", "k");
    r.clock.at += DAY;
    await r.economy.v2.sweep();
    expect(await balance(r, ALICE)).toBe(60);
    r.clock.at += DAY + 1;
    await r.economy.v2.sweep();
    expect(await balance(r, ALICE)).toBe(100);
    expect((await r.economy.v2.commissions(ALICE))[0]).toMatchObject({ status: "expired" });
    await r.economy.v2.sweep();
    expect(await balance(r, ALICE)).toBe(100);
  });
});

describe("her tools", () => {
  it("the speaker commissions in text, she delivers with on_own", async () => {
    const r = await rig();
    await fund(r, ALICE, 100);
    const caps = v2Capabilities(r.economy);
    const asked = await say(r, caps, "commission_her", ALICE, "m1", {
      kind: "poem",
      brief: "寫一首詩",
    });
    expect(asked.data).toMatchObject({ done: true, price: 40, balance: 60 });
    const id = asked.data.id as string;
    const list = await say(r, caps, "list_commissions", ALICE, "m2", {}, true);
    expect(list.text).toContain(id);
    const done = await say(
      r,
      caps,
      "deliver_commission",
      ALICE,
      "m3",
      { commission: id, text: "詩" },
      true,
    );
    expect(done.data).toMatchObject({ done: true });
    expect(await r.economy.purse.balance()).toBe(20);
  });

  it("the speaker cannot deliver for her, and a voice cannot spend", async () => {
    const r = await rig();
    await fund(r, ALICE, 100);
    const caps = v2Capabilities(r.economy);
    const asked = await say(r, caps, "commission_her", ALICE, "m1", { kind: "poem", brief: "詩" });
    const refused = await say(r, caps, "deliver_commission", ALICE, "m2", {
      commission: asked.data.id as string,
      text: "自己交",
    }).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(Error);
    expect((await r.economy.v2.commissionsWaiting()).length).toBe(1);
  });
});
