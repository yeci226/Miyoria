// The song priority ticket and the weekly lottery: tickets within the week's limit, a retry is the
// same purchase, the draw by the CSPRNG weighted by tickets, the prize and what is burned, a week
// with too few buyers refunded, the notices, her note, her own account refused, the lottery turned
// off, and a purchase that stopped half way.

import { describe, expect, it } from "vitest";
import { lastSlot, localDay, nextSlot, weekdayOf } from "../src/time.js";
import {
  ALICE,
  ALICE_TWO,
  BOB,
  CAROL,
  DAVE,
  DAY,
  DRAW,
  HER,
  HOUR,
  MIN,
  OPENS,
  rig,
  STRANGER,
  T0,
} from "./rig.js";

const OFFSET = 480;

describe("her weeks", () => {
  it("finds the latest and the next weekly moment in her time zone", () => {
    expect(weekdayOf(localDay(T0, OFFSET))).toBe(2);
    const sat = { weekday: 6, time: "20:00" };
    expect(nextSlot(sat, T0, OFFSET)).toBe(OPENS);
    expect(lastSlot(sat, OPENS, OFFSET)).toBe(OPENS);
    expect(lastSlot(sat, OPENS - 1, OFFSET)).toBe(OPENS - 7 * DAY);
    expect(nextSlot({ weekday: 0, time: "20:00" }, OPENS, OFFSET)).toBe(DRAW);
    // A moment exactly at the draw belongs to the next week.
    expect(nextSlot({ weekday: 0, time: "20:00" }, DRAW, OFFSET)).toBe(DRAW + 7 * DAY);
  });
});

describe("the song priority ticket", () => {
  it("is 40 coins, at most two a local day, refunded once, never hers", async () => {
    const r = await rig();
    r.wallet.fund(ALICE, 200);
    const p = r.service.songPriority;
    expect(p.terms()).toEqual({ price: 40, per_day: 2, currency: "魚幣" });
    expect(await p.charge(ALICE, "a", "song")).toEqual({ ok: true, balance: 160 });
    expect(await p.charge(ALICE_TWO, "b", "song")).toEqual({ ok: true, balance: 120 });
    expect(await p.charge(ALICE, "c", "song")).toEqual({
      ok: false,
      message: "點歌優先券一天最多用 2 張",
    });
    expect(await p.refund(ALICE, "b")).toBe(40);
    expect(await p.refund(ALICE, "b")).toBe(0);
    expect((await p.charge(ALICE, "c", "song")).ok).toBe(true);
    // The next local day starts the count again.
    r.clock.at = T0 + DAY;
    expect((await p.charge(ALICE, "d", "song")).ok).toBe(true);
    expect(await p.charge(HER, "e", "song")).toMatchObject({ ok: false });
    expect(await p.charge(BOB, "f", "song")).toMatchObject({
      ok: false,
      message: expect.stringContaining("魚幣不夠"),
    });
    expect(await p.charge(STRANGER, "g", "song")).toMatchObject({ ok: false });
  });

  it("says a refund did not go when the wallet is not there, so the singer tries again", async () => {
    const r = await rig();
    r.wallet.fund(ALICE, 100);
    const p = r.service.songPriority;
    expect((await p.charge(ALICE, "a", "song")).ok).toBe(true);
    r.walletGone = true;
    await expect(p.refund(ALICE, "a")).rejects.toThrow();
    r.walletGone = false;
    expect(await p.refund(ALICE, "a")).toBe(40);
    expect(r.wallet.balanceOf("p-alice")).toBe(100);
  });

  it("is not on sale at 0 a day", async () => {
    const r = await rig({ song_priority_per_day: 0 });
    expect(r.service.songPriority.terms()).toBeNull();
    expect(await r.service.songPriority.charge(ALICE, "a", "s")).toMatchObject({ ok: false });
  });
});

describe("the weekly lottery", () => {
  it("sells at most 20 tickets a person a week, a retry being the same purchase", async () => {
    const r = await rig();
    r.wallet.fund(ALICE, 1000);
    const first = await r.service.buyTickets(ALICE, 5, "k1");
    expect(first).toMatchObject({ ok: true, count: 5, mine: 5, charged: 50, balance: 950 });
    expect(await r.service.buyTickets(ALICE_TWO, 5, "k1")).toMatchObject({
      ok: true,
      mine: 5,
      charged: 0,
      again: true,
    });
    expect(await r.service.buyTickets(ALICE, 15, "k2")).toMatchObject({ ok: true, mine: 20 });
    expect(await r.service.buyTickets(ALICE, 1, "k3")).toMatchObject({
      ok: false,
      status: 429,
      message: "一個人一週最多 20 張,你已經有 20 張",
    });
    expect(await r.service.buyTickets(ALICE, 0, "k4")).toMatchObject({ ok: false, status: 400 });
    expect(r.wallet.balanceOf("p-alice")).toBe(800);
    const view = await r.service.lotteryView(ALICE);
    expect(view).toMatchObject({
      tickets: 20,
      buyers: 1,
      pot: 200,
      mine: { tickets: 20 },
      state: "open",
      draw_at: new Date(DRAW).toISOString(),
    });
  });

  it("refuses her, strangers and too few coins, and keeps no purchase that was not paid", async () => {
    const r = await rig();
    r.wallet.fund(BOB, 15);
    expect(await r.service.buyTickets(HER, 1, "k")).toMatchObject({ ok: false, status: 403 });
    expect(await r.service.buyTickets(STRANGER, 1, "k")).toMatchObject({ ok: false, status: 403 });
    expect(await r.service.buyTickets(BOB, 2, "k")).toMatchObject({
      ok: false,
      status: 402,
      message: "魚幣不夠(2 張要 20),你有 15",
    });
    // The refused purchase is gone: the same key buys one now.
    expect(await r.service.buyTickets(BOB, 1, "k")).toMatchObject({ ok: true, mine: 1 });
  });

  it("draws one ticket at the draw, weighted by tickets, pays 70% and burns the rest", async () => {
    const r = await rig({ auction: false });
    for (const a of [ALICE, BOB, CAROL]) r.wallet.fund(a, 500);
    await r.service.buyTickets(ALICE, 2, "a");
    await r.service.buyTickets(BOB, 5, "b");
    await r.service.buyTickets(CAROL, 3, "c");
    // The week's notice went out once, with its buy buttons.
    await r.service.tick();
    await r.service.tick();
    const notices = r.posted.filter((p) => p.reply.card?.title === "每週樂透");
    expect(notices).toHaveLength(1);
    expect(notices[0]?.channel).toBe("100");
    // Ticket 4 of 0..9: Alice holds 0-1, Bob 2-6.
    r.dice.push(4);
    r.clock.at = DRAW - 1;
    await r.service.tick();
    expect(r.store.week(localDay(DRAW, OFFSET))?.status).toBe("open");
    r.clock.at = DRAW;
    await r.service.tick();
    const week = r.store.week(localDay(DRAW, OFFSET));
    expect(week).toMatchObject({
      status: "drawn",
      tickets: 10,
      buyers: 3,
      pot: 100,
      prize: 70,
      burned: 30,
      pick: 4,
      winner: { person: "p-bob", name: "Bob", tickets: 5 },
    });
    expect(r.wallet.balanceOf("p-bob")).toBe(500 - 50 + 70);
    expect(r.wallet.balanceOf("p-alice")).toBe(480);
    const result = r.posted.find((p) => p.reply.text.includes("開獎了"));
    expect(result?.reply.text).toContain("Bob 抽中,獎金 70 魚幣");
    expect(r.told.map((t) => t.summary)).toEqual([
      "這週的樂透開獎了:Bob 抽中,獎金 70 魚幣(一共 3 個人、10 張)。",
    ]);
    // The event is on the log, once.
    const events = r.raw.events
      .query({ types: ["market.lottery_drawn"], order: "asc", limit: 10 })
      .map((e) => e.envelope.data);
    expect(events).toEqual([
      expect.objectContaining({
        pot: 100,
        prize: 70,
        burned: 30,
        winner: "p-bob",
        refunded: false,
      }),
    ]);
    // A later pass does nothing again; the next week opens with its own notice.
    await r.service.tick();
    expect(r.wallet.balanceOf("p-bob")).toBe(520);
    expect(r.told).toHaveLength(1);
    const view = await r.service.lotteryView(BOB);
    expect(view).toMatchObject({
      tickets: 0,
      mine: { tickets: 0 },
      last: { prize: 70, winner: "Bob" },
    });
    expect(r.posted.filter((p) => p.reply.card?.title === "每週樂透")).toHaveLength(3);
    expect(await r.service.myTickets(BOB)).toEqual([
      expect.objectContaining({ tickets: 5, paid: 50, state: "drawn", won: true, prize: 70 }),
    ]);
  });

  it("refunds everyone in full when fewer than three people bought", async () => {
    const r = await rig();
    r.wallet.fund(ALICE, 100);
    r.wallet.fund(BOB, 100);
    await r.service.buyTickets(ALICE, 3, "a");
    await r.service.buyTickets(BOB, 1, "b");
    await r.service.buyTickets(BOB, 1, "c");
    r.clock.at = DRAW + HOUR;
    await r.service.tick();
    expect(r.store.week(localDay(DRAW, OFFSET))).toMatchObject({
      status: "refunded",
      buyers: 2,
      tickets: 5,
      winner: null,
    });
    expect(r.wallet.balanceOf("p-alice")).toBe(100);
    expect(r.wallet.balanceOf("p-bob")).toBe(100);
    expect(r.posted.some((p) => p.reply.text.includes("不開獎"))).toBe(true);
    expect(r.told[0]?.summary).toContain("沒有開獎");
  });

  it("pays a winner once even when the wallet was down at the draw", async () => {
    const r = await rig();
    for (const a of [ALICE, BOB, CAROL]) r.wallet.fund(a, 100);
    for (const [a, k] of [
      [ALICE, "a"],
      [BOB, "b"],
      [CAROL, "c"],
    ] as const)
      await r.service.buyTickets(a, 1, k);
    r.dice.push(2);
    r.clock.at = DRAW;
    r.wallet.down = true;
    await r.service.tick();
    // The winner is kept; only the payment waits.
    expect(r.store.week(localDay(DRAW, OFFSET))).toMatchObject({
      status: "drawing",
      winner: { name: "Carol" },
    });
    r.wallet.down = false;
    await r.service.tick();
    expect(r.store.week(localDay(DRAW, OFFSET))).toMatchObject({ status: "drawn", prize: 21 });
    expect(r.wallet.balanceOf("p-carol")).toBe(111);
  });

  it("settles a purchase that stopped between its row and its charge", async () => {
    const r = await rig();
    r.wallet.fund(ALICE, 100);
    // A purchase written, charged, never marked paid (Core stopped).
    const week = localDay(DRAW, OFFSET);
    r.store.ensureWeek(week, DRAW);
    const ticket = (id: string, key: string, count: number) => ({
      id,
      week,
      person: "p-alice",
      account: ALICE,
      name: "Alice",
      key,
      count,
      amount: count * 10,
    });
    const t = r.store.addTicket(ticket("T1", "k", 2), 20, T0);
    expect(t?.status).toBe("pending");
    await r.wallet.charge(ALICE, 20, "lottery_ticket", "T1", null);
    // One that was never charged.
    r.store.addTicket(ticket("T2", "k2", 3), 20, T0);
    r.clock.at = T0 + 5 * MIN;
    await r.service.tick();
    expect(r.store.tickets(week).map((x) => x.id)).toEqual(["T1"]);
    expect(r.store.ticketByKey("p-alice", "k2")).toBeNull();
  });

  it("gives back a purchase that stopped half way when its week was settled without it", async () => {
    const r = await rig({ auction: false });
    r.wallet.fund(ALICE, 100);
    // Charged, then the Core stopped before the purchase was marked paid.
    r.wallet.throwAfterCharge = true;
    await expect(r.service.buyTickets(ALICE, 2, "k")).rejects.toThrow();
    r.wallet.throwAfterCharge = false;
    expect(r.wallet.balanceOf("p-alice")).toBe(80);
    // Back up within two minutes with the lottery turned off: the week is refunded at once.
    const off = r.restart({ lottery: false });
    await off.tick();
    expect(r.store.week(localDay(DRAW, OFFSET))?.status).toBe("refunded");
    // The purchase is found later: it was in no draw, so it goes back.
    r.clock.at += 5 * MIN;
    await off.tick();
    expect(r.wallet.balanceOf("p-alice")).toBe(100);
    expect(r.store.ticketByKey("p-alice", "k")?.status).toBe("refunded");
    await off.tick();
    expect(r.wallet.balanceOf("p-alice")).toBe(100);
  });

  it("refunds the open week when it is turned off, and sells nothing", async () => {
    const r = await rig();
    for (const a of [ALICE, BOB, CAROL, DAVE]) r.wallet.fund(a, 50);
    for (const [a, k] of [
      [ALICE, "a"],
      [BOB, "b"],
      [CAROL, "c"],
    ] as const)
      await r.service.buyTickets(a, 2, k);
    const off = r.restart({ lottery: false });
    expect(await off.buyTickets(DAVE, 1, "d")).toMatchObject({ ok: false, status: 409 });
    await off.tick();
    expect(r.store.week(localDay(DRAW, OFFSET))?.status).toBe("refunded");
    for (const p of ["p-alice", "p-bob", "p-carol"]) expect(r.wallet.balanceOf(p)).toBe(50);
  });

  it("draws now when the owner settles it", async () => {
    const r = await rig();
    for (const a of [ALICE, BOB, CAROL]) r.wallet.fund(a, 100);
    for (const [a, k] of [
      [ALICE, "a"],
      [BOB, "b"],
      [CAROL, "c"],
    ] as const)
      await r.service.buyTickets(a, 1, k);
    r.dice.push(0);
    expect(await r.service.settleNow("lottery")).toEqual({ ok: true });
    expect(r.store.week(localDay(DRAW, OFFSET))).toMatchObject({
      status: "drawn",
      winner: { name: "Alice" },
    });
    expect(await r.service.settleNow("lottery")).toMatchObject({ ok: false, status: 409 });
    expect(r.service.history().weeks).toHaveLength(1);
  });
});
