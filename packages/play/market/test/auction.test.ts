// The weekly auction: a lot opens Saturday 20:00 in the channel, picked by the owner's plan, by her
// or by the rotation; bids hold coins, an outbid bidder's hold goes back at once, a raise holds the
// difference, a bid near the end moves it; at the end the price is burned and the holds released;
// a name lot waits for a name she accepts and is refunded when given up or late; the old name is
// back after a week; nobody bidding is nothing; turning it off calls the lot off; a restart picks
// up from the rows; she cannot bid.

import { describe, expect, it } from "vitest";
import { marketConfig } from "../src/config.js";
import { parsePick, rotationKind } from "../src/lots.js";
import { retireMarketSql } from "../src/migrations.js";
import { auctionNotice } from "../src/notices.js";
import {
  ALICE,
  ALICE_TWO,
  BOB,
  CAROL,
  DAY,
  HER,
  HOUR,
  MIN,
  OPENS,
  rig,
  STRANGER,
  T0,
} from "./rig.js";

/** A rig with the lot of `kind` open (the owner set it; both kinds on offer). */
async function open(kind: "frame" | "call_name", options: Parameters<typeof rig>[1] = {}) {
  const r = await rig({ lottery: false, auction_lots: ["call_name", "frame"] }, options);
  expect(await r.service.plan(kind)).toMatchObject({ ok: true, plan: kind });
  r.clock.at = OPENS;
  await r.service.tick();
  for (const a of [ALICE, BOB, CAROL]) r.wallet.fund(a, 1000);
  return r;
}

const held = (r: Awaited<ReturnType<typeof rig>>, person: string) =>
  r.wallet.rows
    .filter((x) => x.person === person && ["auction_hold", "auction_release"].includes(x.reason))
    .reduce((n, x) => n - x.delta, 0);

describe("the lot of the week", () => {
  it("offers only the frame unless the config adds the name lot (owner 2026-11-18)", async () => {
    expect(marketConfig().auction_lots).toEqual(["frame"]);
    let asked = 0;
    const picker = {
      pick: async () => {
        asked += 1;
        return { kind: "call_name" as const, why: "不該問" };
      },
    };
    const r = await rig({ lottery: false }, { picker });
    // A plan for a kind not on offer is refused; the frame and a skip are fine.
    expect(await r.service.plan("call_name")).toMatchObject({ ok: false, status: 409 });
    r.clock.at = OPENS;
    await r.service.tick();
    // One kind: nothing to pick, no model call, the frame every week.
    expect(asked).toBe(0);
    expect(r.store.lotsIn(["open"])[0]).toMatchObject({ kind: "frame", picked_by: "rotation" });
    for (const week of [0, 7, 14, 21]) expect(rotationKind(["frame"], week)).toBe("frame");
    // The next week is planned the same way; the owner's history says what is offered and planned.
    expect(await r.service.plan("frame")).toMatchObject({ ok: true, plan: "frame" });
    expect(r.service.history()).toMatchObject({
      offered: ["frame"],
      next: { opens_at: new Date(OPENS + 7 * DAY).toISOString(), plan: "frame" },
    });
    // Added by an owner, the name lot runs again (her pick among the two).
    const both = await rig(
      { lottery: false, auction_lots: ["call_name", "frame"] },
      { picker: { pick: async () => ({ kind: "call_name", why: null }) } },
    );
    both.clock.at = OPENS;
    await both.service.tick();
    expect(both.store.lotsIn(["open"])[0]).toMatchObject({ kind: "call_name", picked_by: "her" });
  });

  it("opens Saturday 20:00 for 24 hours in the channel, by the rotation without a model", async () => {
    const r = await rig({ lottery: false, auction_lots: ["call_name", "frame"] });
    await r.service.tick();
    expect(r.posted).toEqual([]);
    r.clock.at = OPENS;
    await r.service.tick();
    await r.service.tick();
    const lot = r.store.lotsIn(["open"])[0];
    expect(lot).toMatchObject({
      picked_by: "rotation",
      kind: rotationKind(["call_name", "frame"], lot?.week ?? 0),
      opens_at: new Date(OPENS).toISOString(),
      ends_at: new Date(OPENS + DAY).toISOString(),
      channel: "100",
      message_id: "m1",
    });
    expect(r.posted).toHaveLength(1);
    expect(r.posted[0]?.reply.card?.title).toBe("每週拍賣");
    expect(r.posted[0]?.reply.text).toContain("起標 50");
  });

  it("is her pick when a model answers, and the rotation when it does not", async () => {
    const r = await rig(
      { lottery: false, auction_lots: ["call_name", "frame"] },
      { picker: { pick: async () => ({ kind: "frame", why: "想看大家搶" }) } },
    );
    r.clock.at = OPENS + HOUR;
    await r.service.tick();
    expect(r.store.lotsIn(["open"])[0]).toMatchObject({
      kind: "frame",
      picked_by: "her",
      note: "想看大家搶",
    });
    const failing = await rig(
      { lottery: false, auction_lots: ["call_name", "frame"] },
      {
        picker: {
          pick: async () => {
            throw new Error("down");
          },
        },
      },
    );
    failing.clock.at = OPENS;
    await failing.service.tick();
    expect(failing.store.lotsIn(["open"])[0]?.picked_by).toBe("rotation");
    expect(parsePick('{"lot":"frame","why":"好看"}', ["frame"])).toEqual({
      kind: "frame",
      why: "好看",
    });
    expect(parsePick('{"lot":"bond"}', ["frame", "call_name"])).toBeNull();
  });

  it("does not open past its window, on a skipped week, or without a channel", async () => {
    const late = await rig({ lottery: false });
    late.clock.at = OPENS + DAY + MIN;
    await late.service.tick();
    expect(late.store.lotsIn(["open"])).toEqual([]);
    const skipped = await rig({ lottery: false });
    expect(await skipped.service.plan("skip")).toMatchObject({ ok: true, plan: "skip" });
    expect((await skipped.service.auctionView(null)).next).toEqual({
      opens_at: new Date(OPENS).toISOString(),
      plan: "skip",
    });
    skipped.clock.at = OPENS;
    await skipped.service.tick();
    expect(skipped.store.lotsIn(["open"])).toEqual([]);
    const quiet = await rig({ lottery: false, auction_channel: "" });
    quiet.clock.at = OPENS;
    await quiet.service.tick();
    expect(quiet.store.lotsIn(["open"])).toEqual([]);
    expect((await quiet.service.auctionView(null)).running).toBe(false);
  });

  it("takes the owner's plan for the coming week, not one that opened", async () => {
    const r = await open("call_name");
    expect(r.store.lotsIn(["open"])[0]).toMatchObject({ kind: "call_name", picked_by: "owner" });
    // This week's lot is open: a plan is for the next one.
    const next = await r.service.plan("frame");
    expect(next).toMatchObject({ ok: true, opens_at: new Date(OPENS + 7 * DAY).toISOString() });
  });
});

describe("bids", () => {
  it("hold coins, give an outbid bidder's back at once, and hold only a raise's difference", async () => {
    const r = await open("frame");
    expect(await r.service.bid(ALICE, 49)).toMatchObject({ ok: false, message: "出價至少要 50" });
    expect(await r.service.bid(ALICE, 50)).toMatchObject({ ok: true, amount: 50 });
    expect(held(r, "p-alice")).toBe(50);
    expect(await r.service.bid(BOB, 54)).toMatchObject({ ok: false, message: "出價至少要 55" });
    expect(await r.service.bid(BOB, 60)).toMatchObject({ ok: true });
    expect(held(r, "p-alice")).toBe(0);
    expect(held(r, "p-bob")).toBe(60);
    // Bob raises himself: only the difference is held.
    expect(await r.service.bid(BOB, 100)).toMatchObject({ ok: true, amount: 100 });
    expect(held(r, "p-bob")).toBe(100);
    expect(r.wallet.balanceOf("p-bob")).toBe(900);
    // The same bid again is not a second one.
    expect(await r.service.bid(BOB, 100)).toMatchObject({ ok: true, again: true });
    expect(held(r, "p-bob")).toBe(100);
    const view = await r.service.auctionView(ALICE_TWO);
    expect(view.lot).toMatchObject({
      top: { amount: 100, name: "Bob" },
      bids: 3,
      bidders: 2,
      min_bid: 105,
    });
    expect(view.mine).toEqual({ amount: 50, leading: false, won: false });
    expect(view.history.map((h) => h.amount)).toEqual([100, 60, 50]);
  });

  it("refuses her, strangers, too few coins, odd amounts and a lot that is not open", async () => {
    const r = await open("frame");
    expect(await r.service.bid(HER, 100)).toMatchObject({ ok: false, status: 403 });
    expect(await r.service.bid(STRANGER, 100)).toMatchObject({ ok: false, status: 403 });
    expect(await r.service.bid(ALICE, 5000)).toMatchObject({
      ok: false,
      status: 402,
      message: "魚幣不夠,你有 1000",
    });
    expect(await r.service.bid(ALICE, 1.5)).toMatchObject({ ok: false, status: 400 });
    // The refused hold left a void bid and nothing held.
    expect(held(r, "p-alice")).toBe(0);
    expect((await r.service.auctionView(null)).lot?.bids).toBe(0);
    r.clock.at = OPENS + DAY;
    expect(await r.service.bid(ALICE, 100)).toMatchObject({ ok: false, status: 409 });
  });

  it("move the end five minutes later when made in its last five minutes", async () => {
    const r = await open("frame");
    r.clock.at = OPENS + DAY - 3 * MIN;
    const late = await r.service.bid(ALICE, 50);
    expect(late).toMatchObject({ ok: true, extended: true });
    if (late.ok) expect(Date.parse(late.ends_at)).toBe(OPENS + DAY + 2 * MIN);
    r.clock.at = OPENS + DAY + MIN;
    await r.service.tick();
    expect(r.store.lotsIn(["open"])).toHaveLength(1);
    expect(await r.service.bid(BOB, 55)).toMatchObject({ ok: true, extended: true });
    r.clock.at = OPENS + DAY + 6 * MIN;
    await r.service.tick();
    expect(r.store.lotsIn(["open"])).toEqual([]);
  });

  it("never move the end past 30 minutes after the scheduled end, and the notice shows it", async () => {
    const r = await open("frame");
    const cap = OPENS + DAY + 30 * MIN;
    let amount = 50;
    // A bid every two minutes from three minutes before the end: each moves it, up to the cap.
    for (let t = OPENS + DAY - 3 * MIN; t < cap; t += 2 * MIN) {
      r.clock.at = t;
      const who = amount % 10 === 0 ? ALICE : BOB;
      const bid = await r.service.bid(who, amount);
      expect(bid).toMatchObject({ ok: true });
      if (bid.ok) expect(Date.parse(bid.ends_at)).toBe(Math.min(t + 5 * MIN, cap));
      expect(Date.parse(r.store.lotsIn(["open"])[0]?.ends_at ?? "")).toBeLessThanOrEqual(cap);
      amount += 5;
    }
    const lot = (await r.service.auctionView(null)).lot;
    expect(lot).toMatchObject({ ends_at: new Date(cap).toISOString(), extended: true });
    // The card redrawn after a bid shows the real end.
    if (lot) {
      expect(auctionNotice(lot, "魚幣", null, r.service.config).text).toContain(
        `延長到:<t:${cap / 1000}:f>`,
      );
    }
    // At the cap the lot takes no more bids and closes.
    r.clock.at = cap;
    expect(await r.service.bid(ALICE, amount + 100)).toMatchObject({ ok: false, status: 409 });
    await r.service.tick();
    expect(r.store.lotsIn(["open"])).toEqual([]);
    expect(r.store.history(1)[0]).toMatchObject({
      status: "done",
      closed_at: new Date(cap).toISOString(),
    });
  });

  it("keep the end where it is when the cap is 0, and the notice says nothing about extending", async () => {
    const r = await rig({ lottery: false, auction_extend_max_mins: 0 });
    r.clock.at = OPENS;
    await r.service.tick();
    r.wallet.fund(ALICE, 1000);
    r.clock.at = OPENS + DAY - MIN;
    expect(await r.service.bid(ALICE, 50)).toMatchObject({
      ok: true,
      extended: false,
      ends_at: new Date(OPENS + DAY).toISOString(),
    });
    expect(r.posted[0]?.reply.text).not.toContain("延長");
    const shown = await rig({ lottery: false });
    shown.clock.at = OPENS;
    await shown.service.tick();
    expect(shown.posted[0]?.reply.text).toContain(
      "最後 5 分鐘有人出價就延長 5 分鐘,最多延到原本結束後 30 分鐘",
    );
  });
});

describe("the end of a lot", () => {
  it("burns a frame lot's price, releases the winner's holds and gives the frame", async () => {
    const r = await open("frame");
    await r.service.bid(ALICE, 50);
    await r.service.bid(BOB, 70);
    await r.service.bid(BOB, 90);
    r.clock.at = OPENS + DAY;
    await r.service.tick();
    const lot = r.store.history(1)[0];
    expect(lot).toMatchObject({ status: "done", price: 90, kind: "frame" });
    expect(held(r, "p-bob")).toBe(0);
    expect(r.wallet.balanceOf("p-bob")).toBe(910);
    expect(r.wallet.balanceOf("p-alice")).toBe(1000);
    const won = r.wallet.rows.filter((x) => x.reason === "auction_won");
    expect(won).toEqual([
      expect.objectContaining({ person: "p-bob", delta: -90, ref: `frame:${lot?.id}` }),
    ]);
    expect(r.posted.at(-1)?.reply.text).toContain("Bob 以 90 魚幣得標「只此一件的卡框」");
    expect(r.told.at(-1)?.summary).toContain("Bob 以 90 魚幣得標");
    const events = r.raw.events
      .query({ types: ["market.lot_closed"], order: "asc", limit: 10 })
      .map((e) => e.envelope.data);
    expect(events).toEqual([
      expect.objectContaining({ kind: "frame", winner: "p-bob", price: 90, bids: 3, bidders: 2 }),
    ]);
    expect(await r.service.myBids(BOB)).toEqual([
      expect.objectContaining({ amount: 90, state: "won", name: "只此一件的卡框" }),
    ]);
    expect(await r.service.myBids(ALICE)).toEqual([
      expect.objectContaining({ amount: 50, state: "lost" }),
    ]);
    // Nothing more happens on the next passes.
    await r.service.tick();
    expect(r.wallet.balanceOf("p-bob")).toBe(910);
  });

  it("is nothing when nobody bid", async () => {
    const r = await open("frame");
    r.clock.at = OPENS + DAY;
    await r.service.tick();
    expect(r.store.history(1)[0]).toMatchObject({ status: "done", price: null, winner_bid: null });
    expect(r.posted.at(-1)?.reply.text).toContain("沒有人出價");
    expect(r.wallet.rows.some((x) => x.reason === "auction_won")).toBe(false);
  });

  it("waits for a name she accepts, burns then, and gives the old name back after a week", async () => {
    const r = await open("call_name", { unfit: /BAD/ });
    r.calls.set("p-bob", "小鮑");
    await r.service.bid(BOB, 80);
    r.clock.at = OPENS + DAY;
    await r.service.tick();
    const lot = r.store.history(1)[0];
    expect(lot).toMatchObject({ status: "naming" });
    // Nothing is burned until the name is in; the coins are still held.
    expect(held(r, "p-bob")).toBe(80);
    expect(r.posted.at(-1)?.reply.card?.blocks.some((b) => b.type === "buttons")).toBe(true);
    expect(await r.service.proposeName(ALICE, "阿莉")).toMatchObject({ ok: false, status: 404 });
    expect(await r.service.proposeName(BOB, "BAD")).toMatchObject({
      ok: false,
      message: expect.stringContaining("她不想這樣叫你"),
    });
    const named = await r.service.proposeName(BOB, "鮑大王");
    expect(named).toMatchObject({ ok: true, call_name: "鮑大王" });
    expect(r.calls.get("p-bob")).toBe("鮑大王");
    expect(r.store.lot(lot?.id ?? "")).toMatchObject({
      status: "applied",
      previous_call_name: "小鮑",
      call_name: "鮑大王",
    });
    expect(r.wallet.balanceOf("p-bob")).toBe(920);
    expect(held(r, "p-bob")).toBe(0);
    expect(r.told.at(-1)?.summary).toContain("叫他「鮑大王」");
    r.clock.at = OPENS + DAY + 7 * DAY;
    await r.service.tick();
    expect(r.calls.get("p-bob")).toBe("小鮑");
    expect(r.store.lot(lot?.id ?? "")?.status).toBe("done");
  });

  it("keeps a name they changed themselves during the week", async () => {
    const r = await open("call_name");
    await r.service.bid(ALICE, 60);
    r.clock.at = OPENS + DAY;
    await r.service.tick();
    await r.service.proposeName(ALICE_TWO, "莉莉");
    r.calls.set("p-alice", "自己取的");
    r.clock.at = OPENS + 9 * DAY;
    await r.service.tick();
    expect(r.calls.get("p-alice")).toBe("自己取的");
  });

  it("refunds a name lot given up, or not named in time, and refuses one she cannot stand", async () => {
    const r = await open("call_name", { refuses: ["p-carol"] });
    await r.service.bid(CAROL, 200);
    r.clock.at = OPENS + DAY;
    await r.service.tick();
    expect(await r.service.proposeName(CAROL, "卡卡")).toMatchObject({
      ok: false,
      message: expect.stringContaining("不想幫你換稱呼"),
    });
    expect(await r.service.giveUpName(CAROL)).toEqual({ ok: true, refunded: 200 });
    expect(r.wallet.balanceOf("p-carol")).toBe(1000);
    expect(r.store.history(1)[0]?.status).toBe("refunded");
    expect(await r.service.myBids(CAROL)).toEqual([expect.objectContaining({ state: "refunded" })]);

    const late = await open("call_name");
    await late.service.bid(ALICE, 50);
    late.clock.at = OPENS + DAY;
    await late.service.tick();
    late.clock.at = OPENS + DAY + 72 * HOUR;
    await late.service.tick();
    expect(late.store.history(1)[0]?.status).toBe("refunded");
    expect(late.wallet.balanceOf("p-alice")).toBe(1000);
    expect(late.wallet.rows.some((x) => x.reason === "auction_won")).toBe(false);
  });

  it("finishes a name that stopped after its price was burned, never refunding it late", async () => {
    const r = await open("call_name", { nameSetFails: 1 });
    r.calls.set("p-bob", "小鮑");
    await r.service.bid(BOB, 80);
    r.clock.at = OPENS + DAY;
    await r.service.tick();
    const lot = r.store.history(1)[0];
    // The name was taken and the price burned, then the Core stopped before the name was set.
    await expect(r.service.proposeName(BOB, "鮑大王")).rejects.toThrow();
    // Past the due time, after a restart: the pass finishes it rather than refunding.
    r.clock.at = OPENS + DAY + 72 * HOUR;
    const again = r.restart();
    await again.tick();
    expect(r.store.lot(lot?.id ?? "")).toMatchObject({
      status: "applied",
      call_name: "鮑大王",
      previous_call_name: "小鮑",
    });
    expect(r.calls.get("p-bob")).toBe("鮑大王");
    expect(r.wallet.rows.filter((x) => x.reason === "auction_won")).toHaveLength(1);
    expect(held(r, "p-bob")).toBe(0);
    expect(r.wallet.balanceOf("p-bob")).toBe(920);
    expect(await again.myBids(BOB)).toEqual([expect.objectContaining({ state: "won" })]);
  });

  it("does not let a name that was taken be given up for a refund of nothing", async () => {
    const r = await open("call_name", { nameSetFails: 1 });
    await r.service.bid(BOB, 80);
    r.clock.at = OPENS + DAY;
    await r.service.tick();
    const lot = r.store.history(1)[0];
    await expect(r.service.proposeName(BOB, "鮑大王")).rejects.toThrow();
    // 不要了 now: the price is already burned, so the name is finished instead.
    expect(await r.service.giveUpName(BOB)).toMatchObject({ ok: false, status: 409 });
    expect(r.store.lot(lot?.id ?? "")?.status).toBe("applied");
    expect(r.calls.get("p-bob")).toBe("鮑大王");
    expect(r.wallet.balanceOf("p-bob")).toBe(920);
    // Turning the auction off later refunds nothing either.
    await r.restart({ auction: false }).tick();
    expect(r.wallet.balanceOf("p-bob")).toBe(920);
    expect(r.store.lot(lot?.id ?? "")?.status).toBe("applied");
  });

  it("is called off with every hold given back when the auction is turned off", async () => {
    const r = await open("frame");
    await r.service.bid(ALICE, 50);
    await r.service.bid(BOB, 70);
    const off = r.restart({ auction: false });
    await off.tick();
    expect(r.store.history(1)[0]?.status).toBe("cancelled");
    expect(held(r, "p-alice")).toBe(0);
    expect(held(r, "p-bob")).toBe(0);
    expect(await off.bid(ALICE, 100)).toMatchObject({ ok: false, status: 409 });
    expect(await off.myBids(BOB)).toEqual([expect.objectContaining({ state: "cancelled" })]);
  });

  it("picks up from the rows after a restart: a bid that stopped half way, a lot past its end", async () => {
    const r = await open("frame");
    await r.service.bid(ALICE, 50);
    const lot = r.store.lotsIn(["open"])[0];
    // A bid written and held, never marked leading (Core stopped in between).
    const stopped = { id: "B1", lot: lot?.id ?? "", person: "p-bob", account: BOB, name: "Bob" };
    r.store.addBid({ ...stopped, amount: 80, hold: 80 }, OPENS + HOUR);
    await r.wallet.hold(BOB, 80, "B1", null);
    r.clock.at = OPENS + DAY + HOUR;
    const again = r.restart();
    await again.tick();
    expect(r.store.bid("B1")).toMatchObject({ status: "void" });
    expect(held(r, "p-bob")).toBe(0);
    expect(r.store.history(1)[0]).toMatchObject({ status: "done", price: 50 });
    expect(r.wallet.balanceOf("p-alice")).toBe(950);
  });

  it("ends now when the owner settles it", async () => {
    const r = await open("frame");
    await r.service.bid(ALICE, 50);
    expect(await r.service.settleNow("auction")).toEqual({ ok: true });
    expect(r.store.history(1)[0]).toMatchObject({ status: "done", price: 50 });
    expect(await r.service.settleNow("auction")).toMatchObject({ ok: false, status: 409 });
    expect(r.service.history().lots).toEqual([
      expect.objectContaining({ price: 50, state: "done" }),
    ]);
  });
});

describe("the retire migration", () => {
  it("gives back every hold never released and every ticket of a week not drawn", async () => {
    const r = await rig();
    const db = r.raw.db;
    db.run(`CREATE TABLE economy_ledger (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL,
      person_id TEXT NOT NULL, delta INTEGER NOT NULL, reason TEXT NOT NULL, ref TEXT,
      idem_key TEXT, ts INTEGER NOT NULL)`);
    const HOLD1 = "01JHOLD0000000000000000001";
    const HOLD2 = "01JHOLD0000000000000000002";
    const TIX1 = "01JTIX00000000000000000001";
    const rows: [string, string, number, string, string | null, string][] = [
      // A hold still out, one released, a won lot's burn.
      [HOLD1, "p-alice", -50, "auction_hold", "lot:L", "auction_hold:B1"],
      [HOLD2, "p-bob", -70, "auction_hold", "lot:L", "auction_hold:B2"],
      ["01JREL00000000000000000002", "p-bob", 70, "auction_release", HOLD2, "release:x"],
      ["01JWON00000000000000000003", "p-bob", -70, "auction_won", "frame:L", "auction_won:L"],
      // Tickets of an open week, and of a drawn one.
      [TIX1, "p-carol", -10, "lottery_ticket", "lottery:100:1", "lottery_ticket:T1"],
      ["01JTIX00000000000000000002", "p-carol", -10, "lottery_ticket", null, "lottery_ticket:T2"],
    ];
    for (const [id, person, delta, reason, ref, key] of rows) {
      db.run(
        `INSERT INTO economy_ledger (id, person_id, delta, reason, ref, idem_key, ts)
         VALUES ($id, $person, $delta, $reason, $ref, $key, 1)`,
        { id, person, delta, reason, ref, key },
      );
    }
    r.store.ensureWeek(100, T0 + DAY);
    r.store.ensureWeek(93, T0 - DAY);
    r.store.setWeek(93, ["open"], { status: "drawn" });
    for (const [id, week] of [
      ["T1", 100],
      ["T2", 93],
    ] as const) {
      const carol = { person: "p-carol", account: CAROL, name: "Carol" };
      r.store.addTicket({ id, week, ...carol, key: id, count: 1, amount: 10 }, 20, T0);
      r.store.setTicket(id, "paid", T0);
    }
    // Twice over: what went back once is skipped.
    const [refunds = ""] = retireMarketSql.split("DROP TABLE");
    db.exec(refunds);
    db.exec(retireMarketSql);
    const back = db.all(
      "SELECT person_id, delta, ref FROM economy_ledger WHERE reason = 'refund_removed' ORDER BY person_id",
    );
    const left = "SELECT name FROM sqlite_schema WHERE name LIKE 'market_%' AND type = 'table'";
    expect(db.all(left)).toEqual([]);
    expect(back).toEqual([
      { person_id: "p-alice", delta: 50, ref: HOLD1 },
      { person_id: "p-carol", delta: 10, ref: TIX1 },
    ]);
  });
});
