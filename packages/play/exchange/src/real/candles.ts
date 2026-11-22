// Candles (owner 2026-11-21: "a real stock chart"): open, high, low, close and volume per bar, in
// four timeframes — 當日 (the current or last session in 5-minute bars), 日線 (about six months),
// 週線 (about two years) and 月線 (ten years). Real stocks get them from Yahoo's chart endpoint, on
// demand when someone opens a chart, and they are cached per (instrument, timeframe); the five
// local stocks get them from their own ticks (one an hour, kept in `exchange_quote_ticks`), with no
// volume: the game's own traded amount would let one person's trade be read off a quiet hour.
//
// What Yahoo answers was probed by hand (2026-11-21, `test/fixtures/yahoo-candles-*.json`):
//
//     GET https://query1.finance.yahoo.com/v8/finance/chart/2330.TW?range=6mo&interval=1d
//     → { chart: { result: [{ meta, timestamp: [s], indicators: { quote: [{ open, high, low,
//         close, volume }], adjclose: [{ adjclose }] } }], error: null } }
//
// 1d/5m, 6mo/1d, 2y/1wk and 10y/1mo all answer 200 with no cookie or crumb. A daily bar is stamped
// at the session's open; a weekly bar at Monday 00:00 and a monthly bar at the 1st 00:00, both in
// the exchange's zone (`meta.exchangeTimezoneName`). Weekly and monthly answers end with one more
// entry stamped at `regularMarketTime` holding only the latest day: it falls in the same week or
// month as the bar before it, so it is merged into that bar (its close is the latest). Prices are
// as traded (not adjusted for dividends; `adjclose` is ignored), like the quotes.

import { zonedParts } from "./instruments.js";

export const TIMEFRAMES = ["intraday", "daily", "weekly", "monthly"] as const;
export type Timeframe = (typeof TIMEFRAMES)[number];

/** The words on the switch and in the pictures' headers. */
export const TIMEFRAME_WORD: Readonly<Record<Timeframe, string>> = {
  intraday: "當日",
  daily: "日線",
  weekly: "週線",
  monthly: "月線",
};

/** What each timeframe covers, in words (the picture's header). */
export const TIMEFRAME_SPAN: Readonly<Record<Timeframe, string>> = {
  intraday: "最近一個交易日",
  daily: "近 6 個月",
  weekly: "近 2 年",
  monthly: "近 10 年",
};

export const isTimeframe = (x: unknown): x is Timeframe =>
  typeof x === "string" && (TIMEFRAMES as readonly string[]).includes(x);

/** One bar. `at` is when it starts (epoch ms); prices in the instrument's own currency. */
export interface Candle {
  at: number;
  o: number;
  h: number;
  l: number;
  c: number;
  /** Shares traded (`null`: not known, the local stocks). */
  v: number | null;
}

/** Yahoo's `range` and `interval` per timeframe (each probed). */
export const YAHOO_SPAN: Readonly<Record<Timeframe, { range: string; interval: string }>> = {
  intraday: { range: "1d", interval: "5m" },
  daily: { range: "6mo", interval: "1d" },
  weekly: { range: "2y", interval: "1wk" },
  monthly: { range: "10y", interval: "1mo" },
};

/** How far back a timeframe reaches when it is made from ticks. */
export const SPAN_DAYS: Readonly<Record<Timeframe, number>> = {
  intraday: 1,
  daily: 183,
  weekly: 731,
  monthly: 3653,
};

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/**
 * How long a timeframe's candles are kept before they are asked for again: short for the session
 * in progress while its market is open, long for the others (a monthly bar barely moves in a day).
 */
export function candleTtl(tf: Timeframe, open: boolean): number {
  switch (tf) {
    case "intraday":
      return open ? MIN : 30 * MIN;
    case "daily":
      return open ? 5 * MIN : 6 * HOUR;
    case "weekly":
      return open ? 30 * MIN : 12 * HOUR;
    case "monthly":
      return open ? 2 * HOUR : 24 * HOUR;
  }
}

/** The period a time falls in, in `zone`: a step (intraday), a date, the week's Monday, a month. */
export function periodKey(ms: number, tf: Timeframe, zone: string, stepMs = 5 * MIN): string {
  if (tf === "intraday") return String(Math.floor(ms / stepMs) * stepMs);
  const z = zonedParts(ms, zone);
  if (tf === "daily") return z.date;
  if (tf === "monthly") return z.date.slice(0, 7);
  const [y, m, d] = z.date.split("-").map(Number) as [number, number, number];
  const monday = Date.UTC(y, m - 1, d) - ((z.weekday + 6) % 7) * DAY;
  return new Date(monday).toISOString().slice(0, 10);
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** A bar from four prices, its high and low widened to hold the open and close. */
function bar(at: number, o: number, h: number, l: number, c: number, v: number | null): Candle {
  return { at, o, h: Math.max(h, o, c), l: Math.min(l, o, c), c, v };
}

/**
 * A chart response's bars, oldest first, and the exchange's zone; `null` when it does not parse.
 * A bar with a missing or non-positive price is left out (Yahoo writes `null` for a bar with no
 * trade); one more entry in a bar's period is merged into it.
 */
export function parseYahooCandles(
  json: unknown,
  tf: Timeframe,
): { candles: Candle[]; zone: string } | null {
  const chart = (json as { chart?: { result?: unknown; error?: unknown } } | null)?.chart;
  if (!chart || (chart.error !== null && chart.error !== undefined)) return null;
  const r = Array.isArray(chart.result) ? (chart.result[0] as Record<string, unknown>) : null;
  if (!r || typeof r !== "object") return null;
  const meta = r.meta as Record<string, unknown> | undefined;
  const zone = typeof meta?.exchangeTimezoneName === "string" ? meta.exchangeTimezoneName : "UTC";
  const stamps = r.timestamp;
  const q = (r.indicators as { quote?: Record<string, unknown>[] } | undefined)?.quote?.[0];
  // No bars at all (nothing traded in the range): no `timestamp`.
  if (!Array.isArray(stamps)) return { candles: [], zone };
  if (!q) return null;
  const col = (k: string) => (Array.isArray(q[k]) ? (q[k] as unknown[]) : []);
  const [O, H, L, C, V] = [col("open"), col("high"), col("low"), col("close"), col("volume")];
  const raw: Candle[] = [];
  for (let i = 0; i < stamps.length; i++) {
    const t = num(stamps[i]);
    const o = num(O[i]);
    const h = num(H[i]);
    const l = num(L[i]);
    const c = num(C[i]);
    if (t === null || o === null || h === null || l === null || c === null) continue;
    if (!(o > 0 && h > 0 && l > 0 && c > 0) || Math.max(o, h, l, c) > 1e9) continue;
    const v = num(V[i]);
    raw.push(bar(t * 1000, o, h, l, c, v !== null && v >= 0 ? v : null));
  }
  raw.sort((a, b) => a.at - b.at);
  return { candles: mergePeriods(raw, tf, zone), zone };
}

/** Bars in the same period joined: the first's open and time, the extremes, the last close. */
function mergePeriods(bars: readonly Candle[], tf: Timeframe, zone: string): Candle[] {
  const out: Candle[] = [];
  let lastKey: string | null = null;
  for (const b of bars) {
    const k = periodKey(b.at, tf, zone);
    const prev = out.at(-1);
    if (prev && k === lastKey) {
      out[out.length - 1] = bar(
        prev.at,
        prev.o,
        Math.max(prev.h, b.h),
        Math.min(prev.l, b.l),
        b.c,
        prev.v,
      );
      continue;
    }
    out.push(b);
    lastKey = k;
  }
  if (tf !== "intraday") return out;
  // The current (or last) session only.
  const last = out.at(-1);
  if (!last) return out;
  const day = zonedParts(last.at, zone).date;
  return out.filter((b) => zonedParts(b.at, zone).date === day);
}

/**
 * Bars made from price points (oldest first): the first, highest, lowest and last price of each
 * period, no volume. 當日 is the last date's points in steps of `stepMs` (an hour for the local
 * stocks, five minutes otherwise); there a bar opens at the price before it (the day's first bar
 * at the day before's last), so one point a step still draws a body and the morning's gap shows.
 */
export function candlesFromPoints(
  points: readonly { at: number; price: number }[],
  tf: Timeframe,
  zone: string,
  stepMs = 5 * MIN,
): Candle[] {
  const sorted = [...points]
    .filter((p) => Number.isFinite(p.price) && p.price > 0)
    .sort((a, b) => a.at - b.at);
  let use = sorted;
  let before: number | null = null;
  if (tf === "intraday") {
    const last = sorted.at(-1);
    if (!last) return [];
    const day = zonedParts(last.at, zone).date;
    use = sorted.filter((p) => zonedParts(p.at, zone).date === day);
    const first = use[0];
    before = first ? (sorted.filter((p) => p.at < first.at).at(-1)?.price ?? null) : null;
  }
  const out: Candle[] = [];
  let lastKey: string | null = null;
  for (const p of use) {
    const k = periodKey(p.at, tf, zone, stepMs);
    const prev = out.at(-1);
    if (prev && k === lastKey) {
      out[out.length - 1] = bar(
        prev.at,
        prev.o,
        Math.max(prev.h, p.price),
        Math.min(prev.l, p.price),
        p.price,
        null,
      );
      continue;
    }
    if (tf === "intraday") {
      const open = prev?.c ?? before ?? p.price;
      out.push(bar(Math.floor(p.at / stepMs) * stepMs, open, p.price, p.price, p.price, null));
    } else out.push(bar(p.at, p.price, p.price, p.price, p.price, null));
    lastKey = k;
  }
  return out;
}

interface CacheEntry {
  candles: Candle[];
  fetched: number;
  ttl: number;
}

/**
 * Candles per (instrument, timeframe), each fresh for its timeframe's time to live; an expired one
 * is still there to fall back on when the provider cannot answer. At most `max` entries (the
 * oldest fetched goes first).
 */
export class CandleCache {
  readonly #entries = new Map<string, CacheEntry>();
  readonly #inflight = new Map<string, Promise<Candle[] | null>>();

  constructor(private readonly max = 400) {}

  static key(symbol: string, tf: Timeframe): string {
    return `${symbol}|${tf}`;
  }

  /** The cached candles when still fresh at `now`. */
  fresh(key: string, now: number): Candle[] | null {
    const e = this.#entries.get(key);
    return e && now - e.fetched < e.ttl ? e.candles : null;
  }

  /** The cached candles however old (`null`: none). */
  any(key: string): Candle[] | null {
    return this.#entries.get(key)?.candles ?? null;
  }

  set(key: string, candles: Candle[], now: number, ttl: number): void {
    this.#entries.delete(key);
    this.#entries.set(key, { candles, fetched: now, ttl });
    while (this.#entries.size > this.max) {
      const oldest = this.#entries.keys().next().value;
      if (oldest === undefined) break;
      this.#entries.delete(oldest);
    }
  }

  get size(): number {
    return this.#entries.size;
  }

  /** One request per key at a time: a second caller waits for the first. */
  once(key: string, load: () => Promise<Candle[] | null>): Promise<Candle[] | null> {
    const running = this.#inflight.get(key);
    if (running !== undefined) return running;
    const p = load().finally(() => this.#inflight.delete(key));
    this.#inflight.set(key, p);
    return p;
  }
}
