// The exchange's routes: who may call each, that the member's go away with the public side's
// switch, what they hand the exchange (the session's account, the body, a web order's key), how a
// refusal comes back, and that what a real service answers fits the contract (strict response
// checks over a real store). The exchange itself is `packages/play/exchange/test`.

import { contract, routeMeta } from "@miyoria/contracts/api";
import {
  ExchangeKey,
  ExchangeService,
  ExchangeStore,
  exchangeConfig,
  exchangeSchema,
} from "@miyoria/play/exchange";
import { openTestDb } from "@miyoria/store/testing";
import {
  AuthorizerKey,
  type ExchangeEntry,
  type ExchangeWallet,
  type PersonId,
} from "@miyoria/types";
import type { AnyRouter } from "@orpc/server";
import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import { ApiError } from "../src/errors.js";
import { exchangeAdminRpc, exchangeRpc } from "../src/exchange-routes.js";
import { rpcRoutes, tableRoutes } from "../src/rpc.js";
import type { ApiEnv } from "../src/state.js";

const MEMBER = { platform: "discord", id: "1" };
/** Monday 2026-11-23 11:30 local (UTC+8). */
const T0 = Date.UTC(2026, 10, 23, 3, 30);

class Wallet implements ExchangeWallet {
  readonly currency = "魚幣";
  readonly rows: { person: string; key: string; delta: number }[] = [
    { person: "p1", key: "fund", delta: 1000 },
  ];
  async member() {
    return { person: "p1", name: "小魚乾" };
  }
  async holder() {
    return { person: "p1", name: "小魚乾" };
  }
  async balance(person: PersonId) {
    return this.rows.filter((r) => r.person === person).reduce((t, r) => t + r.delta, 0);
  }
  async transferredIn() {
    return 0;
  }
  async post(person: PersonId, entries: readonly ExchangeEntry[]) {
    const first = entries[0];
    if (first && this.rows.some((r) => r.key === first.key))
      return { ok: true as const, balance: 0, duplicate: true };
    for (const e of entries) this.rows.push({ person, key: e.key, delta: e.delta });
    return { ok: true as const, balance: await this.balance(person), duplicate: false };
  }
  async posted(_person: PersonId, key: string) {
    return this.rows.some((r) => r.key === key);
  }
  async circulation() {
    return this.rows.reduce((t, r) => t + r.delta, 0);
  }
}

const dbs: { close(): void }[] = [];
afterEach(() => {
  for (const d of dbs.splice(0)) d.close();
});

function exchange(open = true) {
  const clock = { at: T0 };
  const raw = openTestDb({
    identity: true,
    plugins: [exchangeSchema],
    clock: { now: () => clock.at },
  });
  dbs.push(raw);
  const wallet = new Wallet();
  const service = new ExchangeService({
    config: exchangeConfig({ open }),
    store: new ExchangeStore(raw.db),
    wallet: () => wallet,
    traders: {
      about: async () => ({ known_days: 30, tier: 1, insider: false, self: false }),
      name: async () => "小魚乾",
    },
    now: () => clock.at,
    log: { warn: () => undefined, info: () => undefined } as never,
    seed: "api-test",
  });
  return { service, wallet, clock };
}

function app(service: ExchangeService | null) {
  const state = {
    publicSide: { config: { enabled: true }, admitMember: () => null },
    optional: (key: unknown) => (key === AuthorizerKey ? { allows: () => true } : undefined),
    service: (key: unknown, what: string) => {
      if (key === ExchangeKey && service !== null) return service;
      throw ApiError.unavailable(`${what} is not available`);
    },
  };
  const table: AnyRouter = { exchange: exchangeRpc, exchangeAdmin: exchangeAdminRpc };
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

/** 12:30 Taipei: the local stocks have their first tick. */
const NOON = Date.UTC(2026, 10, 23, 4, 30);

type Json = Record<string, unknown> & { rows?: { code: string; holders: number | null }[] };
const body = async (r: Response) => (await r.json()) as Json;

describe("the exchange's routes", () => {
  it("are member routes, limited, and the owner's changes need a node", () => {
    for (const name of Object.keys(contract.exchange)) {
      expect(routeMeta(contract, ["exchange", name])).toEqual({
        audience: "member",
        permission: null,
        limited: true,
      });
    }
    expect(routeMeta(contract, ["exchangeAdmin", "view"])).toEqual({
      audience: "admin",
      permission: null,
    });
    for (const name of ["ticker", "name", "split", "settle", "sell"]) {
      expect(routeMeta(contract, ["exchangeAdmin", name])).toMatchObject({
        audience: "admin",
        permission: "admin.economy.adjust",
      });
    }
  });

  it("go away with the public side's switch, the owner's stay", () => {
    const off = { publicSide: { config: { enabled: false } }, optional: () => undefined };
    const paths = rpcRoutes(off as never).map((r) => r.path);
    expect(paths).not.toContain("/api/member/exchange");
    expect(paths).toContain("/api/exchange");
  });

  it("answer with views that fit the contract, open an account, quote, order once per key", async () => {
    const { service, wallet, clock } = exchange();
    clock.at = NOON;
    await service.tick();
    const hono = app(service);
    const market = await body(await hono.request("/api/member/exchange"));
    expect(market).toMatchObject({
      colors: "tw",
      default_list: "local",
      rates: { twd_per_coin: 1, twd_per_usd: 30 },
    });
    expect(String(market.no_dividends)).toContain("不發放股息");
    expect(String(market.no_exchange)).toContain("真錢");
    const list = await body(await hono.request("/api/member/exchange/list/local"));
    expect(list.rows?.map((r) => r.code)).toEqual(["RICE", "WHLE", "NAPS", "CUBE", "DPSK"]);
    expect((await hono.request("/api/member/exchange/ticker/RICE")).status).toBe(200);
    expect((await hono.request("/api/member/exchange/ticker/ZZZZ")).status).toBe(404);
    const suggest = await body(await hono.request("/api/member/exchange/suggest?q=ri"));
    expect((suggest.items as { code: string }[])[0]?.code).toBe("RICE");
    const watch = await hono.request(
      "/api/member/exchange/watch",
      json({ code: "RICE", on: true }),
    );
    expect(await watch.json()).toEqual({ watching: true, count: 1 });
    const account = await hono.request("/api/member/exchange/account", { method: "POST" });
    expect(await account.json()).toMatchObject({ opened: true });
    const quote = await body(
      await hono.request(
        "/api/member/exchange/quote",
        json({ side: "buy", code: "RICE", coins: 101 }),
      ),
    );
    expect(quote).toMatchObject({ coins: 101, fee: 1, margin: 100 });
    const order = () =>
      hono.request(
        "/api/member/exchange/order",
        json({ side: "buy", code: "RICE", coins: 101 }, { "idempotency-key": "abc" }),
      );
    const first = await order();
    expect(first.status).toBe(200);
    const again = await order();
    expect((await body(again)).id).toBe((await body(first)).id);
    expect(wallet.rows.filter((r) => r.key.startsWith("exchange:order:"))).toHaveLength(2);
    clock.at = NOON + 31 * 60_000;
    await service.tick();
    const port = await body(await hono.request("/api/member/exchange/portfolio"));
    expect((port.holdings as unknown[]).length).toBe(1);
    const popular = await body(await hono.request("/api/member/exchange/list/popular"));
    expect(popular.rows?.[0]).toMatchObject({ code: "RICE", holders: 1 });
    expect(JSON.stringify(popular)).not.toContain("小魚乾");
    expect((await hono.request("/api/member/exchange/boards")).status).toBe(200);
    const hide = await hono.request("/api/member/exchange/visibility", json({ hide_boards: true }));
    expect(await hide.json()).toMatchObject({ hide_boards: true });
    const admin = await body(await hono.request("/api/exchange"));
    expect((admin.positions as unknown[]).length).toBe(1);
    expect(
      (admin.tickers as { code: string; holders: number }[]).find((t) => t.code === "RICE"),
    ).toMatchObject({ holders: 1 });
    // The owner's name for a ticker: shown everywhere, audited; null goes back to the default.
    const named = await hono.request("/api/exchange/name", json({ code: "RICE", name: "白飯" }));
    expect(await named.json()).toEqual({ name: "白飯" });
    const line = await body(await hono.request("/api/member/exchange/ticker/RICE"));
    expect((line.line as { name: string }).name).toBe("白飯");
    const back = await hono.request("/api/exchange/name", json({ code: "RICE", name: null }));
    expect(await back.json()).toEqual({ name: "白飯食品" });
    // The mint report: today's burn of the buy, against the coins in wallets.
    const mint = (
      admin.report as {
        mint: { windows: { days: number; burned: number }[]; circulation: number | null };
      }
    ).mint;
    expect(mint.windows.map((w) => w.days)).toEqual([1, 7, 30]);
    expect(mint.windows[0]?.burned).toBeGreaterThanOrEqual(100);
    expect(mint.circulation).toBe(wallet.rows.reduce((t, r) => t + r.delta, 0));
  });

  it("answer a ticker's candles with the member's own lines, and the heat maps with no one in them", async () => {
    const { service, clock } = exchange();
    clock.at = NOON;
    await service.tick();
    const hono = app(service);
    await hono.request("/api/member/exchange/account", { method: "POST" });
    await hono.request(
      "/api/member/exchange/order",
      json({ side: "buy", code: "RICE", coins: 101 }, { "idempotency-key": "k" }),
    );
    clock.at = NOON + 31 * 60_000;
    await service.tick();
    clock.at = NOON + 2 * 3_600_000;
    await service.tick();
    const day = await body(await hono.request("/api/member/exchange/candles/RICE?tf=intraday"));
    expect(day).toMatchObject({
      code: "RICE",
      tf: "intraday",
      currency: "COIN",
      volume: false,
      source: "ticks",
    });
    const bars = day.candles as { t: number; o: number; c: number; v: number | null }[];
    expect(bars.length).toBeGreaterThanOrEqual(2);
    expect(bars.every((b) => b.v === null)).toBe(true);
    // Their average cost on their own chart.
    expect((day.marks as { avg_cost: number | null }).avg_cost).toBeGreaterThan(0);
    // Daily by default; a bad timeframe is refused.
    expect((await body(await hono.request("/api/member/exchange/candles/RICE"))).tf).toBe("daily");
    expect((await hono.request("/api/member/exchange/candles/RICE?tf=hourly")).status).toBe(400);
    expect((await hono.request("/api/member/exchange/candles/ZZZZ")).status).toBe(404);
    // One person holds RICE: it is not drawn, and nothing names them.
    const held = await body(await hono.request("/api/member/exchange/map/holdings"));
    expect(held).toMatchObject({ kind: "holdings", title: "伺服器持股圖", tiles: [], hidden: 1 });
    expect(JSON.stringify(held)).not.toContain("小魚乾");
    const tw = await body(await hono.request("/api/member/exchange/map/tw"));
    expect(tw).toMatchObject({
      kind: "tw",
      footnote: "格子大小為預設權重,非即時市值;單一格最多占整張圖的 35%,超過的縮到這個大小",
      max_share: 0.35,
    });
    expect((await hono.request("/api/member/exchange/map/nope")).status).toBe(400);
  });

  it("bring a refusal back as its status and sentence", async () => {
    const { service, clock } = exchange();
    clock.at = NOON;
    await service.tick();
    const hono = app(service);
    const no = await hono.request(
      "/api/member/exchange/order",
      json({ side: "buy", code: "RICE", coins: 100 }),
    );
    expect(no.status).toBe(409);
    expect(await no.json()).toMatchObject({ error: "還沒開戶" });
    await hono.request("/api/member/exchange/account", { method: "POST" });
    const lev = await hono.request(
      "/api/member/exchange/order",
      json({ side: "buy", code: "RICE", coins: 100, leverage: 2 }),
    );
    expect(lev.status).toBe(409);
    expect(await lev.json()).toMatchObject({ error: "新手推薦的獨家股票不開放槓桿,只能 1 倍" });
    const optOut = await hono.request("/api/member/exchange/leverage", json({ accept: false }));
    expect(optOut.status).toBe(400);
    const remove = await hono.request(
      "/api/exchange/ticker",
      json({ code: "ZZZZ", action: "block" }),
    );
    expect(remove.status).toBe(404);
  });

  it("is a 503 naming the module without it", async () => {
    const response = await app(null).request("/api/member/exchange");
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: "exchange module is not available" });
  });
});
