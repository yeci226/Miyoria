// Every number the engine runs on. The defaults are the ones the offline simulation passed with
// (docs/design/exchange.md §9); `[modules.exchange]` can change each of them, and the simulation
// takes the same object, so what was tested is what runs.

import { COMPANIES, type CompanySpec } from "./companies.js";

export interface LeverageParams {
  /** Off: no new leveraged buy; open positions run on until closed. */
  enabled: boolean;
  /** Most exposure per coin of margin (2: exposure up to twice the margin). */
  max: number;
  /** Liquidated when the margin left is at most this share of the margin put up. */
  line: number;
  /** First warning: this share of the margin left (half gone). */
  warn_half: number;
  /** Second warning, near the line. */
  warn_near: number;
  /** Burned per day as a share of the borrowed half, from the position's own margin. */
  carry_daily: number;
}

export interface EngineParams {
  companies: readonly CompanySpec[];
  /** Rounds per day and the local hour of the first (12 rounds from 12:00: the last at 23:00). */
  rounds_per_day: number;
  first_hour: number;
  /** A price stays within this of the day's reference (the previous close). */
  daily_limit: number;
  /** A price moves at most this from the round before (keeps a warning ahead of a liquidation). */
  round_limit: number;
  /** The index falling this much from the previous close stops trading for the day. */
  breaker: number;
  fee_buy: number;
  fee_sell: number;
  tax_sell: number;
  /** The smallest fee or tax, in coins. */
  fee_min: number;
  /** The market factor's noise per round. */
  market_sigma: number;
  /** Each sector's noise per round. */
  sector_sigma: number;
  /** How fast a price returns to its company's hidden value, per round. */
  reversion: number;
  /** The hidden value's own drift noise per day. */
  fundamental_sigma: number;
  /** How hard the level (vault over holdings) pulls the market per round, per unit of ln(level). */
  level_pull: number;
  /** Holdings worth less than this: the level does not pull. */
  level_floor: number;
  /** The move from `depth` coins of net buying in one round. */
  impact: number;
  /** What is left of the price impact after each round. */
  impact_decay: number;
  /** The market mood's drift per round (bull +, bear -), and its chance to change each day. */
  mood_drift: number;
  mood_switch: number;
  /** Small news per company per round, and its size range (as a log move). */
  event_rate: number;
  event_min: number;
  event_max: number;
  /** The weekly earnings surprise's standard deviation. */
  earnings_sigma: number;
  /** Each Sunday the vault burns what it holds above this level. */
  vault_burn_level: number;
  leverage: LeverageParams;
}

export const DEFAULT_LEVERAGE: LeverageParams = {
  // Off on the local companies (owner 2026-11-21: leverage is for real instruments, cross margin);
  // the machinery stays and the simulation still runs it.
  enabled: false,
  max: 2,
  line: 0.2,
  warn_half: 0.5,
  warn_near: 0.35,
  carry_daily: 0.002,
};

export const DEFAULT_PARAMS: EngineParams = {
  companies: COMPANIES,
  rounds_per_day: 12,
  first_hour: 12,
  daily_limit: 0.1,
  round_limit: 0.05,
  breaker: 0.07,
  fee_buy: 0.015,
  fee_sell: 0.015,
  tax_sell: 0.03,
  fee_min: 1,
  market_sigma: 0.0028,
  sector_sigma: 0.0014,
  reversion: 0.04,
  fundamental_sigma: 0.006,
  level_pull: 0.0025,
  level_floor: 500,
  impact: 0.01,
  impact_decay: 0.7,
  mood_drift: 0.00015,
  mood_switch: 0.07,
  event_rate: 1 / 84,
  event_min: 0.01,
  event_max: 0.04,
  earnings_sigma: 0.025,
  vault_burn_level: 1.5,
  leverage: DEFAULT_LEVERAGE,
};

export function params(overrides: Partial<EngineParams> = {}): EngineParams {
  return { ...DEFAULT_PARAMS, ...overrides };
}
