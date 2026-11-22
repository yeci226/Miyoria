// The simulated players. Each is a plain rule over public numbers (prices, closes, the level) and
// its own holdings, the kind of rule a person or a small script would follow. None of them sees
// the seed, a hidden value or the mood.

import { marginRatio } from "../engine/book.js";
import type { Action, AgentView } from "./run.js";

export type StrategyName =
  | "random"
  | "momentum"
  | "hold"
  | "whale"
  | "wash"
  | "gambler"
  | "maker"
  | "level"
  | "dip";

export type Strategy = (view: AgentView) => Action[];

const codes = (v: AgentView) => v.params.companies.map((c) => c.code);

function closeReturn(v: AgentView, code: string, days: number): number | null {
  const list = v.closes.get(code) ?? [];
  if (list.length <= days) return null;
  const now = list[list.length - 1] as number;
  const then = list[list.length - 1 - days] as number;
  return now / then - 1;
}

/** Sells every plain share of `code` it can. */
function sellAll(v: AgentView, code: string): Action[] {
  const qty = v.sellable(code);
  return qty > 0 ? [{ do: "sell", company: code, qty }] : [];
}

function held(v: AgentView, code: string): boolean {
  return (
    v.positions.some((p) => p.company === code && p.leverage <= 1) ||
    v.orders.some((o) => o.company === code && o.side === "buy")
  );
}

/** Buys or sells something now and then, at random. */
const random: Strategy = (v) => {
  if (!v.rng.chance(0.04)) return [];
  const code = v.rng.pick(codes(v));
  if (v.rng.chance(0.55)) return [{ do: "buy", company: code, coins: 10 + v.rng.int(91) }];
  return sellAll(v, code);
};

/** Each morning: buys the best of the last five days if it rose more than 3%, sells what turned. */
const momentum: Strategy = (v) => {
  if (v.slot !== 0) return [];
  const out: Action[] = [];
  for (const code of codes(v)) {
    const r = closeReturn(v, code, 5);
    if (r !== null && r < 0) out.push(...sellAll(v, code));
  }
  let best: string | null = null;
  let bestR = 0.03;
  for (const code of codes(v)) {
    const r = closeReturn(v, code, 5);
    if (r !== null && r > bestR && !held(v, code)) {
      best = code;
      bestR = r;
    }
  }
  if (best) out.push({ do: "buy", company: best, coins: 100 });
  return out;
};

/** Buys a spread on the first two days and never sells. */
const hold: Strategy = (v) => {
  if (v.slot !== 0 || v.memory.get("done") === 1) return [];
  const out: Action[] = [];
  for (const code of codes(v))
    if (!held(v, code)) out.push({ do: "buy", company: code, coins: 70 });
  if (out.length === 0) v.memory.set("done", 1);
  return out.slice(0, 4);
};

/** Fills every limit as fast as it may; takes profit or loss at 8%. */
const whale: Strategy = (v) => {
  const out: Action[] = [];
  for (const code of codes(v)) {
    const lots = v.positions.filter((p) => p.company === code && p.leverage <= 1);
    const cost = lots.reduce((t, p) => t + p.cost, 0);
    const value = lots.reduce((t, p) => t + (p.qty * (v.prices.get(code) ?? 0)) / 100_000, 0);
    if (cost > 0 && (value > cost * 1.08 || value < cost * 0.92)) out.push(...sellAll(v, code));
  }
  if (v.slot <= 2) {
    const code = v.rng.pick(codes(v));
    out.push({ do: "buy", company: code, coins: 200 });
  }
  return out;
};

/** Three linked accounts: buy one company in the morning, sell it the next morning, every day. */
const wash: Strategy = (v) => {
  if (v.slot !== 0) return [];
  const code = v.params.companies[v.day % v.params.companies.length]?.code ?? "DPSK";
  const out: Action[] = [];
  for (const c of codes(v)) out.push(...sellAll(v, c));
  out.push({ do: "buy", company: code, coins: 90 });
  return out;
};

/** Always all in at 2x with the most margin allowed; out at +20% of the margin, or liquidated. */
const gambler: Strategy = (v) => {
  const lev = v.positions.filter((p) => p.leverage > 1);
  const out: Action[] = [];
  for (const pos of lev) {
    const price = v.prices.get(pos.company) ?? 0;
    if (
      marginRatio(pos, price) >= 1.2 &&
      pos.day < v.day &&
      !v.orders.some((o) => o.position === pos.id)
    ) {
      out.push({ do: "close", position: pos.id });
    }
  }
  if (lev.length === 0 && !v.orders.some((o) => o.leverage > 1)) {
    out.push({ do: "buy", company: v.rng.pick(codes(v)), coins: 155, leverage: 2 });
  }
  return out;
};

/** Patient, like a market maker: buys a close that fell 3% with a limit under it, sells at +4% or after ten days. */
const maker: Strategy = (v) => {
  if (v.slot !== 0) return [];
  const out: Action[] = [];
  for (const code of codes(v)) {
    const lots = v.positions.filter((p) => p.company === code && p.leverage <= 1);
    const cost = lots.reduce((t, p) => t + p.cost, 0);
    const value = lots.reduce((t, p) => t + (p.qty * (v.prices.get(code) ?? 0)) / 100_000, 0);
    const age = lots.length > 0 ? v.day - Math.min(...lots.map((p) => p.day)) : 0;
    if (cost > 0 && (value > cost * 1.04 || age >= 10)) {
      const price = v.prices.get(code) ?? 0;
      out.push({
        do: "sell",
        company: code,
        qty: v.sellable(code),
        limit: Math.round(price * 1.01),
      });
      continue;
    }
    const r = closeReturn(v, code, 1);
    if (r !== null && r <= -0.03 && !held(v, code)) {
      const price = v.prices.get(code) ?? 0;
      out.push({ do: "buy", company: code, coins: 80, limit: Math.round(price * 0.99), days: 3 });
    }
  }
  return out.filter((a) => a.do !== "sell" || a.qty > 0);
};

/** Reads the level: buys when the vault is well ahead of the holdings, leaves when it is behind. */
const level: Strategy = (v) => {
  if (v.slot !== 0 || v.level === null) return [];
  if (v.level >= 1.1) return [{ do: "buy", company: v.rng.pick(codes(v)), coins: 100 }];
  if (v.level <= 0.95) return codes(v).flatMap((c) => sellAll(v, c));
  return [];
};

/** Buys the day's worst company at the open, sells it the next day whatever happened. */
const dip: Strategy = (v) => {
  if (v.slot !== 0) return [];
  const out: Action[] = codes(v).flatMap((c) => sellAll(v, c));
  let worst: string | null = null;
  let worstR = 0;
  for (const code of codes(v)) {
    const r = closeReturn(v, code, 1);
    if (r !== null && r < worstR) {
      worst = code;
      worstR = r;
    }
  }
  if (worst) out.push({ do: "buy", company: worst, coins: 100 });
  return out;
};

export const STRATEGIES: Readonly<Record<StrategyName, Strategy>> = {
  random,
  momentum,
  hold,
  whale,
  wash,
  gambler,
  maker,
  level,
  dip,
};

export const STRATEGY_LABEL: Readonly<Record<StrategyName, string>> = {
  random: "隨機",
  momentum: "追漲(五日動能)",
  hold: "買進持有",
  whale: "大戶(每個上限都買滿)",
  wash: "洗量的小號群(三個帳號合併)",
  gambler: "全押 2 倍槓桿",
  maker: "耐心的造市型(跌 3% 掛低接、漲 4% 掛高賣)",
  level: "看水位進出",
  dip: "買前一天跌最多的",
};
