// Who may trade, and how much (owner 2026-11-21, docs/design/exchange.md §6, §8). Pure checks over
// facts the module gathers; each refusal is one plain sentence, the same on the panel and in
// Discord. The numbers are `[modules.exchange]`'s.

import { DEFAULT_CURRENCY } from "@miyoria/types";
import { type BuySplit, splitBuy } from "./money.js";
import type { EngineParams } from "./params.js";

export interface Rules {
  /** The master switch: off, nothing is placed and no round is held. */
  enabled: boolean;
  /** The owner's pause: on, nothing is placed and no round is held. */
  paused: boolean;
  /** An account: known this many days and at least this tier (0: 認識). */
  min_days: number;
  min_tier: number;
  /** One buy order's coins, fee included. */
  order_min: number;
  order_max: number;
  /** Orders a day (buys and sales), and coins bought a day. */
  orders_per_day: number;
  buy_per_day: number;
  /** Holding limits by cost, before they widen. */
  limit_company: number;
  limit_total: number;
  /** Each tier above the first widens them this much; each `limit_age_days` known, `limit_age_step`. */
  limit_bond_step: number;
  limit_age_step: number;
  limit_age_days: number;
  /** They widen at most this many times. */
  limit_max_mult: number;
  /** One person holds at most this share of a company's value held, counted on at least `concentration_floor`. */
  concentration: number;
  concentration_floor: number;
  /** Coins received by transfer this recently cannot be put in. */
  transfer_lock_hours: number;
  /** A limit order lives at most this many trading days. */
  limit_days_max: number;
  /** Leverage: known this many days, at least this tier, at most this much margin in all. */
  leverage_min_days: number;
  leverage_min_tier: number;
  leverage_margin_cap: number;
}

export const DEFAULT_RULES: Rules = {
  enabled: false,
  paused: false,
  min_days: 7,
  min_tier: 0,
  order_min: 10,
  order_max: 200,
  orders_per_day: 20,
  buy_per_day: 300,
  limit_company: 200,
  limit_total: 600,
  limit_bond_step: 0.25,
  limit_age_step: 0.1,
  limit_age_days: 30,
  limit_max_mult: 2,
  concentration: 0.25,
  concentration_floor: 800,
  transfer_lock_hours: 24,
  limit_days_max: 5,
  leverage_min_days: 30,
  leverage_min_tier: 1,
  leverage_margin_cap: 150,
};

/** Who is asking, as the module knows them. */
export interface Trader {
  /** Days since she first knew them (the oldest of their merged persons). */
  known_days: number;
  /** Their tier's place on the bond ladder (0: 認識); -1 below it (陌生人, 討厭). */
  tier: number;
  /** An owner or admin while `staff_may_trade` is off: kept out of trading. */
  insider: boolean;
  /** Her own account. */
  self: boolean;
  /** Blocked: may sell what they hold, never buy. */
  blocked: boolean;
  /** Their account here: opened, and whether they took leverage's risks. */
  opened: boolean;
  leverage_opt_in: boolean;
}

export type GuardRefusal = { ok: false; code: string; message: string };

const no = (code: string, message: string): GuardRefusal => ({ ok: false, code, message });

/** The one-buy size rule in words (`max` 0: only a minimum). */
export function sizeRule(min: number, max: number, currency: string = DEFAULT_CURRENCY): string {
  return max > 0 ? `一筆買進是 ${min} 到 ${max} ${currency}` : `一筆買進至少 ${min} ${currency}`;
}

/** Whether `value` goes past `cap`; a cap of `0` is no cap (the config's default for most). */
export const over = (value: number, cap: number): boolean => cap > 0 && value > cap;

/** The holding limits for someone, widened by tier and time known (`0` stays `0`: no limit). */
export function limitsFor(
  rules: Rules,
  trader: Pick<Trader, "tier" | "known_days">,
): { company: number; total: number; mult: number } {
  const tiers = Math.max(0, trader.tier - rules.min_tier);
  const ages = Math.floor(Math.max(0, trader.known_days) / Math.max(1, rules.limit_age_days));
  const mult = Math.min(
    rules.limit_max_mult,
    1 + rules.limit_bond_step * tiers + rules.limit_age_step * ages,
  );
  return {
    company: Math.floor(rules.limit_company * mult),
    total: Math.floor(rules.limit_total * mult),
    mult,
  };
}

/** Whether they may open an account. */
export function checkOpen(rules: Rules, t: Trader): GuardRefusal | null {
  if (t.self) return no("self", "她自己不能開戶");
  if (t.insider) return no("insider", "這裡設定了 owner 和管理員不能交易(staff_may_trade 關著)");
  if (t.blocked) return no("blocked", "你現在不能開戶");
  if (t.tier < rules.min_tier) return no("tier", "要和她更熟一點(羈絆到「認識」以上)才能開戶");
  if (t.known_days < rules.min_days) {
    return no(
      "young",
      `她認識你滿 ${rules.min_days} 天才能開戶(現在 ${Math.floor(t.known_days)} 天)`,
    );
  }
  return null;
}

/** Whether they may take leverage (on top of an account). */
export function checkLeverageOptIn(rules: Rules, p: EngineParams, t: Trader): GuardRefusal | null {
  if (!p.leverage.enabled) return no("leverage_off", "槓桿現在沒有開放");
  const open = checkOpen(rules, t);
  if (open) return open;
  if (t.tier < rules.leverage_min_tier) return no("leverage_tier", "槓桿要羈絆到「朋友」以上");
  if (t.known_days < rules.leverage_min_days) {
    return no("leverage_young", `槓桿要她認識你滿 ${rules.leverage_min_days} 天`);
  }
  return null;
}

export interface BuyRequest {
  company: string;
  /** Coins to pay, fee included. */
  coins: number;
  limit: number | null;
  leverage: number;
  /** A limit order's trading days. */
  days: number;
}

/** What the module knows about them when a buy comes in. */
export interface BuyFacts {
  balance: number;
  /** Coins received by transfer within `transfer_lock_hours`. */
  transferred: number;
  orders_today: number;
  bought_today: number;
  /** Cost of what they hold in this company, open buys included (leveraged at full exposure). */
  company_cost: number;
  total_cost: number;
  /** Margin of their open leveraged positions and buys. */
  margin: number;
  /** The company's value held by everyone, and by them, now. */
  company_value: number;
  my_company_value: number;
}

export function checkBuy(
  rules: Rules,
  p: EngineParams,
  t: Trader,
  req: BuyRequest,
  f: BuyFacts,
  /** The coins' name in the refusals. */
  currency: string = DEFAULT_CURRENCY,
): { ok: true; split: BuySplit } | GuardRefusal {
  if (!rules.enabled || rules.paused) return no("closed", "交易所現在暫停,不能下單");
  const open = checkOpen(rules, t);
  if (open) return open;
  if (!t.opened) return no("no_account", "還沒開戶");
  if (
    !Number.isSafeInteger(req.coins) ||
    req.coins < rules.order_min ||
    over(req.coins, rules.order_max)
  ) {
    return no("size", sizeRule(rules.order_min, rules.order_max, currency));
  }
  if (req.limit !== null && !(Number.isSafeInteger(req.limit) && req.limit > 0))
    return no("limit", "限價要是正的價格");
  if (req.days < 1 || req.days > rules.limit_days_max)
    return no("days", `限價單最多放 ${rules.limit_days_max} 天`);
  const leverage = Math.floor(req.leverage);
  if (leverage < 1 || leverage > Math.max(1, p.leverage.max))
    return no("leverage", `槓桿最多 ${p.leverage.max} 倍`);
  if (leverage > 1) {
    const lev = checkLeverageOptIn(rules, p, t);
    if (lev) return lev;
    if (!t.leverage_opt_in) return no("leverage_opt_in", "要先看過並同意槓桿的風險");
  }
  if (f.orders_today >= rules.orders_per_day)
    return no("orders", `一天最多 ${rules.orders_per_day} 筆委託`);
  if (over(f.bought_today + req.coins, rules.buy_per_day)) {
    return no(
      "daily",
      `一天最多買 ${rules.buy_per_day} ${currency}(今天還能買 ${Math.max(0, rules.buy_per_day - f.bought_today)})`,
    );
  }
  const usable = f.balance - Math.max(0, f.transferred);
  if (req.coins > usable) {
    if (req.coins <= f.balance)
      return no(
        "transfer_lock",
        `別人轉給你的${currency}要過 ${rules.transfer_lock_hours} 小時才能投入`,
      );
    return no("short", `${currency}不夠`);
  }
  const split = splitBuy(req.coins, leverage, p);
  if (split === null) return no("size", "這筆太小了");
  const limits = limitsFor(rules, t);
  if (over(f.company_cost + split.exposure, limits.company)) {
    return no(
      "limit_company",
      `一家公司最多持有成本 ${limits.company} ${currency}(槓桿照全部部位算)`,
    );
  }
  if (over(f.total_cost + split.exposure, limits.total)) {
    return no("limit_total", `全部合計最多持有成本 ${limits.total} ${currency}(槓桿照全部部位算)`);
  }
  if (leverage > 1 && over(f.margin + split.margin, rules.leverage_margin_cap)) {
    return no("margin_cap", `槓桿的保證金合計最多 ${rules.leverage_margin_cap} ${currency}`);
  }
  const after = f.my_company_value + split.exposure;
  const base = Math.max(f.company_value + split.exposure, rules.concentration_floor);
  if (after > rules.concentration * base) {
    return no(
      "concentration",
      `一個人最多持有一家公司流通市值的 ${Math.round(rules.concentration * 100)}%`,
    );
  }
  return { ok: true, split };
}

export interface SellRequest {
  /** Thousandths of a share; a leveraged close sells the whole position. */
  qty: number;
  limit: number | null;
  days: number;
  /** A leveraged position to close. */
  position: string | null;
}

export interface SellFacts {
  /** Plain shares that can be sold today, less what open sales already reserve. */
  sellable: number;
  orders_today: number;
  /** A leveraged close: the position is theirs, open, and bought before today. */
  position_ok: boolean | null;
  /** A close or a sale of the same position is already waiting. */
  pending_close: boolean;
}

export function checkSell(
  rules: Rules,
  t: Trader,
  req: SellRequest,
  f: SellFacts,
): GuardRefusal | null {
  if (!rules.enabled || rules.paused) return no("closed", "交易所現在暫停,不能下單");
  if (t.self) return no("self", "她自己沒有持股");
  if (t.insider) return no("insider", "這裡設定了 owner 和管理員不能交易(staff_may_trade 關著)");
  if (req.limit !== null && !(Number.isSafeInteger(req.limit) && req.limit > 0))
    return no("limit", "限價要是正的價格");
  if (req.days < 1 || req.days > rules.limit_days_max)
    return no("days", `限價單最多放 ${rules.limit_days_max} 天`);
  if (f.orders_today >= rules.orders_per_day)
    return no("orders", `一天最多 ${rules.orders_per_day} 筆委託`);
  if (req.position !== null) {
    if (f.position_ok === null) return no("no_position", "找不到這個槓桿部位");
    if (!f.position_ok) return no("t1", "今天買的,明天才能賣");
    if (f.pending_close) return no("pending", "這個部位已經有一筆賣單在等了");
    return null;
  }
  if (f.sellable <= 0) return no("t1", "沒有可以賣的股票(今天買的明天才能賣)");
  if (!Number.isSafeInteger(req.qty) || req.qty <= 0) return no("qty", "要賣多少?");
  if (req.qty > f.sellable) {
    return no(
      "t1",
      f.sellable > 0
        ? "可以賣的股數不夠(今天買的明天才能賣)"
        : "沒有可以賣的股票(今天買的明天才能賣)",
    );
  }
  return null;
}
