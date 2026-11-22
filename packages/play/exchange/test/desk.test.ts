// v1 of the exchange end to end over a real store: Yahoo's responses as saved fixtures (never the
// network), the open universe (lookups, validation, the negative cache, the per-person limit, the
// block list), market hours (an order placed while closed fills at the open; DST; a holiday), quotes
// that are stale or absurd never filling, a split pausing the ticker, a ticker suspended after days
// without a quote, fixed rates (TWD and USD, a rate change re-values everyone), round trips that
// create no coin besides the fee, 2x eligibility, and a bankruptcy that leaves her bond untouched.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { candidates, splitRatio } from "../src/real/desk.js";
import { DEFAULT_SESSIONS, isOpenAt, toCoins } from "../src/real/instruments.js";
import type { QuoteProvider, RawQuote } from "../src/real/provider.js";
import { parseChart, parseSpark, YahooProvider, type YahooQuote } from "../src/real/yahoo.js";
import { ALICE, BOB, INFO, MIN, rig } from "./rig.js";

const fixture = (name: string) =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8")) as unknown;
const chart = (s: string) =>
  (fixture(`yahoo-chart-${s}.json`) as { chart: { result: unknown[] } }).chart.result[0];

describe("Yahoo's responses (saved fixtures)", () => {
  it("read a Taiwan listed, a TPEx and a US stock: price, time, currency, exchange, type, previous close, the day's points", () => {
    const tw = parseChart("2330.TW", chart("2330.TW")) as YahooQuote;
    expect(tw).toMatchObject({ currency: "TWD", exchange: "TAI", type: "EQUITY", regular: true });
    expect(tw.price).toBeGreaterThan(0);
    expect(tw.prev_close).toBeGreaterThan(0);
    expect(tw.points.length).toBeGreaterThan(5);
    expect(parseChart("6488.TWO", chart("6488.TWO"))).toMatchObject({
      currency: "TWD",
      exchange: "TWO",
    });
    expect(parseChart("AAPL", chart("AAPL"))).toMatchObject({
      currency: "USD",
      exchange: "NMS",
      type: "EQUITY",
    });
    const spark = parseSpark(fixture("yahoo-spark.json"));
    expect([...spark.keys()].sort()).toEqual(["2330.TW", "6488.TWO", "AAPL"]);
  });

  it("refuse what does not parse and a quote outside the regular session", () => {
    expect(parseChart("X", { meta: { regularMarketPrice: "12" } })).toBeNull();
    expect(() => parseSpark({ nope: 1 })).toThrow();
    const r = chart("AAPL") as { meta: Record<string, unknown> };
    const pre = {
      ...r,
      meta: {
        ...r.meta,
        regularMarketTime:
          (r.meta.currentTradingPeriod as { regular: { start: number } }).regular.start - 3600,
      },
    };
    expect(parseChart("AAPL", pre)?.regular).toBe(false);
  });

  it("make one batched request with a generic browser agent and nothing else, back off on 429, and keep a daily budget", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    let status = 200;
    const fetch = async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(status === 200 ? JSON.stringify(fixture("yahoo-spark.json")) : "busy", {
        status,
      });
    };
    const y = new YahooProvider(
      {
        host: "query1.finance.yahoo.com",
        daily_budget: 2,
        timeout_ms: 1000,
        max_backoff_seconds: 60,
      },
      fetch,
    );
    const now = Date.UTC(2026, 10, 20, 5, 0);
    const all = await y.describe(["2330.TW", "6488.TWO", "AAPL"], now);
    expect(all.size).toBe(3);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(
      "https://query1.finance.yahoo.com/v7/finance/spark?symbols=2330.TW,6488.TWO,AAPL&range=1d&interval=5m",
    );
    expect(Object.keys(calls[0]?.init.headers as object).sort()).toEqual(["accept", "user-agent"]);
    expect(calls[0]?.init.redirect).toBe("error");
    status = 429;
    await expect(y.describe(["AAPL"], now + 1000)).rejects.toThrow("429");
    await expect(y.describe(["AAPL"], now + 2000)).rejects.toThrow("backing off");
    status = 200;
    await expect(y.describe(["AAPL"], now + 3_600_000)).rejects.toThrow("budget");
    expect(calls).toHaveLength(2);
  });
});

describe("hours, symbols, rates", () => {
  it("open the US session at 09:30 New York time in winter and summer, Taiwan at 09:00 Taipei", () => {
    expect(isOpenAt(DEFAULT_SESSIONS.us, Date.UTC(2026, 0, 5, 14, 30))).toBe(true); // EST
    expect(isOpenAt(DEFAULT_SESSIONS.us, Date.UTC(2026, 0, 5, 13, 30))).toBe(false);
    expect(isOpenAt(DEFAULT_SESSIONS.us, Date.UTC(2026, 6, 6, 13, 30))).toBe(true); // EDT
    expect(isOpenAt(DEFAULT_SESSIONS.tw, Date.UTC(2026, 10, 23, 1, 0))).toBe(true);
    expect(
      isOpenAt({ ...DEFAULT_SESSIONS.tw, holidays: ["2026-11-23"] }, Date.UTC(2026, 10, 23, 1, 0)),
    ).toBe(false);
  });

  it("map what people type to Yahoo's symbols and see a split's ratio", () => {
    expect(candidates("2330")).toEqual(["2330.TW", "2330.TWO"]);
    expect(candidates("aapl")).toEqual(["AAPL"]);
    expect(candidates("brk.b")).toEqual(["BRK-B"]);
    expect(candidates("..")).toEqual([]);
    expect(splitRatio(100, 25.2)).toMatchObject({ ratio: 4 });
    expect(splitRatio(10, 99.5)).toMatchObject({ ratio: 0.1 });
    expect(splitRatio(100, 63)).toBeNull();
  });

  it("turn TWD and USD into coins at the fixed rates", () => {
    // The default: one coin is NT$1.
    const r = { twd_per_coin: 1, twd_per_usd: 30 };
    expect(toCoins(2000, "tw", r)).toBe(2000);
    expect(toCoins(342.56, "us", r)).toBeCloseTo(10_276.8);
    expect(toCoins(120, "local", r)).toBe(120);
    expect(toCoins(2000, "tw", { twd_per_coin: 2, twd_per_usd: 30 })).toBe(1000);
  });
});

/** A provider fed by the test: what each symbol's quote is now (Yahoo-like, with what it describes). */
class Scripted implements QuoteProvider {
  readonly id = "yahoo";
  readonly quotesNow = new Map<string, YahooQuote>();
  describeCalls = 0;
  down = false;
  async quotes(symbols: readonly string[]): Promise<Map<string, RawQuote>> {
    if (this.down) throw new Error("down");
    return new Map(
      symbols.flatMap((s) =>
        this.quotesNow.has(s) ? [[s, this.quotesNow.get(s) as RawQuote]] : [],
      ),
    );
  }
  async describe(symbols: readonly string[]): Promise<Map<string, YahooQuote>> {
    this.describeCalls++;
    return new Map(
      symbols.flatMap((s) =>
        this.quotesNow.has(s) ? [[s, this.quotesNow.get(s) as YahooQuote]] : [],
      ),
    );
  }
  set(symbol: string, price: number, at: number, more: Partial<YahooQuote> = {}): void {
    const tw = symbol.endsWith(".TW") || symbol.endsWith(".TWO");
    this.quotesNow.set(symbol, {
      symbol,
      price,
      at,
      prev_close: price,
      currency: tw ? "TWD" : "USD",
      regular: true,
      points: [],
      exchange: tw ? "TAI" : "NMS",
      type: "EQUITY",
      name: symbol,
      ...more,
    });
  }
}

/** Monday 2026-11-23 10:00 Taipei. */
const TW_OPEN = Date.UTC(2026, 10, 23, 2, 0);

async function desk(more: Record<string, unknown> = {}) {
  const p = new Scripted();
  const r = await rig({ open: true, leverage: true, ...more } as never, new Map([["yahoo", p]]));
  for (const who of [ALICE, BOB]) {
    r.wallet.fund(who, 1000);
    await r.service.openAccount(who);
  }
  return { r, p };
}

describe("v1 trading", () => {
  it("validates a ticker once, refuses other types and exchanges, caches junk and limits lookups", async () => {
    const { r, p } = await desk({ lookups_per_hour: 3 });
    r.clock.at = TW_OPEN;
    p.set("2330.TW", 2000, TW_OPEN);
    expect(await r.service.real.lookup(ALICE, "2330")).toMatchObject({
      ok: true,
      instrument: { code: "2330.TW", currency: "TWD", coin_price: 2000 },
    });
    p.set("TSLA", 300, TW_OPEN, { type: "OPTION" });
    expect(await r.service.real.lookup(ALICE, "tsla")).toMatchObject({
      ok: false,
      code: "unknown",
    });
    p.set("QQQQ", 5, TW_OPEN, { exchange: "PNK" });
    expect(await r.service.real.lookup(ALICE, "QQQQ")).toMatchObject({ ok: false });
    const calls = p.describeCalls;
    expect(await r.service.real.lookup(ALICE, "QQQQ")).toMatchObject({ ok: false });
    expect(p.describeCalls).toBe(calls);
    expect(await r.service.real.lookup(ALICE, "ZZZZ")).toMatchObject({
      ok: false,
      code: "lookups",
    });
    // A stored ticker needs no lookup.
    expect(await r.service.real.lookup(ALICE, "2330.TW")).toMatchObject({ ok: true });
  });

  it("fills an order placed while the market is closed at the first valid quote after the open", async () => {
    const { r, p } = await desk();
    r.clock.at = TW_OPEN;
    p.set("2330.TW", 2000, TW_OPEN);
    await r.service.real.lookup(ALICE, "2330");
    r.clock.at = Date.UTC(2026, 10, 23, 7, 0); // 15:00 Taipei, closed
    const placed = await r.service.real.place(
      ALICE,
      { side: "buy", code: "2330.TW", coins: 101 },
      "k1",
    );
    expect(placed).toMatchObject({ ok: true });
    await r.service.tick();
    expect(r.store.real.openPositions("p-alice")).toHaveLength(0);
    r.clock.at = Date.UTC(2026, 10, 24, 1, 1); // the next morning 09:01
    p.set("2330.TW", 2010, r.clock.at - 30_000);
    await r.service.tick();
    const pos = r.store.real.openPositions("p-alice");
    expect(pos).toHaveLength(1);
    expect(r.wallet.balanceOf("p-alice")).toBe(1000 - 101);
  });

  it("never fills on a stale quote, and a round trip creates no coin besides the fee", async () => {
    const { r, p } = await desk();
    r.clock.at = TW_OPEN;
    p.set("2330.TW", 2000, TW_OPEN);
    await r.service.real.lookup(ALICE, "2330");
    await r.service.real.place(ALICE, { side: "buy", code: "2330.TW", coins: 101 }, "k1");
    // A quote 20 minutes old is stale: nothing fills.
    r.clock.at = TW_OPEN + 25 * MIN;
    p.set("2330.TW", 2000, TW_OPEN + 1 * MIN);
    await r.service.tick();
    expect(r.store.real.openPositions("p-alice")).toHaveLength(0);
    p.set("2330.TW", 2000, r.clock.at - MIN);
    await r.service.tick();
    expect(r.store.real.openPositions("p-alice")).toHaveLength(1);
    r.clock.at += 11 * MIN;
    const sell = await r.service.real.place(
      ALICE,
      { side: "sell", code: "2330.TW", all: true },
      "k2",
    );
    expect(sell).toMatchObject({ ok: true });
    r.clock.at += MIN;
    p.set("2330.TW", 2000, r.clock.at - 10_000);
    await r.service.tick();
    // 101 in: margin 100 + fee 1; out: 100 back less a fee of 1. Only fees burned.
    expect(r.wallet.balanceOf("p-alice")).toBe(1000 - 1 - 1);
    const report = r.service.real.report();
    expect(report.books.postings).toBe(report.books.lines);
  });

  it("pauses a ticker on a split-like jump instead of filling or selling, and the owner's confirmation adjusts shares", async () => {
    const { r, p } = await desk();
    r.clock.at = TW_OPEN;
    p.set("2330.TW", 2000, TW_OPEN);
    await r.service.real.lookup(ALICE, "2330");
    await r.service.real.place(ALICE, { side: "buy", code: "2330.TW", coins: 101 }, "k1");
    r.clock.at += MIN;
    p.set("2330.TW", 2000, r.clock.at - 10_000);
    await r.service.tick();
    const qty = r.store.real.openPositions("p-alice")[0]?.qty ?? 0;
    r.clock.at += MIN;
    p.set("2330.TW", 500.4, r.clock.at - 10_000);
    await r.service.tick();
    expect(r.store.real.instrument("2330.TW")?.status).toBe("paused");
    expect(
      await r.service.real.place(BOB, { side: "buy", code: "2330.TW", coins: 50 }, "k3"),
    ).toMatchObject({ code: "paused" });
    expect(r.service.real.confirmSplit("2330.TW", 4)).toMatchObject({ ok: true, positions: 1 });
    expect(r.store.real.openPositions("p-alice")[0]?.qty).toBe(qty * 4);
  });

  it("re-values every holding the same way when a fixed rate changes", async () => {
    const { r, p } = await desk();
    r.clock.at = TW_OPEN;
    p.set("2330.TW", 2000, TW_OPEN);
    await r.service.real.lookup(ALICE, "2330");
    await r.service.real.place(ALICE, { side: "buy", code: "2330.TW", coins: 101 }, "k1");
    r.clock.at += MIN;
    p.set("2330.TW", 2000, r.clock.at - 10_000);
    await r.service.tick();
    const before = r.service.real.portfolio("p-alice").holdings[0]?.value ?? 0;
    // The owner doubles NT$ per coin: every TWD holding is worth half as many coins, shares unchanged.
    const qty = r.store.real.openPositions("p-alice")[0]?.qty;
    r.wallet.twdPerCoin = 2;
    const after = r.service.real.portfolio("p-alice").holdings[0]?.value ?? 0;
    expect(after).toBeCloseTo(before / 2, 5);
    expect(r.store.real.openPositions("p-alice")[0]?.qty).toBe(qty);
  });

  it("allows 2x only above the minimum price, blocks a ticker for buying and still lets it be sold", async () => {
    // The default minimum is 50 coins a share: NT$20 is under it at one coin = NT$1.
    const { r, p } = await desk({ blocked: ["AAPL"] });
    r.clock.at = TW_OPEN;
    p.set("2888.TW", 20, TW_OPEN);
    p.set("2330.TW", 2000, TW_OPEN);
    p.set("AAPL", 340, TW_OPEN);
    await r.service.real.lookup(ALICE, "2888");
    await r.service.real.lookup(ALICE, "2330");
    await r.service.real.lookup(ALICE, "AAPL");
    await r.service.optInLeverage(ALICE, true);
    expect(
      await r.service.real.place(
        ALICE,
        { side: "buy", code: "2888.TW", coins: 60, leverage: 2 },
        "l",
      ),
    ).toMatchObject({ code: "leverage_ticker" });
    expect(
      await r.service.real.place(
        ALICE,
        { side: "buy", code: "2330.TW", coins: 60, leverage: 2 },
        "l2",
      ),
    ).toMatchObject({ ok: true });
    expect(
      await r.service.real.place(ALICE, { side: "buy", code: "AAPL", coins: 60 }, "b"),
    ).toMatchObject({ code: "blocked" });
  });

  it("suspends a held ticker after days without a quote and never sells it on missing data", async () => {
    const { r, p } = await desk({ suspend_after_days: 2 });
    r.clock.at = TW_OPEN;
    p.set("2330.TW", 2000, TW_OPEN);
    await r.service.real.lookup(ALICE, "2330");
    await r.service.optInLeverage(ALICE, true);
    await r.service.real.place(
      ALICE,
      { side: "buy", code: "2330.TW", coins: 101, leverage: 2 },
      "k1",
    );
    r.clock.at += MIN;
    p.set("2330.TW", 2000, r.clock.at - 10_000);
    await r.service.tick();
    p.down = true;
    for (let d = 1; d <= 4; d++) {
      r.clock.at = TW_OPEN + d * 86_400_000;
      await r.service.tick();
    }
    expect(r.store.real.instrument("2330.TW")?.status).toBe("suspended");
    expect(r.store.real.openPositions("p-alice")).toHaveLength(1);
    expect(r.store.notices("p-alice")[0]?.text).toContain("沒有報價");
    expect((await r.service.real.settle("2330.TW", "last", "discord:8")).ok).toBe(true);
    expect(r.store.real.openPositions("p-alice")).toHaveLength(0);
  });

  it("closes everything on a bankruptcy and leaves her bond as it was", async () => {
    const { r, p } = await desk();
    const bond = { ...INFO["p-alice"] };
    // A US session: Monday 2026-11-23 10:00 New York.
    const US = Date.UTC(2026, 10, 23, 15, 0);
    r.clock.at = US;
    p.set("AAPL", 340, US);
    await r.service.real.lookup(ALICE, "AAPL");
    await r.service.optInLeverage(ALICE, true);
    // Spend the wallet down so the loss cannot be covered.
    r.wallet.fund(ALICE, -890);
    expect(
      await r.service.real.place(
        ALICE,
        { side: "buy", code: "AAPL", coins: 102, leverage: 2 },
        "k1",
      ),
    ).toMatchObject({ ok: true });
    r.clock.at += MIN;
    p.set("AAPL", 340, r.clock.at - 10_000);
    await r.service.tick();
    expect(r.store.real.openPositions("p-alice")).toHaveLength(1);
    // A gap far through the line: refused once, believed when a later fetch says the same.
    for (let i = 0; i < 2; i++) {
      r.clock.at += MIN;
      p.set("AAPL", 150, r.clock.at - 10_000);
      await r.service.tick();
    }
    expect(r.wallet.balanceOf("p-alice")).toBe(0);
    expect(r.store.real.openPositions("p-alice")).toHaveLength(0);
    expect(r.service.real.portfolio("p-alice").bankrupt).not.toBeNull();
    expect(INFO["p-alice"]).toEqual(bond);
    const report = r.service.real.report();
    expect(report.books.postings).toBe(report.books.lines);
    expect(report.today.written_off).toBeGreaterThan(0);
  });
});
