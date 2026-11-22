// The deep-sea exchange (docs/design/exchange.md), v1: paper trading of real Taiwan and US stocks
// (quoted by Yahoo Finance) and five local stocks tied to her, with fish coins and the house as
// the counterparty. The member's side: the market (sessions, fixed rates, rules, the small print),
// the browsing lists, suggestions while typing, a ticker's page, the watch list, their account, a
// quote before an order, the order, a cancel, their own portfolio, the rich list. The owner's
// side: the daily mint and burn report, the quotes and the provider, the tickers people added
// (block, unblock, remove), a split to confirm, a suspended ticker to settle, a sale by hand.
// Prices are in the ticker's own currency with the coin price beside them; shares are in
// millionths. Without the `exchange` module these are a `503` that names it.

import { z } from "zod";
import { ListedSpaceSchema } from "./economy.js";
import { IdempotencyHeaders, route } from "./route.js";
import { BoardScopeQuery } from "./wallet.js";

/** The node of the owner's hand on the exchange (the same as on someone's coins). */
const NODE_EXCHANGE = "admin.economy.adjust";

const Market = z.enum(["tw", "us", "crypto", "local"]);
const ListKind = z.enum(["local", "popular", "movers", "tw", "us", "mine", "recent", "watch"]);
const TickerCode = z
  .string()
  .min(1)
  .max(20)
  .regex(/^[A-Za-z0-9.\-^=]+$/);

/**
 * One ticker's line: its last known price in its own currency and in coins, what that price is,
 * the move, the quote's age, when its market opens next.
 */
export const ExchangeLineSchema = z
  .object({
    code: z.string(),
    /** The display name: the owner's, else the starter list's (zh-TW), else the provider's, whole. */
    name: z.string(),
    market: Market,
    price: z.number().nullable(),
    /**
     * `quote`: of the session in progress; `close`: the last session's (closed, or before today's
     * first quote; shown and used for valuation, never traded at); `reference`: a local stock's
     * anchor before its first tick; `null`: nothing known yet.
     */
    basis: z.enum(["quote", "close", "reference"]).nullable(),
    /** The trading date of the price (`YYYY-MM-DD`, the market's zone). */
    price_date: z.string().nullable(),
    /** What the price is, in words, when it is not a live quote (`收盤價(11/20)・休市中`). */
    price_note: z.string().nullable(),
    /** When its market next opens, while it is closed. */
    next_open: z.string().nullable(),
    currency: z.enum(["TWD", "USD", "COIN"]),
    /** A local stock: what moves it, and what moved today's open in numbers from her day. */
    local: z.object({ what_moves: z.string(), today: z.string().nullable() }).nullable(),
    coin_price: z.number().nullable(),
    age_minutes: z.number().int().nullable(),
    source: z.string(),
    change: z.number().nullable(),
    at: z.string().nullable(),
    open: z.boolean(),
    stale: z.boolean(),
    quotes: z.enum(["intraday", "close"]),
  })
  .meta({ id: "ApiExchangeLine" });
export type ExchangeLine = z.output<typeof ExchangeLineSchema>;

/** `GET /api/member/exchange`: the market as a member sees it. */
export const ExchangeMarketSchema = z
  .object({
    enabled: z.boolean(),
    currency: z.string(),
    /** `tw`: red up, green down; `us`: green up, red down. */
    colors: z.enum(["tw", "us"]),
    rates: z.object({ twd_per_coin: z.number(), twd_per_usd: z.number() }),
    house: z.object({
      buys_halted: z.boolean(),
      net_today: z.number().int(),
      cap_daily: z.number().int(),
    }),
    sessions: z.array(
      z.object({
        market: Market,
        open: z.boolean(),
        hours: z.string(),
        zone: z.string(),
        stale: z.boolean(),
        notice: z.string().nullable(),
      }),
    ),
    lists: z.array(z.object({ kind: ListKind, label: z.string() })),
    /** The list they see first (their holdings when they have any, else the local stocks). */
    default_list: ListKind,
    /** `order_max`, `buy_per_day`, `limit_total`, `margin_cap` and `payout_cap_daily`: `0` is no cap. */
    rules: z.object({
      fee: z.number(),
      fee_min: z.number().int(),
      order_min: z.number().int(),
      order_max: z.number().int(),
      orders_per_day: z.number().int(),
      buy_per_day: z.number().int(),
      limit_total: z.number().int(),
      min_hold_minutes: z.number().int(),
      leverage: z.boolean(),
      leverage_line: z.number(),
      leverage_min_days: z.number().int(),
      leverage_min_tier: z.string(),
      margin_cap: z.number().int(),
      account_min_days: z.number().int(),
      account_min_tier: z.string(),
      bankrupt_cooling_days: z.number().int(),
      quote_max_age_seconds: z.number().int(),
      payout_cap_daily: z.number().int(),
      watch_max: z.number().int(),
    }),
    /** The small print: the base line, the real-stock line, the leverage line. */
    small_print: z.object({ base: z.string(), real: z.string(), leverage: z.string() }),
    /** The rules page's lines: no dividends; coins are never exchanged for money or goods. */
    no_dividends: z.string(),
    no_exchange: z.string(),
  })
  .meta({ id: "ApiExchangeMarket" });
export type ExchangeMarket = z.output<typeof ExchangeMarketSchema>;

/** `GET /api/member/exchange/list/{kind}`: a list's rows (大家都在買: counts of holders only). */
export const ExchangeListSchema = z
  .object({
    kind: ListKind,
    label: z.string(),
    rows: z.array(ExchangeLineSchema.extend({ holders: z.number().int().nullable() })),
  })
  .meta({ id: "ApiExchangeList" });
export type ExchangeList = z.output<typeof ExchangeListSchema>;

/** `GET /api/member/exchange/ticker/{code}`: the line, its chart, whether they watch and hold it. */
export const ExchangeTickerSchema = z
  .object({
    line: ExchangeLineSchema,
    points: z.array(z.object({ at: z.string(), price: z.number() })),
    watching: z.boolean(),
  })
  .meta({ id: "ApiExchangeTicker" });
export type ExchangeTicker = z.output<typeof ExchangeTickerSchema>;

const Timeframe = z.enum(["intraday", "daily", "weekly", "monthly"]);
const MapKind = z.enum(["holdings", "tw", "us"]);

/**
 * `GET /api/member/exchange/candles/{code}?tf=`: a ticker's candles for one timeframe (當日 in
 * 5-minute bars, 日線 about six months, 週線 about two years, 月線 ten years), oldest first, in its
 * own currency; and the member's own lines on it (their average cost, each 2× position's line).
 * A real stock's come from the provider on demand and are cached; a local stock's from its own
 * hourly ticks, with no volume.
 */
export const ExchangeCandlesSchema = z
  .object({
    code: z.string(),
    tf: Timeframe,
    /** The market's zone: the bars' times are read in it. */
    zone: z.string(),
    currency: z.enum(["TWD", "USD", "COIN"]),
    candles: z.array(
      z.object({
        /** When the bar starts, epoch ms. */
        t: z.number().int(),
        o: z.number(),
        h: z.number(),
        l: z.number(),
        c: z.number(),
        v: z.number().nullable(),
      }),
    ),
    /** The bars carry volume. */
    volume: z.boolean(),
    source: z.enum(["provider", "ticks"]),
    /** The provider could not answer: these are older than usual. */
    stale: z.boolean(),
    marks: z.object({ avg_cost: z.number().nullable(), liquidation: z.array(z.number()) }),
  })
  .meta({ id: "ApiExchangeCandles" });
export type ExchangeCandles = z.output<typeof ExchangeCandlesSchema>;

/**
 * `GET /api/member/exchange/map/{kind}`: a heat map's tiles (伺服器持股圖: coins the server holds,
 * a ticker held by too few people merged into 其他, never who; 熱門台股圖 / 熱門美股圖: the starter
 * lists with their configured sectors and weights). The panel lays them out.
 */
export const ExchangeMapSchema = z
  .object({
    kind: MapKind,
    title: z.string(),
    footnote: z.string(),
    hidden: z.number().int(),
    /** No tile is laid out bigger than this share of the map (`1`: no cap). */
    max_share: z.number(),
    tiles: z.array(
      z.object({
        code: z.string(),
        name: z.string(),
        sector: z.string(),
        weight: z.number(),
        change: z.number().nullable(),
        price: z.number().nullable(),
        currency: z.enum(["TWD", "USD", "COIN"]).nullable(),
        coin_price: z.number().nullable(),
        basis: z.string(),
      }),
    ),
  })
  .meta({ id: "ApiExchangeMap" });
export type ExchangeMap = z.output<typeof ExchangeMapSchema>;

/** `GET /api/member/exchange/account`: who they are here, what they may do, today's counts. */
export const ExchangeAccountSchema = z
  .object({
    currency: z.string(),
    known: z.boolean(),
    blocked: z.boolean(),
    opened: z.boolean(),
    opened_at: z.string().nullable(),
    cannot_open: z.string().nullable(),
    leverage: z.object({ allowed: z.boolean(), why: z.string().nullable(), opted_in: z.boolean() }),
    /** Holding caps by cost (`0`: none). */
    limits: z.object({ company: z.number().int(), total: z.number().int(), mult: z.number() }),
    today: z.object({
      orders: z.number().int(),
      bought: z.number().int(),
      orders_left: z.number().int(),
      /** `null`: no daily buy cap. */
      buy_left: z.number().int().nullable(),
    }),
    balance: z.number().nullable(),
    investable: z.number().nullable(),
    hide_boards: z.boolean(),
    show_holdings: z.boolean(),
  })
  .meta({ id: "ApiExchangeAccount" });
export type ExchangeAccount = z.output<typeof ExchangeAccountSchema>;

/** A market order: a buy in coins (or shares, 1x), a sale in shares, all of it, or one position. */
export const ExchangeOrderRequestSchema = z
  .strictObject({
    side: z.enum(["buy", "sell"]),
    code: TickerCode,
    coins: z.number().int().positive().optional(),
    shares: z.number().positive().max(1e9).optional(),
    all: z.boolean().optional(),
    leverage: z.union([z.literal(1), z.literal(2)]).optional(),
    position: z.string().min(1).max(40).optional(),
  })
  .meta({ id: "ApiExchangeOrderRequest" });
export type ExchangeOrderRequest = z.output<typeof ExchangeOrderRequestSchema>;

/** What an order would do, for the confirmation. */
export const ExchangeQuoteSchema = z
  .object({
    side: z.enum(["buy", "sell"]),
    code: z.string(),
    price: z.number().nullable(),
    open: z.boolean(),
    coins: z.number().int(),
    margin: z.number().int(),
    exposure: z.number().int(),
    fee: z.number().int(),
    qty: z.number().int(),
    leverage: z.number().int(),
    gross: z.number().int(),
    net: z.number().int(),
    line_price: z.number().nullable(),
    /** The price is not a live quote: what it is; the fill is at the next valid quote. */
    price_note: z.string().nullable(),
    /** Its market is closed: when it opens (the order waits until then and can be cancelled). */
    next_open: z.string().nullable(),
    sentence: z.string(),
    warning: z.string().nullable(),
  })
  .meta({ id: "ApiExchangeQuote" });
export type ExchangeQuote = z.output<typeof ExchangeQuoteSchema>;

export const ExchangeOrderSchema = z
  .object({
    id: z.string(),
    code: z.string(),
    side: z.enum(["buy", "sell"]),
    coins: z.number().int(),
    qty: z.number().int(),
    leverage: z.number().int(),
    position: z.string().nullable(),
    status: z.string(),
    why: z.string().nullable(),
    at: z.string(),
    /** A waiting order whose market is closed: when it opens (it fills at the first valid quote after). */
    next_open: z.string().nullable(),
  })
  .meta({ id: "ApiExchangeOrder" });
export type ExchangeOrder = z.output<typeof ExchangeOrderSchema>;

/** `GET /api/member/exchange/portfolio`: only ever the member's own. */
export const ExchangePortfolioSchema = z
  .object({
    balance: z.number().nullable(),
    holdings: z.array(
      z.object({
        id: z.string(),
        code: z.string(),
        name: z.string(),
        leverage: z.number().int(),
        qty: z.number().int(),
        cost: z.number().int(),
        margin: z.number().int(),
        loan: z.number().int(),
        price: z.number().nullable(),
        value: z.number().nullable(),
        equity: z.number().nullable(),
        ratio: z.number().nullable(),
        line_price: z.number().nullable(),
        warn_half_price: z.number().nullable(),
        warn_near_price: z.number().nullable(),
        opened_at: z.string(),
        can_sell: z.boolean(),
      }),
    ),
    orders: z.array(ExchangeOrderSchema),
    fills: z.array(
      z.object({
        id: z.string(),
        code: z.string(),
        side: z.string(),
        kind: z.string(),
        qty: z.number().int(),
        price: z.number(),
        gross: z.number().int(),
        fee: z.number().int(),
        paid: z.number().int(),
        shortfall: z.number().int(),
        leverage: z.number().int(),
        at: z.string(),
      }),
    ),
    notices: z.array(
      z.object({ id: z.string(), kind: z.string(), text: z.string(), at: z.string() }),
    ),
    bankrupt: z
      .object({ since: z.string(), until: z.string(), written_off: z.number().int() })
      .nullable(),
    totals: z.object({ cost: z.number().int(), value: z.number() }),
  })
  .meta({ id: "ApiExchangePortfolio" });
export type ExchangePortfolio = z.output<typeof ExchangePortfolioSchema>;

/**
 * `GET /api/member/exchange/boards`: the rich list (people who hide are left out), of one server's
 * members or of everyone (`BoardScopeQuery`). Prices and holdings are global either way.
 */
export const ExchangeBoardsSchema = z
  .object({
    currency: z.string(),
    /** The server whose members are ranked; `null`: everyone. */
    space: ListedSpaceSchema.nullable(),
    rich: z.array(
      z.object({
        rank: z.number().int(),
        name: z.string(),
        worth: z.number().int(),
        holdings: z.array(z.object({ code: z.string(), value: z.number().int() })).nullable(),
        me: z.boolean(),
      }),
    ),
    me: z.object({ rich: z.number().int().nullable(), hidden: z.boolean() }).nullable(),
  })
  .meta({ id: "ApiExchangeBoards" });
export type ExchangeBoards = z.output<typeof ExchangeBoardsSchema>;

/** `GET /api/exchange`: the owner's page. */
export const ExchangeAdminSchema = z
  .object({
    enabled: z.boolean(),
    rates: z.object({ twd_per_coin: z.number(), twd_per_usd: z.number() }),
    report: z.object({
      today: z.object({
        day: z.number().int(),
        date: z.string(),
        burned: z.number().int(),
        minted: z.number().int(),
        net: z.number().int(),
        written_off: z.number().int(),
        buys_halted: z.boolean(),
      }),
      days: z.array(
        z.object({
          day: z.number().int(),
          date: z.string(),
          burned: z.number().int(),
          minted: z.number().int(),
          net: z.number().int(),
          written_off: z.number().int(),
        }),
      ),
      cap_daily: z.number().int(),
      bankrupt: z.array(
        z.object({
          name: z.string(),
          since: z.string(),
          until: z.string(),
          written_off: z.number().int(),
        }),
      ),
      quotes: z.array(
        z.object({
          code: z.string(),
          price: z.number().nullable(),
          at: z.string().nullable(),
          refused: z.number().int(),
          last_refusal: z.string().nullable(),
        }),
      ),
      books: z.object({ postings: z.number(), lines: z.number(), pending: z.number() }),
      /**
       * The exchange's coins in and out today, over 7 and over 30 days, each against all coins in
       * wallets (`circulation`), and a warning past `warn_share` over 7 days (nothing is halted).
       */
      mint: z.object({
        windows: z.array(
          z.object({
            days: z.number().int(),
            burned: z.number().int(),
            minted: z.number().int(),
            net: z.number().int(),
            share: z.number().nullable(),
          }),
        ),
        circulation: z.number().nullable(),
        warn_share: z.number(),
        warning: z.string().nullable(),
      }),
    }),
    tickers: z.array(
      z.object({
        code: z.string(),
        /** The display name, and where it comes from: the provider's (whole) and the owner's. */
        name: z.string(),
        provider_name: z.string(),
        name_override: z.string().nullable(),
        market: z.string(),
        exchange: z.string(),
        type: z.string(),
        status: z.string(),
        reason: z.string().nullable(),
        added_at: z.string(),
        missing_days: z.number().int(),
        holders: z.number().int(),
      }),
    ),
    providers: z.array(z.object({ id: z.string(), last_error: z.string().nullable() })),
    /** Seconds between refreshes the request budget allows now. */
    refresh_seconds: z.number().int(),
    positions: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        code: z.string(),
        leverage: z.number().int(),
        qty: z.number().int(),
        value: z.number().nullable(),
      }),
    ),
  })
  .meta({ id: "ApiExchangeAdmin" });
export type ExchangeAdmin = z.output<typeof ExchangeAdminSchema>;

export const ExchangeLeverageRequestSchema = z
  .strictObject({ accept: z.boolean() })
  .meta({ id: "ApiExchangeLeverageRequest" });
export const ExchangeVisibilityRequestSchema = z
  .strictObject({ hide_boards: z.boolean().optional(), show_holdings: z.boolean().optional() })
  .meta({ id: "ApiExchangeVisibilityRequest" });
export const ExchangeCancelRequestSchema = z
  .strictObject({ order: z.string().min(1).max(40) })
  .meta({ id: "ApiExchangeCancelRequest" });
export const ExchangeLookupRequestSchema = z
  .strictObject({ code: z.string().min(1).max(20) })
  .meta({ id: "ApiExchangeLookupRequest" });
export const ExchangeWatchRequestSchema = z
  .strictObject({ code: TickerCode, on: z.boolean() })
  .meta({ id: "ApiExchangeWatchRequest" });
export const ExchangeTickerRequestSchema = z
  .strictObject({ code: TickerCode, action: z.enum(["block", "unblock", "remove"]) })
  .meta({ id: "ApiExchangeTickerRequest" });
export const ExchangeSplitRequestSchema = z
  .strictObject({ code: TickerCode, ratio: z.number().positive().max(1000) })
  .meta({ id: "ApiExchangeSplitRequest" });
export const ExchangeSettleRequestSchema = z
  .strictObject({ code: TickerCode, at: z.enum(["last", "zero"]) })
  .meta({ id: "ApiExchangeSettleRequest" });
export const ExchangeNameRequestSchema = z
  .strictObject({ code: TickerCode, name: z.string().max(60).nullable() })
  .meta({ id: "ApiExchangeNameRequest" });
export const ExchangeAdminSellRequestSchema = z
  .strictObject({ position: z.string().min(1).max(40) })
  .meta({ id: "ApiExchangeAdminSellRequest" });

const member = () => route.meta({ audience: "member", permission: null, limited: true });
const owner = () => route.meta({ audience: "admin", permission: NODE_EXCHANGE });
const Code = z.object({ code: TickerCode });

/** The member's side: needs a session (by cookie), limited per account. */
export const exchange = {
  market: member()
    .route({ method: "GET", path: "/api/member/exchange" })
    .output(ExchangeMarketSchema),
  list: member()
    .route({ method: "GET", path: "/api/member/exchange/list/{kind}" })
    .input(z.object({ params: z.object({ kind: ListKind }) }))
    .output(ExchangeListSchema),
  /** Suggestions while typing: tickers already known and the starter lists; no provider call. */
  suggest: member()
    .route({ method: "GET", path: "/api/member/exchange/suggest" })
    .input(z.object({ query: z.object({ q: z.string().max(24).default("") }) }))
    .output(z.object({ items: z.array(z.object({ code: z.string(), name: z.string() })) })),
  /** Looks a code up (validated through the provider the first time; limited per person). */
  lookup: member()
    .route({ method: "POST", path: "/api/member/exchange/lookup" })
    .input(z.object({ body: ExchangeLookupRequestSchema }))
    .output(z.object({ instrument: ExchangeLineSchema })),
  ticker: member()
    .route({ method: "GET", path: "/api/member/exchange/ticker/{code}" })
    .input(z.object({ params: Code }))
    .output(ExchangeTickerSchema),
  /** Candles on demand (opening a chart counts as a view of the ticker). */
  candles: member()
    .route({ method: "GET", path: "/api/member/exchange/candles/{code}" })
    .input(z.object({ params: Code, query: z.object({ tf: Timeframe.default("daily") }) }))
    .output(ExchangeCandlesSchema),
  /** A heat map's tiles; a 熱門 map counts as a view of its tickers while it is polled. */
  map: member()
    .route({ method: "GET", path: "/api/member/exchange/map/{kind}" })
    .input(z.object({ params: z.object({ kind: MapKind }) }))
    .output(ExchangeMapSchema),
  watch: member()
    .route({ method: "POST", path: "/api/member/exchange/watch" })
    .input(z.object({ body: ExchangeWatchRequestSchema }))
    .output(z.object({ watching: z.boolean(), count: z.number().int() })),
  account: member()
    .route({ method: "GET", path: "/api/member/exchange/account" })
    .output(ExchangeAccountSchema),
  /** Opens their account (`403` with a sentence when they may not yet). */
  open: member()
    .route({ method: "POST", path: "/api/member/exchange/account" })
    .output(ExchangeAccountSchema),
  /** The one-time opt-in to 2x, after its risks were shown in full. */
  leverage: member()
    .route({ method: "POST", path: "/api/member/exchange/leverage" })
    .input(z.object({ body: ExchangeLeverageRequestSchema }))
    .output(ExchangeAccountSchema),
  visibility: member()
    .route({ method: "POST", path: "/api/member/exchange/visibility" })
    .input(z.object({ body: ExchangeVisibilityRequestSchema }))
    .output(ExchangeAccountSchema),
  /** What an order would do, for the confirmation; a refusal says why it would not go through. */
  quote: member()
    .route({ method: "POST", path: "/api/member/exchange/quote" })
    .input(z.object({ body: ExchangeOrderRequestSchema }))
    .output(ExchangeQuoteSchema),
  /** Places a market order; the same `Idempotency-Key` is the same order. */
  order: member()
    .route({ method: "POST", path: "/api/member/exchange/order" })
    .input(z.object({ headers: IdempotencyHeaders, body: ExchangeOrderRequestSchema }))
    .output(ExchangeOrderSchema),
  cancel: member()
    .route({ method: "POST", path: "/api/member/exchange/cancel" })
    .input(z.object({ body: ExchangeCancelRequestSchema }))
    .output(z.object({ refunded: z.number().int() })),
  portfolio: member()
    .route({ method: "GET", path: "/api/member/exchange/portfolio" })
    .output(ExchangePortfolioSchema),
  /** `404` an unknown server, `403` one they are not in. */
  boards: member()
    .route({ method: "GET", path: "/api/member/exchange/boards" })
    .input(z.object({ query: BoardScopeQuery }).optional())
    .output(ExchangeBoardsSchema),
};

/** The owner's side. */
export const exchangeAdmin = {
  view: route
    .meta({ audience: "admin", permission: null })
    .route({ method: "GET", path: "/api/exchange" })
    .output(ExchangeAdminSchema),
  /** Blocks a ticker (sell only), unblocks it, or removes one nobody holds; audited. */
  ticker: owner()
    .route({ method: "POST", path: "/api/exchange/ticker" })
    .input(z.object({ body: ExchangeTickerRequestSchema }))
    .output(z.object({ ok: z.boolean() })),
  /** Confirms a split-like jump: every holding's shares times `ratio`; audited. */
  split: owner()
    .route({ method: "POST", path: "/api/exchange/split" })
    .input(z.object({ body: ExchangeSplitRequestSchema }))
    .output(z.object({ positions: z.number().int() })),
  /** Settles a suspended ticker at its last price or at zero; audited. */
  settle: owner()
    .route({ method: "POST", path: "/api/exchange/settle" })
    .input(z.object({ body: ExchangeSettleRequestSchema }))
    .output(z.object({ paid: z.number().int() })),
  /** The owner's display name of a ticker (`null` or blank: back to the list's or provider's); audited. */
  name: owner()
    .route({ method: "POST", path: "/api/exchange/name" })
    .input(z.object({ body: ExchangeNameRequestSchema }))
    .output(z.object({ name: z.string() })),
  /** Sells one position now at its latest price, no fee; audited. */
  sell: owner()
    .route({ method: "POST", path: "/api/exchange/sell" })
    .input(z.object({ body: ExchangeAdminSellRequestSchema }))
    .output(z.object({ paid: z.number().int() })),
};
