// What a member sees while a market is closed and before anything was quoted (owner 2026-11-22,
// after the first live start on a Sunday): the last known price, said as what it is. A real ticker
// shows the provider's previous close (fetched once per close, on demand), labelled 收盤價 with its
// date and 休市中, and it values holdings, but an order still waits for the open and fills at the
// first valid quote after it. A local stock before its first tick shows its anchor as the opening
// reference. When an order waits, every surface says when the market opens, in Taipei time (the
// US open with its own daylight saving), and it can be cancelled until then.

import { describe, expect, it } from "vitest";
import { overviewPictureData, quotePictureData } from "../src/pictures.js";
import { DEFAULT_SESSIONS, lastCloseAt, nextOpenAt, taipeiWhen } from "../src/real/instruments.js";
import type { QuoteProvider, RawQuote } from "../src/real/provider.js";
import type { YahooQuote } from "../src/real/yahoo.js";
import { ALICE, BOB, rig } from "./rig.js";

/** Sunday 2026-11-22 14:00 Taipei: both markets closed since Friday. */
const SUNDAY = Date.UTC(2026, 10, 22, 6, 0);
/** Friday 2026-11-20 13:30:01 Taipei: the Taiwan close, stamped a second after it. */
const FRIDAY_CLOSE = Date.UTC(2026, 10, 20, 5, 30, 1);
/** Monday 2026-11-23 09:00 Taipei. */
const MONDAY_OPEN = Date.UTC(2026, 10, 23, 1, 0);

/** Yahoo as the saved Sunday probe answered: the last close, outside the regular session. */
class Closed implements QuoteProvider {
  readonly id = "yahoo";
  readonly now = new Map<string, YahooQuote>();
  describeCalls = 0;
  readonly asked: string[] = [];
  async quotes(symbols: readonly string[]): Promise<Map<string, RawQuote>> {
    return new Map(
      symbols.flatMap((s) => (this.now.has(s) ? [[s, this.now.get(s) as RawQuote]] : [])),
    );
  }
  async describe(symbols: readonly string[]): Promise<Map<string, YahooQuote>> {
    this.describeCalls++;
    this.asked.push(...symbols);
    return new Map(
      symbols.flatMap((s) => (this.now.has(s) ? [[s, this.now.get(s) as YahooQuote]] : [])),
    );
  }
  set(
    symbol: string,
    price: number,
    prev: number,
    at: number,
    regular: boolean,
    name = "Taiwan Semiconductor Manufacturing Company Limited",
  ): void {
    const tw = symbol.endsWith(".TW");
    this.now.set(symbol, {
      symbol,
      price,
      at,
      prev_close: prev,
      currency: tw ? "TWD" : "USD",
      regular,
      points: [],
      exchange: tw ? "TAI" : "NMS",
      type: "EQUITY",
      name,
    });
  }
}

async function sunday(more: Record<string, unknown> = {}) {
  const p = new Closed();
  const r = await rig({ open: true, ...more } as never, new Map([["yahoo", p]]));
  r.clock.at = SUNDAY;
  r.wallet.fund(ALICE, 5000);
  r.wallet.fund(BOB, 5000);
  await r.service.openAccount(ALICE);
  await r.service.openAccount(BOB);
  return { r, p };
}

const lineOf = (r: Awaited<ReturnType<typeof sunday>>["r"], code: string) => {
  const l = r.service.real.view().instruments.find((i) => i.code === code);
  if (!l) throw new Error(`no ${code}`);
  return l;
};

describe("the hours", () => {
  it("know the next open and the last close, in Taipei time, with the US's daylight saving", () => {
    expect(nextOpenAt(DEFAULT_SESSIONS.tw, SUNDAY)).toBe(MONDAY_OPEN);
    expect(taipeiWhen(MONDAY_OPEN)).toBe("11/23(一)09:00");
    expect(lastCloseAt(DEFAULT_SESSIONS.tw, SUNDAY)).toBe(Date.UTC(2026, 10, 20, 5, 30));
    // New York in winter (EST): 09:30 there is 22:30 in Taipei; in summer (EDT) 21:30.
    expect(taipeiWhen(nextOpenAt(DEFAULT_SESSIONS.us, SUNDAY) as number)).toBe("11/23(一)22:30");
    const july = Date.UTC(2026, 6, 5, 6, 0); // Sunday 2026-07-05
    expect(taipeiWhen(nextOpenAt(DEFAULT_SESSIONS.us, july) as number)).toBe("7/6(一)21:30");
    // A holiday moves it on; during a session the next open is the next day's.
    expect(nextOpenAt({ ...DEFAULT_SESSIONS.tw, holidays: ["2026-11-23"] }, SUNDAY)).toBe(
      MONDAY_OPEN + 86_400_000,
    );
    expect(nextOpenAt(DEFAULT_SESSIONS.tw, MONDAY_OPEN + 60_000)).toBe(MONDAY_OPEN + 86_400_000);
    // The local stocks: noon every day.
    expect(taipeiWhen(nextOpenAt(DEFAULT_SESSIONS.local, SUNDAY - 3 * 3_600_000) as number)).toBe(
      "11/22(日)12:00",
    );
  });
});

describe("a closed-market Sunday", () => {
  it("shows a looked-up ticker's previous close, labelled, its own move, and the full name", async () => {
    const { r, p } = await sunday();
    p.set("2330.TW", 2000, 2100, FRIDAY_CLOSE, false);
    const found = await r.service.real.lookup(ALICE, "2330");
    expect(found).toMatchObject({ ok: true, instrument: { code: "2330.TW" } });
    const l = lineOf(r, "2330.TW");
    expect(l).toMatchObject({
      name: "台積電", // the starter list's zh-TW name over the provider's
      price: 2000,
      basis: "close",
      price_date: "2026-11-20",
      price_note: "收盤價(11/20)・休市中",
      next_open: new Date(MONDAY_OPEN).toISOString(),
      age_minutes: null,
      open: false,
    });
    expect(l.change).toBeCloseTo(-0.0476, 4);
    // The provider's name is stored whole, never cut.
    expect(r.store.real.instrument("2330.TW")?.name).toBe(
      "Taiwan Semiconductor Manufacturing Company Limited",
    );
    // The heat map colours it by Friday's move.
    expect(r.service.real.map("tw").tiles.find((t) => t.code === "2330.TW")).toMatchObject({
      name: "台積電",
      price: 2000,
    });
  });

  it("asks the provider once for the closes of tickers that have none, and not again", async () => {
    const { r, p } = await sunday();
    p.set("2330.TW", 2000, 2100, FRIDAY_CLOSE, false);
    p.set("2317.TW", 210, 205, FRIDAY_CLOSE, false, "Hon Hai Precision Industry Co., Ltd.");
    // Known from before (an older version kept nothing while closed): no price at all.
    for (const code of ["2330.TW", "2317.TW"])
      r.store.real.addInstrument(
        {
          code,
          market: "tw",
          name: code === "2317.TW" ? "Hon Hai Precision Industry Co., Lt" : code,
          exchange: "TAI",
          type: "EQUITY",
          currency: "TWD",
          provider: "yahoo",
          status: "active",
          added_at: SUNDAY,
          added_by: null,
        },
        SUNDAY,
      );
    expect(lineOf(r, "2317.TW").price).toBeNull();
    await r.service.tick();
    const closes = () => p.asked.filter((s) => s === "2317.TW").length;
    expect(closes()).toBe(1);
    expect(lineOf(r, "2317.TW")).toMatchObject({ price: 210, basis: "close", name: "鴻海" });
    // A name an older version cut short is replaced by the provider's whole one.
    expect(r.store.real.instrument("2317.TW")?.name).toBe("Hon Hai Precision Industry Co., Ltd.");
    r.clock.at += 10 * 60_000;
    await r.service.tick();
    r.clock.at += 3 * 3_600_000;
    await r.service.tick();
    expect(closes()).toBe(1);
  });

  it("values holdings at the last close, the same on the portfolio, the rich list and the holdings map", async () => {
    const { r, p } = await sunday({ map_min_holders: 1 });
    // Bought on Thursday at 1900; Core was down on Friday, so the quote kept here is Thursday's.
    const THURSDAY = Date.UTC(2026, 10, 19, 2, 0);
    r.clock.at = THURSDAY;
    p.set("2330.TW", 1900, 1880, THURSDAY - 60_000, true);
    await r.service.real.lookup(ALICE, "2330");
    await r.service.real.place(ALICE, { side: "buy", code: "2330.TW", coins: 1919 }, "k");
    p.set("2330.TW", 1900, 1880, THURSDAY + 30_000, true);
    r.clock.at = THURSDAY + 60_000;
    await r.service.tick();
    expect(r.store.real.openPositions("p-alice")).toHaveLength(1);
    // Sunday: the provider's close is Friday's 2000.
    r.clock.at = SUNDAY;
    p.set("2330.TW", 2000, 1900, FRIDAY_CLOSE, false);
    await r.service.tick();
    const h = r.service.real.portfolio("p-alice").holdings[0];
    expect(h?.price).toBe(2000);
    expect(h?.value).toBeCloseTo(((h?.qty ?? 0) / 1_000_000) * 2000, 2);
    expect(r.service.real.worth("p-alice").held).toBeCloseTo(h?.value ?? 0, 2);
    const tile = r.service.real.map("holdings").tiles.find((t) => t.code === "2330.TW");
    expect(tile?.weight).toBe(Math.round(h?.value ?? 0));
    expect(tile?.change).toBeCloseTo(2000 / 1900 - 1, 4);
    // Nothing is NaN anywhere a member looks.
    const p2 = r.service.real.portfolio("p-alice");
    expect(Number.isFinite(p2.totals.value)).toBe(true);
  });

  it("takes an order while closed, says when it fills, never fills it at the close, and lets it be cancelled", async () => {
    const { r, p } = await sunday();
    p.set("2330.TW", 2000, 2100, FRIDAY_CLOSE, false);
    await r.service.real.lookup(ALICE, "2330");
    const q = await r.service.real.quote(ALICE, { side: "buy", code: "2330.TW", coins: 2020 });
    if (!q.ok) throw new Error(q.message);
    expect(q.quote.open).toBe(false);
    expect(q.quote.next_open).toBe(new Date(MONDAY_OPEN).toISOString());
    expect(q.quote.price_note).toBe("收盤價(11/20)・休市中");
    expect(q.quote.sentence).toContain("下一個開盤 11/23(一)09:00(台北時間)");
    expect(q.quote.sentence).toContain("照收盤價(11/20)估約");
    const placed = await r.service.real.place(
      ALICE,
      { side: "buy", code: "2330.TW", coins: 2020 },
      "k1",
    );
    if (!placed.ok) throw new Error(placed.message);
    expect(placed.order.next_open).toBe(new Date(MONDAY_OPEN).toISOString());
    await r.service.tick();
    expect(r.store.real.openPositions("p-alice")).toHaveLength(0);
    const waiting = r.service.real
      .portfolio("p-alice")
      .orders.find((o) => o.id === placed.order.id);
    expect(waiting).toMatchObject({
      status: "open",
      next_open: new Date(MONDAY_OPEN).toISOString(),
    });
    // A second one is cancelled before the open: the coins come back.
    const second = await r.service.real.place(
      BOB,
      { side: "buy", code: "2330.TW", coins: 500 },
      "k2",
    );
    if (!second.ok) throw new Error(second.message);
    expect(r.wallet.balanceOf("p-bob")).toBe(4500);
    expect(await r.service.real.cancel(BOB, second.order.id)).toEqual({ ok: true, refunded: 500 });
    await r.service.tick();
    expect(r.wallet.balanceOf("p-bob")).toBe(5000);
    // Monday's first quote fills the one left.
    r.clock.at = MONDAY_OPEN + 60_000;
    p.set("2330.TW", 2010, 2000, MONDAY_OPEN + 30_000, true);
    await r.service.tick();
    expect(r.store.real.openPositions("p-alice")).toHaveLength(1);
    expect(lineOf(r, "2330.TW")).toMatchObject({
      basis: "quote",
      price: 2010,
      price_note: null,
      next_open: null,
    });
  });

  it("sells by coins' worth at the price known, and says the shares and the coins", async () => {
    const { r, p } = await sunday();
    const THURSDAY = Date.UTC(2026, 10, 19, 2, 0);
    r.clock.at = THURSDAY;
    p.set("2330.TW", 1000, 1000, THURSDAY - 60_000, true);
    await r.service.real.lookup(ALICE, "2330");
    await r.service.real.place(ALICE, { side: "buy", code: "2330.TW", shares: 2 }, "k");
    p.set("2330.TW", 1000, 1000, THURSDAY + 30_000, true);
    r.clock.at = THURSDAY + 60_000;
    await r.service.tick();
    r.clock.at = SUNDAY;
    const q = await r.service.real.quote(ALICE, { side: "sell", code: "2330.TW", coins: 500 });
    if (!q.ok) throw new Error(q.message);
    expect(q.quote.qty).toBe(500_000);
    expect(q.quote.sentence).toContain("賣出 0.5000 股");
    expect(q.quote.sentence).toMatch(/拿回 \d+ 魚幣/);
  });
});

describe("a brand-new instance before the first local tick", () => {
  it("shows each local stock's anchor as the opening reference, with the first tick's time", async () => {
    const r = await rig({ open: true });
    // Monday 11:30 Taipei: the local stocks tick first at 12:00.
    await r.service.tick();
    const rice = r.service.real.view().instruments.find((i) => i.code === "RICE");
    expect(rice).toMatchObject({
      price: 100,
      basis: "reference",
      price_note: "開盤參考價・第一筆價格在 11/23(一)12:00",
      change: null,
      at: null,
      age_minutes: null,
    });
    const pic = quotePictureData(r.service, {
      line: rice as never,
      tf: "intraday",
      candles: [],
      volume: false,
      zone: "Asia/Taipei",
      source: "ticks",
      stale: false,
    });
    expect(pic).toMatchObject({ price: 10_000, ref: 10_000, price_label: "開盤參考價" });
    expect(pic.as_of).toBe("還沒有第一筆價格");
    expect(pic.market_line).toContain("下一個開盤 11/23(一)12:00");
    const overview = overviewPictureData(r.service, r.clock.at);
    expect(overview.local.map((l) => l.price)).toEqual([10_000, 10_800, 8_800, 11_600, 9_400]);
  });

  it("explains that a buy waits for 12:00, and fills it at the first tick", async () => {
    const r = await rig({ open: true });
    r.wallet.fund(ALICE, 500);
    await r.service.openAccount(ALICE);
    await r.service.tick();
    const q = await r.service.real.quote(ALICE, { side: "buy", code: "RICE", shares: 1 });
    if (!q.ok) throw new Error(q.message);
    expect(q.quote.price).toBe(100);
    expect(q.quote.sentence).toContain("下一個開盤 11/23(一)12:00(台北時間)");
    expect(q.quote.sentence).toContain("照開盤參考價估約 1.0000 股");
    const placed = await r.service.real.place(ALICE, { side: "buy", code: "RICE", shares: 1 }, "k");
    expect(placed).toMatchObject({ ok: true });
    await r.at(Date.UTC(2026, 10, 23, 4, 1)); // 12:01
    expect(r.store.real.openPositions("p-alice")).toHaveLength(1);
  });
});

describe("suggestions by name", () => {
  it("find a starter by its zh-TW name before it was ever looked up", async () => {
    const r = await rig({ open: true });
    expect(r.service.lists.suggest("x", "台積")).toContainEqual({
      code: "2330",
      name: "台積電・熱門清單",
    });
  });
});
