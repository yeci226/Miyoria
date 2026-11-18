// The wallet karaoke rooms are paid through: the opening charged once per room, refused to
// strangers, the blocked and too few coins; refunded once and keyed on the charge; prizes and
// finishing paid once per key, capped per day and kind, never to a stranger or the blocked; the
// statement labels and the health table.

import { KARAOKE_REASONS } from "@miyoria/types";
import { describe, expect, it } from "vitest";
import { BOARD_REASONS } from "../src/board.js";
import { LedgerStatsKey } from "../src/health.js";
import { EconomyKaraokeWallet } from "../src/karaoke-wallet.js";
import { ALICE, ALICE_TWO, BOB, balance, CAROL, DAVE, DAY, fund, rig } from "./rig.js";

const R = KARAOKE_REASONS;

describe("the karaoke wallet", () => {
  it("charges a room once per key, and refuses strangers, the blocked and too few coins", async () => {
    const r = await rig();
    await fund(r, ALICE, 50);
    const w = new EconomyKaraokeWallet(r.economy);
    expect(w.currency).toBe("魚幣");
    expect(await w.balance(ALICE)).toBe(50);
    expect(await w.balance(DAVE)).toBeNull();
    expect(await w.charge(ALICE, 20, "ROOM1", "room")).toMatchObject({ ok: true, balance: 30 });
    // A retry (from another account of the same person too) is the same charge.
    expect(await w.charge(ALICE_TWO, 20, "ROOM1", "room")).toMatchObject({ ok: true, balance: 30 });
    expect(await balance(r, ALICE)).toBe(30);
    expect(await w.charge(DAVE, 20, "ROOM2", null)).toMatchObject({ ok: false, reason: "refused" });
    expect(await w.charge(CAROL, 20, "ROOM3", null)).toMatchObject({
      ok: false,
      reason: "refused",
    });
    expect(await w.charge(BOB, 20, "ROOM4", null)).toEqual({
      ok: false,
      reason: "insufficient",
      balance: 0,
    });
    expect(await w.charge(ALICE, 0, "ROOM5", null)).toMatchObject({ reason: "refused" });
    expect(await w.charge(ALICE, 2.5, "ROOM5", null)).toMatchObject({ reason: "refused" });
    expect((await r.economy.statement(ALICE)).ledger[0]).toMatchObject({
      delta: -20,
      label: "開唱 K 房間",
    });
  });

  it("refunds a charge once, keyed on it, and refuses that key afterwards", async () => {
    const r = await rig();
    await fund(r, ALICE, 50);
    const w = new EconomyKaraokeWallet(r.economy);
    expect(await w.refund(ALICE, "NONE")).toBe(0);
    expect((await w.charge(ALICE, 20, "ROOM1", "room")).ok).toBe(true);
    expect(await w.charged(ALICE, "ROOM1")).toBe(true);
    expect(await w.charged(BOB, "ROOM1")).toBe(false);
    // Twice at once, and again later: one refund row.
    const [a, b] = await Promise.all([w.refund(ALICE, "ROOM1"), w.refund(ALICE_TWO, "ROOM1")]);
    expect(a + b).toBe(20);
    expect(await w.refund(ALICE, "ROOM1")).toBe(0);
    expect(await w.charged(ALICE, "ROOM1")).toBe(false);
    expect(await balance(r, ALICE)).toBe(50);
    // Someone else's key gives nothing back.
    expect(await w.refund(BOB, "ROOM1")).toBe(0);
    // The refunded key is never answered as paid again; a new key is a new charge.
    expect(await w.charge(ALICE, 20, "ROOM1", null)).toMatchObject({ reason: "refused" });
    expect((await w.charge(ALICE, 20, "ROOM2", null)).ok).toBe(true);
    expect(await balance(r, ALICE)).toBe(30);
    const lines = (await r.economy.statement(ALICE)).ledger;
    expect(lines.slice(0, 3).map((l) => [l.delta, l.label])).toEqual([
      [-20, "開唱 K 房間"],
      [20, "唱 K 房間退費"],
      [-20, "開唱 K 房間"],
    ]);
  });

  it("charges two rooms at once without spending the same coins twice", async () => {
    const r = await rig();
    await fund(r, ALICE, 30);
    const w = new EconomyKaraokeWallet(r.economy);
    const both = await Promise.all([
      w.charge(ALICE, 20, "A", null),
      w.charge(ALICE_TWO, 20, "B", null),
    ]);
    expect(both.filter((c) => c.ok)).toHaveLength(1);
    expect(both.filter((c) => !c.ok)[0]).toMatchObject({ reason: "insufficient", balance: 10 });
    expect(await balance(r, ALICE)).toBe(10);
  });

  it("pays a prize and finishing once per key, capped per day and kind", async () => {
    const r = await rig();
    const w = new EconomyKaraokeWallet(r.economy);
    const cap = () => ({ since: r.economy.todayStart(), perDay: 2 });
    expect(await w.pay(BOB, "prize", 15, "R1:1:p", "R1", cap())).toEqual({
      status: "paid",
      paid: 15,
    });
    // A retry, also at once: nothing more.
    const again = await Promise.all([
      w.pay(BOB, "prize", 15, "R1:1:p", "R1", cap()),
      w.pay(BOB, "prize", 15, "R1:1:p", "R1", cap()),
    ]);
    expect(again).toEqual([
      { status: "duplicate", paid: 0 },
      { status: "duplicate", paid: 0 },
    ]);
    expect(await w.pay(BOB, "prize", 15, "R2:1:p", "R2", cap())).toMatchObject({ status: "paid" });
    // Two prizes today: a third is capped, at once or not, and pays nothing.
    const third = await Promise.all([
      w.pay(BOB, "prize", 15, "R3:1:p", "R3", cap()),
      w.pay(BOB, "prize", 15, "R4:1:p", "R4", cap()),
    ]);
    expect(third.map((p) => p.status)).toEqual(["capped", "capped"]);
    // Finishing is counted apart.
    expect(await w.pay(BOB, "finish", 3, "R3:1:p", "R3", cap())).toMatchObject({ status: "paid" });
    expect(await balance(r, BOB)).toBe(33);
    // The next day the count starts again.
    r.clock.at += DAY;
    expect(await w.pay(BOB, "prize", 15, "R5:1:p", "R5", cap())).toMatchObject({ status: "paid" });
    expect(await balance(r, BOB)).toBe(48);
    const labels = (await r.economy.statement(BOB)).ledger.map((l) => l.label);
    expect(labels).toContain("唱 K 第一名");
    expect(labels).toContain("唱 K 唱完一首");
  });

  it("never pays a stranger or someone she blocked, nor a nonsense amount", async () => {
    const r = await rig();
    const w = new EconomyKaraokeWallet(r.economy);
    const cap = { since: r.economy.todayStart(), perDay: 5 };
    expect(await w.pay(DAVE, "prize", 15, "R1:1:d", null, cap)).toEqual({
      status: "refused",
      paid: 0,
    });
    expect(await w.pay(CAROL, "finish", 3, "R1:1:c", null, cap)).toEqual({
      status: "refused",
      paid: 0,
    });
    expect(await w.pay(BOB, "prize", 0, "R1:1:b", null, cap)).toMatchObject({ status: "refused" });
    expect(await w.pay(BOB, "prize", -5, "R1:1:b", null, cap)).toMatchObject({
      status: "refused",
    });
    expect(await w.pay(BOB, "prize", 15, "", null, cap)).toMatchObject({ status: "refused" });
    expect(await balance(r, BOB)).toBe(0);
  });

  it("is not spending on her, and the health table counts it", async () => {
    expect(BOARD_REASONS).not.toContain(R.room);
    const r = await rig({ achievement_cap: 0, health_days: 7 });
    r.services.provide("test", LedgerStatsKey, {
      dailyTotals: async () => {
        const t = r.economy.today();
        return [
          { day: t, reason: "checkin", positive: 1000, negative: 0 },
          { day: t, reason: R.room, positive: 0, negative: 60 },
          { day: t, reason: R.roomRefund, positive: 20, negative: 0 },
          { day: t, reason: R.prize, positive: 15, negative: 0 },
          { day: t, reason: R.finish, positive: 6, negative: 0 },
        ];
      },
    });
    const v = await r.economy.v2.health();
    // Issued: the check-ins, the prize and the finishing; recovered: the rooms that stood.
    expect(v.days.at(-1)).toMatchObject({ issued: 1021, recovered: 40 });
  });
});
