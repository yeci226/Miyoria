// Real Taiwan and US stocks with the house as the counterparty (owner 2026-11-21, v1: paper trading
// with fish coins). A buy burns its coins into a position; a sale mints the position's value back.
// One fee on every trade, burned. One inflation guard: a market-wide cap on the NET coins the house
// pays out per local day (net = minted − burned). When a sale takes the day to the cap, the sale is
// still paid in full and new buys stop for the rest of the day (the waiting ones go back with their
// fee); nobody's coins are ever held back. Plus the owner's master switch and the daily report.
//
// Leverage is 1x or 2x, cross margin: a member MAY lose more than the margin. A position is sold by
// the rule when the margin left falls to the line, at the quote that crossed it; a gap can take it
// past zero. The shortfall is then taken, in this order, from: the wallet; the coins held by their
// open buys; their other holdings (plain first, largest value first, at the latest price known);
// their other leveraged positions. What still remains is written off by the house (a recorded
// line), every position is closed, and they are bankrupt (破產) for the cooling-off period. Never
// a negative balance, never a debt.
//
// Every coin is a ledger posting with its own keys and also a house line; the two always agree to
// the coin (`netOfPostings` against `netOfLines`). Pure: no clock, no store, no network.

import { feeOn, MILLI } from "../engine/money.js";
import type { RealInstrument } from "./instruments.js";
import type { Quote } from "./provider.js";

/** Millionths of a share in a share: ten coins buy a sliver of a share. */
export const QTY_REAL = 1_000_000;

/** The ledger reasons of the house side (the health table reads them). */
export const HOUSE_REASON = {
  /** Coins burned into a position (a buy's margin); `burn_back` when the buy did not fill. */
  burn: "exchange_burn",
  burnBack: "exchange_burn_back",
  /** Coins minted back by a sale, or what a liquidation left. */
  mint: "exchange_mint",
  /** A loss past the margin, taken from the wallet. */
  loss: "exchange_loss",
  fee: "exchange_fee",
  feeBack: "exchange_fee_back",
} as const;

export interface HouseParams {
  /** The one fee on every buy and sale, burned (rounded up, at least `fee_min`). */
  fee: number;
  fee_min: number;
  /** Net coins the house may pay out per local day, market-wide; `0`: no cap (the default). */
  cap_daily: number;
  /** 1 or 2: the most leverage (1: none). */
  leverage_max: number;
  line: number;
  warn_half: number;
  warn_near: number;
  /** Burned per day as a share of what is borrowed (0: none). */
  carry_daily: number;
  /** A holding can be sold this long after it was bought (the one anti-churn rule). */
  min_hold_ms: number;
  /** How long a bankrupt member waits before trading again. */
  cooling_ms: number;
}

export const DEFAULT_HOUSE: HouseParams = {
  fee: 0.01,
  fee_min: 1,
  cap_daily: 0,
  leverage_max: 2,
  line: 0.2,
  warn_half: 0.5,
  warn_near: 0.35,
  carry_daily: 0,
  min_hold_ms: 10 * 60_000,
  cooling_ms: 7 * 86_400_000,
};

export interface RealPosition {
  id: string;
  person: string;
  code: string;
  leverage: number;
  /** Millionths of a share. */
  qty: number;
  /** The exposure bought, in coins (what counts toward the holding cap). */
  cost: number;
  margin: number;
  loan: number;
  /** Thousandths of a coin. */
  carry: number;
  opened_at: number;
  warned_half: number | null;
  warned_near: number | null;
}

/** A market order: it fills at the first valid quote later than it was placed. */
export interface RealOrder {
  id: string;
  person: string;
  code: string;
  side: "buy" | "sell";
  /** Always `null` in v1 (market orders only); kept for later. */
  limit: number | null;
  coins: number;
  margin: number;
  exposure: number;
  fee: number;
  leverage: number;
  /** A sale: millionths of a share. */
  qty: number;
  position: string | null;
  placed_at: number;
  /** Not used in v1: an order waits for the open until it fills or is cancelled. */
  expires_at: number;
}

export interface HouseDay {
  day: number;
  /** Coins burned: buys that filled (margin and fee), sale fees, carry, losses taken. */
  burned: number;
  /** Coins minted to wallets. */
  minted: number;
  /** What the house wrote off for bankruptcies (no wallet moved). */
  written_off: number;
  by: Record<string, { burned: number; minted: number }>;
  /** The cap was reached: no new buys today. */
  buys_halted: boolean;
}

export interface HouseState {
  today: HouseDay;
  /** The days before, newest last (the daily report). */
  history: HouseDay[];
  /** Bankrupt members and until when (epoch ms). */
  bankrupt: Record<string, { since: number; until: number; written_off: number }>;
}

export interface HouseBook {
  positions: RealPosition[];
  orders: RealOrder[];
  state: HouseState;
}

export interface Posting {
  key: string;
  person: string;
  entries: { reason: string; delta: number }[];
  ref: string;
  /** Refused below zero (a buy, a loss taken from the wallet). */
  covered: boolean;
}

/**
 * `escrow`: a buy's coins held; `release`: held coins leaving the hold (into a position or a loss);
 * `writeoff`: what the house forgave (no wallet moved).
 */
export type LineKind =
  | "burn"
  | "mint"
  | "fee"
  | "loss"
  | "refund"
  | "escrow"
  | "release"
  | "writeoff";

/** The house's own record of a coin movement. */
export interface HouseLine {
  kind: LineKind;
  person: string;
  code: string;
  amount: number;
  ref: string;
}

export interface RealFill {
  id: string;
  order: string | null;
  person: string;
  code: string;
  side: "buy" | "sell";
  kind: "order" | "liquidation" | "shortfall" | "admin";
  position: string | null;
  leverage: number;
  qty: number;
  price: number;
  gross: number;
  fee: number;
  tax: number;
  carry: number;
  /** Coins credited. */
  paid: number;
  /** A loss past the margin this fill left (taken from elsewhere). */
  shortfall: number;
  at: number;
}

export type RealNoticeKind = "warn_half" | "warn_near" | "liquidated" | "shortfall" | "bankrupt";

export interface RealNotice {
  kind: RealNoticeKind;
  person: string;
  code: string;
  position: string | null;
  price: number;
  line_price: number;
  ratio: number;
  amount: number;
  /** A liquidation: whether a warning came first (a gap may sell without one). */
  warned?: boolean;
}

export interface HouseOutcome {
  fills: RealFill[];
  ended: { order: RealOrder; status: "filled" | "cancelled"; why: string; refunded: boolean }[];
  opened: RealPosition[];
  changed: RealPosition[];
  closed: { position: RealPosition; status: "closed" | "liquidated" }[];
  postings: Posting[];
  lines: HouseLine[];
  notices: RealNotice[];
  bankrupt: string[];
}

export function emptyHouseOutcome(): HouseOutcome {
  return {
    fills: [],
    ended: [],
    opened: [],
    changed: [],
    closed: [],
    postings: [],
    lines: [],
    notices: [],
    bankrupt: [],
  };
}

export function newDay(day: number): HouseDay {
  return { day, burned: 0, minted: 0, written_off: 0, by: {}, buys_halted: false };
}

export function newHouse(day: number): HouseBook {
  return { positions: [], orders: [], state: { today: newDay(day), history: [], bankrupt: {} } };
}

/** What the module gives a step: time, ids, the rules, wallets, the latest prices. */
export interface HouseContext {
  now: number;
  day: number;
  params: HouseParams;
  newId: () => string;
  instruments: readonly RealInstrument[];
  /** Wallet balances as read before the step (a loss is taken from these). */
  balance: (person: string) => number;
  /** The latest valid quote of an instrument (fresh, in its session); `null` otherwise. */
  latest: (code: string) => Quote | null;
  /** The last accepted quote however old (a closed market's last price): what a loss is covered at. */
  lastKnown?: (code: string) => Quote | null;
}

// ---- reading ------------------------------------------------------------------------------------

export const valueAt = (qty: number, price: number) => (qty * price) / QTY_REAL;

export function equityOf(p: RealPosition, price: number): number {
  return valueAt(p.qty, price) - p.loan - p.carry / MILLI;
}

export function ratioOf(p: RealPosition, price: number): number {
  return p.margin > 0 ? equityOf(p, price) / p.margin : 1;
}

/** Coins per share at which the margin left is `at` of the margin (`line`: where it is sold). */
export function priceAtRatio(p: RealPosition, at: number): number {
  if (p.qty <= 0) return 0;
  return ((p.loan + p.carry / MILLI + at * p.margin) * QTY_REAL) / p.qty;
}

/** The most leverage (v1: the same for every stock, 1 or 2). */
export function maxLeverage(_inst: RealInstrument, params: HouseParams): number {
  return Math.max(1, Math.min(2, params.leverage_max));
}

export function isBankrupt(state: HouseState, person: string, now: number): boolean {
  const b = state.bankrupt[person];
  return b !== undefined && now < b.until;
}

export function buysHalted(state: HouseState): boolean {
  return state.today.buys_halted;
}

/** Net coins minted today (minted − burned). */
export function netToday(state: HouseState): number {
  return state.today.minted - state.today.burned;
}

/** A position's value to its owner now (leveraged: equity, floored at zero). */
export function worthOf(p: RealPosition, price: number): number {
  return p.leverage > 1 ? Math.max(0, equityOf(p, price)) : valueAt(p.qty, price);
}

/** What a buy of `coins` (fee included) at `leverage` puts up. */
export function splitRealBuy(
  coins: number,
  leverage: number,
  p: HouseParams,
): { margin: number; exposure: number; fee: number } | null {
  if (!Number.isSafeInteger(coins) || coins <= 0) return null;
  const x = Math.max(1, leverage);
  const cost = (m: number) => m + feeOn(Math.floor(m * x), p.fee, p.fee_min);
  let m = Math.floor(coins / (1 + x * p.fee));
  while (m > 0 && cost(m) > coins) m--;
  while (cost(m + 1) <= coins) m++;
  if (m <= 0) return null;
  const exposure = Math.floor(m * x);
  return { margin: m, exposure, fee: feeOn(exposure, p.fee, p.fee_min) };
}

// ---- the ledger and the house's lines ---------------------------------------------------------

function line(
  out: HouseOutcome,
  kind: LineKind,
  person: string,
  code: string,
  amount: number,
  ref: string,
): void {
  if (amount !== 0) out.lines.push({ kind, person, code, amount, ref });
}

function count(state: HouseState, code: string, burned: number, minted: number): void {
  const t = state.today;
  t.burned += burned;
  t.minted += minted;
  const b = t.by[code] ?? { burned: 0, minted: 0 };
  t.by[code] = b;
  b.burned += burned;
  b.minted += minted;
}

function post(
  out: HouseOutcome,
  key: string,
  person: string,
  ref: string,
  entries: [string, number][],
  covered = false,
): void {
  const e = entries.filter(([, d]) => d !== 0).map(([reason, delta]) => ({ reason, delta }));
  if (e.length > 0) out.postings.push({ key, person, ref, entries: e, covered });
}

/** The net coins the postings move (the wallets' view). */
export function netOfPostings(postings: readonly Posting[]): number {
  return postings.reduce((t, p) => t + p.entries.reduce((s, e) => s + e.delta, 0), 0);
}

/** The net coins the house's lines move (its own view): mint, refund and release in, the rest out. */
export function netOfLines(lines: readonly HouseLine[]): number {
  let n = 0;
  for (const l of lines) {
    if (l.kind === "mint" || l.kind === "refund" || l.kind === "release") n += l.amount;
    else if (l.kind === "burn" || l.kind === "fee" || l.kind === "loss" || l.kind === "escrow")
      n -= l.amount;
  }
  return n;
}

/** A buy into the book: the posting takes its margin and fee from the wallet (refused below zero). */
export function placeRealBuy(book: HouseBook, order: RealOrder): HouseOutcome {
  const out = emptyHouseOutcome();
  book.orders.push(order);
  post(
    out,
    `exchange:order:${order.id}`,
    order.person,
    order.id,
    [
      [HOUSE_REASON.burn, -order.margin],
      [HOUSE_REASON.fee, -order.fee],
    ],
    true,
  );
  line(out, "escrow", order.person, order.code, order.margin + order.fee, order.id);
  return out;
}

export function placeRealSell(book: HouseBook, order: RealOrder): void {
  book.orders.push(order);
}

function endOrder(
  book: HouseBook,
  out: HouseOutcome,
  order: RealOrder,
  status: "filled" | "cancelled",
  why: string,
): void {
  const at = book.orders.indexOf(order);
  if (at >= 0) book.orders.splice(at, 1);
  const refund = order.side === "buy" && status !== "filled";
  out.ended.push({ order, status, why, refunded: refund });
  if (refund) {
    post(out, `exchange:refund:${order.id}`, order.person, order.id, [
      [HOUSE_REASON.burnBack, order.margin],
      [HOUSE_REASON.feeBack, order.fee],
    ]);
    line(out, "refund", order.person, order.code, order.margin + order.fee, order.id);
  }
}

/** Takes an open order back; a buy's coins and fee go back. */
export function cancelRealOrder(
  book: HouseBook,
  id: string,
  why = "cancelled",
): HouseOutcome | null {
  const order = book.orders.find((o) => o.id === id);
  if (!order) return null;
  const out = emptyHouseOutcome();
  endOrder(book, out, order, "cancelled", why);
  return out;
}

/** Every open order of instruments no longer traded goes back (a buy with its fee). */
export function cancelOrdersOf(
  book: HouseBook,
  codes: readonly string[],
  why: string,
): HouseOutcome {
  const out = emptyHouseOutcome();
  for (const o of [...book.orders])
    if (codes.includes(o.code)) endOrder(book, out, o, "cancelled", why);
  return out;
}

/** The day's net payout reached the cap: no new buy today, and the waiting ones go back. */
function haltBuys(book: HouseBook, out: HouseOutcome): void {
  book.state.today.buys_halted = true;
  for (const o of book.orders.filter((x) => x.side === "buy"))
    endOrder(book, out, o, "cancelled", "cap");
}

/** Pays `amount` in full; reaching the day's cap (when there is one) stops new buys, never this payment. */
function payOut(
  book: HouseBook,
  out: HouseOutcome,
  ctx: HouseContext,
  person: string,
  code: string,
  amount: number,
  ref: string,
): number {
  if (amount <= 0) return 0;
  post(out, `exchange:mint:${ref}`, person, ref, [[HOUSE_REASON.mint, amount]]);
  line(out, "mint", person, code, amount, ref);
  count(book.state, code, 0, amount);
  if (
    ctx.params.cap_daily > 0 &&
    netToday(book.state) >= ctx.params.cap_daily &&
    !book.state.today.buys_halted
  )
    haltBuys(book, out);
  return amount;
}

// ---- selling ------------------------------------------------------------------------------------

/** The fee of a sale that brought in `gross`; never more than it. */
function feeOf(gross: number, p: HouseParams): number {
  return Math.min(Math.max(0, gross), feeOn(gross, p.fee, p.fee_min));
}

const carryCoins = (p: RealPosition) => Math.ceil(p.carry / MILLI - 1e-9);

/**
 * Closes `pos` at `price`: what it brings is minted after its fee; a loss past zero is the
 * shortfall the caller covers. Answers the fill.
 */
function closeAt(
  book: HouseBook,
  out: HouseOutcome,
  ctx: HouseContext,
  pos: RealPosition,
  price: number,
  kind: RealFill["kind"],
  order: string | null,
  status: "closed" | "liquidated",
): RealFill {
  const gross = Math.floor(valueAt(pos.qty, price));
  const owedBack = gross - pos.loan;
  const fee = feeOf(Math.max(0, owedBack), ctx.params);
  const carry = Math.min(Math.max(0, owedBack - fee), carryCoins(pos));
  const burned = fee + carry;
  // Negative: what the position lost past everything it put up.
  const net = owedBack - burned - (owedBack < 0 ? carryCoins(pos) : 0);
  const id = ctx.newId();
  if (burned > 0) {
    // The fee comes out of what the sale minted: one posting of both.
    post(out, `exchange:fill:${id}`, pos.person, id, [
      [HOUSE_REASON.mint, burned],
      [HOUSE_REASON.fee, -burned],
    ]);
    line(out, "mint", pos.person, pos.code, burned, id);
    line(out, "fee", pos.person, pos.code, burned, id);
    count(book.state, pos.code, burned, burned);
  }
  const paid = net > 0 ? payOut(book, out, ctx, pos.person, pos.code, net, id) : 0;
  const fill: RealFill = {
    id,
    order,
    person: pos.person,
    code: pos.code,
    side: "sell",
    kind,
    position: pos.id,
    leverage: pos.leverage,
    qty: pos.qty,
    price,
    gross,
    fee,
    tax: 0,
    carry,
    paid,
    shortfall: net < 0 ? -net : 0,
    at: ctx.now,
  };
  out.fills.push(fill);
  const at = book.positions.indexOf(pos);
  if (at >= 0) book.positions.splice(at, 1);
  const c = out.changed.indexOf(pos);
  if (c >= 0) out.changed.splice(c, 1);
  out.closed.push({ position: pos, status });
  return fill;
}

/**
 * A loss of `need` coins past a position's margin: from the wallet, the coins of open buys, other
 * holdings, other leveraged positions; the rest is written off and the person is bankrupt.
 * Answers what was written off.
 */
function cover(
  book: HouseBook,
  out: HouseOutcome,
  ctx: HouseContext,
  person: string,
  code: string,
  need: number,
  ref: string,
): number {
  let left = need;
  // 1. The wallet, as read before this step, less what this step already took from it.
  const taken = out.postings
    .filter(
      (p) =>
        p.person === person && p.covered && p.entries.some((e) => e.reason === HOUSE_REASON.loss),
    )
    .reduce((t, p) => t - p.entries.reduce((s, e) => s + e.delta, 0), 0);
  const wallet = Math.max(0, ctx.balance(person) - taken);
  const fromWallet = Math.min(left, wallet);
  if (fromWallet > 0) {
    post(out, `exchange:loss:${ref}`, person, ref, [[HOUSE_REASON.loss, -fromWallet]], true);
    line(out, "loss", person, code, fromWallet, ref);
    count(book.state, code, fromWallet, 0);
    left -= fromWallet;
  }
  // 2. Open buys: their coins are theirs, and go to the loss instead of back.
  for (const o of book.orders.filter((x) => x.person === person && x.side === "buy")) {
    if (left <= 0) break;
    book.orders.splice(book.orders.indexOf(o), 1);
    out.ended.push({ order: o, status: "cancelled", why: "shortfall", refunded: false });
    const held = o.margin + o.fee;
    const use = Math.min(left, held);
    left -= use;
    post(out, `exchange:refund:${o.id}`, person, o.id, [[HOUSE_REASON.burnBack, held - use]]);
    line(out, "refund", person, o.code, held - use, o.id);
    line(out, "release", person, o.code, use, `${o.id}:escrow`);
    line(out, "loss", person, code, use, o.id);
    count(book.state, code, use, 0);
  }
  // 3 and 4. Other holdings, plain first (largest value first), then leveraged ones.
  const others = book.positions
    .filter((p) => p.person === person)
    .map((p) => ({ p, q: ctx.latest(p.code) ?? ctx.lastKnown?.(p.code) ?? null }))
    .filter((x): x is { p: RealPosition; q: Quote } => x.q !== null)
    .sort(
      (a, b) =>
        Number(a.p.leverage > 1) - Number(b.p.leverage > 1) ||
        valueAt(b.p.qty, b.q.price) - valueAt(a.p.qty, a.q.price),
    );
  for (const { p, q } of others) {
    if (left <= 0) break;
    const gross = Math.floor(valueAt(p.qty, q.price));
    const owedBack = gross - p.loan;
    const fee = feeOf(Math.max(0, owedBack), ctx.params);
    const value = owedBack - fee - carryCoins(p);
    const id = ctx.newId();
    const used = Math.max(0, Math.min(left, value));
    const extra = Math.max(0, value - used);
    if (fee > 0) count(book.state, p.code, fee, fee);
    left -= used;
    if (value < 0) left += -value;
    const fill: RealFill = {
      id,
      order: null,
      person,
      code: p.code,
      side: "sell",
      kind: "shortfall",
      position: p.id,
      leverage: p.leverage,
      qty: p.qty,
      price: q.price,
      gross,
      fee,
      tax: 0,
      carry: 0,
      paid: 0,
      shortfall: 0,
      at: ctx.now,
    };
    if (extra > 0) fill.paid = payOut(book, out, ctx, person, p.code, extra, id);
    out.fills.push(fill);
    book.positions.splice(book.positions.indexOf(p), 1);
    out.closed.push({ position: p, status: "liquidated" });
  }
  if (left <= 0) {
    out.notices.push({
      kind: "shortfall",
      person,
      code,
      position: null,
      price: 0,
      line_price: 0,
      ratio: 0,
      amount: need,
    });
    return 0;
  }
  // Bankrupt: everything else closed; the house writes off what remains.
  for (const p of book.positions.filter((x) => x.person === person)) {
    book.positions.splice(book.positions.indexOf(p), 1);
    out.closed.push({ position: p, status: "liquidated" });
  }
  book.state.today.written_off += left;
  line(out, "writeoff", person, code, left, ref);
  book.state.bankrupt[person] = {
    since: ctx.now,
    until: ctx.now + ctx.params.cooling_ms,
    written_off: left,
  };
  out.bankrupt.push(person);
  out.notices.push({
    kind: "bankrupt",
    person,
    code,
    position: null,
    price: 0,
    line_price: 0,
    ratio: 0,
    amount: left,
  });
  return left;
}

// ---- a quote comes in ---------------------------------------------------------------------------

/** Re-arms a warning once the margin left is well above it again. */
function rearm(p: RealPosition, ratio: number, params: HouseParams): boolean {
  let moved = false;
  if (p.warned_half !== null && ratio > params.warn_half + 0.1) {
    p.warned_half = null;
    moved = true;
  }
  if (p.warned_near !== null && ratio > params.warn_near + 0.1) {
    p.warned_near = null;
    moved = true;
  }
  return moved;
}

function notice(
  kind: RealNoticeKind,
  p: RealPosition,
  price: number,
  params: HouseParams,
  amount = 0,
): RealNotice {
  return {
    kind,
    person: p.person,
    code: p.code,
    position: p.id,
    price,
    line_price: priceAtRatio(p, params.line),
    ratio: Math.round(ratioOf(p, price) * 1000) / 1000,
    amount,
  };
}

/**
 * A new valid quote of `inst`: market orders placed before the quote fill at it (an order placed
 * while the market was closed waits for the first quote after the open), then every leveraged
 * position on it is checked (a warning, or a sale at the line).
 */
export function onQuote(
  book: HouseBook,
  inst: RealInstrument,
  quote: Quote,
  ctx: HouseContext,
): HouseOutcome {
  const out = emptyHouseOutcome();
  const p = ctx.params;
  const price = quote.price;
  const waiting = book.orders
    .filter((o) => o.code === inst.code && o.placed_at < quote.at)
    .sort((a, b) => a.placed_at - b.placed_at || (a.id < b.id ? -1 : 1));
  for (const o of waiting) {
    if (!book.orders.includes(o)) continue;
    if (o.side === "buy") {
      if (buysHalted(book.state) || isBankrupt(book.state, o.person, ctx.now)) {
        endOrder(book, out, o, "cancelled", "halted");
        continue;
      }
      const qty = Math.floor((o.exposure * QTY_REAL) / price);
      if (qty <= 0) {
        endOrder(book, out, o, "cancelled", "too_small");
        continue;
      }
      const pos: RealPosition = {
        id: ctx.newId(),
        person: o.person,
        code: o.code,
        leverage: o.leverage,
        qty,
        cost: o.exposure,
        margin: o.margin,
        loan: o.exposure - o.margin,
        carry: 0,
        opened_at: quote.at,
        warned_half: null,
        warned_near: null,
      };
      book.positions.push(pos);
      out.opened.push(pos);
      // The escrow becomes burned: the margin into the position, the fee for good.
      line(out, "burn", o.person, o.code, o.margin, o.id);
      line(out, "fee", o.person, o.code, o.fee, o.id);
      line(out, "release", o.person, o.code, o.margin + o.fee, `${o.id}:escrow`);
      count(book.state, o.code, o.margin + o.fee, 0);
      out.fills.push({
        id: ctx.newId(),
        order: o.id,
        person: o.person,
        code: o.code,
        side: "buy",
        kind: "order",
        position: pos.id,
        leverage: o.leverage,
        qty,
        price,
        gross: o.exposure,
        fee: o.fee,
        tax: 0,
        carry: 0,
        paid: 0,
        shortfall: 0,
        at: ctx.now,
      });
      endOrder(book, out, o, "filled", "filled");
      continue;
    }
    if (o.position !== null) {
      const pos = book.positions.find((x) => x.id === o.position && x.person === o.person);
      if (!pos) {
        endOrder(book, out, o, "cancelled", "no_holding");
        continue;
      }
      if (pos.opened_at + p.min_hold_ms > quote.at) continue; // still within the hold time: it waits
      const fill = closeAt(book, out, ctx, pos, price, "order", o.id, "closed");
      if (fill.shortfall > 0) cover(book, out, ctx, o.person, o.code, fill.shortfall, fill.id);
      endOrder(book, out, o, "filled", "filled");
      continue;
    }
    // A plain sale: lots held at least `min_hold_ms`, oldest first.
    const lots = book.positions
      .filter(
        (x) =>
          x.person === o.person &&
          x.code === o.code &&
          x.leverage <= 1 &&
          x.opened_at + p.min_hold_ms <= quote.at,
      )
      .sort((a, b) => a.opened_at - b.opened_at);
    let left = Math.min(
      o.qty,
      lots.reduce((t, l) => t + l.qty, 0),
    );
    if (left <= 0) {
      // A holding still within its hold time: the sale waits for a later quote.
      if (book.positions.some((x) => x.person === o.person && x.code === o.code && x.leverage <= 1))
        continue;
      endOrder(book, out, o, "cancelled", "no_holding");
      continue;
    }
    for (const lot of lots) {
      if (left <= 0) break;
      if (lot.qty > left) {
        // Split the lot: the part sold becomes its own position.
        const part: RealPosition = {
          ...lot,
          id: ctx.newId(),
          qty: left,
          cost: Math.floor((lot.cost * left) / lot.qty),
          margin: Math.floor((lot.margin * left) / lot.qty),
        };
        lot.cost -= part.cost;
        lot.margin -= part.margin;
        lot.qty -= left;
        if (!out.changed.includes(lot)) out.changed.push(lot);
        book.positions.push(part);
        out.opened.push(part);
        closeAt(book, out, ctx, part, price, "order", o.id, "closed");
        left = 0;
      } else {
        left -= lot.qty;
        closeAt(book, out, ctx, lot, price, "order", o.id, "closed");
      }
    }
    endOrder(book, out, o, "filled", "filled");
  }
  // Every leveraged position on this instrument, at this quote.
  for (const pos of book.positions.filter((x) => x.code === inst.code && x.leverage > 1)) {
    if (!book.positions.includes(pos)) continue;
    const ratio = ratioOf(pos, price);
    if (rearm(pos, ratio, p) && !out.changed.includes(pos)) out.changed.push(pos);
    if (ratio <= p.line) {
      const warned = pos.warned_near !== null || pos.warned_half !== null;
      const fill = closeAt(book, out, ctx, pos, price, "liquidation", null, "liquidated");
      out.notices.push({
        ...notice("liquidated", pos, price, p, fill.paid),
        ratio: Math.round(ratio * 1000) / 1000,
        warned,
      });
      if (fill.shortfall > 0) cover(book, out, ctx, pos.person, pos.code, fill.shortfall, fill.id);
      continue;
    }
    if (ratio <= p.warn_near && pos.warned_near === null) {
      pos.warned_near = ctx.now;
      pos.warned_half ??= ctx.now;
      if (!out.changed.includes(pos)) out.changed.push(pos);
      out.notices.push(notice("warn_near", pos, price, p));
    } else if (ratio <= p.warn_half && pos.warned_half === null) {
      pos.warned_half = ctx.now;
      if (!out.changed.includes(pos)) out.changed.push(pos);
      out.notices.push(notice("warn_half", pos, price, p));
    }
  }
  return out;
}

/** A new local day: yesterday goes into the history (the daily report); the carry, if any, is charged. */
export function rollDay(book: HouseBook, ctx: HouseContext): HouseOutcome {
  const out = emptyHouseOutcome();
  const s = book.state;
  if (s.today.day === ctx.day) return out;
  s.history.push(s.today);
  if (s.history.length > 90) s.history.splice(0, s.history.length - 90);
  s.today = newDay(ctx.day);
  if (ctx.params.carry_daily > 0) {
    for (const pos of book.positions) {
      if (pos.leverage <= 1 || pos.loan <= 0) continue;
      pos.carry += Math.ceil(pos.loan * ctx.params.carry_daily * MILLI - 1e-9);
      out.changed.push(pos);
    }
  }
  return out;
}

/** Sells a position now for the owner at its latest price (no fee); `null` without one. */
export function adminSellReal(
  book: HouseBook,
  pos: RealPosition,
  ctx: HouseContext,
): HouseOutcome | null {
  const q = ctx.latest(pos.code) ?? ctx.lastKnown?.(pos.code) ?? null;
  if (!q) return null;
  const out = emptyHouseOutcome();
  const free = { ...ctx, params: { ...ctx.params, fee: 0, fee_min: 0 } };
  const fill = closeAt(book, out, free, pos, q.price, "admin", null, "closed");
  if (fill.shortfall > 0) cover(book, out, free, pos.person, pos.code, fill.shortfall, fill.id);
  return out;
}

/** Closes `pos` at `price` for the owner's settlement of a suspended ticker (no fee; a loss is covered as always). */
export function settleAt(
  book: HouseBook,
  pos: RealPosition,
  price: number,
  ctx: HouseContext,
): HouseOutcome {
  const out = emptyHouseOutcome();
  const free = { ...ctx, params: { ...ctx.params, fee: 0, fee_min: 0 } };
  const fill = closeAt(book, out, free, pos, price, "admin", null, "closed");
  if (fill.shortfall > 0) cover(book, out, free, pos.person, pos.code, fill.shortfall, fill.id);
  return out;
}
