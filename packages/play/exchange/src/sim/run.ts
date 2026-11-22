// The offline simulation (docs/design/exchange.md §9): the engine the module runs, with made-up
// players instead of people, over many simulated weeks. It checks, at every round, the rules that
// must never break (the vault never below zero, nobody below zero, the books balance to the coin,
// a leveraged position never loses more than its margin) and keeps what the pass criteria read
// (the level, each strategy's return). Nothing here touches a store, a clock or the network.

import {
  type Book,
  checkBuy,
  checkSell,
  coinsOf,
  DEFAULT_LEVERAGE,
  DEFAULT_RULES,
  type EngineParams,
  params as engineParams,
  equityOf,
  exactValue,
  initMarket,
  MILLI,
  type Order,
  type Position,
  type Posting,
  placeBuy,
  placeSell,
  priceOf,
  type RoundOutcome,
  type Rules,
  roundDay,
  roundSlot,
  saleBurns,
  sellableLots,
  settleRound,
  type Trader,
} from "../engine/index.js";
import { type Rng, rngFor } from "../engine/rng.js";
import { STRATEGIES, type Strategy, type StrategyName } from "./agents.js";

export interface SimAgent {
  /** One account; accounts of one person share their limits and holdings (merged alts). */
  account: string;
  person: string;
  strategy: StrategyName;
  leverage_opt_in: boolean;
}

export interface SimOptions {
  seed: string;
  weeks: number;
  params?: EngineParams;
  rules?: Rules;
  agents?: readonly SimAgent[];
  /** Coins each person starts with. */
  start?: number;
}

/** What a strategy sees: public numbers and its own book. */
export interface AgentView {
  round: number;
  day: number;
  slot: number;
  rng: Rng;
  params: EngineParams;
  person: string;
  wallet: number;
  /** Closing prices of past days, per company, oldest first (today's open price last when slot 0). */
  closes: ReadonlyMap<string, readonly number[]>;
  prices: ReadonlyMap<string, number>;
  level: number | null;
  /** Their open positions and orders. */
  positions: readonly Position[];
  orders: readonly Order[];
  /** Plain shares they can sell today, per company. */
  sellable: (company: string) => number;
  /** Per-strategy memory. */
  memory: Map<string, number>;
}

export type Action =
  | {
      do: "buy";
      company: string;
      coins: number;
      leverage?: number;
      limit?: number | null;
      days?: number;
    }
  | { do: "sell"; company: string; qty: number; limit?: number | null }
  | { do: "close"; position: string };

export interface SimPerson {
  person: string;
  strategy: StrategyName;
  start: number;
  wallet: number;
  /** Wallet plus holdings at the last prices (leveraged at equity). */
  worth: number;
}

export interface LeverageRecord {
  margin: number;
  paid: number;
  liquidated: boolean;
  /** Margin left over margin put up when it was sold. */
  ratio: number;
  warned_before: boolean;
}

export interface SimResult {
  rounds: number;
  /** Every held round's level (null while the holdings are too small). */
  levels: (number | null)[];
  min_vault: number;
  min_wallet: number;
  /** The largest |coins out of wallets - (vault + escrow + burned)| seen: 0 when the books balance. */
  max_books_gap: number;
  burned: number;
  volume: number;
  people: SimPerson[];
  leverage: LeverageRecord[];
  breakers: number;
  owed: number;
  /** Daily index returns (close over close). */
  fish_daily: number[];
  /** Daily returns of each company. */
  daily: number[];
  violations: string[];
}

/** The default population: every kind of player the pass criteria name. */
export function defaultAgents(): SimAgent[] {
  const agents: SimAgent[] = [];
  const add = (strategy: StrategyName, n: number, opt = false) => {
    for (let i = 0; i < n; i++) {
      const person = `${strategy}-${i}`;
      agents.push({ account: person, person, strategy, leverage_opt_in: opt });
    }
  };
  add("random", 20);
  add("momentum", 3);
  add("hold", 3);
  add("whale", 1);
  add("gambler", 3, true);
  add("maker", 3);
  add("level", 2);
  add("dip", 2);
  // A wash-trading ring: three linked alts, merged into one person.
  for (let i = 0; i < 3; i++)
    agents.push({ account: `ring-${i}`, person: "ring", strategy: "wash", leverage_opt_in: false });
  return agents;
}

export function runSim(options: SimOptions): SimResult {
  // The local leverage machinery is off in the market (real instruments use cross margin) but the
  // simulation keeps running it, so it stays tested.
  const p = options.params ?? engineParams({ leverage: { ...DEFAULT_LEVERAGE, enabled: true } });
  const rules: Rules = { ...DEFAULT_RULES, enabled: true, ...(options.rules ?? {}) };
  const agents = options.agents ?? defaultAgents();
  const start = options.start ?? 1000;
  const seed = options.seed;
  const firstDay = 20_000; // a Monday is not needed: the week runs from whatever day this is
  const book: Book = {
    market: initMarket(p, firstDay),
    orders: [],
    positions: [],
    owed: [],
    vault: 0,
    held_day: null,
  };
  let n = 0;
  const newId = () => `x${(++n).toString(36).padStart(8, "0")}`;

  const wallets = new Map<string, number>();
  const persons = new Map<string, StrategyName>();
  for (const a of agents) {
    wallets.set(a.person, start);
    persons.set(a.person, a.strategy);
  }
  const startTotal = wallets.size * start;
  const memory = new Map<string, Map<string, number>>();
  const closes = new Map<string, number[]>(p.companies.map((c) => [c.code, [c.start]]));
  const counters = new Map<string, { day: number; orders: number; bought: number }>();
  const margins = new Map<string, number>(); // position -> margin put up, for the leverage records
  const warned = new Set<string>();
  const result: SimResult = {
    rounds: 0,
    levels: [],
    min_vault: Number.POSITIVE_INFINITY,
    min_wallet: start,
    max_books_gap: 0,
    burned: 0,
    volume: 0,
    people: [],
    leverage: [],
    breakers: 0,
    owed: 0,
    fish_daily: [],
    daily: [],
    violations: [],
  };
  let burned = 0;
  const apply = (posting: Posting) => {
    const before = wallets.get(posting.person) ?? 0;
    const delta = posting.entries.reduce((t, e) => t + e.delta, 0);
    wallets.set(posting.person, before + delta);
  };
  const trader = (a: SimAgent): Trader => ({
    known_days: 90,
    tier: 2,
    insider: false,
    self: false,
    blocked: false,
    opened: true,
    leverage_opt_in: a.leverage_opt_in,
  });

  const rounds = options.weeks * 7 * p.rounds_per_day;
  let lastFish = 1000;
  const lastClose = new Map<string, number>(p.companies.map((c) => [c.code, c.start]));
  for (let r = 0; r < rounds; r++) {
    const round = book.market.round + 1;
    const day = roundDay(round, p);
    const slot = roundSlot(round, p);
    const level = levelNow(book, p);
    for (const a of agents) {
      const strategy: Strategy = STRATEGIES[a.strategy];
      let mem = memory.get(a.account);
      if (!mem) {
        mem = new Map();
        memory.set(a.account, mem);
      }
      const view: AgentView = {
        round,
        day,
        slot,
        rng: rngFor(seed, "agent", a.account, round),
        params: p,
        person: a.person,
        wallet: wallets.get(a.person) ?? 0,
        closes,
        prices: new Map(book.market.companies.map((c) => [c.code, c.price])),
        level,
        positions: book.positions.filter((x) => x.person === a.person),
        orders: book.orders.filter((o) => o.person === a.person),
        sellable: (company) => sellableNow(book, a.person, company, day),
        memory: mem,
      };
      for (const action of strategy(view)) {
        const count = counter(counters, a.person, day);
        if (action.do === "buy") {
          const leverage = action.leverage ?? 1;
          const facts = buyFacts(book, a.person, action.company, wallets.get(a.person) ?? 0, count);
          const check = checkBuy(
            rules,
            p,
            trader(a),
            {
              company: action.company,
              coins: action.coins,
              limit: action.limit ?? null,
              leverage,
              days: action.days ?? 1,
            },
            facts,
          );
          if (!check.ok) continue;
          const order: Order = {
            id: newId(),
            person: a.person,
            company: action.company,
            side: "buy",
            kind: action.limit ? "limit" : "market",
            limit: action.limit ?? null,
            coins: check.split.margin + check.split.fee,
            margin: check.split.margin,
            exposure: check.split.exposure,
            fee: check.split.fee,
            leverage,
            qty: 0,
            position: null,
            placed_round: book.market.round,
            expires_day: day + (action.days ?? 1) - 1,
          };
          apply(placeBuy(book, order));
          count.orders++;
          count.bought += order.coins;
        } else if (action.do === "sell") {
          const facts = {
            sellable: sellableNow(book, a.person, action.company, day),
            orders_today: count.orders,
            position_ok: null,
            pending_close: false,
          };
          if (
            checkSell(
              rules,
              trader(a),
              { qty: action.qty, limit: action.limit ?? null, days: 1, position: null },
              facts,
            )
          )
            continue;
          placeSell(
            book,
            sellOrder(
              newId(),
              a.person,
              action.company,
              action.qty,
              null,
              action.limit ?? null,
              book.market.round,
              day,
            ),
          );
          count.orders++;
        } else {
          const pos = book.positions.find((x) => x.id === action.position && x.person === a.person);
          const pending = book.orders.some((o) => o.position === action.position);
          const facts = {
            sellable: 0,
            orders_today: count.orders,
            position_ok: pos ? pos.day < day : null,
            pending_close: pending,
          };
          if (
            !pos ||
            checkSell(
              rules,
              trader(a),
              { qty: pos.qty, limit: null, days: 1, position: pos.id },
              facts,
            )
          )
            continue;
          placeSell(
            book,
            sellOrder(
              newId(),
              a.person,
              pos.company,
              pos.qty,
              pos.id,
              null,
              book.market.round,
              day,
            ),
          );
          count.orders++;
        }
      }
    }
    const outcome = settleRound(book, { seed, round, params: p, newId, mode: "held" });
    for (const posting of outcome.postings) apply(posting);
    burned += outcome.burned;
    result.rounds++;
    record(outcome, result, book, margins, warned);
    // The invariants, every round.
    if (book.vault < 0) result.violations.push(`vault ${book.vault} at round ${round}`);
    result.min_vault = Math.min(result.min_vault, book.vault);
    let total = 0;
    for (const [person, coins] of wallets) {
      total += coins;
      if (coins < 0) result.violations.push(`${person} at ${coins} at round ${round}`);
      result.min_wallet = Math.min(result.min_wallet, coins);
    }
    const escrow = book.orders.reduce((t, o) => t + (o.side === "buy" ? o.coins : 0), 0);
    const gap = Math.abs(startTotal - total - (book.vault + escrow + burned));
    result.max_books_gap = Math.max(result.max_books_gap, gap);
    if (gap !== 0) result.violations.push(`books off by ${gap} at round ${round}`);
    if (slot === p.rounds_per_day - 1) {
      for (const c of book.market.companies) {
        closes.get(c.code)?.push(c.price);
        const prev = lastClose.get(c.code) ?? c.price;
        result.daily.push(c.price / prev - 1);
        lastClose.set(c.code, c.price);
      }
      result.fish_daily.push(outcome.fish / lastFish - 1);
      lastFish = outcome.fish;
    }
  }
  result.burned = burned;
  result.owed = book.owed.length;
  for (const [person, strategy] of persons) {
    const wallet = wallets.get(person) ?? 0;
    let worth = wallet + escrowOf(book, person);
    // What they would get selling everything at the last prices: the sale's fee and tax taken.
    for (const pos of book.positions) {
      if (pos.person !== person) continue;
      const price = priceOf(book, pos.company);
      const gross = coinsOf(pos.qty, price);
      const burns = saleBurns(gross, p);
      const carry = Math.ceil(pos.carry / MILLI);
      worth += Math.max(0, gross - pos.loan - burns.fee - burns.tax - carry);
    }
    for (const owed of book.owed)
      if (owed.person === person) worth += owed.gross - owed.fee - owed.tax - owed.carry;
    result.people.push({ person, strategy, start, wallet, worth: Math.round(worth * 100) / 100 });
  }
  return result;
}

function escrowOf(book: Book, person: string): number {
  return book.orders.reduce(
    (t, o) => t + (o.side === "buy" && o.person === person ? o.coins : 0),
    0,
  );
}

function levelNow(book: Book, p: EngineParams): number | null {
  let o = 0;
  for (const pos of book.positions) {
    const price = priceOf(book, pos.company);
    o += pos.leverage > 1 ? Math.max(0, equityOf(pos, price)) : exactValue(pos.qty, price);
  }
  return o < p.level_floor ? null : book.vault / o;
}

function counter(
  map: Map<string, { day: number; orders: number; bought: number }>,
  person: string,
  day: number,
) {
  let c = map.get(person);
  if (!c || c.day !== day) {
    c = { day, orders: 0, bought: 0 };
    map.set(person, c);
  }
  return c;
}

function sellableNow(book: Book, person: string, company: string, day: number): number {
  const lots = sellableLots(book, person, company, day).reduce((t, l) => t + l.qty, 0);
  const reserved = book.orders.reduce(
    (t, o) =>
      t +
      (o.side === "sell" && o.position === null && o.person === person && o.company === company
        ? o.qty
        : 0),
    0,
  );
  return Math.max(0, lots - reserved);
}

function sellOrder(
  id: string,
  person: string,
  company: string,
  qty: number,
  position: string | null,
  limit: number | null,
  placed: number,
  day: number,
): Order {
  return {
    id,
    person,
    company,
    side: "sell",
    kind: limit === null ? "market" : "limit",
    limit,
    coins: 0,
    margin: 0,
    exposure: 0,
    fee: 0,
    leverage: 1,
    qty,
    position,
    placed_round: placed,
    expires_day: day,
  };
}

function buyFacts(
  book: Book,
  person: string,
  company: string,
  balance: number,
  count: { orders: number; bought: number },
) {
  let companyCost = 0;
  let total = 0;
  let margin = 0;
  let mine = 0;
  let all = 0;
  for (const pos of book.positions) {
    const value = exactValue(pos.qty, priceOf(book, pos.company));
    if (pos.company === company) all += value;
    if (pos.person !== person) continue;
    total += pos.cost;
    if (pos.company === company) {
      companyCost += pos.cost;
      mine += value;
    }
    if (pos.leverage > 1) margin += pos.margin;
  }
  for (const o of book.orders) {
    if (o.person !== person || o.side !== "buy") continue;
    total += o.exposure;
    if (o.company === company) companyCost += o.exposure;
    if (o.leverage > 1) margin += o.margin;
  }
  return {
    balance,
    transferred: 0,
    orders_today: count.orders,
    bought_today: count.bought,
    company_cost: companyCost,
    total_cost: total,
    margin,
    company_value: all,
    my_company_value: mine,
  };
}

function record(
  outcome: RoundOutcome,
  result: SimResult,
  book: Book,
  margins: Map<string, number>,
  warned: Set<string>,
): void {
  result.levels.push(outcome.level);
  if (outcome.breaker) result.breakers++;
  for (const f of outcome.fills) result.volume += f.gross;
  for (const pos of outcome.opened) if (pos.leverage > 1) margins.set(pos.id, pos.margin);
  for (const nt of outcome.notices) if (nt.kind === "warn_near") warned.add(nt.position);
  for (const { position, status } of outcome.closed) {
    if (position.leverage <= 1) continue;
    const fill = outcome.fills.find((f) => f.position === position.id && f.side === "sell");
    const price = fill?.price ?? priceOf(book, position.company);
    const ratio = equityOf(position, price) / Math.max(position.margin, 1);
    const paid = fill ? fill.paid : 0;
    result.leverage.push({
      margin: position.margin,
      paid,
      liquidated: status === "liquidated",
      ratio: Math.round(ratio * 1000) / 1000,
      warned_before: warned.has(position.id),
    });
    if (status === "liquidated" && !warned.has(position.id)) {
      result.violations.push(`liquidated without a warning first: ${position.id}`);
    }
    if (paid < 0)
      result.violations.push(`a leveraged position paid back below zero: ${position.id}`);
    if (status === "liquidated" && ratio <= 0)
      result.violations.push(`a liquidation reached past the margin: ${position.id}`);
  }
}
