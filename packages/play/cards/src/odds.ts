// The public odds table (docs/design/cards.md §2.3, §4): what the member page prints. It is
// computed from the catalogue and the weights with the draw's own helpers (`draw.ts`), so it
// cannot say anything the draw does not do. The same for everyone: the wishlist and the
// relationship change nothing in it (the expression is not drawn by these odds).
//
// Each list of chances sums to 100: the rarities, the rarities under the pity, and each slot's
// parts (with "nothing", when a slot can come out empty). `shown` is the percentage with two
// decimals, rounded so that the printed column adds up to exactly 100.00.

import {
  drawPool,
  type Part,
  type Rarity,
  SLOT_NAMES,
  SLOTS,
  type Slot,
  seriesOf,
} from "./catalogue.js";
import { type DrawRules, headlineSlots, rarityChances, slotParts } from "./draw.js";

export interface OddsRarity {
  rarity: Rarity;
  /** Exact, 0..100. */
  percent: number;
  /** Two decimals; the column sums to 100.00. */
  shown: string;
}

export interface OddsPart {
  id: string;
  name: string;
  rarity: Rarity;
  series: string | null;
  /** The series' name (`SERIES`); `null`: none, or a series it does not know. */
  series_name: string | null;
  percent: number;
  shown: string;
}

export interface OddsSlot {
  slot: Slot;
  name: string;
  /** Chance of each part on a card without the pity, most likely first. */
  parts: OddsPart[];
  /** The chance the slot comes out empty; `null` when it never does. */
  empty: { percent: number; shown: string } | null;
}

export interface OddsTable {
  rarities: OddsRarity[];
  /** After `after` cards without SR or better, the next card's rarity; `null`: no pity possible. */
  pity: { after: number; rarities: OddsRarity[] } | null;
  slots: OddsSlot[];
}

/**
 * `values` (percentages summing to 100) at two decimals summing to exactly 100.00: each rounded
 * down to a hundredth, the hundredths left given to the largest remainders.
 */
export function shownPercents(values: readonly number[]): string[] {
  const total = values.reduce((sum, v) => sum + v, 0);
  if (values.length === 0 || total <= 0) return values.map(() => "0.00");
  const scaled = values.map((v) => (v / total) * 10_000);
  const floors = scaled.map((v) => Math.floor(v + 1e-9));
  let left = 10_000 - floors.reduce((sum, v) => sum + v, 0);
  const order = scaled
    .map((v, i) => [v - (floors[i] as number), i] as const)
    .sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  for (const [, i] of order) {
    if (left <= 0) break;
    floors[i] = (floors[i] as number) + 1;
    left -= 1;
  }
  return floors.map((h) => (h / 100).toFixed(2));
}

function raritiesOf(chances: readonly [Rarity, number][]): OddsRarity[] {
  const shown = shownPercents(chances.map(([, p]) => p * 100));
  return chances.map(([rarity, p], i) => ({ rarity, percent: p * 100, shown: shown[i] as string }));
}

/** The chance of each part of `slot` (and of nothing) on a card of rarity `rarity`. */
function slotChances(
  pool: readonly Part[],
  slot: Slot,
  rarity: Rarity,
): Map<string | null, number> {
  const out = new Map<string | null, number>();
  const add = (key: string | null, p: number) => out.set(key, (out.get(key) ?? 0) + p);
  const share = (parts: readonly Part[], mass: number) => {
    if (mass <= 0) return;
    const total = parts.reduce((sum, p) => sum + p.weight, 0);
    if (parts.length === 0 || total <= 0) {
      add(null, mass);
      return;
    }
    for (const p of parts) add(p.id, (mass * p.weight) / total);
  };
  if (rarity === "N") {
    share(slotParts(pool, slot, rarity, false), 1);
    return out;
  }
  const heads = headlineSlots(pool, rarity);
  const headShare = heads.includes(slot) ? 1 / heads.length : 0;
  share(slotParts(pool, slot, rarity, true), headShare);
  share(slotParts(pool, slot, rarity, false), 1 - headShare);
  return out;
}

/** The odds of a bought card under `rules`, from `catalogue`. */
export function oddsTable(catalogue: readonly Part[], rules: DrawRules): OddsTable {
  const pool = drawPool(catalogue);
  const chances = rarityChances(pool, rules.weights);
  const rare = rarityChances(pool, rules.weights, true);
  const slots = SLOTS.map((slot): OddsSlot => {
    const total = new Map<string | null, number>();
    for (const [rarity, p] of chances) {
      for (const [key, q] of slotChances(pool, slot, rarity)) {
        total.set(key, (total.get(key) ?? 0) + p * q);
      }
    }
    const rows = pool
      .filter((p) => p.slot === slot && (total.get(p.id) ?? 0) > 0)
      .map((p) => ({ part: p, percent: (total.get(p.id) ?? 0) * 100 }))
      .sort((a, b) => b.percent - a.percent || (a.part.id < b.part.id ? -1 : 1));
    const empty = (total.get(null) ?? 0) * 100;
    const shown = shownPercents([...rows.map((r) => r.percent), ...(empty > 0 ? [empty] : [])]);
    return {
      slot,
      name: SLOT_NAMES[slot],
      parts: rows.map((r, i) => ({
        id: r.part.id,
        name: r.part.name,
        rarity: r.part.rarity,
        series: r.part.series,
        series_name: r.part.series === null ? null : (seriesOf(r.part.series)?.name ?? null),
        percent: r.percent,
        shown: shown[i] as string,
      })),
      empty: empty > 0 ? { percent: empty, shown: shown[rows.length] as string } : null,
    };
  });
  return {
    rarities: raritiesOf(chances),
    pity: rare.length > 0 ? { after: rules.pity, rarities: raritiesOf(rare) } : null,
    slots,
  };
}
