// Yahoo Finance as a quote provider (owner 2026-11-21: the source for both Taiwan and US stocks).
// Yahoo has no official public API; this reads the public chart JSON the way widely used open-source
// clients do, and is written against responses actually observed (`test/fixtures/yahoo-*.json`):
//
//     GET https://query1.finance.yahoo.com/v7/finance/spark?symbols=2330.TW,6488.TWO,AAPL&range=1d&interval=5m
//     → { spark: { result: [{ symbol, response: [{ meta, timestamp, indicators: { quote: [{ close }] } }] }], error } }
//
// `meta` carries `regularMarketPrice`, `regularMarketTime` (s), `previousClose` /
// `chartPreviousClose`, `currency`, `exchangeTimezoneName` and `currentTradingPeriod.regular`
// `{ start, end }` (s). No field says whether a quote is real-time or delayed, and there is no
// market-state field: a quote counts only when its time is inside the regular period (that is the
// regular session; pre and post market are never traded), and every card shows the quote's own
// time and how old it is. One request per market per pass (spark takes several symbols), a generic
// browser user agent, no cookies, no crumb, no account, nothing about who asks; a daily request
// budget; exponential backoff on 429 and 5xx; never a redirect. Anything that does not parse, a
// missing field or an absurd number is no quote: the market goes stale and does not trade.
//
// Yahoo's terms describe the data as for personal use, and the endpoint can change or disappear
// without notice. The generic `HttpJsonProvider` stays as the way to switch (docs/design/exchange.md).

import { type Candle, parseYahooCandles, type Timeframe, YAHOO_SPAN } from "./candles.js";
import type { QuoteProvider, RawQuote } from "./provider.js";

/**
 * The share of the day's request budget charts may use: the rest stays for quotes, so opening
 * charts can never stop the prices of what people hold.
 */
export const CHART_SHARE = 0.25;

export interface YahooConfig {
  /** The host; the only one ever called. */
  host: string;
  /** Requests per local day at most; past it, no request until the next day. */
  daily_budget: number;
  timeout_ms: number;
  max_backoff_seconds: number;
}

export const DEFAULT_YAHOO: YahooConfig = {
  host: "query1.finance.yahoo.com",
  daily_budget: 3000,
  timeout_ms: 8000,
  max_backoff_seconds: 1800,
};

/** A generic browser user agent: nothing about who asks. */
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const MAX_BYTES = 2_000_000;

type Fetch = (url: string, init: RequestInit) => Promise<Response>;

/** A Yahoo quote: the raw quote with what else the response said. */
export interface YahooQuote extends RawQuote {
  currency: string | null;
  /** The quote's time is inside the regular session of its day. */
  regular: boolean;
  /** The day's 5-minute closes (the chart), oldest first. */
  points: { at: number; price: number }[];
  /** As the response reports them: `TAI`, `TWO`, `NMS`, `NYQ`, ...; `EQUITY`, `ETF`, ...; the long name. */
  exchange: string | null;
  type: string | null;
  name: string | null;
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** One symbol's chart response (`meta`, `timestamp`, `indicators`), or `null` when it does not parse. */
export function parseChart(symbol: string, r: unknown): YahooQuote | null {
  if (r === null || typeof r !== "object") return null;
  const meta = (r as { meta?: Record<string, unknown> }).meta;
  if (!meta || typeof meta !== "object") return null;
  const price = num(meta.regularMarketPrice);
  const time = num(meta.regularMarketTime);
  if (price === null || time === null || price <= 0) return null;
  const period = (
    meta.currentTradingPeriod as { regular?: { start?: unknown; end?: unknown } } | undefined
  )?.regular;
  const start = num(period?.start);
  const end = num(period?.end);
  const prev = num(meta.previousClose) ?? num(meta.chartPreviousClose);
  const stamps = (r as { timestamp?: unknown }).timestamp;
  const closes = (r as { indicators?: { quote?: { close?: unknown }[] } }).indicators?.quote?.[0]
    ?.close;
  const points: { at: number; price: number }[] = [];
  if (Array.isArray(stamps) && Array.isArray(closes)) {
    for (let i = 0; i < stamps.length; i++) {
      const t = num(stamps[i]);
      const c = num(closes[i]);
      if (t !== null && c !== null && c > 0) points.push({ at: t * 1000, price: c });
    }
  }
  return {
    symbol,
    price,
    at: time * 1000,
    ...(prev === null ? {} : { prev_close: prev }),
    currency: typeof meta.currency === "string" ? meta.currency : null,
    // The closing print is stamped a second or two after the period's end: still the regular session.
    regular: start !== null && end !== null && time >= start && time <= end + 600,
    points,
    exchange: typeof meta.exchangeName === "string" ? meta.exchangeName : null,
    type: typeof meta.instrumentType === "string" ? meta.instrumentType : null,
    name:
      typeof meta.longName === "string"
        ? meta.longName
        : typeof meta.shortName === "string"
          ? meta.shortName
          : null,
  };
}

/** A spark response: each symbol's quote, missing when it does not parse. */
export function parseSpark(json: unknown): Map<string, YahooQuote> {
  const out = new Map<string, YahooQuote>();
  const result = (json as { spark?: { result?: unknown } } | null)?.spark?.result;
  if (!Array.isArray(result)) throw new Error("yahoo: not a spark response");
  for (const item of result) {
    const symbol = (item as { symbol?: unknown }).symbol;
    const response = (item as { response?: unknown[] }).response?.[0];
    if (typeof symbol !== "string") continue;
    const q = parseChart(symbol, response);
    if (q) out.set(symbol, q);
  }
  return out;
}

/** Taiwan listed `2330.TW`, TPEx `6488.TWO`, US the plain ticker. */
export function yahooSymbol(
  market: "tw" | "us" | "crypto",
  code: string,
  board: "twse" | "tpex" = "twse",
): string {
  if (market === "tw") return `${code}.${board === "tpex" ? "TWO" : "TW"}`;
  return code;
}

export class YahooProvider implements QuoteProvider {
  readonly id = "yahoo";
  readonly #c: YahooConfig;
  readonly #fetch: Fetch;
  #day = "";
  #used = 0;
  #charts = 0;
  #failures = 0;
  #notBefore = 0;
  /** The last thing that went wrong (the owner's panel shows it). */
  lastError: string | null = null;

  constructor(
    config: YahooConfig = DEFAULT_YAHOO,
    fetch: Fetch = globalThis.fetch.bind(globalThis),
  ) {
    if (!/^[a-z0-9.-]+$/i.test(config.host)) throw new Error("yahoo: a host name, nothing else");
    this.#c = config;
    this.#fetch = fetch;
  }

  /** Requests made today. */
  get used(): number {
    return this.#used;
  }

  async quotes(
    symbols: readonly string[],
    now: number,
    signal?: AbortSignal,
  ): Promise<Map<string, RawQuote>> {
    const all = await this.describe(symbols, now, signal);
    // Only quotes of the regular session are quotes here.
    const out = new Map<string, RawQuote>();
    for (const [s, q] of all) if (q.regular) out.set(s, q);
    return out;
  }

  /** Chart requests made today (they share the day's budget, at most `CHART_SHARE` of it). */
  get chartsUsed(): number {
    return this.#charts;
  }

  /** Starts a new day's count; throws while backing off or past the day's budget. */
  #spend(now: number, chart: boolean): void {
    const day = new Date(now).toISOString().slice(0, 10);
    if (day !== this.#day) {
      this.#day = day;
      this.#used = 0;
      this.#charts = 0;
    }
    if (now < this.#notBefore) throw new Error("yahoo: backing off");
    if (this.#used >= this.#c.daily_budget) {
      this.lastError = "今天的請求次數用完了";
      throw new Error("yahoo: the day's request budget is spent");
    }
    if (chart && this.#charts >= Math.floor(this.#c.daily_budget * CHART_SHARE))
      throw new Error("yahoo: the day's chart budget is spent");
    this.#used++;
    if (chart) this.#charts++;
  }

  /** One GET of `url`: the text, or a throw (429 and 5xx marked to back off). */
  async #get(url: string, signal?: AbortSignal): Promise<string> {
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), this.#c.timeout_ms);
    try {
      const res = await this.#fetch(url, {
        method: "GET",
        headers: { accept: "application/json", "user-agent": USER_AGENT },
        redirect: "error",
        referrerPolicy: "no-referrer",
        credentials: "omit",
        signal: controller.signal,
      });
      if (res.status === 429 || res.status >= 500)
        throw Object.assign(new Error(`yahoo: HTTP ${res.status}`), { backoff: true });
      if (!res.ok) throw new Error(`yahoo: HTTP ${res.status}`);
      const text = await res.text();
      if (text.length > MAX_BYTES) throw new Error("yahoo: the answer is too big");
      return text;
    } catch (error) {
      // A network failure or a timeout backs off like a 429.
      if (error instanceof Error && !/^yahoo: /.test(error.message))
        Object.assign(error, { backoff: true });
      throw error;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }

  #backOff(now: number): void {
    this.#failures++;
    this.#notBefore = now + Math.min(this.#c.max_backoff_seconds, 15 * 2 ** this.#failures) * 1000;
  }

  /** Everything the response says of each symbol (a lookup validates a new ticker with it). */
  async describe(
    symbols: readonly string[],
    now: number,
    signal?: AbortSignal,
  ): Promise<Map<string, YahooQuote>> {
    if (symbols.length === 0) return new Map();
    this.#spend(now, false);
    const url = `https://${this.#c.host}/v7/finance/spark?symbols=${symbols.map(encodeURIComponent).join(",")}&range=1d&interval=5m`;
    try {
      const parsed = parseSpark(JSON.parse(await this.#get(url, signal)) as unknown);
      const missing = symbols.filter((s) => !parsed.has(s));
      this.#failures = 0;
      this.lastError = missing.length > 0 ? `沒有讀到:${missing.join("、")}` : null;
      return parsed;
    } catch (error) {
      this.#backOff(now);
      this.lastError = String(error instanceof Error ? error.message : error);
      throw error;
    }
  }

  /**
   * One symbol's candles for a timeframe (the chart endpoint), oldest first. Asked only when
   * someone opens a chart, never for the whole universe; within the day's budget and its backoff.
   * A 429, a 5xx or no answer backs off every request; an answer that does not parse only fails.
   */
  async candles(
    symbol: string,
    tf: Timeframe,
    now: number,
    signal?: AbortSignal,
  ): Promise<Candle[]> {
    this.#spend(now, true);
    const { range, interval } = YAHOO_SPAN[tf];
    const url = `https://${this.#c.host}/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=${interval}`;
    let text: string;
    try {
      text = await this.#get(url, signal);
    } catch (error) {
      if ((error as { backoff?: boolean }).backoff) this.#backOff(now);
      throw error;
    }
    this.#failures = 0;
    let json: unknown;
    try {
      json = JSON.parse(text) as unknown;
    } catch {
      throw new Error("yahoo: the chart is not JSON");
    }
    const parsed = parseYahooCandles(json, tf);
    if (parsed === null) throw new Error("yahoo: not a chart response");
    return parsed.candles;
  }
}
