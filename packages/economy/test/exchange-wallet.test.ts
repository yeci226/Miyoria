// The wallet the deep-sea exchange is paid through: a posting of several rows is written together
// or not at all, once per key; someone blocked may sell but not buy; the transfers of a day are
// summed; the rows read in a statement and count in the health table as they should.

import { EXCHANGE_REASONS } from "@miyoria/types";
import { describe, expect, it } from "vitest";
import { EconomyExchangeWallet } from "../src/exchange-wallet.js";
import { giftTables } from "../src/gift-tables.js";
import { GiftDesk } from "../src/gifts.js";
import { ALICE, BOB, balance, CAROL, DAVE, fund, rig } from "./rig.js";

const R = EXCHANGE_REASONS;

describe("the exchange wallet", () => {
  it("writes a posting's rows together, once, and refuses one the balance cannot cover", async () => {
    const r = await rig();
    await fund(r, ALICE, 100);
    const w = new EconomyExchangeWallet(r.economy);
    const alice = await w.member(ALICE);
    if (!alice) throw new Error("no alice");
    const buy = [
      { reason: R.in, delta: -97, key: "exchange:order:o1:in" },
      { reason: R.fee, delta: -2, key: "exchange:order:o1:fee" },
    ] as const;
    expect(await w.post(alice.person, buy, "o1", true)).toEqual({
      ok: true,
      balance: 1,
      duplicate: false,
    });
    expect(await w.post(alice.person, buy, "o1", true)).toEqual({
      ok: true,
      balance: 1,
      duplicate: true,
    });
    expect(await balance(r, ALICE)).toBe(1);
    const tooMuch = [
      { reason: R.in, delta: -5, key: "exchange:order:o2:in" },
      { reason: R.fee, delta: -1, key: "exchange:order:o2:fee" },
    ] as const;
    expect(await w.post(alice.person, tooMuch, "o2", true)).toEqual({
      ok: false,
      reason: "short",
      balance: 1,
    });
    expect(await w.posted(alice.person, "exchange:order:o2:in")).toBe(false);
    expect(await w.posted(alice.person, "exchange:order:o1:fee")).toBe(true);
    // A sale: the coins out and the burned fee as two rows.
    const sale = [
      { reason: R.out, delta: 120, key: "exchange:fill:f1:out" },
      { reason: R.fee, delta: -6, key: "exchange:fill:f1:fee" },
    ] as const;
    expect(await w.post(alice.person, sale, "f1", false)).toMatchObject({ ok: true, balance: 115 });
    const lines = (await r.economy.statement(ALICE)).ledger.map((l) => [l.delta, l.label]);
    expect(lines).toContainEqual([-97, "交易所:買進"]);
    expect(lines).toContainEqual([-6, "交易所:手續費和稅(燒掉)"]);
    expect(lines).toContainEqual([120, "交易所:賣出或退回"]);
  });

  it("lets someone blocked sell but not buy, and knows nobody she has not met", async () => {
    const r = await rig();
    const w = new EconomyExchangeWallet(r.economy);
    expect(await w.member(CAROL)).toBeNull();
    expect(await w.holder(CAROL)).toMatchObject({ name: expect.any(String) });
    expect(await w.member(DAVE)).toBeNull();
    expect(await w.holder(DAVE)).toBeNull();
    expect(w.currency).toBe("魚幣");
  });

  it("sums every coin in every wallet for the exchange's mint report", async () => {
    const r = await rig();
    const w = new EconomyExchangeWallet(r.economy);
    const before = await w.circulation();
    await fund(r, ALICE, 200);
    await fund(r, BOB, 10);
    expect(await w.circulation()).toBe(before + 210);
    // A transfer moves coins between wallets (its fee is burned): the sum is still the wallets'.
    await r.economy.transfer(ALICE, BOB, 50, "t1");
    const both = async () => (await balance(r, ALICE)) + (await balance(r, BOB));
    expect(await w.circulation()).toBe(before + (await both()));
    // A burned exchange fee leaves it.
    const alice = await w.member(ALICE);
    if (!alice) throw new Error("no alice");
    const was = await w.circulation();
    await w.post(alice.person, [{ reason: R.fee, delta: -5, key: "exchange:fee:x" }], "x", true);
    expect(await w.circulation()).toBe(was - 5);
    expect(await w.circulation()).toBe(before + (await both()));
  });

  it("sums what came in by transfer since a time", async () => {
    const r = await rig();
    await fund(r, ALICE, 200);
    await fund(r, BOB, 10);
    const w = new EconomyExchangeWallet(r.economy);
    const bob = await w.member(BOB);
    if (!bob) throw new Error("no bob");
    const since = r.economy.todayStart();
    expect(await w.transferredIn(bob.person, since)).toBe(0);
    await r.economy.transfer(ALICE, BOB, 50, "t1");
    expect(await w.transferredIn(bob.person, since)).toBe(50);
  });

  it("gives the exchange the same NT$ per coin that gift pricing uses, and follows a change", async () => {
    const r = await rig();
    const w = new EconomyExchangeWallet(r.economy);
    const desk = new GiftDesk(r.economy, () => r.store.plugin(giftTables));
    // The default: one coin is NT$1.
    expect(w.twdPerCoin).toBe(1);
    expect(w.twdPerCoin).toBe(desk.rate);
    (r.economy.config as { twd_per_coin: number }).twd_per_coin = 2;
    expect(w.twdPerCoin).toBe(2);
    expect(w.twdPerCoin).toBe(desk.rate);
  });
});
