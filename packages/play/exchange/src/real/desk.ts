// `RealDesk`: v1 of the exchange as people use it (owner 2026-11-21): paper trading of real Taiwan
// and US stocks with fish coins, the house as the counterparty (`house.ts`). It asks the providers
// for quotes while a market is open, keeps only what `QuoteGuard` accepts, lets the house fill the
// orders waiting for a quote and check every leveraged position, writes what changed in one
// transaction and posts what the wallets are owed under their keys.
//
// - Hours: each market trades in its own session (Taiwan 09:00–13:30 Taipei; US regular session,
//   with daylight saving from the zone; holidays from config). An order placed while its market is
//   closed waits and fills at the first valid quote after the open; it can be cancelled before.
//   A market whose provider gives only each day's close (`quotes_<market> = "close"`) fills at the
//   next close.
// - Market orders only, at the first valid quote later than the order (so nobody trades at a price
//   they already saw). The one anti-churn rule: a holding can be sold `min_hold_minutes` after it
//   was bought. One fee on every trade, burned.

import { type Logger, SerialQueue } from "@miyoria/runtime/kernel";
import {
  type AccountRef,
  DEFAULT_CURRENCY,
  EXCHANGE_DISCLAIMER,
  type ExchangeEntry,
  type ExchangeWallet,
  exchangeDisclaimer,
  newId,
  type PersonId,
  type Timestamp,
  toTimestamp,
} from "@miyoria/types";
import {
  type ExchangeConfig,
  houseParams,
  localCompaniesOf,
  OTHER_SECTOR,
  type StarterEntry,
  sessionsOf,
  starterEntries,
} from "../config.js";
import {
  checkOpen,
  type GuardRefusal,
  limitsFor,
  over,
  type Rules,
  sizeRule,
  type Trader,
} from "../engine/guards.js";
import { feeOn } from "../engine/money.js";
import type { ExchangeStore } from "../store.js";
import {
  type Candle,
  CandleCache,
  candlesFromPoints,
  candleTtl,
  SPAN_DAYS,
  type Timeframe,
} from "./candles.js";
import {
  adminSellReal,
  buysHalted,
  cancelRealOrder,
  equityOf,
  type HouseBook,
  type HouseContext,
  type HouseOutcome,
  type HouseParams,
  isBankrupt,
  netToday,
  onQuote,
  placeRealBuy,
  placeRealSell,
  priceAtRatio,
  QTY_REAL,
  type RealNotice,
  type RealOrder,
  rollDay,
  settleAt,
  splitRealBuy,
  valueAt,
  worthOf,
} from "./house.js";
import {
  currencyOf,
  fromCoins,
  isOpenAt,
  lastCloseAt,
  type MarketKind,
  nextCloseAt,
  nextOpenAt,
  type Rates,
  type RealInstrument,
  type Session,
  shortDate,
  taipeiWhen,
  toCoins,
  tradingDate,
} from "./instruments.js";
import { type LocalCompany, LocalProvider, type LocalSignalFeed, lastTick } from "./local.js";
import {
  type HeldValue,
  holdingsMap,
  LOCAL_SECTOR,
  type MapData,
  type MapKind,
  starterMap,
} from "./maps.js";
import {
  QuoteGuard as Guard,
  JUMP_BY_MARKET,
  type Quote,
  type QuoteGuard,
  type QuoteProvider,
  type RawQuote,
} from "./provider.js";
import type {
  InstrumentRecord,
  InstrumentStatus,
  RealNoticeRecord,
  RealOrderRecord,
} from "./store.js";
import { CHART_SHARE, type YahooQuote } from "./yahoo.js";

/** A ticker's candles for one timeframe, and where they came from. */
export interface CandleSet {
  line: RealLine;
  tf: Timeframe;
  candles: Candle[];
  /** The bars carry volume (Yahoo's); the local stocks and bars made from ticks do not. */
  volume: boolean;
  /** The market's zone: the bars' dates and times are read in it. */
  zone: string;
  /** `provider`: the chart endpoint; `ticks`: made from the quotes kept here. */
  source: "provider" | "ticks";
  /** The provider could not answer and these are older than their time to live. */
  stale: boolean;
}

/** A member's own lines on a chart, in the ticker's own currency. */
export interface ChartMarks {
  /** What their shares cost on average (every lot, 1× and 2×). */
  avg_cost: number | null;
  /** Where each 2× position is sold by the rule. */
  liquidation: number[];
}

/** The exchange's coins in and out over a window, and against the coins in wallets. */
export interface MintWindow {
  days: number;
  burned: number;
  minted: number;
  net: number;
  /** `net` over all coins in wallets (`null`: the economy cannot say). */
  share: number | null;
}

export interface MintReport {
  windows: MintWindow[];
  /** All coins in wallets now (`null`: the economy cannot say). */
  circulation: number | null;
  warn_share: number;
  /** A plain warning when the 7-day net is past `warn_share` of the coins in wallets. */
  warning: string | null;
}

/** The base small print (the shared constant, `exchangeSmallPrint`). */
export const DISCLAIMER = EXCHANGE_DISCLAIMER;
/** On the rules: fish coins never become money or goods (`currency`: the profile's coin name). */
export function noExchangeRule(currency: string = DEFAULT_CURRENCY): string {
  return `${currency}永遠不能換成真錢或現實中的物品,也不能用真錢或物品買${currency},在伺服器裡外都一樣。`;
}
/** `noExchangeRule` with the default coin name. */
export const NO_EXCHANGE_RULE = noExchangeRule();
/** On the rules: no dividends here. */
export const NO_DIVIDENDS = "不發放股息;除息日股價下跌屬正常。";
/** What a 2x order's confirmation always says. */
export const LEVERAGE_WARNING =
  "可能賠掉保證金以外的錢,最壞會賠光錢包和其他持股。價格跳空時,可能沒有先通知就被自動賣出。";

const DAY_MS = 86_400_000;
/** One chart point per instrument at most this often. */
const TICK_EVERY_MS = 5 * 60_000;

export type Refusal = { ok: false; status: number; code: string; message: string };
const refuse = (status: number, code: string, message: string): Refusal => ({
  ok: false,
  status,
  code,
  message,
});

/** Who is asking, as the exchange's account layer knows them. */
export interface Asker {
  person: PersonId;
  name: string;
  trader: Trader;
  rules: Rules;
}

export interface RealDeskDeps {
  config: ExchangeConfig;
  store: ExchangeStore;
  wallet: () => ExchangeWallet | null;
  providers: ReadonlyMap<string, QuoteProvider>;
  now: () => number;
  log: Logger;
  /** Her real things' daily signals for the local stocks (none: they walk alone). */
  signals?: LocalSignalFeed;
  /** The account layer: who is asking, their trader facts and the rules; `null` for a stranger. */
  ask: (account: AccountRef) => Promise<Asker | null>;
  newId?: () => string;
  /** The coins' name (`CurrencyKey`); none: the wallet's, else the default. */
  currency?: () => string;
  /** How texts name her (`[character] pronoun`); none: 她. */
  pronoun?: () => string;
}

/**
 * What a line's price is: `quote`, a quote of the session in progress; `close`, the last price of
 * an earlier session (its market is closed, or today's first quote has not come yet): the
 * provider's previous close or the last quote kept here, shown and used to value holdings, never
 * traded at; `reference`, a local stock before its first tick: its anchor, the opening reference.
 */
export type PriceBasis = "quote" | "close" | "reference";

export interface RealLine {
  code: string;
  /** The display name: the owner's, else the starter list's, else the provider's (in full). */
  name: string;
  market: MarketKind;
  /**
   * The last known price in the instrument's own currency (`TWD`, `USD`): see `basis`; `null`
   * only when nothing at all is known yet (a real ticker before its first answer).
   */
  price: number | null;
  basis: PriceBasis | null;
  /** The trading date of the price in its market's zone (`YYYY-MM-DD`; `null`: a reference). */
  price_date: string | null;
  /** What the price is, in words, when it is not a live quote (`收盤價(11/20)・休市中`). */
  price_note: string | null;
  /** When its market next opens, while it is closed (`null`: open now). */
  next_open: Timestamp | null;
  currency: "TWD" | "USD" | "COIN";
  /**
   * One of the five local stocks tied to her (新手推薦 · 這裡獨家): what moves it, in one sentence,
   * and what moved today's open, in numbers from her day (`null`: nothing known yet).
   */
  local: { what_moves: string; today: string | null } | null;
  /** The same in fish coins at today's fixed rates. */
  coin_price: number | null;
  /** How old a live quote is, in minutes (the source states no delay; its own time is shown); `null` for a close or a reference. */
  age_minutes: number | null;
  /** `資料來源:Yahoo Finance`, or the provider's id. */
  source: string;
  /** From the close before it, as a fraction (a close: that session's own move). */
  change: number | null;
  at: Timestamp | null;
  /** Its market is in session now. */
  open: boolean;
  /** The last quote is older than the maximum age (an intraday market in session). */
  stale: boolean;
  quotes: "intraday" | "close";
}

export interface RealMarketView {
  enabled: boolean;
  currency: string;
  instruments: RealLine[];
  /** Each market: in session, and whether its quotes are flowing (`stale`: no valid quote, trading paused). */
  sessions: {
    market: MarketKind;
    open: boolean;
    hours: string;
    zone: string;
    stale: boolean;
    notice: string | null;
  }[];
  rates: Rates;
  house: { buys_halted: boolean; net_today: number; cap_daily: number };
  rules: {
    fee: number;
    fee_min: number;
    order_min: number;
    order_max: number;
    orders_per_day: number;
    buy_per_day: number;
    limit_total: number;
    min_hold_minutes: number;
    leverage: boolean;
    leverage_line: number;
    leverage_min_days: number;
    leverage_min_tier: string;
    margin_cap: number;
    account_min_days: number;
    account_min_tier: string;
    bankrupt_cooling_days: number;
    quote_max_age_seconds: number;
    payout_cap_daily: number;
  };
  disclaimer: string;
  no_exchange: string;
  no_dividends: string;
}

export interface RealHolding {
  id: string;
  code: string;
  name: string;
  leverage: number;
  qty: number;
  cost: number;
  margin: number;
  loan: number;
  price: number | null;
  value: number | null;
  equity: number | null;
  ratio: number | null;
  line_price: number | null;
  warn_half_price: number | null;
  warn_near_price: number | null;
  opened_at: Timestamp;
  /** It may be sold now (past the hold time, no sale already waiting). */
  can_sell: boolean;
}

export interface RealOrderLine {
  id: string;
  code: string;
  side: "buy" | "sell";
  coins: number;
  qty: number;
  leverage: number;
  position: string | null;
  status: string;
  why: string | null;
  at: Timestamp;
  /** A waiting order whose market is closed: when it opens (it fills at the first valid quote after). */
  next_open: Timestamp | null;
}

export interface RealPortfolio {
  holdings: RealHolding[];
  orders: RealOrderLine[];
  fills: {
    id: string;
    code: string;
    side: string;
    kind: string;
    qty: number;
    price: number;
    gross: number;
    fee: number;
    paid: number;
    shortfall: number;
    leverage: number;
    at: Timestamp;
  }[];
  notices: { id: string; kind: string; text: string; at: Timestamp }[];
  bankrupt: { since: Timestamp; until: Timestamp; written_off: number } | null;
  totals: { cost: number; value: number };
}

export interface RealQuote {
  side: "buy" | "sell";
  code: string;
  price: number | null;
  open: boolean;
  coins: number;
  margin: number;
  exposure: number;
  fee: number;
  qty: number;
  leverage: number;
  gross: number;
  net: number;
  line_price: number | null;
  /** The price above is not a live quote: what it is (`收盤價(11/20)`); the fill is at the next valid quote. */
  price_note: string | null;
  /** The market is closed: when it opens (Taipei time in `sentence`). */
  next_open: Timestamp | null;
  sentence: string;
  warning: string | null;
}

export interface RealOrderRequest {
  side: "buy" | "sell";
  code: string;
  /** A buy's coins (fee included); on a sale, that many coins' worth at the price known now. */
  coins?: number;
  /**
   * Shares (six decimals): a sale of a plain holding, or a 1x buy by shares (priced at the latest
   * quote, fee included, rounded up to whole coins) when `coins` is not given.
   */
  shares?: number;
  all?: boolean;
  /** 1 or 2. */
  leverage?: number;
  /** A sale that closes this position (leveraged, or one plain lot). */
  position?: string;
}

export interface RealReport {
  today: {
    day: number;
    date: string;
    burned: number;
    minted: number;
    net: number;
    written_off: number;
    buys_halted: boolean;
  };
  days: {
    day: number;
    date: string;
    burned: number;
    minted: number;
    net: number;
    written_off: number;
  }[];
  cap_daily: number;
  bankrupt: { person: PersonId; since: Timestamp; until: Timestamp; written_off: number }[];
  quotes: {
    code: string;
    price: number | null;
    at: Timestamp | null;
    refused: number;
    last_refusal: string | null;
  }[];
  lines: Record<string, number>;
  /** The wallets' view against the house's lines: equal when the books balance. */
  books: { postings: number; lines: number; pending: number };
}

/** A local stock's tick stands for an hour, and a few minutes more for the poll. */
const LOCAL_MAX_AGE_MS = 65 * 60_000;
/** A previous close the provider could not give is asked for again after this long. */
const CLOSE_RETRY_MS = 30 * 60_000;
/** The provider is asked for a session's close this long after it, when it has it. */
const CLOSE_SETTLE_MS = 2 * 60_000;
/** A provider's name is kept whole up to this length (longer: cut at a word, with an ellipsis). */
const NAME_MAX = 200;

/** The provider's name as stored: whitespace collapsed, whole (never cut inside a word). */
export function cleanName(raw: string, fallback: string): string {
  const t = raw.replace(/\s+/g, " ").trim();
  if (t === "") return fallback;
  if (t.length <= NAME_MAX) return t;
  const cut = t.slice(0, NAME_MAX);
  const space = cut.lastIndexOf(" ");
  return `${space > NAME_MAX / 2 ? cut.slice(0, space) : cut}…`;
}

/** The newest of what is known of a ticker's price, in its own currency. */
interface Known {
  price: number;
  prev: number | null;
  at: number;
  /** It is the quote kept here (else the provider's close fetched while closed). */
  quote: boolean;
}

/** A line's price and what it is. */
interface Shown {
  price: number;
  prev: number | null;
  at: number | null;
  basis: PriceBasis;
}

const finitePositive = (x: unknown): x is number =>
  typeof x === "number" && Number.isFinite(x) && x > 0 && x < 1e9;

const dateOf = (day: number) => new Date(day * DAY_MS).toISOString().slice(0, 10);

export class RealDesk {
  readonly #d: RealDeskDeps;
  readonly #turns = new SerialQueue();
  readonly #guards: Record<"intraday" | "close" | "hourly", QuoteGuard>;
  readonly params: HouseParams;
  readonly sessions: Record<MarketKind, Session>;
  #seeded = false;
  #nextPoll = 0;
  #local: LocalProvider | null = null;
  /** Symbols that did not validate, until when (a cache so junk cannot spend the budget). */
  readonly #negative = new Map<string, { until: number; why: string }>();
  /** Lookups per person in the current hour. */
  readonly #lookups = new Map<string, { hour: number; n: number }>();
  /** The provider's candles per (symbol, timeframe). */
  readonly #candleCache = new CandleCache();
  /** Previous closes asked for: when (a failure waits `CLOSE_RETRY_MS`) and for which close. */
  readonly #closeAsked = new Map<string, number>();
  readonly #closeAnswered = new Map<string, number>();
  /** The starter lists' display names by symbol, for the config they came from. */
  #names: { config: ExchangeConfig; byCode: Map<string, string> } | null = null;

  constructor(deps: RealDeskDeps) {
    this.#d = deps;
    this.params = houseParams(deps.config);
    this.sessions = sessionsOf(deps.config);
    const c = deps.config;
    this.#guards = {
      intraday: new Guard({
        max_age_ms: c.quote_max_age_seconds * 1000,
        jump: JUMP_BY_MARKET,
        confirm_within: 0.02,
      }),
      close: new Guard({ max_age_ms: 4 * DAY_MS, jump: JUMP_BY_MARKET, confirm_within: 0.02 }),
      // The local stocks tick once an hour: their last tick is good until the next.
      hourly: new Guard({
        max_age_ms: LOCAL_MAX_AGE_MS,
        jump: JUMP_BY_MARKET,
        confirm_within: 0.02,
      }),
    };
  }

  get config(): ExchangeConfig {
    return this.#d.config;
  }

  #now(): number {
    return this.#d.now();
  }

  #day(): number {
    return Math.floor((this.#now() + this.#d.config.utc_offset_minutes * 60_000) / DAY_MS);
  }

  #id(): string {
    return (this.#d.newId ?? newId)();
  }

  /** The coins' name: the profile's (one source), else the wallet's, else the default. */
  #currency(): string {
    return this.#d.currency?.() ?? this.#d.wallet()?.currency ?? DEFAULT_CURRENCY;
  }

  /** The coins' name, for the texts the service and the commands build around the desk. */
  get currency(): string {
    return this.#currency();
  }

  #localCache: { config: ExchangeConfig; pronoun: string; list: LocalCompany[] } | null = null;

  /** The five local stocks as the profile names them, in role order. */
  localCompanies(): readonly LocalCompany[] {
    const config = this.#d.config;
    const pronoun = this.#d.pronoun?.() ?? "她";
    const c = this.#localCache;
    if (c && c.config === config && c.pronoun === pronoun) return c.list;
    const list = localCompaniesOf(config, pronoun);
    this.#localCache = { config, pronoun, list };
    return list;
  }

  /** The local stock of `code` (`null`: not one of the five). */
  localOf(code: string): LocalCompany | null {
    return this.localCompanies().find((l) => l.code === code) ?? null;
  }

  /** Every instrument people have looked up and not removed (any status). */
  instruments(): RealInstrument[] {
    return this.#rows().map((i) => this.#instOf(i));
  }

  #rows(): InstrumentRecord[] {
    return this.#d.store.real.instrumentList().filter((i) => i.status !== "removed");
  }

  #instOf(i: InstrumentRecord): RealInstrument {
    return {
      code: i.code,
      name: this.#displayName(i),
      market: i.market,
      provider: i.provider,
      symbol: i.code,
      enabled: i.status === "active" || i.status === "blocked",
    };
  }

  /** The owner's name for it, else its starter list's, else the provider's (stored whole). */
  #displayName(i: Pick<InstrumentRecord, "code" | "name" | "name_override">): string {
    if (i.name_override) return i.name_override;
    // A local stock is named by the profile, whatever name its row was first stored with.
    const local = this.localOf(i.code);
    if (local) return local.name;
    const c = this.#d.config;
    if (this.#names?.config !== c) {
      const byCode = new Map<string, string>();
      for (const e of [...starterEntries(c.starters_tw), ...starterEntries(c.starters_us)])
        if (e.name) for (const code of candidates(e.code)) byCode.set(code, e.name);
      this.#names = { config: c, byCode };
    }
    return this.#names.byCode.get(i.code) ?? i.name;
  }

  /**
   * The newest price known of `row`: the quote kept here, or the provider's previous close
   * fetched while the market was closed, whichever is later.
   */
  #known(
    row: InstrumentRecord,
    quotes: ReadonlyMap<string, { price: number; at: number; prev_close: number | null }>,
  ): Known | null {
    const q = quotes.get(row.code);
    const c = row.close;
    if (c && (!q || c.at > q.at))
      return { price: c.price, prev: c.prev_close, at: c.at, quote: false };
    return q ? { price: q.price, prev: q.prev_close, at: q.at, quote: true } : null;
  }

  /**
   * What a line shows: a quote of the session in progress, else the last close (the market is
   * closed, or today's first quote has not come), else a local stock's anchor before its first
   * tick (the opening reference). In the instrument's own currency.
   */
  #shown(
    inst: RealInstrument,
    row: InstrumentRecord,
    quotes: ReadonlyMap<string, { price: number; at: number; prev_close: number | null }>,
    now: number,
  ): Shown | null {
    const k = this.#known(row, quotes);
    if (!k) {
      if (inst.market !== "local") return null;
      const anchor = this.localOf(inst.code)?.anchor;
      return anchor === undefined
        ? null
        : { price: anchor, prev: null, at: null, basis: "reference" };
    }
    const s = this.sessions[inst.market];
    const live =
      k.quote &&
      isOpenAt(s, now) &&
      this.#inSession(inst, k.at) &&
      tradingDate(s, k.at) === tradingDate(s, now);
    return { price: k.price, prev: k.prev, at: k.at, basis: live ? "quote" : "close" };
  }

  /**
   * The last known price of `code` in coins, live or not: what holdings are valued at (the
   * portfolio, the rich list, the holdings map, the owner's page) when there is no live quote.
   * Never what an order fills at.
   */
  #markPrice(code: string): number | null {
    const row = this.#d.store.real.instrument(code);
    if (!row || row.status === "removed") return null;
    const inst = this.#instOf(row);
    const live = this.#guard(inst).last(code);
    const quotes = new Map(this.#d.store.real.quotes());
    if (live) {
      const stored = quotes.get(code);
      if (!stored || live.at > stored.at)
        quotes.set(code, { ...live, refused: 0, last_refusal: null });
    }
    const shown = this.#shown(inst, row, quotes, this.#now());
    return shown ? toCoins(shown.price, inst.market, this.rates) : null;
  }

  #status(code: string): InstrumentStatus | null {
    return this.#d.store.real.instrument(code)?.status ?? null;
  }

  /**
   * What the pass asks quotes for (owner 2026-11-21: polling scales with what is in use): tickers with
   * an open position, a waiting order, viewed in the last `view_minutes`, or on the watch list of
   * someone active in the last `watch_active_days` while the ticker's market is open.
   */
  pollSet(): RealInstrument[] {
    const book = this.#book();
    const now = this.#now();
    const used = new Set([...book.positions.map((p) => p.code), ...book.orders.map((o) => o.code)]);
    const viewed = this.#d.config.view_minutes * 60_000;
    // Watched tickers of people active lately, only while their market is open.
    const watched = this.#d.store.real.watchedByActive(
      now - this.#d.config.watch_active_days * DAY_MS,
    );
    return this.instruments().filter((i) => {
      if (i.market === "local") return this.#d.config.local_stocks;
      const st = this.#status(i.code);
      if (st === "paused" || st === "suspended") return used.has(i.code);
      const row = this.#d.store.real.instrument(i.code);
      return (
        used.has(i.code) ||
        (watched.has(i.code) && isOpenAt(this.sessions[i.market], now)) ||
        (row?.last_viewed_at !== null &&
          row?.last_viewed_at !== undefined &&
          now - row.last_viewed_at < viewed)
      );
    });
  }

  /**
   * The refresh actually reached: one batch per market per pass, stretched so the day's request
   * budget lasts through both sessions (about 11 hours).
   */
  effectiveInterval(): number {
    const c = this.#d.config;
    const set = this.pollSet();
    const batches = (["tw", "us"] as const).reduce(
      (t, m) => t + Math.ceil(set.filter((i) => i.market === m).length / c.batch_size),
      0,
    );
    // Charts may take `CHART_SHARE` of the budget; the quotes keep the rest.
    const perMinute = (c.yahoo.daily_budget * (1 - CHART_SHARE)) / (11 * 60);
    return Math.max(c.quote_poll_seconds, Math.ceil((batches / Math.max(perMinute, 0.001)) * 60));
  }

  /** The providers, with the local stocks' own. */
  #provider(id: string): QuoteProvider | undefined {
    if (id === "local" && !this.#d.providers.has("local")) {
      const feed = this.#d.signals;
      this.#local ??= new LocalProvider(
        this.#d.store.state()?.seed ?? "local",
        feed ? (role, day) => feed.signal(role, day) : () => null,
        () => this.localCompanies(),
        (code) => {
          const q = this.#d.store.real.quotes().get(code);
          return q ? { price: q.price, at: q.at, prev_close: q.prev_close } : null;
        },
        feed ? (days, now) => feed.prepare(days, now) : undefined,
      );
      return this.#local;
    }
    return this.#d.providers.get(id);
  }

  /** The five local stocks are always listed (unless switched off). */
  #ensureLocal(): void {
    if (!this.#d.config.local_stocks) return;
    const now = this.#now();
    for (const local of this.localCompanies()) {
      const code = local.code;
      const row = this.#d.store.real.instrument(code);
      // A code unlisted while no profile named it is listed again once one does.
      if (row?.market === "local" && row.status === "removed")
        this.#d.store.real.setInstrument(code, { status: "active" }, now);
      if (row) continue;
      this.#d.store.real.addInstrument(
        {
          code,
          market: "local",
          name: local.name,
          exchange: "LOCAL",
          type: "LOCAL",
          currency: "COIN",
          provider: "local",
          status: "active",
          added_at: now,
          added_by: null,
        },
        now,
      );
    }
  }

  get rates(): Rates {
    return {
      twd_per_coin: this.#d.wallet()?.twdPerCoin ?? 1,
      twd_per_usd: this.#d.config.twd_per_usd,
    };
  }

  /** A native quote in coins at today's fixed rates. */
  #coins(inst: RealInstrument, q: Quote): Quote {
    const r = this.rates;
    return {
      ...q,
      price: toCoins(q.price, inst.market, r),
      prev_close: q.prev_close === null ? null : toCoins(q.prev_close, inst.market, r),
    };
  }

  #inst(code: string): RealInstrument | null {
    return this.instruments().find((i) => i.code === code) ?? null;
  }

  #mode(market: MarketKind): "intraday" | "close" {
    return market === "tw"
      ? this.#d.config.quotes_tw
      : market === "us"
        ? this.#d.config.quotes_us
        : "intraday";
  }

  /** Whether `q` counts for its market: inside a session (a close: up to the grace after it). */
  #inSession(inst: RealInstrument, at: number): boolean {
    const s = this.sessions[inst.market];
    // The closing print comes a moment after the close: still that session.
    if (isOpenAt(s, at) || isOpenAt(s, at - 10 * 60_000)) return true;
    return (
      this.#mode(inst.market) === "close" &&
      isOpenAt(s, at - this.#d.config.close_grace_minutes * 60_000)
    );
  }

  #guard(inst: RealInstrument): QuoteGuard {
    return inst.market === "local" ? this.#guards.hourly : this.#guards[this.#mode(inst.market)];
  }

  /** How old a quote of `market` may be and still be traded at. */
  #maxAge(market: MarketKind): number {
    return market === "local" ? LOCAL_MAX_AGE_MS : this.#d.config.quote_max_age_seconds * 1000;
  }

  #seed(): void {
    if (this.#seeded) return;
    this.#seeded = true;
    for (const inst of this.instruments()) {
      const q = this.#d.store.real.quotes().get(inst.code);
      if (q)
        this.#guard(inst).seed({
          code: q.code,
          price: q.price,
          at: q.at,
          prev_close: q.prev_close,
        });
    }
  }

  /** The latest valid quote of `code`: fresh (intraday) and inside its session. */
  #latest(code: string): Quote | null {
    const inst = this.#inst(code);
    if (!inst) return null;
    const q = this.#guard(inst).last(code);
    if (!q || !this.#inSession(inst, q.at)) return null;
    if (this.#mode(inst.market) === "intraday" && this.#now() - q.at > this.#maxAge(inst.market))
      return null;
    return this.#coins(inst, q);
  }

  /** The last accepted quote in coins, however old (what a holding is valued at). */
  #lastKnown(code: string): Quote | null {
    const native = this.#lastNative(code);
    const inst = this.#inst(code);
    return native && inst ? this.#coins(inst, native) : null;
  }

  /** The last accepted quote in the instrument's own currency. */
  #lastNative(code: string): Quote | null {
    const inst = this.#inst(code);
    const stored = this.#d.store.real.quotes().get(code);
    return (
      (inst ? this.#guard(inst).last(code) : null) ??
      (stored ? { code, price: stored.price, at: stored.at, prev_close: stored.prev_close } : null)
    );
  }

  #book(): HouseBook {
    return this.#d.store.real.book(this.#day(), this.#now());
  }

  #ctx(balances: ReadonlyMap<string, number>): HouseContext {
    return {
      now: this.#now(),
      day: this.#day(),
      params: this.params,
      newId: () => this.#id(),
      instruments: this.instruments(),
      balance: (p) => balances.get(p) ?? 0,
      latest: (c) => this.#latest(c),
      lastKnown: (c) => this.#lastKnown(c),
    };
  }

  async #balances(book: HouseBook): Promise<Map<string, number>> {
    const wallet = this.#d.wallet();
    const out = new Map<string, number>();
    if (!wallet) return out;
    for (const p of new Set([
      ...book.positions.map((x) => x.person),
      ...book.orders.map((x) => x.person),
    ]))
      out.set(p, await wallet.balance(p));
    return out;
  }

  // ---- the pass -----------------------------------------------------------------------------

  /** A new day, the buys left half charged, the quotes of every market in session. */
  async tick(): Promise<void> {
    await this.#turns.run(async () => {
      this.#ensureLocal();
      this.#seed();
      await this.#recoverCharging();
      const book = this.#book();
      const newDay = book.state.today.day !== this.#day();
      const rolled = rollDay(book, this.#ctx(new Map()));
      if (newDay || rolled.changed.length > 0) {
        this.#d.store.real.commit(rolled, book, this.#now(), this.#day());
        this.#countMissing();
      }
      if (!this.#d.config.open) {
        await this.#closeAll("closed");
        return;
      }
      await this.#poll();
    });
    // Outside the turn: a starter's first quote takes a turn of its own.
    if (this.#d.config.open) await this.#discoverStarters();
    await this.postLosses();
  }

  async #poll(): Promise<void> {
    const now = this.#now();
    // Stretched past the configured interval only when the day's request budget needs it.
    const every = this.effectiveInterval();
    if (every > this.#d.config.quote_poll_seconds) {
      if (now < this.#nextPoll) return;
      this.#nextPoll = now + every * 1000 - 5_000;
    }
    const byProvider = new Map<string, RealInstrument[]>();
    for (const inst of this.pollSet()) {
      const s = this.sessions[inst.market];
      const due =
        isOpenAt(s, now) ||
        (this.#mode(inst.market) === "close" &&
          isOpenAt(s, now - this.#d.config.close_grace_minutes * 60_000));
      if (!due) continue;
      byProvider.set(inst.provider, [...(byProvider.get(inst.provider) ?? []), inst]);
    }
    for (const [id, list] of byProvider) {
      const provider = this.#provider(id);
      if (!provider) continue;
      const quotes = new Map<
        string,
        { symbol: string; price: number; at: number; prev_close?: number }
      >();
      try {
        for (let i = 0; i < list.length; i += this.#d.config.batch_size) {
          for (const [k, v] of await provider.quotes(
            list.slice(i, i + this.#d.config.batch_size).map((x) => x.symbol),
            now,
          ))
            quotes.set(k, v);
        }
      } catch (error) {
        // Blocked or broken: stop asking and let the quotes go stale; nothing trades or is sold on old data.
        this.#d.log.info(
          { provider: id, err: String(error) },
          "exchange: no quotes from a provider",
        );
        if (quotes.size === 0) continue;
      }
      for (const inst of list) {
        const raw = quotes.get(inst.symbol);
        if (!raw) continue;
        const prev = this.#guard(inst).last(inst.code);
        if (prev && raw.at <= prev.at) continue; // nothing new
        const r = this.#guard(inst).check(inst, raw, now);
        if (!r.ok) {
          this.#d.store.real.refuseQuote(inst.code, r.why, now);
          // A jump by a clean small ratio with no reason in the market is a split: the ticker pauses
          // for the owner to confirm the share change; nothing is filled or sold on it meanwhile.
          const split = r.why === "jump" && prev ? splitRatio(prev.price, raw.price) : null;
          if (split)
            this.#d.store.real.setInstrument(
              inst.code,
              { status: "paused", reason: split.label },
              now,
            );
          continue;
        }
        if (!this.#inSession(inst, r.quote.at)) continue;
        const st = this.#status(inst.code);
        if (st === "paused" || st === "suspended") continue;
        this.#d.store.real.setInstrument(
          inst.code,
          { last_quote_at: r.quote.at, missing_days: 0 },
          now,
        );
        await this.#onQuote(inst, r.quote);
      }
    }
    await this.#refreshCloses(now);
  }

  /**
   * The previous close of every real ticker that lacks its market's last one while that market is
   * closed (a Sunday, a fresh instance, a ticker never polled), and anything at all of one never
   * quoted while its market is open and nobody polls it: one request per provider batch, asked
   * once per close (a failure again after `CLOSE_RETRY_MS`). It is shown and values holdings;
   * orders still wait for the open.
   */
  async #refreshCloses(now: number): Promise<void> {
    const quotes = this.#d.store.real.quotes();
    const polled = new Set(this.pollSet().map((i) => i.code));
    const byProvider = new Map<string, { inst: RealInstrument; last: number }[]>();
    for (const row of this.#rows()) {
      if (row.market !== "tw" && row.market !== "us") continue;
      if (row.status === "paused" || row.status === "suspended") continue;
      const inst = this.#instOf(row);
      const s = this.sessions[inst.market];
      const open = isOpenAt(s, now);
      if (open && polled.has(inst.code)) continue;
      const last = lastCloseAt(s, now);
      if (last === null || now < last + CLOSE_SETTLE_MS) continue;
      const known = this.#known(row, quotes);
      if (known && known.at >= last - 60_000) continue;
      if (open && known) continue;
      if (this.#closeAnswered.get(inst.code) === last) continue;
      if (now - (this.#closeAsked.get(inst.code) ?? 0) < CLOSE_RETRY_MS) continue;
      byProvider.set(inst.provider, [...(byProvider.get(inst.provider) ?? []), { inst, last }]);
    }
    for (const [id, list] of byProvider) {
      const provider = this.#provider(id) as
        | (QuoteProvider & {
            describe?: (s: readonly string[], now: number) => Promise<Map<string, YahooQuote>>;
          })
        | undefined;
      if (!provider) continue;
      for (let i = 0; i < list.length; i += this.#d.config.batch_size) {
        const batch = list.slice(i, i + this.#d.config.batch_size);
        for (const { inst } of batch) this.#closeAsked.set(inst.code, now);
        let got: Map<string, RawQuote | YahooQuote>;
        try {
          const symbols = batch.map((b) => b.inst.symbol);
          got = provider.describe
            ? await provider.describe(symbols, now)
            : await provider.quotes(symbols, now);
        } catch (error) {
          this.#d.log.info(
            { provider: id, err: String(error) },
            "exchange: no previous closes from a provider",
          );
          break;
        }
        for (const { inst, last } of batch) {
          const q = got.get(inst.symbol);
          if (!q) continue;
          this.#closeAnswered.set(inst.code, last);
          await this.#absorb(inst, q, now);
        }
      }
    }
  }

  /**
   * One answer of the provider about `inst` outside the usual poll: a quote of the session in
   * progress goes through the guard like any other; anything else is kept as its last close
   * (shown and used to value holdings, never traded at), when it is newer than what is known. A
   * provider's name, when it gives one, replaces a stored one cut short by an older version.
   */
  async #absorb(inst: RealInstrument, q: RawQuote | YahooQuote, now: number): Promise<void> {
    const store = this.#d.store.real;
    const row = store.instrument(inst.code);
    if (!row) return;
    const name = "name" in q && typeof q.name === "string" ? cleanName(q.name, row.name) : null;
    if (name !== null && name !== row.name && name.length > row.name.length)
      store.setInstrument(inst.code, { name }, now);
    if (!finitePositive(q.price) || !Number.isFinite(q.at) || q.at > now + 60_000) return;
    const regular = "regular" in q ? q.regular : false;
    if (regular && isOpenAt(this.sessions[inst.market], now) && this.#inSession(inst, q.at)) {
      const g = this.#guard(inst).check(inst, q, now);
      if (g.ok) await this.#onQuote(inst, g.quote);
      return;
    }
    const known = this.#known(row, store.quotes());
    if (known && known.at >= q.at) return;
    store.setInstrument(
      inst.code,
      {
        close: {
          price: q.price,
          prev_close: finitePositive(q.prev_close) ? q.prev_close : null,
          at: q.at,
        },
      },
      now,
    );
  }

  async #onQuote(inst: RealInstrument, quote: Quote): Promise<void> {
    const store = this.#d.store.real;
    const prevStored = store.quotes().get(inst.code);
    // The day's reference: the provider's previous close, else the last price of an earlier day.
    const prevClose =
      quote.prev_close ??
      (prevStored &&
      dateOf(Math.floor(prevStored.at / DAY_MS)) !== dateOf(Math.floor(quote.at / DAY_MS))
        ? prevStored.price
        : (prevStored?.prev_close ?? null));
    const q: Quote = { ...quote, prev_close: prevClose };
    store.saveQuote(q, this.#now());
    store.tick(inst.code, q.at, q.price, TICK_EVERY_MS);
    const book = this.#book();
    const out = onQuote(book, inst, this.#coins(inst, q), this.#ctx(await this.#balances(book)));
    this.#commit(out, book);
  }

  #commit(
    out: HouseOutcome,
    book: HouseBook,
    extra: { placed?: RealOrderRecord[]; by?: string | null } = {},
  ): void {
    this.#d.store.real.commit(out, book, this.#now(), this.#day(), {
      ...extra,
      notices: this.#notices(out),
    });
  }

  #notices(out: HouseOutcome): RealNoticeRecord[] {
    const at = toTimestamp(this.#now());
    return out.notices.map((n) => ({
      id: this.#id(),
      person: n.person,
      kind: n.kind,
      position: n.position,
      text: noticeText(n, this.#inst(n.code)?.name ?? n.code, this.#currency()),
      created_at: at,
      quiet: n.kind === "shortfall",
    }));
  }

  /** Losses past the margin to take from wallets: posted now; one the wallet cannot cover in full is cut to what it can, and the rest written off. */
  async postLosses(): Promise<void> {
    const wallet = this.#d.wallet();
    if (!wallet) return;
    for (const p of this.#d.store.real.pendingLosses()) {
      try {
        const r = await wallet.post(p.person, p.entries, p.ref, true);
        if (r.ok) {
          this.#d.store.postingPosted(p.key, toTimestamp(this.#now()));
          continue;
        }
        if (r.reason !== "short") continue;
        const want = -p.entries.reduce((t, e) => t + e.delta, 0);
        const can = Math.max(0, Math.min(want, r.balance));
        const entries: ExchangeEntry[] | null =
          can > 0 ? p.entries.map((e) => ({ ...e, delta: -can, key: `${e.key}:cut` })) : null;
        this.#d.store.real.replaceLoss(p.key, entries, this.#now(), {
          person: p.person,
          amount: want - can,
          day: this.#day(),
        });
      } catch {
        return;
      }
    }
  }

  async #recoverCharging(): Promise<void> {
    const wallet = this.#d.wallet();
    if (!wallet) return;
    for (const o of this.#d.store.real.charging()) {
      const key = `exchange:order:${o.id}`;
      const charged = await wallet.posted(o.person, `${key}:exchange_burn`);
      this.#d.store.real.settleBuy(o.id, key, charged, this.#now());
    }
  }

  /** The master switch off: every open order goes back. */
  async #closeAll(why: string): Promise<void> {
    const book = this.#book();
    if (book.orders.length === 0) return;
    for (const o of [...book.orders]) {
      const out = cancelRealOrder(book, o.id, why);
      if (out) this.#commit(out, book);
    }
  }

  // ---- what anyone sees ---------------------------------------------------------------------

  view(): RealMarketView {
    const c = this.#d.config;
    const now = this.#now();
    const quotes = this.#d.store.real.quotes();
    const state = this.#d.store.real.state();
    const hours = (s: Session) => `${s.open}–${s.close}`;
    return {
      enabled: c.open,
      currency: this.#currency(),
      instruments: this.#rows().map((row) => this.#line(row, quotes, now)),
      sessions: (["tw", "us"] as const).map((m) => {
        const open = isOpenAt(this.sessions[m], now);
        const list = this.instruments().filter((i) => i.market === m);
        const stale =
          open &&
          this.#mode(m) === "intraday" &&
          list.length > 0 &&
          list.some((i) => this.#latest(i.code) === null);
        return {
          market: m,
          open,
          hours: hours(this.sessions[m]),
          zone: this.sessions[m].zone,
          stale,
          notice: stale ? "報價沒有更新,這個市場暫停成交;持股不會因為沒有報價被賣出" : null,
        };
      }),
      rates: this.rates,
      house: {
        buys_halted: state ? buysHalted(state) && state.today.day === this.#day() : false,
        net_today: state && state.today.day === this.#day() ? netToday(state) : 0,
        cap_daily: c.payout_cap_daily,
      },
      rules: {
        fee: c.fee,
        fee_min: c.fee_min,
        order_min: c.order_min,
        order_max: c.order_max,
        orders_per_day: c.orders_per_day,
        buy_per_day: c.buy_per_day,
        limit_total: c.limit_total,
        min_hold_minutes: c.min_hold_minutes,
        leverage: c.leverage,
        leverage_line: c.leverage_line,
        leverage_min_days: c.leverage_min_days,
        leverage_min_tier: c.leverage_min_tier,
        margin_cap: c.leverage_margin_cap,
        account_min_days: c.account_min_days,
        account_min_tier: c.account_min_tier,
        bankrupt_cooling_days: c.bankrupt_cooling_days,
        quote_max_age_seconds: c.quote_max_age_seconds,
        payout_cap_daily: c.payout_cap_daily,
      },
      disclaimer: exchangeDisclaimer(this.#currency()),
      no_exchange: noExchangeRule(this.#currency()),
      no_dividends: NO_DIVIDENDS,
    };
  }

  /** One ticker's line: its last known price, what that price is, its market's state. */
  #line(
    row: InstrumentRecord,
    quotes: ReadonlyMap<string, { price: number; at: number; prev_close: number | null }>,
    now: number,
  ): RealLine {
    const i = this.#instOf(row);
    const q = quotes.get(i.code) ?? null;
    const session = this.sessions[i.market];
    const open = isOpenAt(session, now);
    const shown = this.#shown(i, row, quotes, now);
    const local = i.market === "local" ? this.localOf(i.code) : null;
    const date = shown && shown.at !== null ? tradingDate(session, shown.at) : null;
    const next = open ? null : nextOpenAt(session, now);
    const note =
      shown === null || shown.basis === "quote"
        ? null
        : shown.basis === "reference"
          ? `開盤參考價・第一筆價格在 ${taipeiWhen(open ? (lastTick(now) ?? now) : (next ?? now))}`
          : `收盤價(${shortDate(date ?? "")})・${open ? "等今天第一筆報價" : "休市中"}`;
    return {
      code: i.code,
      name: i.name,
      market: i.market,
      price: shown?.price ?? null,
      basis: shown?.basis ?? null,
      price_date: date,
      price_note: note,
      next_open: next === null ? null : toTimestamp(next),
      currency: currencyOf(i.market),
      coin_price: shown
        ? Math.round(toCoins(shown.price, i.market, this.rates) * 10_000) / 10_000
        : null,
      age_minutes:
        shown?.basis === "quote" && shown.at !== null
          ? Math.max(0, Math.round((now - shown.at) / 60_000))
          : null,
      source:
        i.provider === "yahoo"
          ? "資料來源:Yahoo Finance"
          : i.provider === "local"
            ? "這裡獨家:價格由程式模擬"
            : `資料來源:${i.provider}`,
      local:
        i.market === "local"
          ? {
              what_moves: local?.what_moves ?? "",
              today: local
                ? (this.#d.signals?.line(local.role, now, this.#d.pronoun?.() ?? "她") ?? null)
                : null,
            }
          : null,
      change:
        shown && shown.prev !== null && shown.prev > 0
          ? Math.round((shown.price / shown.prev - 1) * 10_000) / 10_000
          : null,
      at: shown && shown.at !== null ? toTimestamp(shown.at) : null,
      open,
      stale:
        q !== null &&
        open &&
        this.#mode(i.market) === "intraday" &&
        now - q.at > this.#maxAge(i.market),
      quotes: this.#mode(i.market),
    };
  }

  /** An instrument's chart points (oldest first) and its line. */
  history(
    code: string,
    days = 14,
    /** Counts as a view (keeps the ticker polled for a while); an overview's sparkline does not. */
    viewed = true,
  ): { line: RealLine; points: { at: Timestamp; price: number }[] } | null {
    const line = this.view().instruments.find((i) => i.code === code);
    if (!line) return null;
    if (viewed)
      this.#d.store.real.setInstrument(code, { last_viewed_at: this.#now() }, this.#now());
    const points = this.#d.store.real
      .ticks(code, this.#now() - days * DAY_MS)
      .map((t) => ({ at: toTimestamp(t.at), price: t.price }));
    return { line, points };
  }

  // ---- charts and maps ----------------------------------------------------------------------

  /**
   * A ticker's candles for `tf`. A real stock's come from its provider's chart endpoint when it has
   * one (on demand, cached per symbol and timeframe, inside the provider's budget); when it cannot
   * answer, the last ones it gave, else bars made from the quotes kept here. The local stocks' are
   * made from their own hourly ticks, with no volume. Opening a chart counts as a view.
   */
  async candles(code: string, tf: Timeframe, viewed = true): Promise<CandleSet | null> {
    const inst = this.#inst(code);
    const line = this.view().instruments.find((i) => i.code === code);
    if (!inst || !line) return null;
    const now = this.#now();
    if (viewed) this.#d.store.real.setInstrument(code, { last_viewed_at: now }, now);
    const zone = this.sessions[inst.market].zone;
    const set = (candles: Candle[], source: CandleSet["source"], stale: boolean): CandleSet => ({
      line,
      tf,
      candles,
      volume: source === "provider" && candles.some((c) => c.v !== null && c.v > 0),
      zone,
      source,
      stale,
    });
    const fromTicks = (stale: boolean) => set(this.#tickCandles(inst, tf, now), "ticks", stale);
    if (inst.market === "local") return fromTicks(false);
    const provider = this.#provider(inst.provider) as
      | (QuoteProvider & {
          candles?: (symbol: string, tf: Timeframe, now: number) => Promise<Candle[]>;
        })
      | undefined;
    if (!provider?.candles) return fromTicks(false);
    const load = provider.candles.bind(provider);
    const key = CandleCache.key(inst.symbol, tf);
    const fresh = this.#candleCache.fresh(key, now);
    if (fresh) return set(fresh, "provider", false);
    const got = await this.#candleCache.once(key, async () => {
      try {
        const candles = await load(inst.symbol, tf, now);
        this.#candleCache.set(key, candles, now, candleTtl(tf, line.open));
        return candles;
      } catch (error) {
        this.#d.log.info(
          { code, tf, err: String(error) },
          "exchange: no candles from the provider",
        );
        return null;
      }
    });
    if (got) return set(got, "provider", false);
    const old = this.#candleCache.any(key);
    return old ? set(old, "provider", true) : fromTicks(true);
  }

  #tickCandles(inst: RealInstrument, tf: Timeframe, now: number): Candle[] {
    const points = this.#d.store.real.ticks(inst.code, now - (SPAN_DAYS[tf] + 2) * DAY_MS);
    return candlesFromPoints(
      points,
      tf,
      this.sessions[inst.market].zone,
      inst.market === "local" ? 3_600_000 : TICK_EVERY_MS,
    );
  }

  /** `person`'s own lines on `code`'s chart: their average cost and each 2× position's line. */
  marks(person: PersonId, code: string): ChartMarks {
    const inst = this.#inst(code);
    if (!inst) return { avg_cost: null, liquidation: [] };
    const mine = this.#book().positions.filter((p) => p.person === person && p.code === code);
    const qty = mine.reduce((t, p) => t + p.qty, 0);
    const cost = mine.reduce((t, p) => t + p.cost, 0);
    const native = (coins: number) =>
      Math.round(fromCoins(coins, inst.market, this.rates) * 10_000) / 10_000;
    return {
      avg_cost: qty > 0 ? native(cost / (qty / QTY_REAL)) : null,
      liquidation: mine
        .filter((p) => p.leverage > 1)
        .map((p) => native(priceAtRatio(p, this.params.line))),
    };
  }

  /**
   * A heat map's tiles: what the server holds (counts and totals only, a ticker held by too few
   * people merged into 其他), or a starter list with its configured sectors and weights. A 熱門 map
   * counts as a view of its tickers, so their quotes are asked for in the usual batches while
   * someone keeps the map open.
   */
  map(kind: MapKind, viewed = true): MapData {
    const now = this.#now();
    const lines = new Map(this.view().instruments.map((l) => [l.code, l]));
    if (kind === "holdings") {
      const held: HeldValue[] = this.#book().positions.flatMap((p) => {
        const price = this.#markPrice(p.code);
        return price === null ? [] : [{ person: p.person, code: p.code, value: worthOf(p, price) }];
      });
      const sectors = new Map<string, string>();
      for (const m of ["tw", "us"] as const)
        for (const s of this.starterLines(m)) sectors.set(s.code, s.entry.sector);
      return holdingsMap({
        held,
        lines,
        sectorOf: (l) =>
          l.market === "local" ? LOCAL_SECTOR : (sectors.get(l.code) ?? OTHER_SECTOR),
        minHolders: this.#d.config.map_min_holders,
        maxShare: this.#d.config.map_max_share,
        currency: this.#currency(),
      });
    }
    const entries = this.starterLines(kind).map((s) => ({
      entry: s.entry,
      line: lines.get(s.code) ?? null,
    }));
    if (viewed)
      for (const { line } of entries) {
        if (!line) continue;
        const seen = this.#d.store.real.instrument(line.code)?.last_viewed_at ?? null;
        if (seen === null || now - seen > 60_000)
          this.#d.store.real.setInstrument(line.code, { last_viewed_at: now }, now);
      }
    return starterMap(kind, entries, this.#d.config.map_max_share);
  }

  /**
   * The exchange's coins in and out today, over 7 and over 30 local days, against all coins in
   * wallets, with a plain warning when the 7-day net is past `mint_warn_share` of them (a warning
   * only: nothing is halted by it).
   */
  async mintReport(): Promise<MintReport> {
    const s = this.#d.store.real.state() ?? this.#book().state;
    let circulation: number | null = null;
    try {
      const wallet = this.#d.wallet();
      circulation = wallet?.circulation ? await wallet.circulation() : null;
    } catch {
      circulation = null;
    }
    return mintReportOf(
      [...s.history, s.today],
      this.#day(),
      circulation,
      this.#d.config.mint_warn_share,
      this.#currency(),
    );
  }

  // ---- orders -------------------------------------------------------------------------------

  #holdingsCost(book: HouseBook, person: PersonId): { cost: number; margin: number } {
    let cost = 0;
    let margin = 0;
    for (const p of book.positions)
      if (p.person === person) {
        cost += p.cost;
        if (p.leverage > 1) margin += p.margin;
      }
    for (const o of book.orders)
      if (o.person === person && o.side === "buy") {
        cost += o.exposure;
        if (o.leverage > 1) margin += o.margin;
      }
    return { cost, margin };
  }

  async #check(
    account: AccountRef,
    req: RealOrderRequest,
  ): Promise<
    | {
        ok: true;
        quote: RealQuote;
        asker: Asker;
        book: HouseBook;
        split: { margin: number; exposure: number; fee: number } | null;
        qty: number;
        position: string | null;
      }
    | Refusal
  > {
    const c = this.#d.config;
    if (!c.open) return refuse(409, "closed", "交易所現在沒有開");
    const inst = this.#inst(req.code);
    if (!inst) return refuse(404, "instrument", "沒有這個標的(先查詢代號)");
    const status = this.#status(inst.code);
    if (status === "paused")
      return refuse(409, "paused", "這檔疑似分割或合併股數,暫停交易,等 owner 確認");
    if (status === "suspended")
      return refuse(409, "suspended", "這檔好幾個交易日沒有報價,暫停交易,等 owner 處理");
    if (req.side === "buy" && (status === "blocked" || this.#blockedByConfig(inst.code)))
      return refuse(409, "blocked", "這檔不開放買進(可以賣出)");
    const asker = await this.#d.ask(account);
    if (!asker) return refuse(403, "stranger", "她還不認識你,先和她說說話吧");
    const book = this.#book();
    const t = asker.trader;
    if (!t.opened) return refuse(409, "no_account", "還沒開戶");
    const now = this.#now();
    // The estimate: a live quote, else the last known price (a close, a local stock's opening
    // reference), said as such. An order always fills at the first valid quote after it.
    const live = this.#latest(inst.code);
    const mark = live?.price ?? this.#markPrice(inst.code);
    const latest = mark === null ? null : { price: mark };
    const row = this.#d.store.real.instrument(inst.code);
    const shownLine = row ? this.#line(row, this.#d.store.real.quotes(), now) : null;
    const priceNote = live ? null : (shownLine?.price_note ?? null);
    const est = live ? "照現價" : priceNote ? `照${priceNote.split("・")[0]}估` : "照現價";
    const session = this.sessions[inst.market];
    const open = isOpenAt(session, now);
    const next = open ? null : nextOpenAt(session, now);
    const counted = this.#d.store.real.countedToday(asker.person, this.#dayStartMs());
    if (counted.orders >= c.orders_per_day)
      return refuse(409, "orders", `一天最多 ${c.orders_per_day} 筆委託`);
    const when = this.#whenText(inst.market, now);
    if (req.side === "buy") {
      const no: GuardRefusal | null = checkOpen(asker.rules, t);
      if (no) return refuse(403, no.code, no.message);
      const b = book.state.bankrupt[asker.person];
      if (isBankrupt(book.state, asker.person, now) && b)
        return refuse(
          403,
          "bankrupt",
          `破產冷靜期到 ${new Date(b.until).toISOString().slice(0, 10)},之前不能買進`,
        );
      if (buysHalted(book.state) && book.state.today.day === this.#day())
        return refuse(
          409,
          "cap",
          `今天交易所發出的${this.#currency()}到上限了,今天停止買進(賣出照常)`,
        );
      // A buy by shares (the local stocks' ticket default): what those shares cost now, fee
      // included, in whole coins. It still fills at the next valid quote, so the shares may differ
      // a little; 1x only.
      let coins = req.coins ?? 0;
      if (req.coins === undefined && req.shares !== undefined) {
        const px = latest?.price ?? null;
        if (px === null)
          return refuse(409, "no_quote", `還沒有報價,請用${this.#currency()}金額下單`);
        if (!(req.shares > 0) || (req.leverage ?? 1) !== 1)
          return refuse(409, "qty", "照股數買只能 1 倍、股數要大於 0");
        const exposure = Math.ceil(req.shares * px - 1e-9);
        coins = exposure + feeOn(exposure, c.fee, c.fee_min);
      }
      if (!Number.isSafeInteger(coins) || coins < c.order_min || over(coins, c.order_max))
        return refuse(409, "size", sizeRule(c.order_min, c.order_max, this.#currency()));
      const leverage = req.leverage === 2 ? 2 : 1;
      if (req.leverage !== undefined && req.leverage !== 1 && req.leverage !== 2)
        return refuse(409, "leverage", "槓桿只有 1 倍或 2 倍");
      if (leverage > 1) {
        if (!c.leverage) return refuse(409, "leverage_off", "槓桿現在沒有開放");
        if (inst.market === "local")
          return refuse(409, "leverage_local", "新手推薦的獨家股票不開放槓桿,只能 1 倍");
        const q = this.#lastKnown(inst.code);
        if (!q || q.prev_close === null || q.price < c.leverage_min_coin_price) {
          return refuse(
            409,
            "leverage_ticker",
            `這檔只能 1 倍:2 倍只開放一股至少 ${c.leverage_min_coin_price} ${this.#currency()}、有前一天收盤價的標的`,
          );
        }
        if (t.tier < asker.rules.leverage_min_tier)
          return refuse(403, "leverage_tier", `2 倍要羈絆到「${c.leverage_min_tier}」以上`);
        if (t.known_days < asker.rules.leverage_min_days)
          return refuse(
            403,
            "leverage_young",
            `2 倍要她認識你滿 ${asker.rules.leverage_min_days} 天`,
          );
        if (!t.leverage_opt_in) return refuse(409, "leverage_opt_in", "要先看過並同意槓桿的風險");
      }
      if (over(counted.bought + coins, c.buy_per_day))
        return refuse(
          409,
          "daily",
          `一天最多買 ${c.buy_per_day} ${this.#currency()}(今天還能買 ${Math.max(0, c.buy_per_day - counted.bought)})`,
        );
      const wallet = this.#d.wallet();
      if (!wallet) return refuse(503, "wallet", "錢包現在打不開");
      const balance = await wallet.balance(asker.person);
      const transferred = await wallet.transferredIn(
        asker.person,
        toTimestamp(now - c.transfer_lock_hours * 3_600_000),
      );
      if (coins > balance - Math.max(0, transferred)) {
        return coins <= balance
          ? refuse(
              402,
              "transfer_lock",
              `別人轉給你的${this.#currency()}要過 ${c.transfer_lock_hours} 小時才能投入`,
            )
          : refuse(402, "short", `${this.#currency()}不夠`);
      }
      const split = splitRealBuy(coins, leverage, this.params);
      if (!split) return refuse(409, "size", "這筆太小了");
      const at = latest?.price ?? null;
      if (at !== null && Math.floor((split.exposure * QTY_REAL) / at) <= 0) {
        return refuse(409, "too_small", "金額太小,這檔一股太貴,連 0.000001 股都買不到");
      }
      const held = this.#holdingsCost(book, asker.person);
      const cap = limitsFor(asker.rules, t).total;
      if (over(held.cost + split.exposure, cap))
        return refuse(
          409,
          "limit_total",
          `持有上限是成本 ${cap} ${this.#currency()}(槓桿照全部部位算)`,
        );
      if (leverage > 1 && over(held.margin + split.margin, c.leverage_margin_cap))
        return refuse(
          409,
          "margin_cap",
          `槓桿的保證金合計最多 ${c.leverage_margin_cap} ${this.#currency()}`,
        );
      const price = latest?.price ?? null;
      const qty = price ? Math.floor((split.exposure * QTY_REAL) / price) : 0;
      const line =
        price && leverage > 1
          ? priceAtRatio(
              {
                id: "",
                person: "",
                code: "",
                leverage,
                qty,
                cost: split.exposure,
                margin: split.margin,
                loan: split.exposure - split.margin,
                carry: 0,
                opened_at: 0,
                warned_half: null,
                warned_near: null,
              },
              this.params.line,
            )
          : null;
      return {
        ok: true,
        asker,
        book,
        split,
        qty,
        position: null,
        quote: {
          side: "buy",
          code: inst.code,
          price,
          open,
          coins: split.margin + split.fee,
          margin: split.margin,
          exposure: split.exposure,
          fee: split.fee,
          qty,
          leverage,
          gross: 0,
          net: 0,
          line_price: line,
          price_note: priceNote,
          next_open: next === null ? null : toTimestamp(next),
          sentence:
            leverage > 1
              ? `付 ${split.margin + split.fee} ${this.#currency()}(保證金 ${split.margin}、手續費 ${split.fee}),買 2 倍的部位 ${split.exposure};${when}。${line ? `跌到約 ${line.toFixed(2)} 會依規則自動賣出。` : ""}`
              : `付 ${split.margin + split.fee} ${this.#currency()}(含手續費 ${split.fee}),${est}約 ${(qty / QTY_REAL).toFixed(4)} 股,${when}。買進後 ${c.min_hold_minutes} 分鐘才能賣。`,
          warning: leverage > 1 ? LEVERAGE_WARNING : null,
        },
      };
    }
    // A sale: one position (leveraged, or a lot), or the plain holdings of the instrument.
    const mine = book.positions.filter((p) => p.person === asker.person && p.code === inst.code);
    const pending = book.orders.filter(
      (o) => o.person === asker.person && o.side === "sell" && o.code === inst.code,
    );
    const sellable = (p: { opened_at: number }) => p.opened_at + this.params.min_hold_ms <= now;
    let qty = 0;
    let position: string | null = null;
    let gross = 0;
    let loan = 0;
    if (req.position) {
      const p = mine.find((x) => x.id === req.position);
      if (!p) return refuse(404, "no_position", "找不到這個持股");
      if (!sellable(p)) return refuse(409, "hold", `買進後 ${c.min_hold_minutes} 分鐘才能賣`);
      if (pending.some((o) => o.position === p.id))
        return refuse(409, "pending", "這筆已經有賣單在等了");
      qty = p.qty;
      position = p.id;
      loan = p.loan;
    } else {
      const lots = mine.filter((p) => p.leverage <= 1);
      if (lots.length === 0) return refuse(409, "no_holding", "沒有可以賣的持股");
      const free =
        lots.filter(sellable).reduce((t2, p) => t2 + p.qty, 0) -
        pending.filter((o) => o.position === null).reduce((t2, o) => t2 + o.qty, 0);
      if (free <= 0) return refuse(409, "hold", `買進後 ${c.min_hold_minutes} 分鐘才能賣`);
      if (!req.all && req.shares === undefined && req.coins !== undefined) {
        // A sale by coins: that many coins' worth at the price known now (the fill is at the next
        // valid quote, so what comes back may differ a little).
        const px = latest?.price ?? null;
        if (px === null) return refuse(409, "no_quote", "還沒有價格,請用股數賣出");
        if (!(req.coins > 0)) return refuse(409, "qty", "要賣多少?");
        qty = Math.min(free, Math.floor((req.coins / px) * QTY_REAL));
      } else qty = req.all ? free : Math.min(free, Math.round((req.shares ?? 0) * QTY_REAL));
      if (qty <= 0) return refuse(409, "qty", "要賣多少?(四捨五入後是 0 股)");
    }
    const price = latest?.price ?? null;
    if (price) gross = Math.floor(valueAt(qty, price));
    const fee = Math.max(
      0,
      Math.min(gross - loan, Math.max(c.fee_min, Math.ceil((gross - loan) * c.fee - 1e-9))),
    );
    return {
      ok: true,
      asker,
      book,
      split: null,
      qty,
      position,
      quote: {
        side: "sell",
        code: inst.code,
        price,
        open,
        coins: 0,
        margin: 0,
        exposure: 0,
        fee,
        qty,
        leverage: 1,
        gross,
        net: Math.max(0, gross - loan - fee),
        line_price: null,
        price_note: priceNote,
        next_open: next === null ? null : toTimestamp(next),
        sentence: `賣出 ${(qty / QTY_REAL).toFixed(4)} 股,${when};${est}大約拿回 ${Math.max(0, gross - loan - fee)} ${this.#currency()}(手續費 ${fee} 燒掉)。`,
        warning: loan > 0 && gross - loan < 0 ? LEVERAGE_WARNING : null,
      },
    };
  }

  /**
   * When an order placed now on `market` fills, in words: at the next valid quote while it is
   * open; else after the next open, in Taipei time (the US open with its daylight saving), and it
   * can be cancelled until then. A market quoted only at its close fills at the next close.
   */
  #whenText(market: MarketKind, now: number): string {
    const s = this.sessions[market];
    if (this.#mode(market) === "close") {
      const close = nextCloseAt(s, now);
      return close === null
        ? "下一個收盤價成交"
        : `在下一個收盤價成交(${taipeiWhen(close)} 台北時間,之前都可以取消)`;
    }
    if (isOpenAt(s, now)) return "下一筆有效報價成交";
    const next = nextOpenAt(s, now);
    return next === null
      ? "開盤後第一筆有效報價成交(之前都可以取消)"
      : `現在休市,下一個開盤 ${taipeiWhen(next)}(台北時間)後第一筆有效報價成交,之前都可以取消`;
  }

  /** When a waiting order of `code` is expected to fill, while its market is closed. */
  #orderNextOpen(code: string, now: number): Timestamp | null {
    const inst = this.#inst(code);
    if (!inst) return null;
    const s = this.sessions[inst.market];
    if (isOpenAt(s, now)) return null;
    const next = nextOpenAt(s, now);
    return next === null ? null : toTimestamp(next);
  }

  #dayStartMs(): number {
    return this.#day() * DAY_MS - this.#d.config.utc_offset_minutes * 60_000;
  }

  #blockedByConfig(code: string): boolean {
    const c = this.#d.config;
    return c.blocked.includes(code) || (c.allow_only.length > 0 && !c.allow_only.includes(code));
  }

  /**
   * Looks a ticker up by code: the stored row, or (the first time) the provider's answer, checked
   * against the allowed exchanges and types and added. Lookups are limited per person and a ticker
   * that did not validate is not asked again for a while.
   */
  async lookup(
    account: AccountRef,
    input: string,
  ): Promise<{ ok: true; instrument: RealLine } | Refusal> {
    const asker = await this.#d.ask(account);
    if (!asker) return refuse(403, "stranger", "她還不認識你,先和她說說話吧");
    const now = this.#now();
    const list = candidates(input);
    if (list.length === 0)
      return refuse(400, "code", "請打台股代號(例如 2330、0050)或美股代號(例如 AAPL)");
    for (const code of list) {
      const row = this.#d.store.real.instrument(code);
      if (row && row.status !== "removed") {
        this.#d.store.real.setInstrument(code, { last_viewed_at: now }, now);
        const line = this.view().instruments.find((i) => i.code === code);
        if (line) return { ok: true, instrument: line };
      }
    }
    const neg = list.map((c) => this.#negative.get(c)).find((n) => n && n.until > now);
    if (neg && list.every((c) => (this.#negative.get(c)?.until ?? 0) > now))
      return refuse(404, "unknown", neg.why);
    const hour = Math.floor(now / 3_600_000);
    const used = this.#lookups.get(asker.person);
    const n = used && used.hour === hour ? used.n : 0;
    if (n >= this.#d.config.lookups_per_hour)
      return refuse(429, "lookups", "查詢太頻繁了,晚一點再查新的代號");
    this.#lookups.set(asker.person, { hour, n: n + 1 });
    return this.#discover(list, asker.person);
  }

  /**
   * Validates the first of `list` the provider knows and stores it (`by`: who asked; `null` for
   * the starter lists). A code that does not validate is remembered for a while.
   */
  async #discover(
    list: readonly string[],
    by: PersonId | null,
  ): Promise<{ ok: true; instrument: RealLine } | Refusal> {
    const now = this.#now();
    let why = "找不到這個代號";
    for (const code of list) {
      if ((this.#negative.get(code)?.until ?? 0) > now) continue;
      const market: MarketKind = code.endsWith(".TW") || code.endsWith(".TWO") ? "tw" : "us";
      const provider = this.#d.providers.get(
        market === "tw" ? this.#d.config.provider_tw : this.#d.config.provider_us,
      ) as
        | (QuoteProvider & {
            describe?: (s: readonly string[], now: number) => Promise<Map<string, YahooQuote>>;
          })
        | undefined;
      if (!provider?.describe) return refuse(503, "provider", "報價來源現在不能查詢");
      let found: YahooQuote | undefined;
      try {
        found = (await provider.describe([code], now)).get(code);
      } catch {
        return refuse(503, "provider", "報價來源現在沒有回應,晚一點再試");
      }
      const no = this.#validate(found, market);
      if (no) {
        why = no;
        this.#negative.set(code, {
          until: now + this.#d.config.negative_cache_minutes * 60_000,
          why: no,
        });
        continue;
      }
      const q = found as YahooQuote;
      this.#d.store.real.addInstrument(
        {
          code,
          market,
          // Whole: a long name is ellipsized where it is drawn, by the room there.
          name: cleanName(q.name ?? "", code),
          exchange: q.exchange ?? "",
          type: q.type ?? "",
          currency: q.currency ?? "",
          provider: provider.id,
          status: this.#d.config.blocked.includes(code) ? "blocked" : "active",
          added_at: now,
          added_by: by,
        },
        now,
      );
      if (by !== null) this.#d.store.real.setInstrument(code, { last_viewed_at: now }, now);
      // Its price now: a quote when it is in session (the same checks as every quote), else the
      // provider's last close, kept to show (never traded at).
      const inst = this.#inst(code);
      if (inst) await this.#turns.run(() => this.#absorb(inst, q, now));
      const line = this.view().instruments.find((i) => i.code === code);
      if (line) return { ok: true, instrument: line };
    }
    return refuse(404, "unknown", why);
  }

  /** The starter lists' codes, each as the provider's symbol once it validated (`null`: not yet or never). */
  starters(market: "tw" | "us"): string[] {
    return this.starterLines(market).map((s) => s.code);
  }

  /** A starter list's entries (code, sector, weight) as configured, in order. */
  starterConfig(market: "tw" | "us"): StarterEntry[] {
    return starterEntries(
      market === "tw" ? this.#d.config.starters_tw : this.#d.config.starters_us,
    );
  }

  /** The starter list's validated symbols, each with its configured entry. */
  starterLines(market: "tw" | "us"): { code: string; entry: StarterEntry }[] {
    const out: { code: string; entry: StarterEntry }[] = [];
    for (const entry of this.starterConfig(market)) {
      const hit = candidates(entry.code).find((c) => {
        const row = this.#d.store.real.instrument(c);
        return row !== null && row.status !== "removed" && row.market === market;
      });
      if (hit) out.push({ code: hit, entry });
    }
    return out;
  }

  /** Validates a few starter codes not yet known (the pass calls it; failures drop silently). */
  async #discoverStarters(max = 3): Promise<void> {
    const now = this.#now();
    let asked = 0;
    for (const market of ["tw", "us"] as const) {
      for (const { code: typed } of this.starterConfig(market)) {
        if (asked >= max) return;
        const list = candidates(typed).filter((c) =>
          market === "tw" ? c.endsWith(".TW") || c.endsWith(".TWO") : !c.includes(".TW"),
        );
        if (list.length === 0) continue;
        if (list.some((c) => this.#d.store.real.instrument(c) !== null)) continue;
        if (list.every((c) => (this.#negative.get(c)?.until ?? 0) > now)) continue;
        asked++;
        const r = await this.#discover(list, null);
        // A starter that fails is left out of its list for good (until the config changes).
        if (!r.ok)
          for (const c of list)
            this.#negative.set(c, { until: Number.MAX_SAFE_INTEGER, why: r.message });
      }
    }
  }

  /** A member opened a ticker: 我最近看過 (the newest 20), and they count as active. */
  noteView(person: PersonId, code: string): void {
    const now = this.#now();
    this.#d.store.real.mark(person, "view", code, now);
    this.#d.store.real.trimMarks(person, "view", 20);
    this.#d.store.real.setInstrument(code, { last_viewed_at: now }, now);
  }

  /** Why a provider's answer is not a ticker people may trade; `null` when it is. */
  #validate(q: YahooQuote | undefined, market: MarketKind): string | null {
    const c = this.#d.config;
    if (!q) return "找不到這個代號";
    if (!q.type || !q.exchange || !q.currency) return "報價來源沒有說這是什麼,不能交易";
    if (!c.allowed_types.includes(q.type)) return `只能交易股票和 ETF(這檔是 ${q.type})`;
    const exchanges = market === "tw" ? c.allowed_exchanges_tw : c.allowed_exchanges_us;
    if (!exchanges.includes(q.exchange))
      return `只能交易台股上市櫃和美股主要交易所(這檔在 ${q.exchange})`;
    if (q.currency !== currencyOf(market)) return `價格不是 ${currencyOf(market)},不能交易`;
    if (!(q.price > 0)) return "沒有正常的價格";
    return null;
  }

  // ---- the owner on tickers -----------------------------------------------------------------

  /**
   * The owner's display name for a ticker (`null` or blank: back to the starter list's, else the
   * provider's). Plain text, at most 60 characters.
   */
  setName(code: string, name: string | null): { ok: true; name: string } | Refusal {
    const row = this.#d.store.real.instrument(code);
    if (!row || row.status === "removed") return refuse(404, "instrument", "沒有這個標的");
    const clean = name === null ? "" : name.replace(/\s+/g, " ").trim();
    if (clean.length > 60) return refuse(400, "name", "名稱最多 60 個字");
    this.#d.store.real.setInstrument(
      code,
      { name_override: clean === "" ? null : clean },
      this.#now(),
    );
    return {
      ok: true,
      name: this.#displayName({ ...row, name_override: clean === "" ? null : clean }),
    };
  }

  /** Blocks (sell only), unblocks, or removes a ticker (removing one people hold is refused). */
  setTicker(code: string, action: "block" | "unblock" | "remove"): { ok: true } | Refusal {
    const row = this.#d.store.real.instrument(code);
    if (!row) return refuse(404, "instrument", "沒有這個標的");
    const book = this.#book();
    if (
      action === "remove" &&
      (book.positions.some((p) => p.code === code) || book.orders.some((o) => o.code === code))
    ) {
      return refuse(409, "held", "還有人持有或掛單,先封鎖(只能賣)");
    }
    this.#d.store.real.setInstrument(
      code,
      {
        status: action === "block" ? "blocked" : action === "unblock" ? "active" : "removed",
        reason: null,
      },
      this.#now(),
    );
    return { ok: true };
  }

  /** The owner confirms a split (or reverse split): every holding's shares times `ratio`; the ticker trades again. */
  confirmSplit(code: string, ratio: number): { ok: true; positions: number } | Refusal {
    const row = this.#d.store.real.instrument(code);
    if (row?.status !== "paused") return refuse(409, "not_paused", "這檔沒有在等分割確認");
    if (!(ratio > 0) || ratio > 50 || ratio < 1 / 50) return refuse(400, "ratio", "比例不合理");
    const n = this.#d.store.real.adjustShares(code, ratio);
    const inst = this.#inst(code);
    if (inst) this.#guard(inst).forget(code);
    this.#d.store.real.setInstrument(code, { status: "active", reason: null }, this.#now());
    return { ok: true, positions: n };
  }

  /** The owner settles a suspended ticker: every holding sold at its last valid price, or at zero (a delisting). */
  async settle(
    code: string,
    at: "last" | "zero",
    by: string,
  ): Promise<{ ok: true; paid: number } | Refusal> {
    return this.#turns.run(async () => {
      const row = this.#d.store.real.instrument(code);
      if (row?.status !== "suspended") return refuse(409, "not_suspended", "這檔沒有暫停");
      const last = this.#lastKnown(code);
      const price = at === "zero" ? 0 : (last?.price ?? 0);
      const book = this.#book();
      let paid = 0;
      for (const pos of book.positions.filter((p) => p.code === code)) {
        const out = settleAt(book, pos, price, this.#ctx(await this.#balances(book)));
        paid += out.fills.reduce((t, f) => t + f.paid, 0);
        this.#commit(out, book, { by });
      }
      for (const o of book.orders.filter((x) => x.code === code)) {
        const out = cancelRealOrder(book, o.id, "settled");
        if (out) this.#commit(out, book);
      }
      this.#d.store.real.setInstrument(
        code,
        { status: "removed", reason: `settled:${at}` },
        this.#now(),
      );
      return { ok: true, paid };
    });
  }

  /** At a new local day: held tickers without a valid quote for `suspend_after_days` trading days are suspended. */
  #countMissing(): void {
    const now = this.#now();
    const book = this.#book();
    const held = new Set(book.positions.map((p) => p.code));
    for (const inst of this.instruments()) {
      if (!held.has(inst.code)) continue;
      const row = this.#d.store.real.instrument(inst.code);
      if (!row || row.status === "suspended" || row.status === "removed") continue;
      const yesterday = now - DAY_MS;
      const s = this.sessions[inst.market];
      const traded =
        s.days.includes(new Date(yesterday).getUTCDay()) &&
        !s.holidays.includes(new Date(yesterday).toISOString().slice(0, 10));
      if (!traded) continue;
      const fresh = row.last_quote_at !== null && now - row.last_quote_at < DAY_MS;
      const missing = fresh ? 0 : row.missing_days + 1;
      if (missing >= this.#d.config.suspend_after_days) {
        this.#d.store.real.setInstrument(
          inst.code,
          { status: "suspended", reason: "no_quote", missing_days: missing },
          now,
        );
        const at = toTimestamp(now);
        const notices = [
          ...new Set(book.positions.filter((p) => p.code === inst.code).map((p) => p.person)),
        ].map((person) => ({
          id: this.#id(),
          person,
          kind: "suspended",
          position: null,
          text: `${inst.code}(${inst.name})好幾個交易日沒有報價,暫停交易;你的持股不會因此被賣出,等 owner 處理。`,
          created_at: at,
          quiet: false,
        }));
        this.#d.store.real.commit(
          {
            fills: [],
            ended: [],
            opened: [],
            changed: [],
            closed: [],
            postings: [],
            lines: [],
            notices: [],
            bankrupt: [],
          },
          book,
          now,
          this.#day(),
          { notices },
        );
      } else this.#d.store.real.setInstrument(inst.code, { missing_days: missing }, now);
    }
  }

  async quote(
    account: AccountRef,
    req: RealOrderRequest,
  ): Promise<{ ok: true; quote: RealQuote } | Refusal> {
    const r = await this.#check(account, req);
    return r.ok ? { ok: true, quote: r.quote } : r;
  }

  /** Places a market order; the same `key` is the same order. */
  async place(
    account: AccountRef,
    req: RealOrderRequest,
    key: string,
  ): Promise<{ ok: true; order: RealOrderLine } | Refusal> {
    return this.#turns.run(async () => {
      const wallet = this.#d.wallet();
      const known = wallet ? await wallet.holder(account) : null;
      if (known) {
        const first = this.#d.store.real.orderByKey(known.person, key);
        if (first)
          return first.status === "void"
            ? refuse(409, "void", `這筆沒有成立(${this.#currency()}不夠),請再下一次`)
            : { ok: true, order: orderLine(first, this.#orderNextOpen(first.code, this.#now())) };
      }
      const r = await this.#check(account, req);
      if (!r.ok) return r;
      const now = this.#now();
      const base: RealOrderRecord = {
        id: this.#id(),
        person: r.asker.person,
        account,
        name: r.asker.name,
        request_key: key,
        code: req.code,
        side: req.side,
        limit: null,
        coins: 0,
        margin: 0,
        exposure: 0,
        fee: 0,
        leverage: 1,
        qty: r.qty,
        position: r.position,
        placed_at: now,
        expires_at: Date.UTC(2200, 0, 1),
        status: "open",
        why: null,
      };
      if (req.side === "sell") {
        placeRealSell(r.book, base);
        this.#d.store.real.commit(
          {
            fills: [],
            ended: [],
            opened: [],
            changed: [],
            closed: [],
            postings: [],
            lines: [],
            notices: [],
            bankrupt: [],
          },
          r.book,
          now,
          this.#day(),
          { placed: [base] },
        );
        return { ok: true, order: orderLine(base, this.#orderNextOpen(base.code, now)) };
      }
      if (!wallet || !r.split) return refuse(503, "wallet", "錢包現在打不開");
      const order: RealOrderRecord = {
        ...base,
        status: "charging",
        coins: r.split.margin + r.split.fee,
        margin: r.split.margin,
        exposure: r.split.exposure,
        fee: r.split.fee,
        leverage: r.quote.leverage,
      };
      const out = placeRealBuy(r.book, order);
      const posting = out.postings[0];
      const postKey = `exchange:order:${order.id}`;
      const entries: ExchangeEntry[] = (posting?.entries ?? []).map((e) => ({
        reason: e.reason as ExchangeEntry["reason"],
        delta: e.delta,
        key: `${postKey}:${e.reason}`,
      }));
      this.#d.store.real.startBuy(order, postKey, entries, now);
      const post = await wallet.post(order.person, entries, order.id, true);
      this.#d.store.real.settleBuy(order.id, postKey, post.ok, now);
      if (post.ok) this.#d.store.real.lines(out.lines, this.#day(), now);
      if (!post.ok)
        return post.reason === "short"
          ? refuse(402, "short", `${this.#currency()}不夠`)
          : refuse(409, "refused", post.message);
      return {
        ok: true,
        order: orderLine({ ...order, status: "open" }, this.#orderNextOpen(order.code, now)),
      };
    });
  }

  async cancel(account: AccountRef, id: string): Promise<{ ok: true; refunded: number } | Refusal> {
    return this.#turns.run(async () => {
      const asker = await this.#d.ask(account);
      if (!asker) return refuse(403, "stranger", "她還不認識你,先和她說說話吧");
      const book = this.#book();
      const order = book.orders.find((o) => o.id === id && o.person === asker.person);
      if (!order) return refuse(404, "no_order", "沒有這筆還沒成交的委託");
      const out = cancelRealOrder(book, id) as HouseOutcome;
      this.#commit(out, book);
      return { ok: true, refunded: order.side === "buy" ? order.coins : 0 };
    });
  }

  /** The owner sells one position now at its latest price, no fee (recorded in the audit log by the caller). */
  async adminSell(positionId: string, by: string): Promise<{ ok: true; paid: number } | Refusal> {
    return this.#turns.run(async () => {
      const book = this.#book();
      const pos = book.positions.find((p) => p.id === positionId);
      if (!pos) return refuse(404, "no_position", "找不到這個持股");
      const out = adminSellReal(book, pos, this.#ctx(await this.#balances(book)));
      if (!out) return refuse(409, "no_quote", "這個標的還沒有報價");
      this.#commit(out, book, { by });
      return { ok: true, paid: out.fills.reduce((t, f) => t + f.paid, 0) };
    });
  }

  // ---- their own book -----------------------------------------------------------------------

  portfolio(person: PersonId): RealPortfolio {
    const book = this.#book();
    const now = this.#now();
    const pending = new Set(
      book.orders
        .filter((o) => o.person === person && o.side === "sell")
        .map((o) => o.position ?? `plain:${o.code}`),
    );
    const holdings: RealHolding[] = book.positions
      .filter((p) => p.person === person)
      .map((p) => {
        // The last known price: a live quote, else the last close (never what a sale fills at).
        const price = this.#markPrice(p.code);
        return {
          id: p.id,
          code: p.code,
          name: this.#inst(p.code)?.name ?? p.code,
          leverage: p.leverage,
          qty: p.qty,
          cost: p.cost,
          margin: p.margin,
          loan: p.loan,
          price,
          value: price === null ? null : Math.round(valueAt(p.qty, price) * 100) / 100,
          equity: price === null ? null : Math.round(equityOf(p, price) * 100) / 100,
          ratio:
            price === null || p.leverage <= 1
              ? null
              : Math.round((equityOf(p, price) / p.margin) * 1000) / 1000,
          line_price: p.leverage > 1 ? priceAtRatio(p, this.params.line) : null,
          warn_half_price: p.leverage > 1 ? priceAtRatio(p, this.params.warn_half) : null,
          warn_near_price: p.leverage > 1 ? priceAtRatio(p, this.params.warn_near) : null,
          opened_at: toTimestamp(p.opened_at),
          can_sell:
            p.opened_at + this.params.min_hold_ms <= now &&
            !pending.has(p.id) &&
            !(p.leverage <= 1 && pending.has(`plain:${p.code}`)),
        };
      });
    const b = book.state.bankrupt[person];
    return {
      holdings,
      orders: this.#d.store.real
        .orders(person, { limit: 30 })
        .map((o) => orderLine(o, this.#orderNextOpen(o.code, now))),
      fills: this.#d.store.real.fills(person, 30).map((f) => ({
        id: f.id,
        code: f.code,
        side: f.side,
        kind: f.kind,
        qty: f.qty,
        price: f.price,
        gross: f.gross,
        fee: f.fee,
        paid: f.paid,
        shortfall: f.shortfall,
        leverage: f.leverage,
        at: f.created_at,
      })),
      notices: this.#d.store
        .notices(person, 20)
        .map((n) => ({ id: n.id, kind: n.kind, text: n.text, at: n.created_at })),
      bankrupt:
        b && now < b.until
          ? { since: toTimestamp(b.since), until: toTimestamp(b.until), written_off: b.written_off }
          : null,
      totals: {
        cost: holdings.reduce((t, h) => t + h.cost, 0),
        value:
          Math.round(
            holdings.reduce(
              (t, h) =>
                t +
                (h.price === null
                  ? 0
                  : h.leverage > 1
                    ? Math.max(0, h.equity ?? 0)
                    : (h.value ?? 0)),
              0,
            ) * 100,
          ) / 100,
      },
    };
  }

  /** What a person holds here, at the latest prices known (equity for leveraged), and their open buys' coins. */
  worth(person: PersonId): { held: number; escrow: number; codes: string[] } {
    const book = this.#book();
    let held = 0;
    const codes = new Set<string>();
    for (const p of book.positions) {
      if (p.person !== person) continue;
      const price = this.#markPrice(p.code);
      if (price !== null) held += worthOf(p, price);
      codes.add(p.code);
    }
    const escrow = book.orders
      .filter((o) => o.person === person && o.side === "buy")
      .reduce((t, o) => t + o.coins, 0);
    return { held, escrow, codes: [...codes] };
  }

  /** Every open position, for the owner's page (a sale by hand). */
  allPositions(): {
    id: string;
    person: PersonId;
    code: string;
    leverage: number;
    qty: number;
    value: number | null;
  }[] {
    return this.#book().positions.map((p) => {
      const price = this.#markPrice(p.code);
      return {
        id: p.id,
        person: p.person,
        code: p.code,
        leverage: p.leverage,
        qty: p.qty,
        value: price === null ? null : Math.round(worthOf(p, price) * 100) / 100,
      };
    });
  }

  /** Each provider's last problem, for the owner's page (`null`: none). */
  providerStatus(): { id: string; last_error: string | null }[] {
    return [...this.#d.providers].map(([id, p]) => ({
      id,
      last_error: (p as { lastError?: string | null }).lastError ?? null,
    }));
  }

  /** How many people hold each ticker (counts only, never who). */
  holderCounts(): Map<string, number> {
    const by = new Map<string, Set<PersonId>>();
    for (const p of this.#book().positions) {
      const set = by.get(p.code) ?? new Set<PersonId>();
      set.add(p.person);
      by.set(p.code, set);
    }
    return new Map([...by].map(([code, set]) => [code, set.size]));
  }

  /** The tickers people added, for the owner's page. */
  tickers() {
    return this.#d.store.real
      .instrumentList()
      .filter((i) => i.status !== "removed")
      .map((i) => ({
        code: i.code,
        name: this.#displayName(i),
        provider_name: i.name,
        name_override: i.name_override,
        market: i.market,
        exchange: i.exchange,
        type: i.type,
        status: i.status,
        reason: i.reason,
        added_at: toTimestamp(i.added_at),
        missing_days: i.missing_days,
      }));
  }

  isBankrupt(person: PersonId): boolean {
    const s = this.#d.store.real.state();
    return s !== null && isBankrupt(s, person, this.#now());
  }

  /** The owner's daily mint and burn report, the bankrupt, the quotes, and the books. */
  report(): RealReport {
    const s = this.#d.store.real.state() ?? this.#book().state;
    const day = (d: (typeof s)["today"]) => ({
      day: d.day,
      date: dateOf(d.day),
      burned: d.burned,
      minted: d.minted,
      net: d.minted - d.burned,
      written_off: d.written_off,
    });
    const lines = this.#d.store.real.lineTotals();
    const totals = this.#d.store.postingTotals();
    const net =
      (lines.mint ?? 0) +
      (lines.refund ?? 0) +
      (lines.release ?? 0) -
      (lines.burn ?? 0) -
      (lines.fee ?? 0) -
      (lines.loss ?? 0) -
      (lines.escrow ?? 0);
    const quotes = this.#d.store.real.quotes();
    return {
      today: { ...day(s.today), buys_halted: s.today.buys_halted },
      days: s.history.slice(-30).reverse().map(day),
      cap_daily: this.#d.config.payout_cap_daily,
      bankrupt: Object.entries(s.bankrupt)
        .filter(([, b]) => b.until > this.#now())
        .map(([person, b]) => ({
          person,
          since: toTimestamp(b.since),
          until: toTimestamp(b.until),
          written_off: b.written_off,
        })),
      quotes: this.instruments().map((i) => {
        const q = quotes.get(i.code);
        return {
          code: i.code,
          price: q?.price ?? null,
          at: q ? toTimestamp(q.at) : null,
          refused: q?.refused ?? 0,
          last_refusal: q?.last_refusal ?? null,
        };
      }),
      lines,
      books: { postings: totals.posted + totals.pending, lines: net, pending: totals.pending },
    };
  }

  /** For her: who is bankrupt now, and this week's biggest win and loss, among `shown` people only. */
  facts(shown: ReadonlySet<PersonId>): {
    bankrupt: PersonId[];
    wins: { person: PersonId; result: number }[];
    losses: { person: PersonId; result: number }[];
  } {
    const s = this.#d.store.real.state();
    const now = this.#now();
    const bankrupt = s
      ? Object.entries(s.bankrupt)
          .filter(([p, b]) => b.until > now && shown.has(p))
          .map(([p]) => p)
      : [];
    const results = this.#d.store.real
      .resultsSince(now - 7 * DAY_MS)
      .filter((r) => shown.has(r.person));
    return {
      bankrupt,
      wins: results
        .filter((r) => r.result >= 100)
        .sort((a, b) => b.result - a.result)
        .slice(0, 3),
      losses: results
        .filter((r) => r.result <= -100)
        .sort((a, b) => a.result - b.result)
        .slice(0, 3),
    };
  }
}

/**
 * The mint report from the house's days (`today` is the local day number): coins burned, minted
 * and the net today, over 7 and over 30 days, each against `circulation` (all coins in wallets),
 * and a plain warning when the 7-day net is past `warnShare` of it.
 */
export function mintReportOf(
  days: readonly { day: number; burned: number; minted: number }[],
  today: number,
  circulation: number | null,
  warnShare: number,
  currency: string = DEFAULT_CURRENCY,
): MintReport {
  const byDay = new Map<number, { burned: number; minted: number }>();
  for (const d of days) if (d.day <= today && d.day > today - 30) byDay.set(d.day, d);
  const windows = [1, 7, 30].map((n): MintWindow => {
    let burned = 0;
    let minted = 0;
    for (const [day, d] of byDay)
      if (day > today - n) {
        burned += d.burned;
        minted += d.minted;
      }
    const net = minted - burned;
    return {
      days: n,
      burned,
      minted,
      net,
      share: circulation !== null && circulation > 0 ? net / circulation : null,
    };
  });
  const week = windows[1] as MintWindow;
  const pct = (x: number) => `${(Math.round(x * 1000) / 10).toFixed(1)}%`;
  const warning =
    week.share !== null && week.net > 0 && week.share > warnShare
      ? `過去 7 天交易所淨發出 ${week.net.toLocaleString("en-US")} ${currency},是現在所有錢包合計的 ${pct(week.share)},超過提醒線 ${pct(warnShare)}。沒有每天淨發出上限時,上漲的市場會讓${currency}變多;要限制,在 系統 / 交易所 設「每天最多淨發出」。`
      : null;
  return { windows, circulation, warn_share: warnShare, warning };
}

function orderLine(o: RealOrderRecord, nextOpen: Timestamp | null = null): RealOrderLine {
  return {
    id: o.id,
    code: o.code,
    side: o.side,
    coins: o.coins,
    qty: o.qty,
    leverage: o.leverage,
    position: o.position,
    status: o.status,
    why: o.why,
    at: toTimestamp(o.placed_at),
    next_open: o.status === "open" || o.status === "charging" ? nextOpen : null,
  };
}

const price2 = (n: number) => n.toFixed(2);

/** What a member is told, in plain words: the rule did it, never her. */
export function noticeText(
  n: RealNotice,
  name: string,
  currency: string = DEFAULT_CURRENCY,
): string {
  const who = `${n.code}(${name})`;
  const left = `${Math.max(0, Math.round(n.ratio * 100))}%`;
  switch (n.kind) {
    case "warn_half":
      return `${who} 的 2 倍部位:保證金剩 ${left}。跌到 ${price2(n.line_price)} 會依規則自動賣出;賠超過保證金的部分會從錢包和其他持股扣。可以自己先賣掉。`;
    case "warn_near":
      return `${who} 的 2 倍部位:保證金剩 ${left},接近自動賣出的價格 ${price2(n.line_price)}。可以自己先賣掉。`;
    case "liquidated":
      return `${who} 的 2 倍部位${n.warned === false ? "(價格跳空,來不及先通知)" : ""}依規則以 ${price2(n.price)} 自動賣出,退回 ${n.amount} ${currency}。`;
    case "shortfall":
      return `${who} 那筆賠超過保證金 ${n.amount} ${currency},依規則從錢包和其他持股扣了。`;
    case "bankrupt":
      return `錢包和持股都扣完了還差 ${n.amount} ${currency},依規則由交易所吸收:你破產了,所有持股已經結清,冷靜期過後才能再交易。不會欠錢。`;
  }
}

export type { RealOrder };

/** A move by a clean small integer ratio (2..20, either way) within 3%: a split or a reverse split. */
export function splitRatio(before: number, after: number): { ratio: number; label: string } | null {
  if (!(before > 0) || !(after > 0)) return null;
  const k = before / after;
  const check = (x: number) => {
    const n = Math.round(x);
    return n >= 2 && n <= 20 && Math.abs(x - n) <= 0.03 * n ? n : null;
  };
  const split = check(k);
  if (split) return { ratio: split, label: `split:${split}` };
  const reverse = check(1 / k);
  if (reverse) return { ratio: 1 / reverse, label: `reverse:${reverse}` };
  return null;
}

/** What people type, as the provider's symbol candidates: `2330` → `2330.TW`, `2330.TWO`; `brk.b` → `BRK-B`. */
export function candidates(input: string): string[] {
  const t = input.trim().toUpperCase();
  if (/^\d{4,6}[A-Z]?$/.test(t)) return [`${t}.TW`, `${t}.TWO`];
  if (/^\d{4,6}[A-Z]?\.(TW|TWO)$/.test(t)) return [t];
  if (/^[A-Z]{1,5}([.-][A-Z])?$/.test(t)) return [t.replace(".", "-")];
  return [];
}

export type { YahooQuote };
