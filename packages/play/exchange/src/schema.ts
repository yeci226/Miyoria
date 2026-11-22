// The tables of the `exchange` plugin (docs/design/exchange.md §11, v5-data.md §3.2), as Drizzle
// definitions: `migrations.ts` holds the SQL drizzle-kit generates from them, `STRICT` added, and
// the store's drift test keeps the two together.
//
// - `exchange_state`: one row: the secret seed, the market's hidden state, the vault, the owner's
//   pause. Never shown as it is.
// - `exchange_rounds`: one row per round handled (held, skipped, halted, paused), with every
//   company's price: what the charts read.
// - `exchange_orders`, `exchange_positions`, `exchange_fills`: the book.
// - `exchange_postings`: what each member's wallet is to get, written with what caused it and
//   posted to the economy's ledger after, under its keys (a retry is the same rows).
// - `exchange_vault`: append-only, every coin into and out of the vault with the balance after;
//   the balance can never go below zero.
// - `exchange_news`: what the program drew, and her words for it.
// - `exchange_accounts`: who opened an account, took leverage's risks, hides from the boards.
// - `exchange_notices`: what a member was told about their own positions (the margin warnings,
//   a liquidation), on their page and by DM.
// - `exchange_words`: her opening and closing lines and her weekly rating.
//
// No foreign key to `persons`: the rows are money records and stay when a person is forgotten.

import { micros } from "@miyoria/store";
import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const exchangeState = sqliteTable(
  "exchange_state",
  {
    id: integer().primaryKey(),
    /** The market's secret seed: every draw comes from it. */
    seed: text().notNull(),
    /** The engine's `MarketState` as JSON (hidden values included). */
    market: text().notNull(),
    vault: integer().notNull(),
    /** Coins burned in all (fees, tax, carry, the vault's weekly burn). */
    burned: integer().notNull().default(0),
    held_day: integer(),
    /** Liquidations the vault still owes, as JSON. */
    owed: text().notNull().default("[]"),
    /** The owner's pause. */
    paused: integer({ mode: "boolean" }).notNull().default(false),
    paused_by: text(),
    created_at: micros().notNull(),
    updated_at: micros().notNull(),
  },
  (t) => [
    check("exchange_state_one", sql`${t.id} = 1`),
    check("exchange_state_vault_check", sql`${t.vault} >= 0 AND ${t.burned} >= 0`),
  ],
);

export const exchangeRounds = sqliteTable(
  "exchange_rounds",
  {
    round: integer().primaryKey(),
    day: integer().notNull(),
    due_at: micros().notNull(),
    /** `held`, `skipped`, `halted`, `paused`. */
    status: text().notNull(),
    fish: real().notNull(),
    level: real(),
    vault: integer().notNull(),
    obligations: real().notNull(),
    burned: integer().notNull(),
    /** Coins traded at this round. */
    volume: integer().notNull(),
    breaker: integer({ mode: "boolean" }).notNull().default(false),
    /** `[{ code, price, ref, limit, bought, sold }]`. */
    prices: text().notNull(),
    settled_at: micros().notNull(),
  },
  (t) => [
    index("exchange_rounds_day_idx").on(t.day),
    check(
      "exchange_rounds_status_check",
      sql`${t.status} IN ('held', 'skipped', 'halted', 'paused')`,
    ),
  ],
);

export const exchangeOrders = sqliteTable(
  "exchange_orders",
  {
    id: text().primaryKey(),
    person_id: text().notNull(),
    /** The account that placed it, and its name then (untrusted). */
    platform: text().notNull(),
    account_id: text().notNull(),
    name: text().notNull(),
    /** The request's key: a retry is the same order. */
    request_key: text().notNull(),
    company: text().notNull(),
    side: text().notNull(),
    kind: text().notNull(),
    limit_price: integer(),
    coins: integer().notNull(),
    margin: integer().notNull(),
    exposure: integer().notNull(),
    fee: integer().notNull(),
    leverage: integer().notNull(),
    qty: integer().notNull(),
    position_id: text(),
    placed_round: integer().notNull(),
    expires_day: integer().notNull(),
    /** `charging` (the wallet is asked), `open`, `filled`, `cancelled`, `expired`, `void`. */
    status: text().notNull(),
    /** Why it ended (`EndWhy`), `null` while open. */
    why: text(),
    fill_id: text(),
    created_at: micros().notNull(),
    ended_at: micros(),
  },
  (t) => [
    uniqueIndex("exchange_orders_key_idx").on(t.person_id, t.request_key),
    index("exchange_orders_status_idx").on(t.status, t.created_at),
    index("exchange_orders_person_idx").on(t.person_id, t.created_at),
    check(
      "exchange_orders_status_check",
      sql`${t.status} IN ('charging', 'open', 'filled', 'cancelled', 'expired', 'void')`,
    ),
    check("exchange_orders_side_check", sql`${t.side} IN ('buy', 'sell')`),
    check("exchange_orders_kind_check", sql`${t.kind} IN ('market', 'limit')`),
    check(
      "exchange_orders_amount_check",
      sql`${t.coins} >= 0 AND ${t.margin} >= 0 AND ${t.fee} >= 0 AND ${t.qty} >= 0 AND ${t.leverage} >= 1`,
    ),
  ],
);

export const exchangePositions = sqliteTable(
  "exchange_positions",
  {
    id: text().primaryKey(),
    person_id: text().notNull(),
    company: text().notNull(),
    leverage: integer().notNull(),
    qty: integer().notNull(),
    cost: integer().notNull(),
    margin: integer().notNull(),
    loan: integer().notNull(),
    /** Thousandths of a coin. */
    carry: integer().notNull().default(0),
    day: integer().notNull(),
    round: integer().notNull(),
    warned_half: integer(),
    warned_near: integer(),
    /** `open`, `closed`, `liquidated`. */
    status: text().notNull(),
    closed_round: integer(),
    created_at: micros().notNull(),
    closed_at: micros(),
  },
  (t) => [
    index("exchange_positions_person_idx").on(t.person_id, t.status),
    index("exchange_positions_status_idx").on(t.status, t.company),
    check("exchange_positions_status_check", sql`${t.status} IN ('open', 'closed', 'liquidated')`),
    check(
      "exchange_positions_amount_check",
      sql`${t.qty} >= 0 AND ${t.cost} >= 0 AND ${t.margin} >= 0 AND ${t.loan} >= 0 AND ${t.carry} >= 0`,
    ),
  ],
);

export const exchangeFills = sqliteTable(
  "exchange_fills",
  {
    id: text().primaryKey(),
    order_id: text(),
    person_id: text().notNull(),
    company: text().notNull(),
    side: text().notNull(),
    /** `order`, `liquidation`, `admin`, `owed`. */
    kind: text().notNull(),
    position_id: text(),
    leverage: integer().notNull(),
    qty: integer().notNull(),
    price: integer().notNull(),
    gross: integer().notNull(),
    fee: integer().notNull(),
    tax: integer().notNull(),
    carry: integer().notNull(),
    paid: integer().notNull(),
    vault: integer().notNull(),
    round: integer().notNull(),
    /** The owner who sold it (`admin`). */
    by: text(),
    created_at: micros().notNull(),
  },
  (t) => [
    index("exchange_fills_person_idx").on(t.person_id, t.created_at),
    index("exchange_fills_round_idx").on(t.round),
    check("exchange_fills_kind_check", sql`${t.kind} IN ('order', 'liquidation', 'admin', 'owed')`),
    check("exchange_fills_paid_check", sql`${t.paid} >= 0`),
  ],
);

export const exchangePostings = sqliteTable(
  "exchange_postings",
  {
    key: text().primaryKey(),
    person_id: text().notNull(),
    /** `[{ reason, delta, key }]`. */
    entries: text().notNull(),
    ref: text().notNull(),
    /** Refused when it would take the wallet below zero (a buy); a payout is never refused. */
    covered: integer({ mode: "boolean" }).notNull(),
    /** `pending`, `posted`, `short` (a buy the wallet could not cover). */
    status: text().notNull(),
    created_at: micros().notNull(),
    posted_at: micros(),
  },
  (t) => [
    index("exchange_postings_status_idx").on(t.status, t.created_at),
    check("exchange_postings_status_check", sql`${t.status} IN ('pending', 'posted', 'short')`),
  ],
);

export const exchangeVault = sqliteTable(
  "exchange_vault",
  {
    id: integer().primaryKey({ autoIncrement: true }),
    round: integer().notNull(),
    /** `buy`, `sell`, `burn`, `owed`, `margin`, `admin`. */
    kind: text().notNull(),
    amount: integer().notNull(),
    /** The vault after this row. */
    balance: integer().notNull(),
    ref: text().notNull(),
    at: micros().notNull(),
  },
  (t) => [
    index("exchange_vault_round_idx").on(t.round),
    check("exchange_vault_balance_check", sql`${t.balance} >= 0`),
    check(
      "exchange_vault_kind_check",
      sql`${t.kind} IN ('buy', 'sell', 'burn', 'owed', 'margin', 'admin')`,
    ),
  ],
);

export const exchangeNews = sqliteTable(
  "exchange_news",
  {
    id: text().primaryKey(),
    round: integer().notNull(),
    day: integer().notNull(),
    /** `null`: the whole market. */
    company: text(),
    /** `event`, `earnings`. */
    kind: text().notNull(),
    /** `up`, `down`. */
    direction: text().notNull(),
    /** `small`, `medium`, `large`. */
    size: text().notNull(),
    /** The log move the program put on the price. Never shown, never given to her as a number. */
    move: real().notNull(),
    headline: text(),
    body: text(),
    /** `her`, `plain`; `null` until worded. */
    worded_by: text(),
    created_at: micros().notNull(),
    worded_at: micros(),
  },
  (t) => [
    index("exchange_news_company_idx").on(t.company, t.round),
    index("exchange_news_round_idx").on(t.round),
    check("exchange_news_kind_check", sql`${t.kind} IN ('event', 'earnings')`),
  ],
);

export const exchangeAccounts = sqliteTable("exchange_accounts", {
  person_id: text().primaryKey(),
  opened_at: micros().notNull(),
  /** When they took leverage's risks (the one-time opt-in); `null`: never. */
  leverage_at: micros(),
  /** Off the leaderboards (default: on them). */
  hide_boards: integer({ mode: "boolean" }).notNull().default(false),
  /** Others may see what they hold (default: no). */
  show_holdings: integer({ mode: "boolean" }).notNull().default(false),
  updated_at: micros().notNull(),
});

export const exchangeNotices = sqliteTable(
  "exchange_notices",
  {
    id: text().primaryKey(),
    person_id: text().notNull(),
    /** `warn_half`, `warn_near`, `liquidated`, `owed_paid`, `refunded`. */
    kind: text().notNull(),
    position_id: text(),
    order_id: text(),
    round: integer().notNull(),
    text: text().notNull(),
    created_at: micros().notNull(),
    /** When it went out by DM; `null`: not (yet). */
    sent_at: micros(),
  },
  (t) => [
    index("exchange_notices_person_idx").on(t.person_id, t.created_at),
    index("exchange_notices_sent_idx").on(t.sent_at, t.created_at),
  ],
);

export const exchangeWords = sqliteTable(
  "exchange_words",
  {
    /** `open:<day>`, `close:<day>`, `rating:<day>`. */
    key: text().primaryKey(),
    kind: text().notNull(),
    day: integer().notNull(),
    text: text().notNull(),
    /** `her`, `plain`. */
    by: text().notNull(),
    /** The weekly rating: `[{ code, rating, reason }]`. */
    data: text(),
    created_at: micros().notNull(),
    posted_at: micros(),
  },
  (t) => [index("exchange_words_day_idx").on(t.day)],
);

// ---- real instruments (version 2, owner 2026-11-21): the house is the counterparty ------------

/** One row: the house's state as JSON (today's and recent days' mint and burn, the payout queue, who is bankrupt, the automatic halt). */
export const exchangeHouse = sqliteTable(
  "exchange_house",
  {
    id: integer().primaryKey(),
    state: text().notNull(),
    updated_at: micros().notNull(),
  },
  (t) => [check("exchange_house_one", sql`${t.id} = 1`)],
);

/** The last accepted quote of each real instrument (what a restart starts from). */
export const exchangeQuotes = sqliteTable("exchange_quotes", {
  code: text().primaryKey(),
  /** Coins per unit. */
  price: real().notNull(),
  at: micros().notNull(),
  prev_close: real(),
  /** Quotes refused since the last accepted one, and why the last was. */
  refused: integer().notNull().default(0),
  last_refusal: text(),
  updated_at: micros().notNull(),
});

export const exchangeRealOrders = sqliteTable(
  "exchange_real_orders",
  {
    id: text().primaryKey(),
    person_id: text().notNull(),
    platform: text().notNull(),
    account_id: text().notNull(),
    name: text().notNull(),
    request_key: text().notNull(),
    code: text().notNull(),
    side: text().notNull(),
    limit_price: real(),
    coins: integer().notNull(),
    margin: integer().notNull(),
    exposure: integer().notNull(),
    fee: integer().notNull(),
    leverage: real().notNull(),
    qty: integer().notNull(),
    position_id: text(),
    placed_at: micros().notNull(),
    expires_at: micros().notNull(),
    /** `charging`, `open`, `filled`, `cancelled`, `expired`, `void`. */
    status: text().notNull(),
    why: text(),
    ended_at: micros(),
  },
  (t) => [
    uniqueIndex("exchange_real_orders_key_idx").on(t.person_id, t.request_key),
    index("exchange_real_orders_status_idx").on(t.status, t.code),
    index("exchange_real_orders_person_idx").on(t.person_id, t.placed_at),
    check(
      "exchange_real_orders_status_check",
      sql`${t.status} IN ('charging', 'open', 'filled', 'cancelled', 'expired', 'void')`,
    ),
    check(
      "exchange_real_orders_amount_check",
      sql`${t.coins} >= 0 AND ${t.margin} >= 0 AND ${t.fee} >= 0 AND ${t.qty} >= 0 AND ${t.leverage} >= 1`,
    ),
  ],
);

export const exchangeRealPositions = sqliteTable(
  "exchange_real_positions",
  {
    id: text().primaryKey(),
    person_id: text().notNull(),
    code: text().notNull(),
    leverage: real().notNull(),
    /** Millionths of a unit. */
    qty: integer().notNull(),
    cost: integer().notNull(),
    margin: integer().notNull(),
    loan: integer().notNull(),
    carry: integer().notNull().default(0),
    opened_at: micros().notNull(),
    warned_half: micros(),
    warned_near: micros(),
    /** `open`, `closed`, `liquidated`. */
    status: text().notNull(),
    closed_at: micros(),
  },
  (t) => [
    index("exchange_real_positions_person_idx").on(t.person_id, t.status),
    index("exchange_real_positions_status_idx").on(t.status, t.code),
    check(
      "exchange_real_positions_status_check",
      sql`${t.status} IN ('open', 'closed', 'liquidated')`,
    ),
    check(
      "exchange_real_positions_amount_check",
      sql`${t.qty} >= 0 AND ${t.cost} >= 0 AND ${t.margin} >= 0 AND ${t.loan} >= 0 AND ${t.carry} >= 0`,
    ),
  ],
);

export const exchangeRealFills = sqliteTable(
  "exchange_real_fills",
  {
    id: text().primaryKey(),
    order_id: text(),
    person_id: text().notNull(),
    code: text().notNull(),
    side: text().notNull(),
    /** `order`, `liquidation`, `shortfall`, `bankruptcy`, `admin`. */
    kind: text().notNull(),
    position_id: text(),
    leverage: real().notNull(),
    qty: integer().notNull(),
    price: real().notNull(),
    gross: integer().notNull(),
    fee: integer().notNull(),
    tax: integer().notNull(),
    carry: integer().notNull(),
    paid: integer().notNull(),
    shortfall: integer().notNull(),
    by: text(),
    created_at: micros().notNull(),
  },
  (t) => [
    index("exchange_real_fills_person_idx").on(t.person_id, t.created_at),
    index("exchange_real_fills_created_idx").on(t.created_at),
    check("exchange_real_fills_paid_check", sql`${t.paid} >= 0 AND ${t.shortfall} >= 0`),
  ],
);

/** Accepted quotes over time (thinned): what a company page's chart and the quote card draw. */
export const exchangeQuoteTicks = sqliteTable(
  "exchange_quote_ticks",
  {
    code: text().notNull(),
    at: micros().notNull(),
    price: real().notNull(),
  },
  (t) => [primaryKey({ name: "exchange_quote_ticks_pk", columns: [t.code, t.at] })],
);

/** The house's own record of every coin it moved (and every write-off), append-only. */
export const exchangeHouseLines = sqliteTable(
  "exchange_house_lines",
  {
    id: integer().primaryKey({ autoIncrement: true }),
    day: integer().notNull(),
    kind: text().notNull(),
    person_id: text().notNull(),
    code: text().notNull(),
    amount: integer().notNull(),
    ref: text().notNull(),
    at: micros().notNull(),
  },
  (t) => [
    index("exchange_house_lines_day_idx").on(t.day, t.kind),
    check(
      "exchange_house_lines_kind_check",
      sql`${t.kind} IN ('burn', 'mint', 'fee', 'loss', 'refund', 'escrow', 'release', 'writeoff')`,
    ),
  ],
);

/**
 * The instruments people have looked up (owner 2026-11-21: an open universe): the first request for
 * a ticker validates it through the provider and adds it here; later requests read this row.
 */
export const exchangeInstruments = sqliteTable(
  "exchange_instruments",
  {
    /** The provider's symbol, also what people see (`2330.TW`, `6488.TWO`, `AAPL`). */
    code: text().primaryKey(),
    market: text().notNull(),
    name: text().notNull(),
    /** As the provider reports them (`TAI`, `TWO`, `NMS`; `EQUITY`, `ETF`). */
    exchange: text().notNull(),
    type: text().notNull(),
    currency: text().notNull(),
    provider: text().notNull(),
    /** `active`, `blocked` (sell only), `paused` (a split-like jump waits for the owner), `suspended` (gone for days). */
    status: text().notNull(),
    reason: text(),
    added_at: micros().notNull(),
    added_by: text(),
    last_quote_at: micros(),
    /** Trading days in a row it had no valid quote. */
    missing_days: integer().notNull().default(0),
    last_viewed_at: micros(),
    updated_at: micros().notNull(),
    /** The owner's display name for it (`null`: the starter list's, else the provider's). */
    name_override: text(),
    /**
     * The provider's last price outside a session (the previous close), fetched on demand while
     * its market is closed: shown and used to value holdings, never traded at.
     */
    close_price: real(),
    close_prev: real(),
    close_at: micros(),
  },
  (t) => [
    index("exchange_instruments_status_idx").on(t.status),
    check(
      "exchange_instruments_status_check",
      sql`${t.status} IN ('active', 'blocked', 'paused', 'suspended', 'removed')`,
    ),
    check("exchange_instruments_market_check", sql`${t.market} IN ('tw', 'us', 'crypto', 'local')`),
  ],
);

/**
 * A member's marks on tickers: `watch` (their watch list, capped), `view` (what they opened
 * recently, for 我最近看過 and for whether they are still around). Never shown to anyone else.
 */
export const exchangeMarks = sqliteTable(
  "exchange_marks",
  {
    person_id: text().notNull(),
    kind: text().notNull(),
    code: text().notNull(),
    at: micros().notNull(),
  },
  (t) => [
    primaryKey({ name: "exchange_marks_pk", columns: [t.person_id, t.kind, t.code] }),
    index("exchange_marks_kind_idx").on(t.kind, t.at),
    check("exchange_marks_kind_check", sql`${t.kind} IN ('watch', 'view')`),
  ],
);
