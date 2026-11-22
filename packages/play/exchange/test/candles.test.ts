// Candles (docs/design/exchange.md §11): Yahoo's chart responses per timeframe as saved fixtures
// (never the network), the extra "today" entry of a weekly or monthly answer merged into its
// period, bars made from the local stocks' hourly ticks, the cache's times to live and its single
// request per key, the provider's chart budget inside its daily budget and its backoff, and the
// desk asking only on demand with the stale and tick fallbacks.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  CandleCache,
  candlesFromPoints,
  candleTtl,
  parseYahooCandles,
  periodKey,
  type Timeframe,
  YAHOO_SPAN,
} from "../src/real/candles.js";
import type { QuoteProvider, RawQuote } from "../src/real/provider.js";
import { CHART_SHARE, YahooProvider, type YahooQuote } from "../src/real/yahoo.js";
import { ALICE, HOUR, local, MIN, rig } from "./rig.js";

const fixture = (name: string) =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8")) as unknown;

const iso = (ms: number) => new Date(ms).toISOString();

describe("Yahoo's chart answers (saved fixtures)", () => {
  it("reads 日線: one bar a session, stamped at the open, in the exchange's zone", () => {
    const tw = parseYahooCandles(fixture("yahoo-candles-2330.TW-6mo-1d.json"), "daily");
    expect(tw?.zone).toBe("Asia/Taipei");
    expect(tw?.candles).toHaveLength(30);
    const last = tw?.candles.at(-1);
    expect(last).toMatchObject({ o: 2035, h: 2060, l: 1970, c: 2000, v: 75_539_460 });
    // 09:00 Taipei is 01:00 UTC.
    expect(iso(last?.at ?? 0)).toBe("2026-11-20T01:00:00.000Z");
    const us = parseYahooCandles(fixture("yahoo-candles-AAPL-6mo-1d.json"), "daily");
    expect(us?.zone).toBe("America/New_York");
    expect(us?.candles).toHaveLength(10);
    expect(iso(us?.candles.at(-1)?.at ?? 0)).toBe("2026-11-20T14:30:00.000Z");
    // Every bar's high and low hold its open and close.
    for (const k of [...(tw?.candles ?? []), ...(us?.candles ?? [])]) {
      expect(k.h).toBeGreaterThanOrEqual(Math.max(k.o, k.c));
      expect(k.l).toBeLessThanOrEqual(Math.min(k.o, k.c));
    }
  });

  it("reads 週線 and 月線, merging the extra entry of today into its week or month", () => {
    const week = parseYahooCandles(fixture("yahoo-candles-2330.TW-2y-1wk.json"), "weekly");
    // 8 entries: 7 weeks and a last one stamped at the latest trade, inside the last week.
    expect(week?.candles).toHaveLength(7);
    const w = week?.candles.at(-1);
    expect(iso(w?.at ?? 0)).toBe("2026-11-15T16:00:00.000Z"); // Monday 11/16 00:00 Taipei
    expect(w).toMatchObject({ o: 2340, c: 2000, l: 1970 });
    expect(periodKey(w?.at ?? 0, "weekly", "Asia/Taipei")).toBe("2026-11-16");
    const month = parseYahooCandles(fixture("yahoo-candles-AAPL-10y-1mo.json"), "monthly");
    expect(month?.candles).toHaveLength(7);
    const m = month?.candles.at(-1);
    expect(periodKey(m?.at ?? 0, "monthly", "America/New_York")).toBe("2026-11");
    expect(m?.c).toBeCloseTo(342.56, 2);
    expect(m?.h).toBeCloseTo(360.83, 2);
    // One bar a month, oldest first, no two in the same month.
    const keys = (month?.candles ?? []).map((k) => periodKey(k.at, "monthly", "America/New_York"));
    expect(new Set(keys).size).toBe(keys.length);
    expect([...keys].sort()).toEqual(keys);
  });

  it("reads 當日 from the 5-minute answer: the last session only", () => {
    const day = parseYahooCandles(fixture("yahoo-chart-AAPL.json"), "intraday");
    expect(day?.candles).toHaveLength(12);
    expect(day?.candles[1]?.at).toBe((day?.candles[0]?.at ?? 0) + 5 * MIN);
    expect(day?.candles.at(-1)?.v).toBe(0);
  });

  it("leaves out bars with a missing price and refuses what is not a chart", () => {
    const json = fixture("yahoo-candles-2330.TW-6mo-1d.json") as {
      chart: { result: { indicators: { quote: Record<string, (number | null)[]>[] } }[] };
    };
    const q = json.chart.result[0]?.indicators.quote[0] as Record<string, (number | null)[]>;
    (q.close as (number | null)[])[3] = null;
    (q.open as (number | null)[])[5] = -1;
    expect(parseYahooCandles(json, "daily")?.candles).toHaveLength(28);
    expect(
      parseYahooCandles({ chart: { result: null, error: { code: "Not Found" } } }, "daily"),
    ).toBeNull();
    expect(parseYahooCandles({ nope: true }, "daily")).toBeNull();
    expect(parseYahooCandles({ chart: { result: [{ meta: {} }], error: null } }, "daily")).toEqual({
      candles: [],
      zone: "UTC",
    });
  });
});

describe("bars from the local stocks' ticks", () => {
  // One tick an hour, 12:00 to 23:00 Taipei, two days.
  const ticks = [0, 1].flatMap((d) =>
    Array.from({ length: 12 }, (_, h) => ({ at: local(d, 12 + h), price: 100 + d * 10 + h })),
  );

  it("makes 當日 of the last day, one bar an hour opening at the price before it", () => {
    const bars = candlesFromPoints(ticks, "intraday", "Asia/Taipei", HOUR);
    expect(bars).toHaveLength(12);
    // The day's first bar opens at the day before's last tick: the morning's gap shows.
    expect(bars[0]).toMatchObject({ o: 111, c: 110, h: 111, l: 110, v: null });
    expect(bars[1]).toMatchObject({ o: 110, c: 111 });
    expect(bars.every((b) => b.v === null)).toBe(true);
  });

  it("makes 日線, 週線 and 月線: first, highest, lowest and last of each period", () => {
    const daily = candlesFromPoints(ticks, "daily", "Asia/Taipei");
    expect(daily).toEqual([
      { at: local(0, 12), o: 100, h: 111, l: 100, c: 111, v: null },
      { at: local(1, 12), o: 110, h: 121, l: 110, c: 121, v: null },
    ]);
    // Monday 11/23 and Tuesday 11/24 are one week and one month.
    expect(candlesFromPoints(ticks, "weekly", "Asia/Taipei")).toEqual([
      { at: local(0, 12), o: 100, h: 121, l: 100, c: 121, v: null },
    ]);
    expect(candlesFromPoints(ticks, "monthly", "Asia/Taipei")).toHaveLength(1);
    expect(candlesFromPoints([], "daily", "Asia/Taipei")).toEqual([]);
  });
});

describe("the candle cache", () => {
  it("keeps the session in progress briefly while its market is open and the rest for long", () => {
    expect(candleTtl("intraday", true)).toBe(MIN);
    expect(candleTtl("intraday", false)).toBeGreaterThan(candleTtl("intraday", true));
    for (const tf of ["daily", "weekly", "monthly"] as Timeframe[])
      expect(candleTtl(tf, false)).toBeGreaterThanOrEqual(6 * HOUR);
    expect(candleTtl("daily", true)).toBeLessThan(candleTtl("weekly", true));
    expect(candleTtl("weekly", true)).toBeLessThan(candleTtl("monthly", true));
  });

  it("answers fresh entries, keeps expired ones to fall back on, and holds at most its size", () => {
    const c = new CandleCache(2);
    const bars = [{ at: 1, o: 1, h: 1, l: 1, c: 1, v: null }];
    c.set("A|daily", bars, 0, 10);
    expect(c.fresh("A|daily", 5)).toBe(bars);
    expect(c.fresh("A|daily", 10)).toBeNull();
    expect(c.any("A|daily")).toBe(bars);
    c.set("B|daily", bars, 0, 10);
    c.set("C|daily", bars, 0, 10);
    expect(c.size).toBe(2);
    expect(c.any("A|daily")).toBeNull();
  });

  it("asks once for a key while a request for it is under way", async () => {
    const c = new CandleCache();
    let calls = 0;
    let release: (v: []) => void = () => undefined;
    const load = () => {
      calls++;
      return new Promise<[]>((r) => {
        release = r;
      });
    };
    const a = c.once("X|daily", load);
    const b = c.once("X|daily", load);
    release([]);
    expect(await a).toEqual([]);
    expect(await b).toEqual([]);
    expect(calls).toBe(1);
  });
});

describe("the chart endpoint", () => {
  const config = {
    host: "query1.finance.yahoo.com",
    daily_budget: 8,
    timeout_ms: 1000,
    max_backoff_seconds: 60,
  };
  const now = Date.UTC(2026, 10, 20, 5, 0);

  it("asks the probed range and interval for each timeframe, with nothing about who asks", async () => {
    const urls: string[] = [];
    const inits: RequestInit[] = [];
    const fetch = async (url: string, init: RequestInit) => {
      urls.push(url);
      inits.push(init);
      return new Response(JSON.stringify(fixture("yahoo-candles-2330.TW-6mo-1d.json")));
    };
    const y = new YahooProvider({ ...config, daily_budget: 100 }, fetch);
    const bars = await y.candles("2330.TW", "daily", now);
    expect(bars).toHaveLength(30);
    for (const tf of ["intraday", "weekly", "monthly"] as Timeframe[])
      await y.candles("2330.TW", tf, now);
    expect(urls).toEqual(
      (["daily", "intraday", "weekly", "monthly"] as Timeframe[]).map(
        (tf) =>
          `https://query1.finance.yahoo.com/v8/finance/chart/2330.TW?range=${YAHOO_SPAN[tf].range}&interval=${YAHOO_SPAN[tf].interval}`,
      ),
    );
    expect(Object.keys(inits[0]?.headers as object).sort()).toEqual(["accept", "user-agent"]);
    expect(inits[0]?.redirect).toBe("error");
    expect(inits[0]?.credentials).toBe("omit");
  });

  it("spends the day's budget with the quotes, and never more than its share of it", async () => {
    let calls = 0;
    const fetch = async (url: string) => {
      calls++;
      return new Response(
        JSON.stringify(
          url.includes("spark")
            ? fixture("yahoo-spark.json")
            : fixture("yahoo-candles-2330.TW-6mo-1d.json"),
        ),
      );
    };
    const y = new YahooProvider(config, fetch);
    // 8 a day: charts may use 2 of them.
    expect(Math.floor(config.daily_budget * CHART_SHARE)).toBe(2);
    await y.candles("2330.TW", "daily", now);
    await y.candles("2330.TW", "weekly", now);
    await expect(y.candles("2330.TW", "monthly", now)).rejects.toThrow("chart budget");
    expect(y.chartsUsed).toBe(2);
    // The quotes still have theirs, counted in the same day.
    for (let i = 0; i < 6; i++) await y.describe(["2330.TW"], now);
    expect(y.used).toBe(8);
    await expect(y.describe(["2330.TW"], now)).rejects.toThrow("budget");
    expect(calls).toBe(8);
    // A new day starts both counts again.
    await y.candles("2330.TW", "daily", now + 86_400_000);
    expect(y.chartsUsed).toBe(1);
  });

  it("backs every request off after a 429 or no answer, not after an answer it cannot read", async () => {
    let answer: () => Response = () => new Response("busy", { status: 429 });
    const fetch = async () => answer();
    const y = new YahooProvider({ ...config, daily_budget: 100 }, fetch);
    await expect(y.candles("2330.TW", "daily", now)).rejects.toThrow("429");
    // The quotes back off too.
    await expect(y.describe(["2330.TW"], now + 1000)).rejects.toThrow("backing off");
    await expect(y.candles("2330.TW", "daily", now + 2000)).rejects.toThrow("backing off");
    const later = now + 3_600_000;
    answer = () => new Response("not json");
    await expect(y.candles("2330.TW", "daily", later)).rejects.toThrow("not JSON");
    answer = () => new Response(JSON.stringify(fixture("yahoo-candles-2330.TW-6mo-1d.json")));
    expect(await y.candles("2330.TW", "daily", later + 1000)).toHaveLength(30);
  });
});

/** A Yahoo-like provider whose candles the test counts and can take down. */
class Charted implements QuoteProvider {
  readonly id = "yahoo";
  readonly quotesNow = new Map<string, YahooQuote>();
  chartCalls = 0;
  down = false;
  async quotes(symbols: readonly string[]): Promise<Map<string, RawQuote>> {
    return new Map(
      symbols.flatMap((s) =>
        this.quotesNow.has(s) ? [[s, this.quotesNow.get(s) as RawQuote]] : [],
      ),
    );
  }
  async describe(symbols: readonly string[]): Promise<Map<string, YahooQuote>> {
    return new Map(
      symbols.flatMap((s) =>
        this.quotesNow.has(s) ? [[s, this.quotesNow.get(s) as YahooQuote]] : [],
      ),
    );
  }
  async candles(_symbol: string, tf: Timeframe) {
    this.chartCalls++;
    if (this.down) throw new Error("down");
    const parsed = parseYahooCandles(fixture("yahoo-candles-2330.TW-6mo-1d.json"), tf);
    return parsed?.candles ?? [];
  }
}

/** Monday 2026-11-23 10:00 Taipei. */
const TW_OPEN = Date.UTC(2026, 10, 23, 2, 0);

describe("the desk's charts", () => {
  async function desk() {
    const p = new Charted();
    const r = await rig({ open: true } as never, new Map([["yahoo", p]]));
    r.clock.at = TW_OPEN;
    p.quotesNow.set("2330.TW", {
      symbol: "2330.TW",
      price: 2000,
      at: TW_OPEN,
      prev_close: 1990,
      currency: "TWD",
      regular: true,
      points: [],
      exchange: "TAI",
      type: "EQUITY",
      name: "示範半導體",
    });
    await r.service.real.lookup(ALICE, "2330");
    return { r, p };
  }

  it("asks the provider only when a chart is opened, then answers from the cache until it expires", async () => {
    const { r, p } = await desk();
    expect(p.chartCalls).toBe(0);
    await r.service.tick();
    expect(p.chartCalls).toBe(0);
    const a = await r.service.real.candles("2330.TW", "daily");
    expect(a).toMatchObject({
      tf: "daily",
      source: "provider",
      volume: true,
      stale: false,
      zone: "Asia/Taipei",
    });
    expect(a?.candles).toHaveLength(30);
    await r.service.real.candles("2330.TW", "daily");
    expect(p.chartCalls).toBe(1);
    // Another timeframe is another key.
    await r.service.real.candles("2330.TW", "weekly");
    expect(p.chartCalls).toBe(2);
    // Past the daily bars' time to live while the market is open (5 minutes): asked again.
    r.clock.at += 6 * MIN;
    await r.service.real.candles("2330.TW", "daily");
    expect(p.chartCalls).toBe(3);
    // Opening a chart counts as a view, so the ticker's quotes keep coming.
    expect(r.store.real.instrument("2330.TW")?.last_viewed_at).toBe(r.clock.at);
  });

  it("falls back to the last candles, else to bars from the kept quotes, when the provider is down", async () => {
    const { r, p } = await desk();
    await r.service.real.candles("2330.TW", "daily");
    p.down = true;
    r.clock.at += 10 * MIN;
    const stale = await r.service.real.candles("2330.TW", "daily");
    expect(stale).toMatchObject({ source: "provider", stale: true });
    expect(stale?.candles).toHaveLength(30);
    const ticks = await r.service.real.candles("2330.TW", "monthly");
    expect(ticks).toMatchObject({ source: "ticks", stale: true, volume: false });
  });

  it("makes a local stock's candles from its own ticks, with no volume and no provider call", async () => {
    const { r, p } = await desk();
    await r.runTo(local(1, 23, 30));
    const day = await r.service.real.candles("RICE", "intraday");
    expect(day).toMatchObject({ source: "ticks", volume: false, zone: "Asia/Taipei" });
    expect(day?.candles.length).toBeGreaterThanOrEqual(10);
    expect(day?.candles.every((k) => k.v === null)).toBe(true);
    const daily = await r.service.real.candles("RICE", "daily");
    expect(daily?.candles.length).toBeGreaterThanOrEqual(2);
    expect(p.chartCalls).toBe(0);
    expect(await r.service.real.candles("NOPE", "daily")).toBeNull();
  });
});
