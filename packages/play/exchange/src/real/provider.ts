// Where real prices come from (owner 2026-11-21). Every provider sits behind `QuoteProvider` and is
// injected; none is wired to a real data vendor in this pass. Two come with the exchange:
//
// - `HttpJsonProvider`: a configurable JSON endpoint (a URL template and field paths from config),
//   with a rate limit per provider, a cache, backoff after a failure, a timeout and a size cap. It
//   sends nothing about who asks (a generic user agent, no referrer, no cookies), never follows a
//   redirect, and only ever calls the host its template names.
// - `FixtureProvider`: a recorded series, for tests and the offline simulation; it can be told to
//   be down for a while (an outage).
//
// What a provider answers is untrusted numbers. `QuoteGuard` checks each one before the exchange
// may use it: a finite positive price in a sane range, a timestamp neither in the future nor too
// old, and a jump bigger than the instrument's class believes only when a second, later fetch
// confirms it. Provider text never reaches a prompt: only the numbers are kept.

import type { MarketKind, RealInstrument } from "./instruments.js";

/** One quote as a provider gave it. `price` is in the quote's own currency. */
export interface RawQuote {
  symbol: string;
  price: number;
  /** When the provider says the price is from (epoch ms). */
  at: number;
  /** The previous session's close, when the provider gives it. */
  prev_close?: number;
}

export interface QuoteProvider {
  readonly id: string;
  /**
   * The latest quote of each symbol it can answer (missing: it cannot). Throws when the provider
   * cannot be reached at all (an outage); the exchange then uses no quote of it.
   */
  quotes(
    symbols: readonly string[],
    now: number,
    signal?: AbortSignal,
  ): Promise<Map<string, RawQuote>>;
}

// ---- the recorded one -----------------------------------------------------------------------

export interface FixtureSeries {
  /** Points per symbol, oldest first. */
  series: Record<string, { at: number; price: number }[]>;
  /** Times the provider is down. */
  outages?: { from: number; to: number }[];
}

export class FixtureProvider implements QuoteProvider {
  constructor(
    readonly id: string,
    private readonly data: FixtureSeries,
  ) {}

  async quotes(symbols: readonly string[], now: number): Promise<Map<string, RawQuote>> {
    if ((this.data.outages ?? []).some((o) => now >= o.from && now < o.to))
      throw new Error(`${this.id} is down`);
    const out = new Map<string, RawQuote>();
    for (const symbol of symbols) {
      const points = this.data.series[symbol] ?? [];
      let last: { at: number; price: number } | undefined;
      for (const p of points) {
        if (p.at > now) break;
        last = p;
      }
      if (last) out.set(symbol, { symbol, price: last.price, at: last.at });
    }
    return out;
  }
}

// ---- the configurable JSON one --------------------------------------------------------------

export interface HttpProviderConfig {
  id: string;
  /**
   * The URL: `{symbol}` for one symbol per request, `{symbols}` for a batch (joined by
   * `separator`). Its host may not contain a placeholder: it is the only host ever called.
   */
  url: string;
  separator: string;
  /** Dot paths into the JSON; `{symbol}` is replaced by the symbol (`data.{symbol}.price`). */
  price_path: string;
  time_path: string | null;
  time_unit: "s" | "ms" | "iso";
  prev_close_path: string | null;
  /** Requests per minute at most. */
  rate_per_minute: number;
  /** A symbol fetched this recently is answered from the cache. */
  cache_seconds: number;
  timeout_ms: number;
  /** After a failure, wait 2^n seconds, at most this long. */
  max_backoff_seconds: number;
  /** An API key read from this environment variable, sent as this header or query parameter. */
  api_key_env: string | null;
  api_key_header: string | null;
  api_key_param: string | null;
}

/** The largest response read. */
const MAX_BYTES = 1_000_000;

type Fetch = (url: string, init: RequestInit) => Promise<Response>;

/** The value at a dot path, `null` when it is not there. */
export function pathValue(json: unknown, path: string): unknown {
  let at: unknown = json;
  for (const key of path.split(".")) {
    if (key === "") continue;
    if (at === null || typeof at !== "object") return null;
    at =
      Array.isArray(at) && /^\d+$/.test(key)
        ? at[Number(key)]
        : (at as Record<string, unknown>)[key];
  }
  return at ?? null;
}

function numberOf(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && /^-?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(v.trim())) return Number(v);
  return null;
}

function timeOf(v: unknown, unit: HttpProviderConfig["time_unit"]): number | null {
  if (unit === "iso") {
    if (typeof v !== "string") return null;
    const ms = Date.parse(v);
    return Number.isFinite(ms) ? ms : null;
  }
  const n = numberOf(v);
  if (n === null) return null;
  return unit === "s" ? n * 1000 : n;
}

export class HttpJsonProvider implements QuoteProvider {
  readonly id: string;
  readonly #c: HttpProviderConfig;
  readonly #fetch: Fetch;
  readonly #env: Readonly<Record<string, string | undefined>>;
  readonly #host: string;
  readonly #cache = new Map<string, { quote: RawQuote; fetched: number }>();
  /** Request times in the last minute. */
  #sent: number[] = [];
  #failures = 0;
  #notBefore = 0;

  constructor(
    config: HttpProviderConfig,
    fetch: Fetch = globalThis.fetch.bind(globalThis),
    env: Readonly<Record<string, string | undefined>> = process.env,
  ) {
    const host = /^https:\/\/([^/?#]+)/.exec(config.url)?.[1];
    if (!host || host.includes("{"))
      throw new Error(`provider ${config.id}: the URL must be https:// with a fixed host`);
    this.id = config.id;
    this.#c = config;
    this.#fetch = fetch;
    this.#env = env;
    this.#host = host;
  }

  async quotes(
    symbols: readonly string[],
    now: number,
    signal?: AbortSignal,
  ): Promise<Map<string, RawQuote>> {
    const out = new Map<string, RawQuote>();
    const want: string[] = [];
    for (const s of symbols) {
      const hit = this.#cache.get(s);
      if (hit && now - hit.fetched < this.#c.cache_seconds * 1000) out.set(s, hit.quote);
      else want.push(s);
    }
    if (want.length === 0) return out;
    if (now < this.#notBefore) {
      if (out.size > 0) return out;
      throw new Error(`${this.id}: backing off`);
    }
    const batches = this.#c.url.includes("{symbols}") ? [want] : want.map((s) => [s]);
    let failed: unknown = null;
    for (const batch of batches) {
      this.#sent = this.#sent.filter((t) => now - t < 60_000);
      if (this.#sent.length >= this.#c.rate_per_minute) break; // the rest waits for the next pass
      this.#sent.push(now);
      try {
        const json = await this.#get(batch, signal);
        for (const symbol of batch) {
          const q = this.#read(json, symbol, now);
          if (q) {
            out.set(symbol, q);
            this.#cache.set(symbol, { quote: q, fetched: now });
          }
        }
        this.#failures = 0;
      } catch (error) {
        failed = error;
        this.#failures++;
        this.#notBefore = now + Math.min(this.#c.max_backoff_seconds, 2 ** this.#failures) * 1000;
        break;
      }
    }
    if (failed !== null && out.size === 0) throw failed;
    return out;
  }

  async #get(batch: readonly string[], signal?: AbortSignal): Promise<unknown> {
    let url = this.#c.url
      .replace(
        "{symbols}",
        batch.map(encodeURIComponent).join(encodeURIComponent(this.#c.separator)),
      )
      .replace("{symbol}", encodeURIComponent(batch[0] ?? ""));
    const headers: Record<string, string> = {
      accept: "application/json",
      "user-agent": "Mozilla/5.0",
    };
    const key = this.#c.api_key_env ? this.#env[this.#c.api_key_env] : undefined;
    if (key && this.#c.api_key_header) headers[this.#c.api_key_header] = key;
    if (key && this.#c.api_key_param)
      url += `${url.includes("?") ? "&" : "?"}${encodeURIComponent(this.#c.api_key_param)}=${encodeURIComponent(key)}`;
    if (new URL(url).host !== this.#host) throw new Error(`${this.id}: not the configured host`);
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), this.#c.timeout_ms);
    try {
      const res = await this.#fetch(url, {
        method: "GET",
        headers,
        redirect: "error",
        referrerPolicy: "no-referrer",
        credentials: "omit",
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`${this.id}: HTTP ${res.status}`);
      const text = await res.text();
      if (text.length > MAX_BYTES) throw new Error(`${this.id}: the answer is too big`);
      return JSON.parse(text) as unknown;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }

  #read(json: unknown, symbol: string, now: number): RawQuote | null {
    const at = (p: string) => pathValue(json, p.replaceAll("{symbol}", symbol));
    const price = numberOf(at(this.#c.price_path));
    if (price === null) return null;
    const time =
      this.#c.time_path === null ? now : timeOf(at(this.#c.time_path), this.#c.time_unit);
    if (time === null) return null;
    const prev = this.#c.prev_close_path === null ? null : numberOf(at(this.#c.prev_close_path));
    return { symbol, price, at: time, ...(prev === null ? {} : { prev_close: prev }) };
  }
}

// ---- checking what came back ----------------------------------------------------------------

/**
 * How big a move between two accepted quotes is believed at once, by market (log move): Taiwan has
 * a ±10% daily limit, so more than that is a bad number until a second fetch confirms it.
 */
export const JUMP_BY_MARKET: Readonly<Record<MarketKind, number>> = {
  tw: 0.12,
  us: 0.3,
  crypto: 0.4,
  local: 0.12,
};

export interface GuardLimits {
  /** Older than this (ms) is stale. */
  max_age_ms: number;
  jump: Readonly<Record<MarketKind, number>>;
  /** A confirming quote is within this share of the suspect one. */
  confirm_within: number;
}

/** An accepted quote: a price in the instrument's own currency, and when it is from. */
export interface Quote {
  code: string;
  price: number;
  at: number;
  prev_close: number | null;
}

export type GuardResult =
  | { ok: true; quote: Quote; confirmed: boolean }
  | { ok: false; why: "number" | "range" | "future" | "stale" | "old" | "jump" };

interface GuardState {
  good: Quote | null;
  /** A jump seen once, waiting for a later fetch to confirm it. */
  suspect: { price: number; at: number } | null;
}

export class QuoteGuard {
  readonly #state = new Map<string, GuardState>();

  constructor(private readonly limits: GuardLimits) {}

  /** The last accepted quote of `code`. */
  last(code: string): Quote | null {
    return this.#state.get(code)?.good ?? null;
  }

  /** Forgets an instrument's last quote (a confirmed split starts it again). */
  forget(code: string): void {
    this.#state.delete(code);
  }

  /** Seeds the last accepted quote (a restart reads it back from the store). */
  seed(q: Quote): void {
    this.#state.set(q.code, { good: q, suspect: null });
  }

  check(inst: RealInstrument, raw: RawQuote, now: number): GuardResult {
    const st = this.#state.get(inst.code) ?? { good: null, suspect: null };
    this.#state.set(inst.code, st);
    if (!Number.isFinite(raw.price) || !Number.isFinite(raw.at))
      return { ok: false, why: "number" };
    const price = raw.price;
    if (!(price > 0) || price > 1e9) return { ok: false, why: "range" };
    if (raw.at > now + 60_000) return { ok: false, why: "future" };
    if (now - raw.at > this.limits.max_age_ms) return { ok: false, why: "stale" };
    if (st.good && raw.at < st.good.at) return { ok: false, why: "old" };
    const prev =
      raw.prev_close !== undefined && Number.isFinite(raw.prev_close) && raw.prev_close > 0
        ? raw.prev_close
        : null;
    const quote: Quote = { code: inst.code, price, at: raw.at, prev_close: prev };
    if (st.good) {
      const move = Math.abs(Math.log(price / st.good.price));
      if (move > this.limits.jump[inst.market]) {
        const s = st.suspect;
        if (s && raw.at > s.at && Math.abs(price / s.price - 1) <= this.limits.confirm_within) {
          st.good = quote;
          st.suspect = null;
          return { ok: true, quote, confirmed: true };
        }
        st.suspect = { price, at: raw.at };
        return { ok: false, why: "jump" };
      }
    }
    st.good = quote;
    st.suspect = null;
    return { ok: true, quote, confirmed: false };
  }
}
