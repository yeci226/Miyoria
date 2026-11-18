// The wallet the weekly market is paid through: charges keyed and capped, refunds once, a bid's
// hold and its release, a won lot burned, a prize paid, the labels, the health table, and the
// one-of-a-kind frame a won lot gives.

import { MARKET_REASONS } from "@miyoria/types";
import { describe, expect, it } from "vitest";
import { BOARD_REASONS } from "../src/board.js";
import { LedgerStatsKey } from "../src/health.js";
import { EconomyMarketWallet } from "../src/market-wallet.js";
import { ALICE, ALICE_TWO, BOB, balance, CAROL, DAVE, fund, rig } from "./rig.js";

const R = MARKET_REASONS;

describe("the market wallet", () => {
  it("charges once per key, refuses strangers, the blocked and too few coins", async () => {
    const r = await rig();
    await fund(r, ALICE, 100);
    const w = new EconomyMarketWallet(r.economy);
    expect(w.currency).toBe("魚幣");
    expect(await w.member(ALICE)).toMatchObject({ name: "Alice" });
    expect(await w.member(DAVE)).toBeNull();
    expect(await w.member(CAROL)).toBeNull();
    const first = await w.charge(ALICE, 40, R.songPriority, "k1", "song");
    expect(first).toMatchObject({ ok: true, balance: 60 });
    const again = await w.charge(ALICE_TWO, 40, R.songPriority, "k1", "song");
    expect(again).toMatchObject({ ok: true, balance: 60 });
    expect(await w.charge(DAVE, 40, R.songPriority, "k", null)).toMatchObject({ ok: false });
    expect(await w.charge(CAROL, 40, R.songPriority, "k", null)).toMatchObject({
      reason: "refused",
    });
    expect(await w.charge(ALICE, 61, R.lotteryTicket, "k2", null)).toEqual({
      ok: false,
      reason: "insufficient",
      balance: 60,
    });
    expect((await r.economy.statement(ALICE)).ledger[0]).toMatchObject({
      delta: -40,
      label: "點歌優先券",
    });
  });

  it("caps the charges that stand since a time, refunds once and refuses a refunded key", async () => {
    const r = await rig();
    await fund(r, ALICE, 200);
    const w = new EconomyMarketWallet(r.economy);
    const since = r.economy.todayStart();
    const cap = { since, limit: 2 };
    expect((await w.charge(ALICE, 40, R.songPriority, "a", null, cap)).ok).toBe(true);
    expect((await w.charge(ALICE, 40, R.songPriority, "b", null, cap)).ok).toBe(true);
    expect(await w.charge(ALICE, 40, R.songPriority, "c", null, cap)).toMatchObject({
      ok: false,
      reason: "capped",
    });
    // A retry of a standing key is not a new charge, even at the cap.
    expect(await w.charge(ALICE, 40, R.songPriority, "b", null, cap)).toMatchObject({ ok: true });
    expect(await w.charged(ALICE, R.songPriority, "b")).toBe(true);
    expect(await w.refund(ALICE_TWO, R.songPriority, "b")).toBe(40);
    expect(await w.refund(ALICE, R.songPriority, "b")).toBe(0);
    expect(await w.refund(BOB, R.songPriority, "a")).toBe(0);
    expect(await w.charged(ALICE, R.songPriority, "b")).toBe(false);
    // The refunded one no longer counts; its key is refused, a new key goes through.
    expect(await w.charge(ALICE, 40, R.songPriority, "b", null, cap)).toMatchObject({
      reason: "refused",
    });
    expect((await w.charge(ALICE, 40, R.songPriority, "c", null, cap)).ok).toBe(true);
    expect(await balance(r, ALICE)).toBe(120);
    expect((await r.economy.statement(ALICE)).ledger[1]).toMatchObject({
      delta: 40,
      label: "點歌優先券退回",
    });
  });

  it("holds a bid, releases it once, and burns a won lot before its holds go back", async () => {
    const r = await rig();
    await fund(r, ALICE, 300);
    const w = new EconomyMarketWallet(r.economy);
    expect(await w.hold(ALICE, 120, "bid1", "lot")).toMatchObject({ ok: true, balance: 180 });
    expect(await w.hold(ALICE, 120, "bid1", "lot")).toMatchObject({ ok: true, balance: 180 });
    expect(await w.hold(ALICE, 500, "bid2", "lot")).toMatchObject({ reason: "insufficient" });
    expect(await w.release(ALICE_TWO, "bid1")).toBe(120);
    expect(await w.release(ALICE, "bid1")).toBe(0);
    // A released hold is not taken again under its key.
    expect(await w.hold(ALICE, 120, "bid1", "lot")).toMatchObject({ reason: "refused" });
    expect(await balance(r, ALICE)).toBe(300);
    // The winner: held, burned whatever the balance, then released.
    expect((await w.hold(ALICE, 250, "bid3", "lot")).ok).toBe(true);
    expect(await w.burn(ALICE, 250, "LOT1", "frame:LOT1")).toBe(true);
    expect(await w.burn(ALICE, 250, "LOT1", "frame:LOT1")).toBe(true);
    expect(await balance(r, ALICE)).toBe(-200);
    expect(await w.release(ALICE, "bid3")).toBe(250);
    expect(await balance(r, ALICE)).toBe(50);
    const lines = (await r.economy.statement(ALICE)).ledger;
    expect(lines.slice(0, 3).map((l) => [l.delta, l.label])).toEqual([
      [250, "拍賣出價退回"],
      [-250, "拍賣得標:只此一件的卡框"],
      [-250, "拍賣出價(押著)"],
    ]);
  });

  it("gives the winner of a frame lot that one frame, theirs alone to choose", async () => {
    const r = await rig();
    await fund(r, ALICE, 300);
    const w = new EconomyMarketWallet(r.economy);
    await w.burn(ALICE, 100, "LOT9", "frame:LOT9");
    await w.burn(ALICE, 100, "LOTC", "call_name:LOTC");
    const view = await r.economy.wallet(ALICE);
    expect(view.frames.owned).toEqual(["one-LOT9"]);
    expect((await r.economy.frame(ALICE, { select: "one-LOT9" }, "s")).selected).toBe("one-LOT9");
    expect(await r.economy.selectedFrame(ALICE_TWO)).toBe("one-LOT9");
    await expect(r.economy.frame(BOB, { select: "one-LOT9" }, "s")).rejects.toMatchObject({
      status: 409,
    });
    // Nobody can buy it.
    await expect(r.economy.frame(BOB, { buy: "one-LOT9" }, "b")).rejects.toMatchObject({
      status: 400,
    });
  });

  it("pays a prize once", async () => {
    const r = await rig();
    const w = new EconomyMarketWallet(r.economy);
    expect(await w.pay(BOB, 70, "W1", "week")).toBe(true);
    expect(await w.pay(BOB, 70, "W1", "week")).toBe(true);
    expect(await balance(r, BOB)).toBe(70);
    expect((await r.economy.statement(BOB)).ledger[0]).toMatchObject({ label: "每週樂透中獎" });
  });

  it("is not spending on her, and counts as recovered in the health table less what went back", async () => {
    expect(BOARD_REASONS).not.toContain(R.lotteryTicket);
    expect(BOARD_REASONS).not.toContain(R.auctionWon);
    const r = await rig({ achievement_cap: 0, health_days: 7 });
    r.services.provide("test", LedgerStatsKey, {
      dailyTotals: async () => {
        const t = r.economy.today();
        return [
          { day: t, reason: "checkin", positive: 1000, negative: 0 },
          { day: t, reason: R.lotteryTicket, positive: 0, negative: 100 },
          { day: t, reason: R.lotteryPrize, positive: 70, negative: 0 },
          { day: t, reason: R.songPriority, positive: 0, negative: 80 },
          { day: t, reason: R.songPriorityRefund, positive: 40, negative: 0 },
          { day: t, reason: R.auctionHold, positive: 0, negative: 500 },
          { day: t, reason: R.auctionRelease, positive: 500, negative: 0 },
          { day: t, reason: R.auctionWon, positive: 0, negative: 200 },
        ];
      },
    });
    const v = await r.economy.v2.health();
    // 30 of the lottery, 40 of the tickets that stood, the whole won lot; holds are neither.
    expect(v.days.at(-1)).toMatchObject({ issued: 1000, recovered: 270 });
  });
});
