// The pass criteria over many runs (docs/design/exchange.md §9, owner 2026-11-21), and the tables
// the design doc shows. A strategy is "reliably profitable" when the lower end of a 95% interval
// of its mean return across runs is above zero.

import type { EngineParams } from "../engine/params.js";
import { STRATEGY_LABEL, type StrategyName } from "./agents.js";
import { runSim, type SimResult } from "./run.js";

export interface StrategyRow {
  strategy: StrategyName;
  label: string;
  people: number;
  /** Mean return over every simulated person of this kind, as a fraction of what they started with. */
  mean: number;
  median: number;
  /** Share of those people who ended above where they started. */
  profitable: number;
  /** The lower end of a 95% interval of the per-run mean. */
  low: number;
  reliably_profitable: boolean;
}

export interface Summary {
  runs: number;
  weeks: number;
  rounds: number;
  violations: string[];
  min_vault: number;
  min_wallet: number;
  max_books_gap: number;
  /** Share of held rounds (with a level) whose level was within 0.8..1.2. */
  level_in_band: number;
  level_rounds: number;
  level_min: number;
  level_max: number;
  level_median: number;
  burned_share_of_volume: number;
  burned_per_week: number;
  volume_per_week: number;
  breakers_per_run: number;
  fish_daily_sd: number;
  company_daily_sd: number;
  strategies: StrategyRow[];
  leverage: {
    positions: number;
    liquidated: number;
    warned_first: number;
    min_ratio_at_liquidation: number | null;
    mean_paid_over_margin: number;
    paid_below_zero: number;
  };
  pass: {
    vault_never_negative: boolean;
    nobody_below_zero: boolean;
    books_balance: boolean;
    level_in_band_90: boolean;
    no_strategy_reliably_profitable: boolean;
    leverage_never_past_margin: boolean;
    warning_before_liquidation: boolean;
    no_violations: boolean;
  };
}

const median = (xs: readonly number[]): number => {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? (s[m] as number) : ((s[m - 1] as number) + (s[m] as number)) / 2;
};
const mean = (xs: readonly number[]): number =>
  xs.length === 0 ? 0 : xs.reduce((t, x) => t + x, 0) / xs.length;
const sd = (xs: readonly number[]): number => {
  const m = mean(xs);
  return Math.sqrt(mean(xs.map((x) => (x - m) ** 2)));
};

export function summarize(results: readonly SimResult[], weeks: number): Summary {
  const violations = results.flatMap((r) => r.violations);
  const levels = results.flatMap((r) => r.levels).filter((l): l is number => l !== null);
  const inBand = levels.filter((l) => l >= 0.8 && l <= 1.2).length;
  const volume = results.reduce((t, r) => t + r.volume, 0);
  const burned = results.reduce((t, r) => t + r.burned, 0);
  const names = [...new Set(results.flatMap((r) => r.people.map((p) => p.strategy)))];
  const strategies: StrategyRow[] = names.map((strategy) => {
    const all = results.flatMap((r) =>
      r.people.filter((p) => p.strategy === strategy).map((p) => p.worth / p.start - 1),
    );
    const perRun = results.map((r) =>
      mean(r.people.filter((p) => p.strategy === strategy).map((p) => p.worth / p.start - 1)),
    );
    const m = mean(perRun);
    const se =
      perRun.length > 1 ? sd(perRun) / Math.sqrt(perRun.length - 1) : Number.POSITIVE_INFINITY;
    const low = m - 1.96 * se;
    return {
      strategy,
      label: STRATEGY_LABEL[strategy],
      people: all.length,
      mean: mean(all),
      median: median(all),
      profitable: all.filter((x) => x > 0).length / Math.max(all.length, 1),
      low,
      reliably_profitable: low > 0,
    };
  });
  const lev = results.flatMap((r) => r.leverage);
  const liquidated = lev.filter((l) => l.liquidated);
  const pass = {
    vault_never_negative: results.every((r) => r.min_vault >= 0),
    nobody_below_zero: results.every((r) => r.min_wallet >= 0),
    books_balance: results.every((r) => r.max_books_gap === 0),
    level_in_band_90: levels.length === 0 || inBand / levels.length >= 0.9,
    no_strategy_reliably_profitable: strategies.every((s) => !s.reliably_profitable),
    leverage_never_past_margin:
      lev.every((l) => l.paid >= 0) && liquidated.every((l) => l.ratio > 0),
    warning_before_liquidation: liquidated.every((l) => l.warned_before),
    no_violations: violations.length === 0,
  };
  return {
    runs: results.length,
    weeks,
    rounds: results.reduce((t, r) => t + r.rounds, 0),
    violations: violations.slice(0, 20),
    min_vault: Math.min(...results.map((r) => r.min_vault)),
    min_wallet: Math.min(...results.map((r) => r.min_wallet)),
    max_books_gap: Math.max(...results.map((r) => r.max_books_gap)),
    level_in_band: levels.length === 0 ? 1 : inBand / levels.length,
    level_rounds: levels.length,
    level_min: levels.length === 0 ? 1 : Math.min(...levels),
    level_max: levels.length === 0 ? 1 : Math.max(...levels),
    level_median: median(levels),
    burned_share_of_volume: volume === 0 ? 0 : burned / volume,
    burned_per_week: burned / Math.max(results.length * weeks, 1),
    volume_per_week: volume / Math.max(results.length * weeks, 1),
    breakers_per_run: mean(results.map((r) => r.breakers)),
    fish_daily_sd: sd(results.flatMap((r) => r.fish_daily)),
    company_daily_sd: sd(results.flatMap((r) => r.daily)),
    strategies,
    leverage: {
      positions: lev.length,
      liquidated: liquidated.length,
      warned_first: liquidated.filter((l) => l.warned_before).length,
      min_ratio_at_liquidation:
        liquidated.length === 0 ? null : Math.min(...liquidated.map((l) => l.ratio)),
      mean_paid_over_margin: mean(lev.map((l) => l.paid / Math.max(l.margin, 1))),
      paid_below_zero: lev.filter((l) => l.paid < 0).length,
    },
    pass,
  };
}

/** `runs` runs of `weeks` weeks, seeds `<prefix>-0` ... */
export function simulate(runs: number, weeks: number, prefix = "sim", p?: EngineParams): Summary {
  const results: SimResult[] = [];
  for (let i = 0; i < runs; i++)
    results.push(runSim({ seed: `${prefix}-${i}`, weeks, ...(p ? { params: p } : {}) }));
  return summarize(results, weeks);
}

/**
 * A rougher market for the leverage paths: three times the market noise, twice each company's
 * own noise, news up to 8% (more than one round may move, so the round limit cuts it), a mood
 * four times as strong. Not what runs; what has to hold even then.
 */
export function stressParams(p: EngineParams): EngineParams {
  return {
    ...p,
    leverage: { ...p.leverage, enabled: true },
    market_sigma: p.market_sigma * 3,
    companies: p.companies.map((c) => ({ ...c, sigma: c.sigma * 2 })),
    event_rate: p.event_rate * 3,
    event_max: 0.08,
    mood_drift: p.mood_drift * 4,
  };
}
