// The draw of a card (docs/design/cards.md §4, docs/design/v5-play.md §2): pure functions over the
// catalogue, with the random source passed in so a seeded run is a test.
//
// 1. The rarity, by the public weights (N 70 / R 22 / SR 7 / SSR 1 by default). A rarity no part
//    can give is left out and the others share its weight. Pity: after `pity` cards in a row
//    without an SR-or-better part, the next one is drawn from SR and SSR only, by their weights.
// 2. For SR, R or SSR, one slot that has parts of exactly that rarity is picked (each such slot
//    alike) and given one of them by weight: that is what makes the card its rarity.
// 3. Every other slot gets a part of that rarity or lower, by weight. A card's rarity is therefore
//    always the rarity of its rarest part, which is what the pity counts.
// 4. Her expression, from the group of the relationship's tier (`expressions.ts`), never from the
//    rarity. Then a seed for the small random offsets of the pose, so the same card can be drawn
//    again exactly. SSR cards are foil.
//
// The odds table (`odds.ts`) is computed from the same helpers, so it cannot disagree with this.
// The wishlist changes nothing here: who wished for what is looked at after the draw. A card
// dropped in a channel is drawn the same way, then given one drop-only part (`withDropPart`).

import {
  drawPool,
  isRare,
  type Part,
  RARITIES,
  type Rarity,
  rarityRank,
  SLOTS,
  type Slot,
} from "./catalogue.js";
import { type Expression, expressionsFor } from "./expressions.js";

/** A number in [0, 1), like `Math.random`. */
export type Random = () => number;

export type RarityWeights = Readonly<Record<Rarity, number>>;

/** What a draw is ruled by (the config's numbers). */
export interface DrawRules {
  weights: RarityWeights;
  /** Cards in a row without an SR-or-better part after which the next one is guaranteed one. */
  pity: number;
}

/** A part as a card keeps it: a snapshot, so a later change of the catalogue does not change it. */
export interface DrawnPart {
  id: string;
  slot: Slot;
  rarity: Rarity;
  series: string | null;
  name: string;
  blank: boolean;
}

export interface DrawnCard {
  rarity: Rarity;
  /** One per slot that had anything to draw, in slot order. */
  parts: DrawnPart[];
  expression: Expression;
  /** SSR cards are foil. */
  foil: boolean;
  /** For the pose's small random offsets (a 31-bit integer). */
  seed: number;
  /** The pity decided the rarity (only SR and SSR could come). */
  pity_hit: boolean;
}

export interface DrawInput {
  catalogue: readonly Part[];
  rules: DrawRules;
  /** Cards in a row without an SR-or-better part so far (`cards_pity.since`). */
  since: number;
  /** The relationship's tier (`RelationshipLabel`): what decides the expression. */
  tier: string;
  random: Random;
}

export class CardsError extends Error {
  override name = "CardsError";
}

// ---- shared with the odds table --------------------------------------------------------------

/** The parts of `slot` of exactly `rarity` (`exact`) or of `rarity` and lower. */
export function slotParts(
  pool: readonly Part[],
  slot: Slot,
  rarity: Rarity,
  exact: boolean,
): Part[] {
  const rank = rarityRank(rarity);
  return pool.filter(
    (p) =>
      p.slot === slot && (exact ? rarityRank(p.rarity) === rank : rarityRank(p.rarity) <= rank),
  );
}

/** The slots that can carry a card of `rarity`: those with a part of exactly that rarity. */
export function headlineSlots(pool: readonly Part[], rarity: Rarity): Slot[] {
  return SLOTS.filter((slot) => slotParts(pool, slot, rarity, true).length > 0);
}

/**
 * The chance of each rarity a draw can give (summing to 1), lowest first: a rarity no part can
 * give, or of weight 0, is left out. `rareOnly`: SR and SSR only (the pity). Empty when nothing
 * can be drawn.
 */
export function rarityChances(
  pool: readonly Part[],
  weights: RarityWeights,
  rareOnly = false,
): [Rarity, number][] {
  const open = RARITIES.filter(
    (r) =>
      (!rareOnly || isRare(r)) &&
      weights[r] > 0 &&
      (r === "N"
        ? SLOTS.some((s) => slotParts(pool, s, r, true).length > 0)
        : headlineSlots(pool, r).length > 0),
  );
  const total = open.reduce((sum, r) => sum + weights[r], 0);
  return total > 0 ? open.map((r) => [r, weights[r] / total]) : [];
}

/** Whether the next card falls under the pity (and the pity can give anything). */
export function pityApplies(pool: readonly Part[], rules: DrawRules, since: number): boolean {
  return since >= rules.pity && rarityChances(pool, rules.weights, true).length > 0;
}

/** The pity counter after a card of `rarity`. */
export function nextSince(since: number, rarity: Rarity): number {
  return isRare(rarity) ? 0 : since + 1;
}

/** The counter as a person sees it. */
export interface PityView {
  /** Cards in a row without SR or better. */
  since: number;
  /** The pity's length. */
  pity: number;
  /** Cards still to go before the guarantee; 0: the next card is SR or better. */
  until: number;
}

export function pityView(since: number, pity: number): PityView {
  return { since, pity, until: Math.max(pity - since, 0) };
}

// ---- the draw --------------------------------------------------------------------------------

/** One of `items` by weight. `items` must not be empty. */
function pickWeighted<T>(items: readonly T[], weightOf: (item: T) => number, random: Random): T {
  const total = items.reduce((sum, item) => sum + weightOf(item), 0);
  let x = random() * total;
  for (const item of items) {
    x -= weightOf(item);
    if (x < 0) return item;
  }
  return items[items.length - 1] as T;
}

/** One of `items`, each alike. `items` must not be empty. */
function pickOne<T>(items: readonly T[], random: Random): T {
  const i = Math.min(Math.max(Math.floor(random() * items.length), 0), items.length - 1);
  return items[i] as T;
}

export function drawnPart(p: Part): DrawnPart {
  return {
    id: p.id,
    slot: p.slot,
    rarity: p.rarity,
    series: p.series,
    name: p.name,
    blank: p.blank,
  };
}

/** Draws one card. Throws a `CardsError` when the catalogue has nothing to draw. */
export function drawCard(input: DrawInput): DrawnCard {
  const { rules, random } = input;
  const pool = drawPool(input.catalogue);
  const pityHit = pityApplies(pool, rules, input.since);
  const chances = rarityChances(pool, rules.weights, pityHit);
  if (chances.length === 0) throw new CardsError("the catalogue has nothing to draw");
  const [rarity] = pickWeighted(chances, ([, p]) => p, random);
  const headline = rarity === "N" ? null : pickOne(headlineSlots(pool, rarity), random);
  const parts: DrawnPart[] = [];
  for (const slot of SLOTS) {
    const candidates = slotParts(pool, slot, rarity, slot === headline);
    if (candidates.length === 0) continue;
    parts.push(drawnPart(pickWeighted(candidates, (p) => p.weight, random)));
  }
  const expression = pickOne(expressionsFor(input.tier), random);
  const seed = Math.floor(random() * 2 ** 31);
  return { rarity, parts, expression, foil: rarity === "SSR", seed, pity_hit: pityHit };
}

/**
 * A dropped card (v5-play §6.2): `drawn` with one part only a drop can give put in its slot, picked
 * by weight among the enabled drop-only parts; the card's rarity is again its rarest part's (an
 * SSR one shines). Unchanged when the catalogue has no such part.
 */
export function withDropPart(
  drawn: DrawnCard,
  catalogue: readonly Part[],
  random: Random,
): DrawnCard {
  const only = catalogue.filter((p) => p.enabled && p.drop_only);
  if (only.length === 0) return drawn;
  const part = drawnPart(pickWeighted(only, (p) => p.weight, random));
  const parts = SLOTS.flatMap((slot) => {
    if (slot === part.slot) return [part];
    const had = drawn.parts.find((p) => p.slot === slot);
    return had === undefined ? [] : [had];
  });
  const rarity = parts.reduce<Rarity>(
    (best, p) => (rarityRank(p.rarity) > rarityRank(best) ? p.rarity : best),
    "N",
  );
  return { ...drawn, parts, rarity, foil: rarity === "SSR" };
}

/** What a card keeps of its draw (`cards_card.parts`): enough to draw its picture again. */
export interface DrawSnapshot {
  parts: DrawnPart[];
  expression: Expression;
  /** SSR, or a shine bought for it. */
  foil: boolean;
  seed: number;
}

/** The wished parts a card has, in the wishlist's order. */
export function wishedOn(card: Pick<DrawnCard, "parts">, wishlist: readonly string[]): string[] {
  const ids = new Set(card.parts.map((p) => p.id));
  return wishlist.filter((id) => ids.has(id));
}

/**
 * A seeded random source (mulberry32): the same seed gives the same numbers. For tests and for
 * drawing a card again from its seed; a real draw uses `Math.random`.
 */
export function seededRandom(seed: number): Random {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
