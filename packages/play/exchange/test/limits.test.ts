// The limits off by default (owner 2026-11-21: "otherwise it is unplayable"): no per-order
// maximum, no daily buy cap, no holding cap, no 2× margin cap and no daily net payout cap, each
// turned back on by a number; what stays (the minimum order, the 10-minute hold, the 2× rules, the
// zero-share refusal, the account requirement, the master switch); the mint report the owner reads
// now that nothing bounds minting; and a long run with the defaults whose books still balance with
// nobody below zero.

import { describe, expect, it } from "vitest";
import { exchangeConfig, rulesOf } from "../src/config.js";
import { limitsFor, sizeRule } from "../src/engine/guards.js";
import { mintReportOf } from "../src/real/desk.js";
import {
  DEFAULT_HOUSE,
  type HouseContext,
  type HouseOutcome,
  netOfLines,
  netOfPostings,
  newHouse,
  onQuote,
  placeRealBuy,
  placeRealSell,
  type RealOrder,
  rollDay,
  splitRealBuy,
} from "../src/real/house.js";
import type { RealInstrument } from "../src/real/instruments.js";
import type { QuoteProvider, RawQuote } from "../src/real/provider.js";
import type { YahooQuote } from "../src/real/yahoo.js";
import { ALICE, BOB, CAROL, MIN, rig } from "./rig.js";

describe("the defaults", () => {
  it("leave every cap on buying and holding off, and keep the rest", () => {
    const c = exchangeConfig();
    expect(c.order_max).toBe(0);
    expect(c.buy_per_day).toBe(0);
    expect(c.limit_total).toBe(0);
    expect(c.leverage_margin_cap).toBe(0);
    expect(c.payout_cap_daily).toBe(0);
    // Kept as they were.
    expect(c.order_min).toBe(10);
    expect(c.min_hold_minutes).toBe(10);
    expect(c.leverage_min_coin_price).toBe(50);
    expect(c.account_min_days).toBe(7);
    expect(c.open).toBe(false);
    expect(c.mint_warn_share).toBe(0.05);
    // 0 stays 0 in the rules (not raised to the minimum), and the holding limit stays none.
    const rules = rulesOf(c, false);
    expect(rules.order_max).toBe(0);
    expect(limitsFor(rules, { tier: 3, known_days: 400 }).total).toBe(0);
    expect(sizeRule(10, 0)).toBe("一筆買進至少 10 魚幣");
    expect(sizeRule(10, 200)).toBe("一筆買進是 10 到 200 魚幣");
    // A number turns a cap back on.
    expect(rulesOf(exchangeConfig({ order_max: 5 }), false).order_max).toBe(10);
    expect(exchangeConfig({ payout_cap_daily: 1500 }).payout_cap_daily).toBe(1500);
  });
});

/** A Yahoo-like provider fed by the test. */
class Scripted implements QuoteProvider {
  readonly id = "yahoo";
  readonly now = new Map<string, YahooQuote>();
  async quotes(symbols: readonly string[]): Promise<Map<string, RawQuote>> {
    return new Map(
      symbols.flatMap((s) => (this.now.has(s) ? [[s, this.now.get(s) as RawQuote]] : [])),
    );
  }
  async describe(symbols: readonly string[]): Promise<Map<string, YahooQuote>> {
    return new Map(
      symbols.flatMap((s) => (this.now.has(s) ? [[s, this.now.get(s) as YahooQuote]] : [])),
    );
  }
  set(symbol: string, price: number, at: number): void {
    this.now.set(symbol, {
      symbol,
      price,
      at,
      prev_close: price,
      currency: "TWD",
      regular: true,
      points: [],
      exchange: "TAI",
      type: "EQUITY",
      name: symbol,
    });
  }
}

/** Monday 2026-11-23 10:00 Taipei. */
const TW_OPEN = Date.UTC(2026, 10, 23, 2, 0);

async function desk(more: Record<string, unknown> = {}) {
  const p = new Scripted();
  const r = await rig({ open: true, leverage: true, ...more } as never, new Map([["yahoo", p]]));
  r.clock.at = TW_OPEN;
  p.set("2330.TW", 2000, TW_OPEN);
  for (const who of [ALICE, BOB]) {
    r.wallet.fund(who, 100_000);
    await r.service.openAccount(who);
  }
  await r.service.real.lookup(ALICE, "2330");
  // The pass lists the local stocks.
  await r.service.tick();
  return { r, p };
}

const buy = (coins: number, leverage = 1) =>
  ({ side: "buy", code: "2330.TW", coins, leverage }) as const;

describe("on the desk", () => {
  it("takes a buy of any size by default, and refuses one past each cap set back on", async () => {
    const { r } = await desk();
    // 50,000 in one order, more than the old 200 an order, 300 a day and 600 held.
    expect(await r.service.real.quote(ALICE, buy(50_000))).toMatchObject({ ok: true });
    expect(await r.service.real.place(ALICE, buy(50_000), "big")).toMatchObject({ ok: true });
    expect(await r.service.real.place(ALICE, buy(20_000), "more")).toMatchObject({ ok: true });
    // Each cap, set to a number, refuses again.
    const cases: [Record<string, number>, number, string][] = [
      [{ order_max: 200 }, 201, "size"],
      [{ buy_per_day: 300 }, 301, "daily"],
      // The holding cap widens with the bond and time known, at most twice.
      [{ limit_total: 600 }, 1201, "limit_total"],
    ];
    for (const [cap, coins, code] of cases) {
      const s = r.restart(cap);
      expect(await s.real.quote(BOB, buy(coins)), JSON.stringify(cap)).toMatchObject({
        ok: false,
        code,
      });
      // Under the cap it goes through.
      expect(await s.real.quote(BOB, buy(100))).toMatchObject({ ok: true });
    }
  });

  it("has no 2× margin cap by default, and one when it is set", async () => {
    const { r } = await desk();
    await r.service.optInLeverage(ALICE, true);
    expect(await r.service.real.quote(ALICE, buy(5_000, 2))).toMatchObject({ ok: true });
    const s = r.restart({ leverage_margin_cap: 150 });
    expect(await s.real.quote(ALICE, buy(5_000, 2))).toMatchObject({
      ok: false,
      code: "margin_cap",
    });
    expect(await s.real.quote(ALICE, buy(100, 2))).toMatchObject({ ok: true });
  });

  it("keeps the rules that stay: the minimum order, no 2× on a local stock, the account, the master switch", async () => {
    const { r } = await desk();
    expect(await r.service.real.quote(ALICE, buy(9))).toMatchObject({ ok: false, code: "size" });
    await r.service.optInLeverage(ALICE, true);
    expect(
      await r.service.real.quote(ALICE, { side: "buy", code: "RICE", coins: 100, leverage: 2 }),
    ).toMatchObject({ ok: false, code: "leverage_local" });
    expect(await r.service.real.quote(CAROL, buy(100))).toMatchObject({ ok: false });
    const closed = r.restart({ open: false });
    expect(await closed.real.quote(ALICE, buy(100))).toMatchObject({ ok: false, code: "closed" });
  });

  it("shows no buy cap left to a member when there is none", async () => {
    const { r } = await desk();
    expect((await r.service.accountView(ALICE))?.today.buy_left).toBeNull();
    const s = r.restart({ buy_per_day: 300 });
    expect((await s.accountView(ALICE))?.today.buy_left).toBe(300);
  });

  it("never halts buys by the net payout by default; a number halts them again", async () => {
    const { r, p } = await desk();
    await r.service.real.place(ALICE, buy(10_000), "a");
    r.clock.at += MIN;
    p.set("2330.TW", 2000, r.clock.at - 1000);
    await r.service.tick();
    r.clock.at += 11 * MIN;
    await r.service.real.place(ALICE, { side: "sell", code: "2330.TW", all: true }, "b");
    r.clock.at += MIN;
    // Up 9%: the sale mints more than was burned.
    p.set("2330.TW", 2180, r.clock.at - 1000);
    await r.service.tick();
    expect(r.service.real.view().house.buys_halted).toBe(false);
    expect(await r.service.real.quote(BOB, buy(100))).toMatchObject({ ok: true });
    const report = await r.service.real.mintReport();
    expect(report.windows[0]?.net).toBeGreaterThan(0);
    expect(report.circulation).toBe(r.wallet.rows.reduce((t, x) => t + x.delta, 0));
  });
});

describe("the mint report", () => {
  it("adds today, 7 and 30 days, sets each against the coins in wallets, and warns past the line", () => {
    const days = [
      { day: 100, burned: 1000, minted: 1500 }, // today: +500
      { day: 99, burned: 0, minted: 2000 }, // +2000
      { day: 94, burned: 300, minted: 0 }, // the 7th day back: -300
      { day: 93, burned: 0, minted: 10_000 }, // outside 7, inside 30
      { day: 70, burned: 0, minted: 99_999 }, // outside 30
      { day: 101, burned: 0, minted: 5 }, // after today (not counted)
    ];
    const r = mintReportOf(days, 100, 40_000, 0.05);
    expect(r.windows.map((w) => [w.days, w.burned, w.minted, w.net])).toEqual([
      [1, 1000, 1500, 500],
      [7, 1300, 3500, 2200],
      [30, 1300, 13_500, 12_200],
    ]);
    expect(r.windows[1]?.share).toBeCloseTo(2200 / 40_000, 9);
    // 5.5% of the coins in wallets in a week, past 5%: a plain warning, nothing halted.
    expect(r.warning).toContain("過去 7 天交易所淨發出 2,200 魚幣");
    expect(r.warning).toContain("5.5%");
    expect(mintReportOf(days, 100, 100_000, 0.05).warning).toBeNull();
    // Without the economy's sum: no share, no warning.
    const none = mintReportOf(days, 100, null, 0.05);
    expect(none.windows[1]?.share).toBeNull();
    expect(none.warning).toBeNull();
    // Net burning never warns.
    expect(
      mintReportOf([{ day: 100, burned: 9_000, minted: 0 }], 100, 1000, 0.01).warning,
    ).toBeNull();
  });
});

describe("a long run with the defaults (no payout cap)", () => {
  const STOCK: RealInstrument = {
    code: "ACME",
    name: "Acme",
    market: "us",
    provider: "yahoo",
    symbol: "ACME",
    enabled: true,
  };

  it("never halts buys, keeps the postings equal to the house's lines, and nobody goes below zero", () => {
    expect(DEFAULT_HOUSE.cap_daily).toBe(0);
    const book = newHouse(0);
    const wallets = new Map([
      ["a", 5000],
      ["b", 5000],
    ]);
    let now = Date.UTC(2026, 10, 23, 15, 0);
    let day = 0;
    let n = 0;
    const all: HouseOutcome[] = [];
    let price = 100;
    let seed = 11;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    const quotes = new Map<string, { code: string; price: number; at: number; prev_close: null }>();
    const ctx = (): HouseContext => ({
      now,
      day,
      params: DEFAULT_HOUSE,
      newId: () => `id${++n}`,
      instruments: [STOCK],
      balance: (p) => wallets.get(p) ?? 0,
      latest: (c) => quotes.get(c) ?? null,
    });
    const apply = (out: HouseOutcome) => {
      all.push(out);
      for (const p of out.postings) {
        const sum = p.entries.reduce((t, e) => t + e.delta, 0);
        const was = wallets.get(p.person) ?? 0;
        if (p.covered && was + sum < 0) throw new Error("a covered posting below zero");
        wallets.set(p.person, was + sum);
      }
      for (const [who, coins] of wallets) expect(coins, who).toBeGreaterThanOrEqual(0);
    };
    for (let i = 0; i < 1500; i++) {
      const who = rnd() < 0.5 ? "a" : "b";
      const r = rnd();
      if (r < 0.25) {
        const coins = 10 + Math.floor(rnd() * 3000);
        const lev = rnd() < 0.3 ? 2 : 1;
        const s = splitRealBuy(coins, lev, DEFAULT_HOUSE);
        if (s && (wallets.get(who) ?? 0) >= s.margin + s.fee) {
          const order: RealOrder = {
            id: `o${++n}`,
            person: who,
            code: "ACME",
            side: "buy",
            limit: null,
            coins: s.margin + s.fee,
            ...s,
            leverage: lev,
            qty: 0,
            position: null,
            placed_at: now,
            expires_at: Number.MAX_SAFE_INTEGER,
          };
          apply(placeRealBuy(book, order));
        }
      } else if (r < 0.35) {
        for (const p of book.positions.filter((x) => x.person === who))
          placeRealSell(book, {
            id: `o${++n}`,
            person: who,
            code: p.code,
            side: "sell",
            limit: null,
            coins: 0,
            margin: 0,
            exposure: 0,
            fee: 0,
            leverage: 1,
            qty: p.qty,
            position: p.leverage > 1 ? p.id : null,
            placed_at: now,
            expires_at: Number.MAX_SAFE_INTEGER,
          });
      }
      // A rising market with dips: the house mints more than it burns.
      price = Math.max(1, price * Math.exp((rnd() - 0.45) * 0.06));
      if (i % 300 === 150) price *= 0.5;
      now += 20 * MIN;
      const q = { code: "ACME", price: Math.round(price * 100) / 100, at: now, prev_close: null };
      quotes.set("ACME", q);
      apply(onQuote(book, STOCK, q, ctx()));
      if (i % 40 === 39) {
        day++;
        apply(rollDay(book, ctx()));
      }
      expect(book.state.today.buys_halted).toBe(false);
    }
    expect(all.some((o) => o.fills.some((f) => f.side === "buy"))).toBe(true);
    expect(all.some((o) => o.fills.some((f) => f.side === "sell"))).toBe(true);
    // The books balance.
    expect(netOfPostings(all.flatMap((o) => o.postings))).toBe(
      netOfLines(all.flatMap((o) => o.lines)),
    );
    const report = mintReportOf([...book.state.history, book.state.today], day, 20_000, 0.05);
    expect(report.windows[2]?.minted).toBeGreaterThan(0);
  });
});
