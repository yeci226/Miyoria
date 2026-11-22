// The market's routes: who may call each, that they go away with the public side's switch, what
// they hand the market (the session's account, the body, a web purchase's key) and how a refusal
// comes back (its status and sentence). The market itself is `packages/play/market/test`.

import { contract, routeMeta } from "@miyoria/contracts/api";
import type { AuctionView, LotteryView, MarketService } from "@miyoria/play/market";
import { MarketKey } from "@miyoria/play/market";
import { PeopleStoreKey } from "@miyoria/store";
import { AuthorizerKey, type Places, PlacesKey, type SpaceRef } from "@miyoria/types";
import type { AnyRouter } from "@orpc/server";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { ApiError } from "../src/errors.js";
import { marketAdminRpc, marketRpc } from "../src/market-routes.js";
import { rpcRoutes, tableRoutes } from "../src/rpc.js";
import type { ApiEnv } from "../src/state.js";

const MEMBER = { platform: "discord", id: "1" };

const AUCTION: AuctionView = {
  currency: "魚幣",
  running: true,
  lot: null,
  next: { opens_at: "2026-11-21T12:00:00.000Z", plan: null },
  mine: null,
  history: [],
};

const LOTTERY: LotteryView = {
  currency: "魚幣",
  running: true,
  price: 10,
  per_person: 20,
  min_buyers: 3,
  prize_share: 0.7,
  week: 20414,
  state: "open",
  draw_at: "2026-11-22T12:00:00.000Z",
  tickets: 4,
  buyers: 2,
  pot: 40,
  mine: { tickets: 1 },
  last: null,
};

function fakeMarket() {
  const calls: unknown[][] = [];
  const market = {
    auctionView: async (a: unknown) => {
      calls.push(["auctionView", a]);
      return AUCTION;
    },
    lotteryView: async (a: unknown) => {
      calls.push(["lotteryView", a]);
      return LOTTERY;
    },
    myBids: async () => [],
    myTickets: async () => [],
    bid: async (a: unknown, amount: number) => {
      calls.push(["bid", a, amount]);
      return amount < 50
        ? { ok: false, status: 409, message: "出價至少要 50" }
        : { ok: true, amount, ends_at: "x", extended: false, balance: 10, again: false };
    },
    buyTickets: async (a: unknown, count: number, key: string) => {
      calls.push(["buy", a, count, key]);
      return { ok: true, count, mine: count, charged: count * 10, balance: 0, again: false };
    },
    proposeName: async (_a: unknown, name: string) => ({
      ok: true,
      call_name: name,
      applied_until: "y",
    }),
    giveUpName: async () => ({ ok: true, refunded: 80 }),
    plan: async (lot: string) =>
      lot === "frame"
        ? { ok: true, week: 1, opens_at: "z", plan: lot }
        : { ok: false, status: 409, message: "這週的拍賣已經開始了" },
    settleNow: async () => ({ ok: true }),
    history: () => ({
      lots: [],
      weeks: [],
      offered: ["frame"],
      next: { opens_at: "z", plan: "frame" },
    }),
  };
  return { market: market as unknown as MarketService, calls };
}

/** Two servers she is in, A (the primary) and B; the member is in A only, unless `inB`. */
function twoSpaces(inB: boolean): Places {
  const space = (id: string, primary: boolean): SpaceRef => ({
    id,
    platform: "discord",
    external_id: `g${id}`,
    name: id,
    primary,
    established: primary,
  });
  const spaces = [space("A", true), space("B", false)];
  return {
    primary: () => spaces[0] ?? null,
    spaces: () => spaces,
    space: (id: string) => spaces.find((s) => s.id === id) ?? null,
    spacesOf: () => (inB ? spaces : [spaces[0] as SpaceRef]),
    isMember: (_p: unknown, id: string) => id === "A" || inB,
  } as unknown as Places;
}

function app(
  market: MarketService | null,
  options: { places?: Places; markets?: Record<string, MarketService> } = {},
) {
  const services = new Map<unknown, unknown>([
    [AuthorizerKey, { allows: () => true }],
    [PeopleStoreKey, { personByAccount: async () => ({ id: "p1" }) }],
  ]);
  if (options.places) services.set(PlacesKey, options.places);
  const markets = {
    of: (space: string | null) =>
      options.markets === undefined ? market : (options.markets[space ?? "A"] ?? null),
  };
  const state = {
    publicSide: { config: { enabled: true }, admitMember: () => null },
    optional: (key: unknown) => services.get(key),
    service: (key: unknown, what: string) => {
      if (key === MarketKey && market !== null) return markets;
      if (key === PlacesKey && options.places) return options.places;
      throw ApiError.unavailable(`${what} is not available`);
    },
  };
  // The market's two groups of the table, as the full router has them.
  const table: AnyRouter = { market: marketRpc, marketAdmin: marketAdminRpc };
  const hono = new Hono<ApiEnv>();
  for (const r of tableRoutes(state as never, table, { responseCheck: "strict" })) {
    hono.on(r.method, r.path, async (c) => {
      if (r.member) c.set("member", { account: MEMBER } as never);
      try {
        return await r.handler(c);
      } catch (error) {
        return error instanceof ApiError
          ? error.toResponse()
          : ApiError.internal(error).toResponse();
      }
    });
  }
  return hono;
}

const json = (body: unknown, headers: Record<string, string> = {}) => ({
  method: "POST",
  body: JSON.stringify(body),
  headers: { "content-type": "application/json", ...headers },
});

describe("the market's routes", () => {
  it("are member routes, limited, and the owner's two changes need a node", () => {
    for (const name of ["auction", "bids", "lottery", "tickets", "bid", "name", "buy"]) {
      expect(routeMeta(contract, ["market", name])).toEqual({
        audience: "member",
        permission: null,
        limited: true,
      });
    }
    expect(routeMeta(contract, ["marketAdmin", "history"])).toEqual({
      audience: "admin",
      permission: null,
    });
    for (const name of ["plan", "settle"]) {
      expect(routeMeta(contract, ["marketAdmin", name])).toMatchObject({
        audience: "admin",
        permission: "admin.economy.adjust",
      });
    }
  });

  it("go away with the public side's switch, the owner's stay", () => {
    const off = { publicSide: { config: { enabled: false } }, optional: () => undefined };
    const paths = rpcRoutes(off as never).map((r) => r.path);
    expect(paths).not.toContain("/api/member/market/auction");
    expect(paths).toContain("/api/market/history");
  });

  it("hand the market the session's account and answer with its views", async () => {
    const { market, calls } = fakeMarket();
    const hono = app(market);
    const auction = await hono.request("/api/member/market/auction");
    expect(auction.status).toBe(200);
    expect(await auction.json()).toEqual(AUCTION);
    expect(await (await hono.request("/api/member/market/lottery")).json()).toEqual(LOTTERY);
    expect(await (await hono.request("/api/member/market/bids")).json()).toEqual({ bids: [] });
    expect(await (await hono.request("/api/member/market/tickets")).json()).toEqual({
      weeks: [],
    });
    expect(calls.slice(0, 2)).toEqual([
      ["auctionView", MEMBER],
      ["lotteryView", MEMBER],
    ]);
  });

  it("bid, buy with the request's key, and name, with a refusal's status and words", async () => {
    const { market, calls } = fakeMarket();
    const hono = app(market);
    const bid = await hono.request("/api/member/market/bid", json({ amount: 60 }));
    expect(await bid.json()).toEqual({ amount: 60, ends_at: "x", extended: false, balance: 10 });
    const low = await hono.request("/api/member/market/bid", json({ amount: 40 }));
    expect(low.status).toBe(409);
    expect(await low.json()).toMatchObject({ error: "出價至少要 50" });
    const buy = await hono.request(
      "/api/member/market/lottery",
      json({ count: 2 }, { "idempotency-key": "abc" }),
    );
    expect(await buy.json()).toEqual({ count: 2, mine: 2, charged: 20, balance: 0 });
    expect(calls.find((c) => c[0] === "buy")).toEqual(["buy", MEMBER, 2, "web:abc"]);
    const name = await hono.request("/api/member/market/name", json({ name: "鮑大王" }));
    expect(await name.json()).toEqual({ call_name: "鮑大王", applied_until: "y", refunded: 0 });
    const gave = await hono.request("/api/member/market/name", json({ give_up: true }));
    expect(await gave.json()).toEqual({ call_name: null, applied_until: null, refunded: 80 });
    expect((await hono.request("/api/member/market/name", json({}))).status).toBe(400);
  });

  it("plan, settle and list for the owner", async () => {
    const { market } = fakeMarket();
    const hono = app(market);
    const plan = await hono.request("/api/market/plan", json({ lot: "frame" }));
    expect(await plan.json()).toEqual({ week: 1, opens_at: "z", plan: "frame" });
    const late = await hono.request("/api/market/plan", json({ lot: "skip" }));
    expect(late.status).toBe(409);
    const settle = await hono.request("/api/market/settle", json({ what: "auction" }));
    expect(await settle.json()).toEqual({ ok: true });
    expect(await (await hono.request("/api/market/history")).json()).toEqual({
      lots: [],
      weeks: [],
      offered: ["frame"],
      next: { opens_at: "z", plan: "frame" },
    });
  });

  it("are about one server's market: the member's own by default, the asked one if theirs", async () => {
    const a = fakeMarket();
    const b = fakeMarket();
    const markets = { A: a.market, B: b.market };
    const hono = app(a.market, { places: twoSpaces(false), markets });
    expect((await hono.request("/api/member/market/auction")).status).toBe(200);
    expect(a.calls).toHaveLength(1);
    const elsewhere = await hono.request("/api/member/market/auction?space=B");
    expect(elsewhere.status).toBe(403);
    expect(await elsewhere.json()).toMatchObject({ error: "你不在這個伺服器裡" });
    expect((await hono.request("/api/member/market/lottery?space=Z")).status).toBe(404);
    expect(b.calls).toEqual([]);
    const member = app(a.market, { places: twoSpaces(true), markets });
    await member.request("/api/member/market/bid?space=B", json({ amount: 60 }));
    expect(b.calls).toEqual([["bid", MEMBER, 60]]);
    // The owner's side: the primary by default, any server she is in when asked.
    await member.request("/api/market/settle?space=B", json({ what: "lottery" }));
    expect((await member.request("/api/market/history?space=Z")).status).toBe(404);
    expect((await member.request("/api/market/history")).status).toBe(200);
  });

  it("is a 503 naming the module without it", async () => {
    const response = await app(null).request("/api/member/market/auction");
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: "market module is not available" });
  });
});
