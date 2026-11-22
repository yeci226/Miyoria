// The market per Space (phase 6): migration 3 gives the rows of the one server they all came from
// to it (a lot by its channel's room) and copies the lottery's weeks into the draws per Space,
// leaving the old table as it was; two Spaces then run their own auctions and lotteries at their
// own times, a lot and a draw of the same week in each; a server nobody set up runs nothing; rows
// of before there was any Space go to the primary once there is one.

import { DatabaseSync } from "node:sqlite";
import type { CommandReply } from "@miyoria/commands";
import { Db, EventStore, Identity, identitySchema, migrate, SpacePlaces } from "@miyoria/store";
import type { ContextKey, PlaceConfig, SpaceRef } from "@miyoria/types";
import { describe, expect, it } from "vitest";
import { type MarketConfig, marketConfig } from "../src/config.js";
import { MarketRegistry } from "../src/markets.js";
import { marketSchema } from "../src/migrations.js";
import { MarketStore } from "../src/store.js";
import { ALICE, BOB, CAROL, type FakeWallet, HER, HOUR, rig, T0 } from "./rig.js";

const ctx = (scope: string, channel: string): ContextKey => ({
  platform: "discord",
  scope,
  channel,
  kind: "channel",
});
const author = (id: string) => ({ account: { platform: "discord", id }, display_name: id });

const A_CHANNEL = "100000000000000001";
const B_CHANNEL = "200000000000000002";

describe("migration 3", () => {
  it("gives every row of before it the original server and leaves the old weeks as they were", () => {
    let now = T0;
    const raw = new DatabaseSync(":memory:");
    const db = new Db(raw, { now: () => now++ });
    try {
      const before = { ...marketSchema, migrations: marketSchema.migrations.slice(0, 2) };
      migrate(db, [identitySchema, before]);
      const identity = new Identity(db);
      // The original server (the primary: the first Space seen), and a second one with a channel.
      const a = identity.resolve(ctx("gA", A_CHANNEL), author("1"));
      identity.resolve(ctx("gA", "100000000000000009"), author("2"));
      const b = identity.resolve(ctx("gB", B_CHANNEL), author("3"));
      const A = a.space_id as string;
      const B = b.space_id as string;
      expect(A).not.toBe(B);
      const lot = (id: string, week: number, status: string, channel: string | null) =>
        db.run(
          `INSERT INTO market_lots (id, week, kind, status, picked_by, opens_at, ends_at, channel,
             created_at) VALUES ($id, $week, 'frame', $status, 'rotation', 1, 2, $channel, 1)`,
          { id, week, status, channel },
        );
      lot("l1", 20400, "done", A_CHANNEL);
      lot("l2", 20407, "open", B_CHANNEL);
      lot("l3", 20414, "planned", null);
      for (const [id, week] of [
        ["t1", 20401],
        ["t2", 20408],
      ] as const) {
        db.run(
          `INSERT INTO market_lottery_tickets (id, week, person_id, platform, account_id, name,
             purchase_key, count, amount, status, created_at)
           VALUES ($id, $week, 'p-alice', 'discord', '1', 'Alice', $id, 2, 20, 'paid', 1)`,
          { id, week },
        );
      }
      db.run(
        `INSERT INTO market_song_tickets (key, person_id, platform, account_id, amount, status, created_at)
         VALUES ('song:1', 'p-alice', 'discord', '1', 40, 'charged', 1)`,
      );
      db.run(
        `INSERT INTO market_lottery_weeks (week, status, draw_at, tickets, buyers, pot, prize, burned,
           winner_person, winner_platform, winner_account_id, winner_name, winner_tickets, pick,
           drawn_at, paid_at, announced_at)
         VALUES (20401, 'drawn', 5, 6, 3, 60, 42, 18, 'p-alice', 'discord', '1', 'Alice', 2, 1, 6, 6, 7)`,
      );
      db.run(
        "INSERT INTO market_lottery_weeks (week, status, draw_at, notice_at) VALUES (20408, 'open', 9, 8)",
      );
      const weeks = () => db.all("SELECT * FROM market_lottery_weeks ORDER BY week");
      const oldWeeks = weeks();
      const counts = () =>
        [
          "market_lots",
          "market_lottery_tickets",
          "market_song_tickets",
          "market_lottery_weeks",
        ].map((t) => Number(db.get(`SELECT COUNT(*) AS n FROM ${t}`)?.n));
      const oldCounts = counts();

      migrate(db, [identitySchema, marketSchema]);

      expect(counts()).toEqual(oldCounts);
      expect(weeks()).toEqual(oldWeeks);
      const spaceOf = (table: string, key: string, id: string) =>
        db.get(`SELECT space_id FROM ${table} WHERE ${key} = $id`, { id })?.space_id;
      // A lot by its channel's room; one without a channel, the tickets: the primary.
      expect(spaceOf("market_lots", "id", "l1")).toBe(A);
      expect(spaceOf("market_lots", "id", "l2")).toBe(B);
      expect(spaceOf("market_lots", "id", "l3")).toBe(A);
      expect(spaceOf("market_lottery_tickets", "id", "t1")).toBe(A);
      expect(spaceOf("market_song_tickets", "key", "song:1")).toBe(A);
      const draws = db.all("SELECT * FROM market_lottery_draws ORDER BY week");
      expect(draws).toEqual(oldWeeks.map((w) => ({ space_id: A, ...w })));

      // The original server's views find what it had; the second server finds only its lot.
      const store = new MarketStore(db, new EventStore(db, { identity }));
      const mine = store.forSpace(A);
      expect(mine.history(10).map((l) => l.id)).toEqual(["l1"]);
      expect(mine.lotOfWeek(20414)?.id).toBe("l3");
      expect(mine.week(20401)).toMatchObject({ status: "drawn", prize: 42 });
      expect(mine.tickets(20408).map((t) => t.id)).toEqual(["t2"]);
      expect(
        store
          .forSpace(B)
          .lotsIn(["open"])
          .map((l) => l.id),
      ).toEqual(["l2"]);
      expect(store.forSpace(B).week(20401)).toBeNull();
      // A week is a week per Space now.
      const other = store.forSpace(B).ensureWeek(20401, 99);
      expect(other).toMatchObject({ status: "open", tickets: 0 });
      expect(mine.week(20401)?.status).toBe("drawn");
      expect(weeks()).toEqual(oldWeeks);
    } finally {
      db.close();
    }
  });

  it("keeps the rows of a database with no Space for the first one", async () => {
    const r = await rig();
    const store = r.store;
    store.putLot({
      id: "early",
      week: 1,
      kind: "frame",
      status: "planned",
      picked_by: "owner",
      opens_at: T0,
      ends_at: T0 + HOUR,
      channel: null,
      note: null,
      now: T0,
    });
    store.ensureWeek(2, T0);
    const identity = r.raw.identity as Identity;
    const places = new SpacePlaces(r.raw.db, identity);
    const A = places.seen("discord", "gA", "A");
    expect(store.adopt(A)).toBe(2);
    expect(store.forSpace(A).lotOfWeek(1)?.id).toBe("early");
    expect(store.forSpace(A).week(2)).not.toBeNull();
    expect(store.adopt(A)).toBe(0);
  });
});

/** Two servers she is in, each with its own market, and a third nobody set up. */
async function twoSpaces() {
  const r = await rig();
  const identity = r.raw.identity as Identity;
  const places = new SpacePlaces(r.raw.db, identity);
  const A = identity.resolve(ctx("gA", A_CHANNEL), author("1")).space_id as string;
  const B = identity.resolve(ctx("gB", B_CHANNEL), author("2")).space_id as string;
  const C = identity.resolve(ctx("gC", "300000000000000003"), author("3")).space_id as string;
  // A: Saturday 20:00 and Sunday 20:00 at UTC+8 (12:00 UTC). B: the same days at 21:00 UTC.
  const configs = new Map<string, MarketConfig>([
    [A, marketConfig({ auction_channel: A_CHANNEL, lottery_min_buyers: 1 })],
    [
      B,
      marketConfig({
        auction_channel: B_CHANNEL,
        auction_time: "21:00",
        lottery_time: "21:00",
        utc_offset_minutes: 0,
        lottery_min_buyers: 1,
      }),
    ],
    // C: the cluster's values with its channels dropped (they are in A).
    [C, marketConfig({ lottery_min_buyers: 1 })],
  ]);
  const base = configs.get(A) as MarketConfig;
  const config: PlaceConfig<MarketConfig> = {
    base: () => base,
    for: (where) => {
      const space =
        where !== null && where !== undefined && "space_id" in where ? where.space_id : null;
      return configs.get(space ?? "") ?? base;
    },
    onChange: () => () => undefined,
  };
  const posted: { space: SpaceRef | null; channel: string; reply: CommandReply }[] = [];
  let n = 0;
  const markets = new MarketRegistry({
    shared: {
      wallet: () => r.wallet,
      now: () => r.clock.at,
      isSelf: (a) => a.id === HER.id,
      names: null,
      screenName: async () => null,
      picker: null,
      tell: () => undefined,
      log: { info: () => undefined, warn: () => undefined },
      randomInt: () => 0,
    },
    store: r.store,
    config,
    places,
    post: async (space, channel, reply) => {
      posted.push({ space, channel, reply: reply as CommandReply });
      return `m${++n}`;
    },
  });
  return { r, places, markets, posted, A, B, C };
}

describe("two Spaces", () => {
  it("run their own auctions and lotteries at their own times, and a third runs nothing", async () => {
    const { r, markets, posted, A, B, C } = await twoSpaces();
    const wallet: FakeWallet = r.wallet;
    for (const who of [ALICE, BOB, CAROL]) wallet.fund(who, 1000);

    // Tuesday: each set-up server gets its week's lottery notice in its own channel.
    await markets.tick();
    expect(posted.map((p) => [p.space?.external_id, p.channel])).toEqual([
      ["gA", A_CHANNEL],
      ["gB", B_CHANNEL],
    ]);
    const a = markets.of(A);
    const b = markets.of(B);
    const c = markets.of(C);
    if (a === null || b === null || c === null) throw new Error("no market");
    expect(markets.of(null)).toBe(a);
    expect(markets.at(ctx("gB", B_CHANNEL))).toBe(b);
    expect(markets.at({ platform: "discord", scope: null, channel: "dm", kind: "dm" })).toBe(a);

    // Tickets are each server's own; the third sells none.
    expect(await a.buyTickets(ALICE, 2, "k1")).toMatchObject({ ok: true, mine: 2 });
    expect(await b.buyTickets(ALICE, 3, "k2")).toMatchObject({ ok: true, mine: 3 });
    expect(await c.buyTickets(ALICE, 1, "k3")).toMatchObject({ ok: false, status: 409 });
    expect((await a.lotteryView(ALICE)).mine).toEqual({ tickets: 2 });
    expect((await b.lotteryView(ALICE)).pot).toBe(30);
    expect((await c.lotteryView(null)).running).toBe(false);

    // Saturday 12:00 UTC: A's lot opens; B's (21:00 UTC) has not.
    r.clock.at = Date.UTC(2026, 10, 21, 12, 0, 0);
    await markets.tick();
    expect((await a.auctionView(null)).lot?.state).toBe("open");
    expect(await b.bid(BOB, 50)).toMatchObject({ ok: false, status: 409 });
    expect(await a.bid(BOB, 50)).toMatchObject({ ok: true, amount: 50 });

    // 21:00 UTC: B's lot opens, the same local day number as A's.
    r.clock.at = Date.UTC(2026, 10, 21, 21, 0, 0);
    await markets.tick();
    const lots = r.raw.db.all("SELECT space_id, week, status FROM market_lots ORDER BY space_id");
    expect(lots).toHaveLength(2);
    expect(new Set(lots.map((l) => l.week)).size).toBe(1);
    expect(new Set(lots.map((l) => l.space_id))).toEqual(new Set([A, B]));
    expect(await b.bid(CAROL, 60)).toMatchObject({ ok: true });
    expect((await a.auctionView(null)).lot?.top).toEqual({ amount: 50, name: "Bob" });
    expect((await b.auctionView(null)).lot?.top).toEqual({ amount: 60, name: "Carol" });

    // Sunday 12:00 UTC: A's lot has ended and A's lottery is drawn; B's lottery is not yet.
    r.clock.at = Date.UTC(2026, 10, 22, 12, 0, 0);
    await markets.tick();
    expect((await a.lotteryView(null)).last).toMatchObject({ state: "drawn", tickets: 2 });
    expect((await b.lotteryView(null)).last).toBeNull();
    expect((await a.auctionView(null)).lot?.winner).toEqual({ name: "Bob", price: 50 });
    expect((await b.auctionView(null)).lot?.state).toBe("open");
    r.clock.at = Date.UTC(2026, 10, 22, 21, 0, 0);
    await markets.tick();
    expect((await b.lotteryView(null)).last).toMatchObject({ state: "drawn", tickets: 3, pot: 30 });
    expect((await b.auctionView(null)).lot?.winner).toEqual({ name: "Carol", price: 60 });
    // Every notice went to its own server; nothing was written for the third.
    expect(posted.every((p) => (p.space?.id === A) === (p.channel === A_CHANNEL))).toBe(true);
    expect(r.raw.db.all("SELECT * FROM market_lots WHERE space_id = $c", { c: C })).toEqual([]);
    expect(
      r.raw.db.all("SELECT * FROM market_lottery_draws WHERE space_id = $c", { c: C }),
    ).toEqual([]);
  });

  it("settles what was open in a server she left, with every hold given back", async () => {
    const { r, places, markets, A, B } = await twoSpaces();
    r.wallet.fund(BOB, 500);
    r.clock.at = Date.UTC(2026, 10, 21, 21, 0, 0);
    await markets.tick();
    const b = markets.of(B);
    expect(await b?.bid(BOB, 70)).toMatchObject({ ok: true });
    expect(await b?.buyTickets(BOB, 2, "kb")).toMatchObject({ ok: true });
    expect(r.wallet.balanceOf("p-bob")).toBe(500 - 70 - 20);
    places.left("discord", "gB");
    await markets.tick();
    expect(markets.of(B)).toBeNull();
    expect(r.wallet.balanceOf("p-bob")).toBe(500);
    const lot = r.raw.db.get("SELECT status FROM market_lots WHERE space_id = $b", { b: B });
    expect(lot?.status).toBe("cancelled");
    // A goes on as before.
    expect(markets.of(A)?.auctionRunning()).toBe(true);
  });
});
