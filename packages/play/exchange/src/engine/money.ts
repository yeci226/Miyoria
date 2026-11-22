// Units and fees. Coins are whole numbers; a price is whole cents (10000 = 100.00); a holding is
// whole thousandths of a share, so ten coins buy a piece of a 200-coin share. A value in coins is
// `qty * price / 100_000`. Fees and the tax are rounded up with a smallest of `fee_min` coins
// (owner 2026-11-21), and never take more than the sale brought in.

import type { EngineParams } from "./params.js";

/** Thousandths of a share in a share. */
export const QTY_SCALE = 1000;
/** Cents in a coin. */
export const PRICE_SCALE = 100;
const VALUE_DIV = QTY_SCALE * PRICE_SCALE;
/** Thousandths of a coin in a coin: the carry fee accrues in them. */
export const MILLI = 1000;

/** A fee or tax on `amount` coins: rounded up, at least `min`; nothing on nothing. */
export function feeOn(amount: number, rate: number, min: number): number {
  if (amount <= 0 || rate <= 0) return 0;
  return Math.max(min, Math.ceil(amount * rate - 1e-9));
}

/** What a buy of `coins` (fee included) puts up: margin, the exposure it buys, and the fee. */
export interface BuySplit {
  /** Coins that go into the vault. */
  margin: number;
  /** What it buys: `margin` times the leverage. */
  exposure: number;
  /** The buy fee on the exposure, burned. */
  fee: number;
}

/**
 * The split of `coins` for a buy at `leverage`: the largest margin whose fee on its exposure still
 * fits, so margin + fee never passes what was paid. `null` when nothing fits.
 */
export function splitBuy(coins: number, leverage: number, p: EngineParams): BuySplit | null {
  if (!Number.isSafeInteger(coins) || coins <= 0) return null;
  const x = Math.max(1, Math.floor(leverage));
  let margin = Math.floor(coins / (1 + x * p.fee_buy));
  const cost = (m: number) => m + feeOn(m * x, p.fee_buy, p.fee_min);
  while (margin > 0 && cost(margin) > coins) margin--;
  while (cost(margin + 1) <= coins) margin++;
  if (margin <= 0) return null;
  return { margin, exposure: margin * x, fee: feeOn(margin * x, p.fee_buy, p.fee_min) };
}

/** The shares (thousandths) `coins` buy at `price` cents, rounded down. */
export function qtyFor(coins: number, price: number): number {
  return Math.floor((coins * VALUE_DIV) / price);
}

/** What `qty` is worth at `price`, in coins, exactly (a fraction). */
export function exactValue(qty: number, price: number): number {
  return (qty * price) / VALUE_DIV;
}

/** What `qty` is worth at `price`, in whole coins, rounded down. */
export function coinsOf(qty: number, price: number): number {
  return Math.floor(exactValue(qty, price) + 1e-9);
}

/** The fee and the tax on a sale that brought in `gross` coins; together never more than `gross`. */
export function saleBurns(gross: number, p: EngineParams): { fee: number; tax: number } {
  const fee = Math.min(gross, feeOn(gross, p.fee_sell, p.fee_min));
  const tax = Math.min(gross - fee, feeOn(gross, p.tax_sell, p.fee_min));
  return { fee, tax };
}

/** A price in cents as people read it: `123.45`. */
export function priceText(price: number): string {
  return (price / PRICE_SCALE).toFixed(2);
}

/** A holding in thousandths as people read it: `1.234` shares. */
export function qtyText(qty: number): string {
  return (qty / QTY_SCALE).toFixed(3);
}
