// The prices (docs/design/exchange.md §5). Each round, for each company:
//
//     move = beta * (mood + market noise + level pull) + sector noise + news
//            + own noise + a pull back toward its hidden value + what this round's net buying did
//
// The hidden value takes the common part and the news too, so a market move or a piece of news
// stays; only the company's own noise fades back. The level pull (vault over holdings) is the
// rule that keeps prices from running ahead of the coins behind them. Then the price is held
// within the daily limit (from the previous close) and the round limit (from the round before);
// a move cut off there is thrown away, not carried into later rounds, so nothing is predictable
// from a limit hit. Nothing here is random except through the seed.

import type { CompanySpec, Sector } from "./companies.js";
import type { EngineParams } from "./params.js";
import { rngFor } from "./rng.js";
import { weekdayOf } from "./time.js";

export interface CompanyState {
  code: string;
  /** The last round's price, in cents. */
  price: number;
  /** ln price before the impact of net buying. */
  core: number;
  /** ln of the hidden value. Never shown. */
  value: number;
  /** ln offset of recent net buying; it fades each round. */
  impact: number;
  /** The day's reference price (the previous close), in cents. */
  ref: number;
  /** A shock waiting for the next round that is held (the weekly earnings). */
  pending: number;
}

/** The hidden mood: bear -1, flat 0, bull 1. Only its effect on prices is ever seen. */
export type Mood = -1 | 0 | 1;

export interface MarketState {
  version: 1;
  /** The last round handled (held, skipped or halted). */
  round: number;
  mood: Mood;
  /** The index at the previous close. */
  fish_ref: number;
  /** The breaker stopped the rest of this local day (`null`: no). */
  halted_day: number | null;
  companies: CompanyState[];
}

export type NewsKind = "event" | "earnings";

/** A piece of news the program drew: who, which way, how big. Her words come later. */
export interface NewsDraw {
  company: string;
  kind: NewsKind;
  /** The log move it puts on the price (and the hidden value). Never shown as a number. */
  move: number;
  /** The words for the size people see. */
  size: "small" | "medium" | "large";
}

export function sizeOf(move: number): NewsDraw["size"] {
  const a = Math.abs(move);
  if (a < 0.02) return "small";
  if (a < 0.03) return "medium";
  return "large";
}

/** A market before its first round: every company at its first price. */
export function initMarket(p: EngineParams, firstDay: number): MarketState {
  return {
    version: 1,
    round: firstDay * p.rounds_per_day - 1,
    mood: 0,
    fish_ref: 1000,
    halted_day: null,
    companies: p.companies.map((c) => {
      const ln = Math.log(c.start);
      return {
        code: c.code,
        price: c.start,
        core: ln,
        value: ln,
        impact: 0,
        ref: c.start,
        pending: 0,
      };
    }),
  };
}

/** The market index FISH: the average of each price over its first price, times 1000. */
export function fishOf(state: MarketState, p: EngineParams): number {
  let sum = 0;
  for (const [i, c] of state.companies.entries()) {
    const spec = p.companies[i] as CompanySpec;
    sum += c.price / spec.start;
  }
  return Math.round((sum / Math.max(state.companies.length, 1)) * 1000 * 100) / 100;
}

/** What the program draws for one round, before anyone's orders. */
export interface RoundDraw {
  market: number;
  sectors: Record<Sector, number>;
  own: number[];
  news: NewsDraw[];
}

export function drawRound(seed: string, round: number, p: EngineParams): RoundDraw {
  const rng = rngFor(seed, "round", round);
  const market = rng.normal() * p.market_sigma;
  const sectors: Record<Sector, number> = {
    ai: rng.normal() * p.sector_sigma,
    staples: rng.normal() * p.sector_sigma,
    media: rng.normal() * p.sector_sigma,
    resources: rng.normal() * p.sector_sigma,
  };
  const own = p.companies.map((c) => rng.normal() * c.sigma);
  const events = rngFor(seed, "events", round);
  const news: NewsDraw[] = [];
  for (const c of p.companies) {
    if (!events.chance(p.event_rate)) continue;
    const sign = events.chance(0.5) ? 1 : -1;
    const move = sign * events.range(p.event_min, p.event_max);
    news.push({ company: c.code, kind: "event", move, size: sizeOf(move) });
  }
  return { market, sectors, own, news };
}

/** A company's price bounds this round, in cents. */
export function boundsOf(c: CompanyState, p: EngineParams): { lo: number; hi: number } {
  const lo = Math.max(
    1,
    Math.ceil(c.ref * (1 - p.daily_limit)),
    Math.ceil(c.price * (1 - p.round_limit)),
  );
  const hi = Math.max(
    lo,
    Math.min(Math.floor(c.ref * (1 + p.daily_limit)), Math.floor(c.price * (1 + p.round_limit))),
  );
  return { lo, hi };
}

/** Whether a price is at the day's upper or lower limit. */
export function limitState(price: number, ref: number, p: EngineParams): "up" | "down" | null {
  if (price >= Math.floor(ref * (1 + p.daily_limit))) return "up";
  if (price <= Math.ceil(ref * (1 - p.daily_limit))) return "down";
  return null;
}

/** The pull of the level on the market factor: up when the vault holds more than the holdings. */
export function levelTerm(level: number | null, p: EngineParams): number {
  if (level === null || !(level > 0)) return 0;
  const ln = Math.max(-0.4, Math.min(0.4, Math.log(level)));
  return p.level_pull * ln;
}

/**
 * The prices of a round from its draw, the coins of net buying per company (`flows`, positive:
 * more bought than sold) and the level before it. Returns the companies after the round; the
 * input is not changed.
 */
export function priceRound(
  state: MarketState,
  draw: RoundDraw,
  flows: readonly number[],
  level: number | null,
  p: EngineParams,
): CompanyState[] {
  const common = state.mood * p.mood_drift + draw.market + levelTerm(level, p);
  return state.companies.map((c, i) => {
    const spec = p.companies[i] as CompanySpec;
    const news = draw.news.filter((n) => n.company === c.code).reduce((t, n) => t + n.move, 0);
    const shared = spec.beta * common + (draw.sectors[spec.sector] ?? 0) + news + c.pending;
    const variance = (spec.beta * p.market_sigma) ** 2 + p.sector_sigma ** 2 + spec.sigma ** 2;
    const value = c.value + shared;
    let core = c.core + shared + (draw.own[i] ?? 0) + p.reversion * (value - c.core) - variance / 2;
    const impact = c.impact * p.impact_decay + (p.impact * (flows[i] ?? 0)) / spec.depth;
    const { lo, hi } = boundsOf(c, p);
    const wanted = Math.round(Math.exp(core + impact));
    const price = Math.min(hi, Math.max(lo, wanted));
    let shifted = value;
    if (price !== wanted) {
      // The limit cut the move: what was cut is thrown away, from the hidden value too.
      const cut = core - (Math.log(price) - impact);
      core -= cut;
      shifted = value - cut;
    }
    return { ...c, price, core, value: shifted, impact, pending: 0 };
  });
}

/** Opens a local day: the references are the previous close; the hidden values drift a little. */
export function openDay(state: MarketState, seed: string, day: number, p: EngineParams): void {
  const rng = rngFor(seed, "day", day);
  state.fish_ref = fishOf(state, p);
  state.halted_day = null;
  for (const c of state.companies) {
    c.ref = c.price;
    c.value += rng.normal() * p.fundamental_sigma - p.fundamental_sigma ** 2 / 2;
  }
}

/**
 * Closes a local day: the mood may change, and on Sunday every company's earnings are drawn; they
 * are published now and move the price at the next round held.
 */
export function closeDay(
  state: MarketState,
  seed: string,
  day: number,
  p: EngineParams,
  traded = true,
): NewsDraw[] {
  // A day nothing traded on (the market off, paused or down) has no mood change and no earnings.
  if (!traded) return [];
  const rng = rngFor(seed, "close", day);
  if (rng.chance(p.mood_switch)) {
    const others = ([-1, 0, 1] as const).filter((m) => m !== state.mood);
    state.mood = rng.pick(others);
  }
  const news: NewsDraw[] = [];
  if (weekdayOf(day) === 0) {
    for (const c of state.companies) {
      const move = rng.normal() * p.earnings_sigma;
      c.pending += move;
      news.push({ company: c.code, kind: "earnings", move, size: sizeOf(move) });
    }
  }
  return news;
}
