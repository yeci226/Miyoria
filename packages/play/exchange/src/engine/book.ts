// The book: orders, holdings, the vault, and what one round does to them
// (docs/design/exchange.md §3, §6, §7). Everything trades with the exchange at the round's one
// price; nobody trades with anybody else.
//
// The vault is closed. A buy puts its margin in (the whole cost, for a plain buy); a sale takes
// out what the holding is worth, less what a leveraged one borrowed; nothing else ever adds coins
// to it, and nothing takes out more than it holds: a sale it cannot pay waits for the next round,
// a liquidation it cannot pay is owed and paid first when it can. Fees, the tax and the carry fee
// are burned, never kept.
//
// Leverage is isolated per position: a 2x buy puts up margin M for exposure 2M, so the vault
// lends the other M under the same closed books. Its owner can lose at most M: the position is
// sold when the margin left is at most `line` of what was put up, after a warning in an earlier
// round, and it never reaches anything else in the wallet. Nobody ever owes a coin.
//
// The functions change the book in place and say what they did (`RoundOutcome`): the module
// writes that to its tables in one transaction, the simulation keeps it in memory.

import {
  closeDay,
  drawRound,
  fishOf,
  limitState,
  type MarketState,
  type NewsDraw,
  openDay,
  priceRound,
} from "./market.js";
import { coinsOf, exactValue, MILLI, qtyFor, saleBurns } from "./money.js";
import type { EngineParams } from "./params.js";
import { isClose, isOpen, roundDay, weekdayOf } from "./time.js";

/** The ledger reasons of the exchange (the economy's health table reads them). */
export const EXCHANGE_REASON = {
  /** Coins a member puts in: a buy's margin (the whole cost, plain), margin added. */
  in: "exchange_in",
  /** Coins back to a member: a sale, a liquidation's remainder, a buy that did not fill. */
  out: "exchange_out",
  /** Burned: the buy fee, the sale fee and tax, the carry fee. */
  fee: "exchange_fee",
  /** The fee of a buy that did not fill, given back. */
  feeBack: "exchange_fee_back",
} as const;

export type Side = "buy" | "sell";
export type OrderKind = "market" | "limit";

export interface Order {
  id: string;
  person: string;
  company: string;
  side: Side;
  kind: OrderKind;
  /** A limit order's price in cents: at most this for a buy, at least this for a sale. */
  limit: number | null;
  /** A buy: what was paid, margin plus fee. */
  coins: number;
  margin: number;
  /** A buy: what it buys (margin times leverage). */
  exposure: number;
  fee: number;
  leverage: number;
  /** A sale of plain holdings: thousandths of a share. */
  qty: number;
  /** A sale that closes this leveraged position. */
  position: string | null;
  /** The last round handled when it was placed: it fills from the next one on. */
  placed_round: number;
  /** The last local day it may fill. */
  expires_day: number;
}

export interface Position {
  id: string;
  person: string;
  company: string;
  /** 1: a plain lot; 2: a leveraged position. */
  leverage: number;
  /** Thousandths of a share. */
  qty: number;
  /** What it cost: the exposure bought (cost basis for the holding limits). */
  cost: number;
  /** The margin put up, added margin included (plain: the cost). */
  margin: number;
  /** What the vault lent; 0 for a plain lot. */
  loan: number;
  /** The carry fee accrued, in thousandths of a coin. */
  carry: number;
  /** The local day it was bought: it can be sold from the next day on. */
  day: number;
  round: number;
  /** The rounds of the two warnings, while they stand. */
  warned_half: number | null;
  warned_near: number | null;
}

/** A liquidation the vault could not pay yet: paid first when it can. */
export interface Owed {
  id: string;
  person: string;
  position: string;
  company: string;
  /** What the vault pays out, of which `fee + tax + carry` is burned. */
  gross: number;
  fee: number;
  tax: number;
  carry: number;
  round: number;
}

export interface Book {
  market: MarketState;
  orders: Order[];
  positions: Position[];
  owed: Owed[];
  /** Coins in the vault. Never below zero. */
  vault: number;
  /** The last local day with a held round (the carry fee runs only on days that traded). */
  held_day: number | null;
}

export interface PostingEntry {
  reason: string;
  delta: number;
}

/** What one member's wallet is to get, under one key, in one atomic posting. */
export interface Posting {
  key: string;
  person: string;
  entries: PostingEntry[];
  /** The order or fill it is for. */
  ref: string;
}

export type FillKind = "order" | "liquidation" | "admin" | "owed";

export interface Fill {
  id: string;
  order: string | null;
  person: string;
  company: string;
  side: Side;
  kind: FillKind;
  /** The leveraged position, or the first lot a sale took from. */
  position: string | null;
  leverage: number;
  qty: number;
  price: number;
  /** A buy: the exposure bought; a sale: what the shares brought in. */
  gross: number;
  fee: number;
  tax: number;
  carry: number;
  /** Coins to the member (a sale); 0 for a buy. */
  paid: number;
  /** The vault's change. */
  vault: number;
  round: number;
}

export type EndWhy =
  | "filled"
  | "day_end"
  | "expired"
  | "skipped"
  | "halted"
  | "paused"
  | "too_small"
  | "no_holding"
  | "cancelled";

export interface OrderEnd {
  order: Order;
  status: "filled" | "cancelled" | "expired";
  why: EndWhy;
  fill: string | null;
  /** A buy that did not fill: its margin and fee go back. */
  refunded: boolean;
}

export type NoticeKind = "warn_half" | "warn_near" | "liquidated" | "owed_paid";

export interface Notice {
  kind: NoticeKind;
  person: string;
  position: string;
  company: string;
  round: number;
  /** The round's price, and the price at which it is sold (the line). */
  price: number;
  line_price: number;
  /** The margin left as a share of what was put up. */
  ratio: number;
  /** A liquidation: what came back (`null` while it is owed). */
  paid: number | null;
}

export type RoundStatus = "held" | "skipped" | "halted" | "paused";

export interface CompanyRound {
  code: string;
  price: number;
  ref: number;
  limit: "up" | "down" | null;
  /** Coins bought and sold at this round. */
  bought: number;
  sold: number;
}

export interface VaultMove {
  kind: "buy" | "sell" | "burn" | "owed" | "margin" | "admin";
  amount: number;
  ref: string;
}

export interface RoundOutcome {
  round: number;
  status: RoundStatus;
  companies: CompanyRound[];
  news: NewsDraw[];
  fills: Fill[];
  ended: OrderEnd[];
  opened: Position[];
  changed: Position[];
  closed: { position: Position; status: "closed" | "liquidated" }[];
  owed_added: Owed[];
  owed_paid: Owed[];
  notices: Notice[];
  postings: Posting[];
  vault: VaultMove[];
  /** Coins burned at this round (fees of buys that filled, sale fees and tax, carry, the vault). */
  burned: number;
  /** After the round: the vault, the holdings, their ratio, the index. */
  vault_after: number;
  obligations: number;
  level: number | null;
  fish: number;
  /** The breaker stopped the day at this round. */
  breaker: boolean;
}

/** The context of a round: the seed, the round, the rules, a source of new ids. */
export interface RoundInput {
  seed: string;
  round: number;
  params: EngineParams;
  newId: () => string;
  /** `held` when it runs, else why it does not (prices stay, orders waiting for it end). */
  mode: "held" | "skipped" | "paused";
}

// ---- reading the book -----------------------------------------------------------------------

export function companyIndex(p: EngineParams, code: string): number {
  return p.companies.findIndex((c) => c.code === code);
}

export function priceOf(book: Book, code: string): number {
  return book.market.companies.find((c) => c.code === code)?.price ?? 0;
}

/** What a position is worth to its owner now: its value less what it borrowed and the carry. */
export function equityOf(pos: Position, price: number): number {
  return exactValue(pos.qty, price) - pos.loan - pos.carry / MILLI;
}

/** The margin left over the margin put up (1 for a plain lot). */
export function marginRatio(pos: Position, price: number): number {
  if (pos.leverage <= 1 || pos.margin <= 0) return 1;
  return equityOf(pos, price) / pos.margin;
}

/** The price (cents) at which a leveraged position is sold: where the margin left hits the line. */
export function linePrice(pos: Position, p: EngineParams): number {
  if (pos.leverage <= 1 || pos.qty <= 0) return 0;
  const coins = pos.loan + pos.carry / MILLI + p.leverage.line * pos.margin;
  return Math.ceil((coins * 100_000) / pos.qty);
}

/** The price at which a warning comes, for a share `at` of the margin left. */
export function warnPrice(pos: Position, at: number): number {
  if (pos.leverage <= 1 || pos.qty <= 0) return 0;
  const coins = pos.loan + pos.carry / MILLI + at * pos.margin;
  return Math.ceil((coins * 100_000) / pos.qty);
}

/** What everyone could take out now: plain holdings at their value, leveraged ones at equity. */
export function obligationsOf(book: Book): number {
  let total = 0;
  for (const pos of book.positions) {
    const price = priceOf(book, pos.company);
    total += pos.leverage > 1 ? Math.max(0, equityOf(pos, price)) : exactValue(pos.qty, price);
  }
  return total;
}

/** Vault over holdings; `null` while the holdings are too small to say. */
export function levelOf(book: Book, p: EngineParams): number | null {
  const o = obligationsOf(book);
  return o < p.level_floor ? null : book.vault / o;
}

/** Coins held by open buy orders (margin and fee). */
export function escrowOf(book: Book): number {
  return book.orders.reduce((t, o) => t + (o.side === "buy" ? o.coins : 0), 0);
}

// ---- placing ----------------------------------------------------------------------------------

/** A buy into the book: the posting that takes its margin and fee from the wallet. */
export function placeBuy(book: Book, order: Order): Posting {
  book.orders.push(order);
  return {
    key: `exchange:order:${order.id}`,
    person: order.person,
    ref: order.id,
    entries: entries([
      [EXCHANGE_REASON.in, -order.margin],
      [EXCHANGE_REASON.fee, -order.fee],
    ]),
  };
}

/** A sale into the book (the shares stay until it fills). */
export function placeSell(book: Book, order: Order): void {
  book.orders.push(order);
}

/** The posting that gives a buy's margin and fee back. */
export function refundPosting(order: Order): Posting {
  return {
    key: `exchange:refund:${order.id}`,
    person: order.person,
    ref: order.id,
    entries: entries([
      [EXCHANGE_REASON.out, order.margin],
      [EXCHANGE_REASON.feeBack, order.fee],
    ]),
  };
}

/** Takes an open order out of the book; a buy's coins go back. `null` when it is not open. */
export function cancelOrder(
  book: Book,
  id: string,
  why: EndWhy = "cancelled",
): { end: OrderEnd; posting: Posting | null } | null {
  const at = book.orders.findIndex((o) => o.id === id);
  if (at < 0) return null;
  const [order] = book.orders.splice(at, 1) as [Order];
  const refunded = order.side === "buy";
  return {
    end: { order, status: why === "expired" ? "expired" : "cancelled", why, fill: null, refunded },
    posting: refunded ? refundPosting(order) : null,
  };
}

/**
 * Adds `coins` of margin to a leveraged position: it pays down what the vault lent, so the line
 * moves down. At most what is still borrowed. The posting takes the coins from the wallet.
 */
export function addMargin(
  book: Book,
  positionId: string,
  coins: number,
  key: string,
  p: EngineParams,
): { position: Position; posting: Posting; added: number } | null {
  const pos = book.positions.find((x) => x.id === positionId);
  if (!pos || pos.leverage <= 1) return null;
  const added = Math.min(coins, pos.loan);
  if (!(added > 0)) return null;
  pos.loan -= added;
  pos.margin += added;
  book.vault += added;
  rearm(pos, marginRatio(pos, priceOf(book, pos.company)), p);
  return {
    position: pos,
    added,
    posting: {
      key,
      person: pos.person,
      ref: pos.id,
      entries: entries([[EXCHANGE_REASON.in, -added]]),
    },
  };
}

function entries(pairs: readonly (readonly [string, number])[]): PostingEntry[] {
  return pairs.filter(([, d]) => d !== 0).map(([reason, delta]) => ({ reason, delta }));
}

// ---- one round ------------------------------------------------------------------------------

function emptyOutcome(round: number, status: RoundStatus): RoundOutcome {
  return {
    round,
    status,
    companies: [],
    news: [],
    fills: [],
    ended: [],
    opened: [],
    changed: [],
    closed: [],
    owed_added: [],
    owed_paid: [],
    notices: [],
    postings: [],
    vault: [],
    burned: 0,
    vault_after: 0,
    obligations: 0,
    level: null,
    fish: 0,
    breaker: false,
  };
}

/** Orders in the order they were placed. */
function byPlacement(a: Order, b: Order): number {
  return a.placed_round - b.placed_round || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

function canBuyAt(order: Order, price: number, ref: number, p: EngineParams): boolean {
  if (order.limit !== null && price > order.limit) return false;
  // At the upper limit the exchange does not sell: the buy waits.
  return limitState(price, ref, p) !== "up";
}

function canSellAt(order: Order, price: number, ref: number, p: EngineParams): boolean {
  if (order.limit !== null && price < order.limit) return false;
  // At the lower limit the exchange does not buy: the sale waits.
  return limitState(price, ref, p) !== "down";
}

/** Plain lots of a person in a company that can be sold today (bought before `day`), oldest first. */
export function sellableLots(book: Book, person: string, company: string, day: number): Position[] {
  return book.positions
    .filter((x) => x.person === person && x.company === company && x.leverage <= 1 && x.day < day)
    .sort((a, b) => a.round - b.round || (a.id < b.id ? -1 : 1));
}

function end(
  out: RoundOutcome,
  order: Order,
  status: OrderEnd["status"],
  why: EndWhy,
  fill: string | null,
  book: Book,
): void {
  const at = book.orders.indexOf(order);
  if (at >= 0) book.orders.splice(at, 1);
  const refunded = order.side === "buy" && status !== "filled";
  out.ended.push({ order, status, why, fill, refunded });
  if (refunded) out.postings.push(refundPosting(order));
}

function changed(out: RoundOutcome, pos: Position): void {
  if (!out.changed.includes(pos) && !out.opened.includes(pos)) out.changed.push(pos);
}

function close(
  out: RoundOutcome,
  book: Book,
  pos: Position,
  status: "closed" | "liquidated",
): void {
  const at = book.positions.indexOf(pos);
  if (at >= 0) book.positions.splice(at, 1);
  const c = out.changed.indexOf(pos);
  if (c >= 0) out.changed.splice(c, 1);
  out.closed.push({ position: pos, status });
}

function salePosting(fill: Fill): Posting | null {
  const burned = fill.fee + fill.tax + fill.carry;
  const out = fill.paid + burned;
  if (out <= 0) return null;
  return {
    key: `exchange:fill:${fill.id}`,
    person: fill.person,
    ref: fill.id,
    entries: entries([
      [EXCHANGE_REASON.out, out],
      [EXCHANGE_REASON.fee, -burned],
    ]),
  };
}

/** What closing a leveraged position at `gross` brings: what the vault pays, and its burns. */
function leveragedClose(
  pos: Position,
  gross: number,
  p: EngineParams,
): { out: number; fee: number; tax: number; carry: number } {
  const out = Math.max(0, gross - pos.loan);
  const burns = saleBurns(gross, p);
  const fee = Math.min(out, burns.fee);
  const tax = Math.min(out - fee, burns.tax);
  const carry = Math.min(out - fee - tax, Math.ceil(pos.carry / MILLI - 1e-9));
  return { out, fee, tax, carry };
}

/**
 * Handles round `input.round` (the next after `book.market.round`). A held round draws its news,
 * prices the companies with the net buying of the orders it can fill, fills them, checks every
 * leveraged position, and may trip the breaker. A round that is not held moves nothing, and the
 * market orders that waited for it end with their coins given back. The day's open and close run
 * either way.
 */
export function settleRound(book: Book, input: RoundInput): RoundOutcome {
  const { seed, round, params: p } = input;
  const day = roundDay(round, p);
  if (isOpen(round, p)) openDay(book.market, seed, day, p);
  let status: RoundStatus = input.mode;
  if (status === "held" && book.market.halted_day === day) status = "halted";
  const out = emptyOutcome(round, status);
  if (status === "held") {
    holdRound(book, input, day, out);
    book.held_day = day;
  } else {
    for (const order of [...book.orders].sort(byPlacement)) {
      if (order.kind === "market" && order.placed_round < round)
        end(out, order, "cancelled", status, null, book);
    }
  }
  if (isClose(round, p)) closeRound(book, input, day, out);
  book.market.round = round;
  out.vault_after = book.vault;
  out.obligations = Math.round(obligationsOf(book) * 100) / 100;
  out.level = levelOf(book, p);
  out.fish = fishOf(book.market, p);
  return out;
}

function holdRound(book: Book, input: RoundInput, day: number, out: RoundOutcome): void {
  const { seed, round, params: p } = input;
  payOwed(book, out);
  const m = book.market;
  const draw = drawRound(seed, round, p);
  const level = levelOf(book, p);
  const n = m.companies.length;
  const zero = new Array<number>(n).fill(0);
  const tentative = priceRound(m, draw, zero, level, p);
  const waiting = book.orders.filter((o) => o.placed_round < round).sort(byPlacement);
  const flows = [...zero];
  for (const o of waiting) {
    const i = companyIndex(p, o.company);
    const c = tentative[i];
    if (!c) continue;
    if (o.side === "buy" && canBuyAt(o, c.price, c.ref, p)) flows[i] = (flows[i] ?? 0) + o.exposure;
    if (o.side === "sell" && canSellAt(o, c.price, c.ref, p)) {
      const qty =
        o.position === null ? o.qty : (book.positions.find((x) => x.id === o.position)?.qty ?? 0);
      flows[i] = (flows[i] ?? 0) - exactValue(qty, c.price);
    }
  }
  m.companies = priceRound(m, draw, flows, level, p);
  out.news.push(...draw.news);
  const bought = new Array<number>(n).fill(0);
  const sold = new Array<number>(n).fill(0);

  // Buys first: their coins are in the vault before any sale is paid.
  for (const order of waiting) {
    if (order.side !== "buy") continue;
    const i = companyIndex(p, order.company);
    const c = m.companies[i];
    if (!c || !canBuyAt(order, c.price, c.ref, p)) continue;
    const qty = qtyFor(order.exposure, c.price);
    if (qty <= 0) {
      end(out, order, "cancelled", "too_small", null, book);
      continue;
    }
    const pos: Position = {
      id: input.newId(),
      person: order.person,
      company: order.company,
      leverage: order.leverage,
      qty,
      cost: order.exposure,
      margin: order.margin,
      loan: order.exposure - order.margin,
      carry: 0,
      day,
      round,
      warned_half: null,
      warned_near: null,
    };
    book.positions.push(pos);
    out.opened.push(pos);
    book.vault += order.margin;
    out.burned += order.fee;
    const fill: Fill = {
      id: input.newId(),
      order: order.id,
      person: order.person,
      company: order.company,
      side: "buy",
      kind: "order",
      position: pos.id,
      leverage: order.leverage,
      qty,
      price: c.price,
      gross: order.exposure,
      fee: order.fee,
      tax: 0,
      carry: 0,
      paid: 0,
      vault: order.margin,
      round,
    };
    out.fills.push(fill);
    out.vault.push({ kind: "buy", amount: order.margin, ref: fill.id });
    bought[i] = (bought[i] ?? 0) + order.exposure;
    end(out, order, "filled", "filled", fill.id, book);
  }

  // Then sales, in the order they were placed, while the vault can pay them.
  for (const order of waiting) {
    if (order.side !== "sell" || !book.orders.includes(order)) continue;
    const i = companyIndex(p, order.company);
    const c = m.companies[i];
    if (!c || !canSellAt(order, c.price, c.ref, p)) continue;
    const fill =
      order.position === null
        ? sellLots(book, order, c.price, day, input, out)
        : closePosition(book, order, c.price, day, input, out);
    if (fill === "wait") continue;
    if (fill === null) {
      end(out, order, "cancelled", "no_holding", null, book);
      continue;
    }
    sold[i] = (sold[i] ?? 0) + fill.gross;
    end(out, order, "filled", "filled", fill.id, book);
  }

  checkLeverage(book, input, out);

  for (const [i, c] of m.companies.entries()) {
    out.companies.push({
      code: c.code,
      price: c.price,
      ref: c.ref,
      limit: limitState(c.price, c.ref, p),
      bought: bought[i] ?? 0,
      sold: sold[i] ?? 0,
    });
  }
  // The breaker: the index this far under the previous close stops the rest of the day.
  if (fishOf(m, p) <= m.fish_ref * (1 - p.breaker)) {
    m.halted_day = day;
    out.breaker = true;
  }
}

function sellLots(
  book: Book,
  order: Order,
  price: number,
  day: number,
  input: RoundInput,
  out: RoundOutcome,
): Fill | null | "wait" {
  const lots = sellableLots(book, order.person, order.company, day);
  const available = lots.reduce((t, l) => t + l.qty, 0);
  const qty = Math.min(order.qty, available);
  if (qty <= 0) return null;
  const gross = coinsOf(qty, price);
  if (book.vault < gross) return "wait";
  const { fee, tax } = saleBurns(gross, input.params);
  let left = qty;
  let first: string | null = null;
  for (const lot of lots) {
    if (left <= 0) break;
    const take = Math.min(lot.qty, left);
    first ??= lot.id;
    if (take === lot.qty) {
      close(out, book, lot, "closed");
    } else {
      lot.cost -= Math.floor((lot.cost * take) / lot.qty);
      lot.margin = lot.cost;
      lot.qty -= take;
      changed(out, lot);
    }
    left -= take;
  }
  book.vault -= gross;
  out.burned += fee + tax;
  const fill: Fill = {
    id: input.newId(),
    order: order.id,
    person: order.person,
    company: order.company,
    side: "sell",
    kind: "order",
    position: first,
    leverage: 1,
    qty,
    price,
    gross,
    fee,
    tax,
    carry: 0,
    paid: gross - fee - tax,
    vault: -gross,
    round: input.round,
  };
  out.fills.push(fill);
  out.vault.push({ kind: "sell", amount: -gross, ref: fill.id });
  const posting = salePosting(fill);
  if (posting) out.postings.push(posting);
  return fill;
}

function closePosition(
  book: Book,
  order: Order,
  price: number,
  day: number,
  input: RoundInput,
  out: RoundOutcome,
): Fill | null | "wait" {
  const pos = book.positions.find((x) => x.id === order.position && x.person === order.person);
  if (!pos || pos.day >= day) return pos ? "wait" : null;
  const gross = coinsOf(pos.qty, price);
  const money = leveragedClose(pos, gross, input.params);
  if (book.vault < money.out) return "wait";
  return closeWith(book, pos, price, gross, money, "order", order.id, input, out);
}

function closeWith(
  book: Book,
  pos: Position,
  price: number,
  gross: number,
  money: { out: number; fee: number; tax: number; carry: number },
  kind: FillKind,
  order: string | null,
  input: RoundInput,
  out: RoundOutcome,
): Fill {
  book.vault -= money.out;
  const burned = money.fee + money.tax + money.carry;
  out.burned += burned;
  const fill: Fill = {
    id: input.newId(),
    order,
    person: pos.person,
    company: pos.company,
    side: "sell",
    kind,
    position: pos.id,
    leverage: pos.leverage,
    qty: pos.qty,
    price,
    gross,
    fee: money.fee,
    tax: money.tax,
    carry: money.carry,
    paid: money.out - burned,
    vault: -money.out,
    round: input.round,
  };
  out.fills.push(fill);
  out.vault.push({ kind: kind === "admin" ? "admin" : "sell", amount: -money.out, ref: fill.id });
  const posting = salePosting(fill);
  if (posting) out.postings.push(posting);
  close(out, book, pos, kind === "liquidation" ? "liquidated" : "closed");
  return fill;
}

/** Re-arms a warning once the margin left is well back above it. */
function rearm(pos: Position, ratio: number, p: EngineParams): boolean {
  let moved = false;
  if (pos.warned_half !== null && ratio > p.leverage.warn_half + 0.1) {
    pos.warned_half = null;
    moved = true;
  }
  if (pos.warned_near !== null && ratio > p.leverage.warn_near + 0.1) {
    pos.warned_near = null;
    moved = true;
  }
  return moved;
}

function notice(
  kind: Notice["kind"],
  pos: Position,
  price: number,
  round: number,
  p: EngineParams,
  paid: number | null,
): Notice {
  return {
    kind,
    person: pos.person,
    position: pos.id,
    company: pos.company,
    round,
    price,
    line_price: linePrice(pos, p),
    ratio: Math.round(marginRatio(pos, price) * 1000) / 1000,
    paid,
  };
}

/**
 * Every leveraged position at the round's price: a warning when half the margin is gone, another
 * near the line, and a liquidation at the line only when the second warning came in an earlier
 * round (a position that reaches the line unwarned is warned now and sold at the next round).
 */
function checkLeverage(book: Book, input: RoundInput, out: RoundOutcome): void {
  const { round, params: p } = input;
  const L = p.leverage;
  for (const pos of [...book.positions]) {
    if (pos.leverage <= 1) continue;
    const price = priceOf(book, pos.company);
    const ratio = marginRatio(pos, price);
    if (rearm(pos, ratio, p)) changed(out, pos);
    if (ratio <= L.line && pos.warned_near !== null && pos.warned_near < round) {
      liquidate(book, pos, price, input, out);
      continue;
    }
    if (ratio <= L.warn_near && pos.warned_near === null) {
      pos.warned_near = round;
      pos.warned_half ??= round;
      changed(out, pos);
      out.notices.push(notice("warn_near", pos, price, round, p, null));
    } else if (ratio <= L.warn_half && pos.warned_half === null) {
      pos.warned_half = round;
      changed(out, pos);
      out.notices.push(notice("warn_half", pos, price, round, p, null));
    }
  }
}

function liquidate(
  book: Book,
  pos: Position,
  price: number,
  input: RoundInput,
  out: RoundOutcome,
): void {
  // Rounded up: a liquidation never loses a fraction of a coin to the house.
  const gross = Math.ceil(exactValue(pos.qty, price) - 1e-9);
  const money = leveragedClose(pos, gross, input.params);
  const line = linePrice(pos, input.params);
  if (book.vault >= money.out) {
    const fill = closeWith(book, pos, price, gross, money, "liquidation", null, input, out);
    out.notices.push({
      ...notice("liquidated", pos, price, input.round, input.params, fill.paid),
      line_price: line,
    });
    return;
  }
  const owed: Owed = {
    id: input.newId(),
    person: pos.person,
    position: pos.id,
    company: pos.company,
    gross: money.out,
    fee: money.fee,
    tax: money.tax,
    carry: money.carry,
    round: input.round,
  };
  book.owed.push(owed);
  out.owed_added.push(owed);
  out.notices.push({
    ...notice("liquidated", pos, price, input.round, input.params, null),
    line_price: line,
  });
  close(out, book, pos, "liquidated");
}

/** Pays what liquidations are owed, oldest first, while the vault can. */
function payOwed(book: Book, out: RoundOutcome): void {
  while (book.owed.length > 0) {
    const owed = book.owed[0] as Owed;
    if (book.vault < owed.gross) return;
    book.owed.shift();
    book.vault -= owed.gross;
    const burned = owed.fee + owed.tax + owed.carry;
    out.burned += burned;
    out.owed_paid.push(owed);
    out.vault.push({ kind: "owed", amount: -owed.gross, ref: owed.id });
    if (owed.gross > 0) {
      out.postings.push({
        key: `exchange:owed:${owed.id}`,
        person: owed.person,
        ref: owed.id,
        entries: entries([
          [EXCHANGE_REASON.out, owed.gross],
          [EXCHANGE_REASON.fee, -burned],
        ]),
      });
    }
  }
}

function closeRound(book: Book, input: RoundInput, day: number, out: RoundOutcome): void {
  const { seed, round, params: p } = input;
  for (const order of [...book.orders].sort(byPlacement)) {
    if (order.placed_round >= round) continue;
    if (order.kind === "market") end(out, order, "cancelled", "day_end", null, book);
    else if (order.expires_day <= day) end(out, order, "expired", "expired", null, book);
  }
  // The carry fee, on days that traded.
  if (book.held_day === day) {
    for (const pos of book.positions) {
      if (pos.leverage <= 1 || pos.loan <= 0) continue;
      pos.carry += Math.ceil(pos.loan * p.leverage.carry_daily * MILLI - 1e-9);
      changed(out, pos);
    }
  }
  out.news.push(...closeDay(book.market, seed, day, p, book.held_day === day));
  // Sunday: what the vault holds above `vault_burn_level` of the holdings is burned.
  if (weekdayOf(day) === 0) {
    const o = Math.max(obligationsOf(book), p.level_floor);
    const owed = book.owed.reduce((t, x) => t + x.gross, 0);
    const excess = Math.floor(book.vault - owed - p.vault_burn_level * o);
    if (excess > 0) {
      book.vault -= excess;
      out.burned += excess;
      out.vault.push({ kind: "burn", amount: -excess, ref: `burn:${round}` });
    }
  }
}

/**
 * Sells a person's holding now, at the last round's price, for the owner (`/api/exchange/sell`):
 * no fee, no tax, no carry, no T+1; only when the vault can pay. `null` when there is nothing.
 */
export function adminSell(
  book: Book,
  pos: Position,
  input: Omit<RoundInput, "mode">,
  out: RoundOutcome,
): Fill | "short" {
  const price = priceOf(book, pos.company);
  const gross = coinsOf(pos.qty, price);
  const money = { out: Math.max(0, gross - pos.loan), fee: 0, tax: 0, carry: 0 };
  if (book.vault < money.out) return "short";
  return closeWith(book, pos, price, gross, money, "admin", null, { ...input, mode: "held" }, out);
}

/** An outcome for something done outside a round (the owner's sale). */
export function outcomeOf(round: number): RoundOutcome {
  return emptyOutcome(round, "held");
}
