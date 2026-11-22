// `ExchangeService`: the deep-sea exchange as people use it (docs/design/exchange.md). It reads
// the book from the store, lets the engine decide, writes what changed in one transaction, and
// posts what each wallet is owed through the economy's `ExchangeWallet` under keys, so nothing is
// booked twice or lost when Core stops in the middle. Every change runs in turn (one queue), so
// two clicks cannot both pass a check meant for one.
//
// Rounds: the pass holds each round due since the last one, in order. A round Core reaches within
// `round_grace_minutes` of its hour is held as if on time; one older than that is skipped: no
// price moves, and the market orders that waited for it go back with their fee. Prices only move
// at rounds that are held live, so nobody gets a fill at a price set while they could not act, and
// every margin warning is out at least one held round before the position could be sold.

import { randomBytes } from "node:crypto";
import { type Logger, SerialQueue } from "@miyoria/runtime/kernel";
import {
  type AccountRef,
  DEFAULT_CHARACTER,
  type ExchangeEntry,
  type ExchangeWallet,
  newId,
  type PersonId,
  type Timestamp,
  toTimestamp,
} from "@miyoria/types";
import { type ExchangeConfig, engineParams, rulesOf } from "./config.js";
import {
  addMargin,
  adminSell,
  type Book,
  type BuyRequest,
  COMPANIES,
  type CompanySpec,
  cancelOrder,
  checkBuy,
  checkLeverageOptIn,
  checkOpen,
  checkSell,
  coinsOf,
  companyOf,
  type EngineParams,
  equityOf,
  exactValue,
  fishOf,
  initMarket,
  lastRoundDue,
  levelOf,
  limitsFor,
  linePrice,
  localDay,
  marginRatio,
  type Order,
  obligationsOf,
  outcomeOf,
  type Position,
  priceOf,
  qtyFor,
  type RoundOutcome,
  type Rules,
  roundAt,
  roundDay,
  saleBurns,
  sellableLots,
  settleRound,
  type splitBuy,
  type Trader,
  warnPrice,
  weekOf,
} from "./engine/index.js";
import { type Asker, RealDesk } from "./real/desk.js";
import { MarketLists } from "./real/lists.js";
import type { LocalSignalFeed } from "./real/local.js";
import type { QuoteProvider } from "./real/provider.js";
import {
  type AccountRecord,
  type ExchangeStore,
  type NewsRecord,
  type NoticeRecord,
  type OrderRecord,
  postingEntries,
  type RoundRecord,
} from "./store.js";
import { END_WHY, hourOf, noticeText, refundText } from "./texts.js";

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
/** Rounds of history a company page draws: fourteen trading days. */
const HISTORY_ROUNDS = 14 * 12;
/** Board rows. */
const BOARD_ROWS = 20;

/** What the module knows about someone beyond their wallet. */
export interface TraderInfo {
  known_days: number;
  /** Their tier's place on the bond ladder; -1 below it. */
  tier: number;
  insider: boolean;
  self: boolean;
}

export interface Traders {
  about(account: AccountRef, person: PersonId): Promise<TraderInfo>;
  /** A person's name for the boards; `null`: unknown. */
  name(person: PersonId): Promise<string | null>;
}

export interface ExchangeDeps {
  config: ExchangeConfig;
  store: ExchangeStore;
  wallet: () => ExchangeWallet | null;
  traders: Traders;
  now: () => number;
  log: Logger;
  /** A DM to the person (a margin warning, a liquidation); whether it went. */
  dm?: (person: PersonId, text: string) => Promise<boolean>;
  /** Records the owner's hand on the market (the audit log). */
  audit?: (action: string, target: string, detail: Record<string, unknown>, by: string) => void;
  /** The seed of a new market (tests); a random one otherwise. */
  seed?: string;
  /** The quote providers by id (v1: real stocks). */
  providers?: ReadonlyMap<string, QuoteProvider>;
  /**
   * Her real things' daily signals for the local stocks (`LocalSignalBook`, which the module builds
   * over the event log); without it they walk alone.
   */
  signals?: LocalSignalFeed;
  /** The exchange's name in this profile (`[character] exchange_name`); default 深海交易所. */
  name?: () => string;
  /** The coins' name (`CurrencyKey`); none: the wallet's, else the default. */
  currency?: () => string;
  /** How texts name her (`[character] pronoun`); none: 她. */
  pronoun?: () => string;
}

export type Refusal = { ok: false; status: number; code: string; message: string };
const refuse = (status: number, code: string, message: string): Refusal => ({
  ok: false,
  status,
  code,
  message,
});

// ---- views ------------------------------------------------------------------------------------

export interface CompanyLine {
  code: string;
  name: string;
  sector: string;
  blurb: string;
  price: number;
  ref: number;
  /** Change from the reference, as a fraction. */
  change: number;
  limit: "up" | "down" | null;
  /** The last held rounds' prices, oldest first. */
  spark: number[];
}

export interface NewsLine {
  id: string;
  company: string | null;
  kind: "event" | "earnings";
  direction: "up" | "down";
  size: "small" | "medium" | "large";
  headline: string;
  body: string;
  by: "her" | "plain";
  round: number;
  at: Timestamp;
}

export interface MarketView {
  enabled: boolean;
  paused: boolean;
  /** The breaker stopped today. */
  halted: boolean;
  currency: string;
  /** The last round handled and the next one due. */
  last_round: { round: number; at: Timestamp; status: string } | null;
  next_round_at: Timestamp | null;
  fish: number;
  fish_ref: number;
  level: number | null;
  vault: number;
  obligations: number;
  burned_week: number;
  companies: CompanyLine[];
  news: NewsLine[];
  rules: RulesView;
  /** Her latest line (opening or closing), if any. */
  her: { text: string; kind: string; at: Timestamp } | null;
  rating: {
    day: number;
    items: { code: string; rating: string; reason: string }[];
    at: Timestamp;
  } | null;
}

export interface RulesView {
  rounds_per_day: number;
  first_hour: number;
  daily_limit: number;
  round_limit: number;
  breaker: number;
  fee_buy: number;
  fee_sell: number;
  tax_sell: number;
  fee_min: number;
  order_min: number;
  order_max: number;
  orders_per_day: number;
  buy_per_day: number;
  limit_company: number;
  limit_total: number;
  concentration: number;
  transfer_lock_hours: number;
  account_min_days: number;
  account_min_tier: string;
  leverage: {
    enabled: boolean;
    max: number;
    line: number;
    warn_half: number;
    warn_near: number;
    carry_daily: number;
    min_days: number;
    min_tier: string;
    margin_cap: number;
  };
}

export interface CompanyView {
  company: CompanyLine;
  /** Held rounds of the last two weeks. */
  history: { round: number; at: Timestamp; price: number }[];
  /** Daily closes. */
  closes: { day: number; date: string; price: number }[];
  news: NewsLine[];
  mine: { qty: number; cost: number; value: number; leveraged: number } | null;
}

export interface AccountView {
  currency: string;
  /** Someone she knows and has not blocked (may buy); someone blocked may still sell. */
  known: boolean;
  blocked: boolean;
  opened: boolean;
  opened_at: Timestamp | null;
  /** Why they cannot open one now (`null`: they can, or did). */
  cannot_open: string | null;
  leverage: { allowed: boolean; why: string | null; opted_in: boolean };
  /** Holding caps by cost (`0`: none). */
  limits: { company: number; total: number; mult: number };
  /** `buy_left` is `null` when there is no daily buy cap. */
  today: { orders: number; bought: number; orders_left: number; buy_left: number | null };
  balance: number | null;
  /** What they may put in now (coins received by transfer recently held back). */
  investable: number | null;
  hide_boards: boolean;
  show_holdings: boolean;
}

export interface HoldingLine {
  code: string;
  name: string;
  qty: number;
  /** Shares that can be sold today (bought before today, not reserved by an open sale). */
  sellable: number;
  cost: number;
  value: number;
  price: number;
}

export interface LeveragedLine {
  id: string;
  code: string;
  name: string;
  qty: number;
  leverage: number;
  exposure: number;
  margin: number;
  loan: number;
  carry: number;
  price: number;
  value: number;
  equity: number;
  ratio: number;
  line_price: number;
  warn_half_price: number;
  warn_near_price: number;
  opened_day: number;
  can_close: boolean;
  /** The most it can still lose: the margin left. */
  at_risk: number;
}

export interface OrderLine {
  id: string;
  code: string;
  side: "buy" | "sell";
  kind: "market" | "limit";
  limit: number | null;
  coins: number;
  qty: number;
  leverage: number;
  position: string | null;
  status: string;
  why: string | null;
  at: Timestamp;
}

export interface FillLine {
  id: string;
  code: string;
  side: "buy" | "sell";
  kind: string;
  qty: number;
  price: number;
  gross: number;
  fee: number;
  tax: number;
  carry: number;
  paid: number;
  leverage: number;
  at: Timestamp;
}

export interface PortfolioView {
  account: AccountView;
  holdings: HoldingLine[];
  leveraged: LeveragedLine[];
  orders: OrderLine[];
  fills: FillLine[];
  notices: { id: string; kind: string; text: string; at: Timestamp }[];
  totals: { cost: number; value: number; worth: number | null };
}

export interface QuoteView {
  side: "buy" | "sell";
  code: string;
  price: number;
  /** A buy: what is paid, the margin, the exposure, the fee, about how many shares. */
  coins: number;
  margin: number;
  exposure: number;
  fee: number;
  qty: number;
  leverage: number;
  /** A sale: about what comes back, after the fee and the tax. */
  gross: number;
  tax: number;
  net: number;
  /** Leverage: the most it can lose, and where it is sold. */
  max_loss: number | null;
  line_price: number | null;
  warn_half_price: number | null;
  warn_near_price: number | null;
  /** The confirmation's sentence. */
  sentence: string;
}

export interface BoardsView {
  currency: string;
  rich: {
    rank: number;
    name: string;
    worth: number;
    holdings: { code: string; value: number }[] | null;
    me: boolean;
  }[];
  volume: { rank: number; name: string; volume: number; trades: number; me: boolean }[];
  /** The viewer's own place, also when they hide or are below the table. */
  me: { rich: number | null; volume: number | null; hidden: boolean } | null;
  week_start: string;
}

export interface AdminView {
  enabled: boolean;
  paused: boolean;
  paused_by: string | null;
  vault: number;
  vault_rows: number | null;
  burned: number;
  burned_week: number;
  obligations: number;
  level: number | null;
  fish: number;
  owed: { person: string; name: string | null; gross: number }[];
  pending_postings: number;
  accounts: number;
  positions: number;
  open_orders: number;
  rounds: {
    round: number;
    at: Timestamp;
    status: string;
    fish: number;
    level: number | null;
    vault: number;
    burned: number;
    volume: number;
  }[];
  holders: {
    person: string;
    name: string | null;
    positions: {
      id: string;
      code: string;
      leverage: number;
      qty: number;
      value: number;
      equity: number;
    }[];
  }[];
  params: Record<string, number | boolean | string>;
}

export type Ok<T> = { ok: true } & T;

// ---- the service ------------------------------------------------------------------------------

export class ExchangeService {
  readonly #d: ExchangeDeps;
  readonly #turns = new SerialQueue();
  readonly params: EngineParams;
  /** v1: real Taiwan and US stocks, the house as the counterparty. */
  readonly real: RealDesk;
  /** Browsing: the lists, the watch list, suggestions while typing. */
  readonly lists: MarketLists;

  constructor(deps: ExchangeDeps) {
    this.#d = deps;
    this.params = engineParams(deps.config);
    this.real = new RealDesk({
      config: deps.config,
      store: deps.store,
      wallet: deps.wallet,
      providers: deps.providers ?? new Map(),
      now: deps.now,
      log: deps.log,
      ask: (account) => this.#ask(account),
      ...(deps.signals ? { signals: deps.signals } : {}),
      ...(deps.currency ? { currency: deps.currency } : {}),
      ...(deps.pronoun ? { pronoun: deps.pronoun } : {}),
    });
    this.lists = new MarketLists(this.real, deps.store, () => deps.config, deps.now);
  }

  /** Who is asking, for the real desk: their person, trader facts and the rules. */
  async #ask(account: AccountRef): Promise<Asker | null> {
    const who = await this.#who(account);
    if (!who) return null;
    this.#ensure();
    const acct = this.#d.store.account(who.person);
    const trader = await this.#trader(account, who, acct);
    if (acct && this.real.isBankrupt(who.person)) trader.blocked = who.blocked;
    return {
      person: who.person,
      name: who.name,
      trader,
      rules: this.#rules(this.#d.store.state()?.paused ?? false),
    };
  }

  get config(): ExchangeConfig {
    return this.#d.config;
  }

  /** The engine's numbers with leverage as v1 offers it (2x on real stocks, `leverage`). */
  #leverageParams(): EngineParams {
    return {
      ...this.params,
      leverage: { ...this.params.leverage, enabled: this.#d.config.leverage },
    };
  }

  /** A person's display name (the boards, her note). */
  nameOf(person: PersonId): Promise<string | null> {
    return this.#d.traders.name(person);
  }

  /** The person behind `account`, or `null` when the wallet does not know them. */
  async personOf(account: AccountRef): Promise<PersonId | null> {
    return (await this.#who(account))?.person ?? null;
  }

  /** What the exchange is called (`[character] exchange_name`). */
  get name(): string {
    return this.#d.name?.() ?? DEFAULT_CHARACTER.exchange_name;
  }

  /** The coins' name: the profile's (one source), else the wallet's, else the default. */
  get currency(): string {
    return this.real.currency;
  }

  /** How texts name her (`[character] pronoun`). */
  get pronoun(): string {
    return this.#d.pronoun?.() ?? DEFAULT_CHARACTER.pronoun;
  }

  /** The old market's company of `code` under this profile's names. */
  #company(code: string) {
    return companyOf(code, this.params.companies);
  }

  /** Records the owner's hand on the market in the audit log. */
  audit(action: string, target: string, detail: Record<string, unknown>, by: string): void {
    this.#d.audit?.(action, target, detail, by);
  }

  /** The service's clock (epoch ms). */
  nowMs(): number {
    return this.#d.now();
  }

  #now(): number {
    return this.#d.now();
  }

  #ts(): Timestamp {
    return toTimestamp(this.#now());
  }

  #today(): number {
    return localDay(this.#now(), this.#d.config.utc_offset_minutes);
  }

  #dayStartMs(day: number): number {
    return day * DAY_MS - this.#d.config.utc_offset_minutes * 60_000;
  }

  #rules(paused: boolean): Rules {
    return rulesOf(this.#d.config, paused);
  }

  /** The state, made on first use (a random seed nobody sees). */
  #ensure() {
    const s = this.#d.store;
    const loaded = s.book();
    if (loaded) return loaded;
    const seed = this.#d.seed ?? randomBytes(16).toString("hex");
    s.init(seed, initMarket(this.params, this.#today()), this.#ts());
    return s.book() as NonNullable<ReturnType<ExchangeStore["book"]>>;
  }

  // ---- the pass ---------------------------------------------------------------------------

  /**
   * One pass: buys left half charged are settled, the rounds due are handled in order, the
   * wallets are paid what they are owed, and the notices go out. Off: the open orders go back.
   */
  async tick(): Promise<void> {
    await this.real.tick();
    if (!this.#d.config.local_enabled) {
      await this.flush();
      await this.#sendNotices();
      return;
    }
    await this.#turns.run(async () => {
      if (!this.#d.config.open) {
        await this.#recoverCharging();
        this.#closeAll("paused");
      } else {
        await this.#recoverCharging();
        await this.#recoverMargin();
        this.#catchUp();
      }
    });
    await this.flush();
    await this.#sendNotices();
  }

  /** Off or paused: every open order goes back (a buy with its fee). */
  #closeAll(why: "paused"): number {
    const loaded = this.#d.store.book();
    if (!loaded || loaded.book.orders.length === 0) return 0;
    const { book } = loaded;
    const out = outcomeOf(book.market.round);
    for (const o of [...book.orders]) {
      const r = cancelOrder(book, o.id, why);
      if (!r) continue;
      out.ended.push(r.end);
      if (r.posting) out.postings.push(r.posting);
    }
    this.#d.store.commit({
      outcome: out,
      book,
      round: null,
      notices: this.#refundNotices(out),
      now: this.#ts(),
    });
    return out.ended.length;
  }

  /** Every round due since the last one, in order (held live, or skipped when long past). */
  #catchUp(): void {
    const { book, state } = this.#ensure();
    const now = this.#now();
    const offset = this.#d.config.utc_offset_minutes;
    const due = lastRoundDue(now, this.params, offset);
    const grace = this.#d.config.round_grace_minutes * 60_000;
    let n = 0;
    for (let round = book.market.round + 1; round <= due; round++) {
      const at = roundAt(round, this.params, offset);
      const mode = state.paused ? "paused" : now - at <= grace ? "held" : "skipped";
      const outcome = settleRound(book, {
        seed: state.seed,
        round,
        params: this.params,
        newId,
        mode,
      });
      this.#d.store.commit({
        outcome,
        book,
        round: { due_at: toTimestamp(at), day: roundDay(round, this.params) },
        notices: [...this.#notices(outcome), ...this.#refundNotices(outcome)],
        news: this.#news(outcome),
        now: this.#ts(),
      });
      n++;
    }
    if (n > 1) this.#d.log.info({ rounds: n }, "exchange: caught up");
  }

  #notices(o: RoundOutcome): NoticeRecord[] {
    const hour = hourOf(o.round, this.params.rounds_per_day, this.params.first_hour);
    const out: NoticeRecord[] = o.notices.map((n) => ({
      id: newId(),
      person: n.person,
      kind: n.kind,
      position: n.position,
      order: null,
      round: o.round,
      text: noticeText(n, hour, this.currency, this.params.companies),
      created_at: this.#ts(),
      sent_at: null,
    }));
    for (const owed of o.owed_paid) {
      out.push({
        id: newId(),
        person: owed.person,
        kind: "owed_paid",
        position: owed.position,
        order: null,
        round: o.round,
        text: noticeText(
          {
            kind: "owed_paid",
            person: owed.person,
            position: owed.position,
            company: owed.company,
            round: o.round,
            price: 0,
            line_price: 0,
            ratio: 0,
            paid: owed.gross - owed.fee - owed.tax - owed.carry,
          },
          hour,
          this.currency,
          this.params.companies,
        ),
        created_at: this.#ts(),
        sent_at: null,
      });
    }
    return out;
  }

  /** A line on their page for each buy that went back unfilled because no round was held. */
  #refundNotices(o: RoundOutcome): NoticeRecord[] {
    return o.ended
      .filter(
        (e) => e.refunded && (e.why === "skipped" || e.why === "halted" || e.why === "paused"),
      )
      .map((e) => ({
        id: newId(),
        person: e.order.person,
        kind: "refunded" as const,
        position: null,
        order: e.order.id,
        round: o.round,
        text: refundText(
          e.order.company,
          e.order.coins,
          e.why,
          this.currency,
          this.params.companies,
        ),
        created_at: this.#ts(),
        sent_at: this.#ts(), // on their page only; never a DM
      }));
  }

  #news(o: RoundOutcome): NewsRecord[] {
    return o.news.map((n) => ({
      id: newId(),
      round: o.round,
      day: roundDay(o.round, this.params),
      company: n.company,
      kind: n.kind,
      direction: n.move >= 0 ? "up" : "down",
      size: n.size,
      move: n.move,
      headline: null,
      body: null,
      worded_by: null,
      created_at: this.#ts(),
    }));
  }

  /** Buys whose charge was asked when something stopped: open when it went through, else void. */
  async #recoverCharging(): Promise<void> {
    const wallet = this.#d.wallet();
    if (!wallet) return;
    for (const order of this.#d.store.charging()) {
      const key = `exchange:order:${order.id}`;
      const first = postingEntries(key, buyEntries(order))[0];
      const charged = first ? await wallet.posted(order.person, first.key) : false;
      this.#d.store.settleBuy(order.id, key, charged, this.#ts());
      // A buy opened late may have waited for rounds that passed: the next pass sees it in the book.
    }
  }

  /** Margin whose charge was asked when something stopped: applied when it went through. */
  async #recoverMargin(): Promise<void> {
    const wallet = this.#d.wallet();
    if (!wallet) return;
    for (const p of this.#d.store.pendingMargin()) {
      const first = p.entries[0];
      const charged = first ? await wallet.posted(p.person, first.key) : false;
      this.#applyMargin(p.key, p.ref, -(first?.delta ?? 0), charged);
    }
  }

  /** Posts what wallets are owed (sales, refunds, liquidations), each under its keys. */
  async flush(): Promise<number> {
    const wallet = this.#d.wallet();
    if (!wallet) return 0;
    let n = 0;
    for (const p of this.#d.store.pendingPostings()) {
      try {
        const r = await wallet.post(p.person, p.entries, p.ref, false);
        if (r.ok) {
          this.#d.store.postingPosted(p.key, this.#ts());
          n++;
        } else {
          this.#d.log.warn({ key: p.key, r }, "exchange: a payout was not posted");
        }
      } catch (error) {
        this.#d.log.warn(
          { key: p.key, err: String(error) },
          "exchange: the wallet cannot be reached",
        );
        return n;
      }
    }
    return n;
  }

  /** Margin warnings and liquidations go to the person by DM, once (their page has them anyway). */
  async #sendNotices(): Promise<void> {
    const dm = this.#d.dm;
    if (!dm) return;
    for (const n of this.#d.store.unsent(this.#now() - DAY_MS)) {
      let sent = false;
      try {
        sent = await dm(n.person, n.text);
      } catch {
        sent = false;
      }
      // Sent or not, a notice is tried once: it is on their page either way.
      this.#d.store.markSent(n.id, this.#ts());
      if (!sent)
        this.#d.log.info({ notice: n.id }, "exchange: a notice stays on the member page only");
    }
  }

  // ---- the owner --------------------------------------------------------------------------

  /** The owner's pause: no round is held and nothing can be placed; open orders go back. */
  async setPaused(paused: boolean, by: string): Promise<{ paused: boolean; refunded: number }> {
    const refunded = await this.#turns.run(async () => {
      this.#ensure();
      this.#d.store.setPaused(paused, paused ? by : null, this.#ts());
      return paused ? this.#closeAll("paused") : 0;
    });
    this.#d.audit?.("exchange.pause", "exchange", { paused, refunded }, by);
    await this.flush();
    return { paused, refunded };
  }

  /**
   * Sells one position now for the owner, at the last price, with no fee, no tax, no carry and
   * no T+1 (a cleanup, not a trade); only when the vault can pay. Recorded in the audit log.
   */
  async adminSell(
    positionId: string,
    by: string,
    note: string | null,
  ): Promise<Ok<{ paid: number }> | Refusal> {
    const r = await this.#turns.run(async (): Promise<Ok<{ paid: number }> | Refusal> => {
      const { book } = this.#ensure();
      const pos = book.positions.find((p) => p.id === positionId);
      if (!pos) return refuse(404, "no_position", "找不到這個持股");
      const out = outcomeOf(book.market.round);
      // Its open sales go first: they would sell what is no longer there.
      for (const o of book.orders.filter(
        (x) =>
          x.person === pos.person &&
          x.side === "sell" &&
          (x.position === pos.id || x.company === pos.company),
      )) {
        const c = cancelOrder(book, o.id);
        if (c) out.ended.push(c.end);
      }
      const fill = adminSell(
        book,
        pos,
        { seed: "", round: book.market.round, params: this.params, newId },
        out,
      );
      if (fill === "short") return refuse(409, "vault_short", "金庫現在付不出這筆");
      this.#d.store.commit({ outcome: out, book, round: null, by, now: this.#ts() });
      this.#d.audit?.(
        "exchange.admin_sell",
        pos.person,
        {
          position: pos.id,
          company: pos.company,
          qty: fill.qty,
          price: fill.price,
          paid: fill.paid,
          note,
        },
        by,
      );
      return { ok: true, paid: fill.paid };
    });
    await this.flush();
    return r;
  }

  async adminView(): Promise<AdminView> {
    const loaded = this.#ensure();
    const { book, state } = loaded;
    const names = new Map<string, string | null>();
    const nameOf = async (p: string) => {
      if (!names.has(p)) names.set(p, await this.#d.traders.name(p));
      return names.get(p) ?? null;
    };
    const holders = new Map<string, AdminView["holders"][number]>();
    for (const pos of book.positions) {
      let h = holders.get(pos.person);
      if (!h) {
        h = { person: pos.person, name: await nameOf(pos.person), positions: [] };
        holders.set(pos.person, h);
      }
      const price = priceOf(book, pos.company);
      h.positions.push({
        id: pos.id,
        code: pos.company,
        leverage: pos.leverage,
        qty: pos.qty,
        value: round2(exactValue(pos.qty, price)),
        equity: round2(equityOf(pos, price)),
      });
    }
    const c = this.#d.config;
    const params: Record<string, number | boolean | string> = {};
    for (const [k, v] of Object.entries(c))
      if (typeof v !== "object") params[k] = v as number | boolean | string;
    return {
      enabled: c.open,
      paused: state.paused,
      paused_by: state.paused_by,
      vault: book.vault,
      vault_rows: this.#d.store.vaultBalance(),
      burned: state.burned,
      burned_week: this.#d.store.burnedSince(weekOf(this.#today()) * this.params.rounds_per_day),
      obligations: round2(obligationsOf(book)),
      level: roundLevel(levelOf(book, this.params)),
      fish: fishOf(book.market, this.params),
      owed: await Promise.all(
        book.owed.map(async (o) => ({
          person: o.person,
          name: await nameOf(o.person),
          gross: o.gross,
        })),
      ),
      pending_postings: this.#d.store.pendingPostings(1000).length,
      accounts: this.#d.store.accounts().length,
      positions: book.positions.length,
      open_orders: book.orders.length,
      rounds: this.#d.store
        .rounds({ limit: 36 })
        .reverse()
        .map((r) => ({
          round: r.round,
          at: r.due_at,
          status: r.status,
          fish: r.fish,
          level: r.level,
          vault: r.vault,
          burned: r.burned,
          volume: r.volume,
        })),
      holders: [...holders.values()],
      params,
    };
  }

  // ---- what anyone sees -------------------------------------------------------------------

  rulesView(): RulesView {
    const c = this.#d.config;
    const p = this.params;
    return {
      rounds_per_day: p.rounds_per_day,
      first_hour: p.first_hour,
      daily_limit: p.daily_limit,
      round_limit: p.round_limit,
      breaker: p.breaker,
      fee_buy: p.fee_buy,
      fee_sell: p.fee_sell,
      tax_sell: p.tax_sell,
      fee_min: p.fee_min,
      order_min: c.order_min,
      order_max: c.order_max,
      orders_per_day: c.orders_per_day,
      buy_per_day: c.buy_per_day,
      limit_company: c.limit_company,
      limit_total: c.limit_total,
      concentration: c.concentration,
      transfer_lock_hours: c.transfer_lock_hours,
      account_min_days: c.account_min_days,
      account_min_tier: c.account_min_tier,
      leverage: {
        enabled: p.leverage.enabled,
        max: p.leverage.max,
        line: p.leverage.line,
        warn_half: p.leverage.warn_half,
        warn_near: p.leverage.warn_near,
        carry_daily: p.leverage.carry_daily,
        min_days: c.leverage_min_days,
        min_tier: c.leverage_min_tier,
        margin_cap: c.leverage_margin_cap,
      },
    };
  }

  #lines(book: Book, rounds: RoundRecord[]): CompanyLine[] {
    return book.market.companies.map((c) => {
      const spec = this.#company(c.code);
      const spark = rounds
        .slice(-24)
        .map((r) => r.prices.find((x) => x.code === c.code)?.price ?? c.price);
      return {
        code: c.code,
        name: spec?.name ?? c.code,
        sector: spec?.sector ?? "",
        blurb: spec?.blurb ?? "",
        price: c.price,
        ref: c.ref,
        change: c.ref > 0 ? round4(c.price / c.ref - 1) : 0,
        limit:
          c.price >= Math.floor(c.ref * (1 + this.params.daily_limit))
            ? "up"
            : c.price <= Math.ceil(c.ref * (1 - this.params.daily_limit))
              ? "down"
              : null,
        spark,
      };
    });
  }

  #newsLine(n: NewsRecord): NewsLine {
    const plain = plainNews(n, this.params.companies);
    return {
      id: n.id,
      company: n.company,
      kind: n.kind,
      direction: n.direction,
      size: n.size,
      headline: n.headline ?? plain.headline,
      body: n.body ?? plain.body,
      by: n.worded_by ?? "plain",
      round: n.round,
      at: n.created_at,
    };
  }

  market(): MarketView {
    const { book, state } = this.#ensure();
    const rounds = this.#d.store.rounds({ limit: 48, held: true });
    const last = this.#d.store.rounds({ limit: 1 })[0] ?? null;
    const enabled = this.#d.config.open;
    const next =
      enabled && !state.paused
        ? roundAt(book.market.round + 1, this.params, this.#d.config.utc_offset_minutes)
        : null;
    const opening = this.#d.store.recentWords(10);
    const her = opening.find((w) => w.kind === "open" || w.kind === "close") ?? null;
    const rating = opening.find((w) => w.kind === "rating") ?? null;
    return {
      enabled,
      paused: state.paused,
      halted: book.market.halted_day === this.#today(),
      currency: this.currency,
      last_round: last ? { round: last.round, at: last.due_at, status: last.status } : null,
      next_round_at: next === null ? null : toTimestamp(next),
      fish: fishOf(book.market, this.params),
      fish_ref: book.market.fish_ref,
      level: roundLevel(levelOf(book, this.params)),
      vault: book.vault,
      obligations: round2(obligationsOf(book)),
      burned_week: this.#d.store.burnedSince(weekOf(this.#today()) * this.params.rounds_per_day),
      companies: this.#lines(book, rounds),
      news: this.#d.store.news({ limit: 12 }).map((n) => this.#newsLine(n)),
      rules: this.rulesView(),
      her: her ? { text: her.text, kind: her.kind, at: her.created_at } : null,
      rating: rating
        ? { day: rating.day, items: parseRating(rating.data), at: rating.created_at }
        : null,
    };
  }

  async company(code: string, account: AccountRef | null): Promise<CompanyView | null> {
    if (!this.#company(code)) return null;
    const { book } = this.#ensure();
    const rounds = this.#d.store.rounds({ limit: HISTORY_ROUNDS, held: true });
    const line = this.#lines(book, rounds).find((c) => c.code === code) as CompanyLine;
    const offset = this.#d.config.utc_offset_minutes;
    const closes = new Map<number, number>();
    for (const r of rounds) {
      const p = r.prices.find((x) => x.code === code);
      if (p) closes.set(r.day, p.price);
    }
    let mine: CompanyView["mine"] = null;
    if (account) {
      const who = await this.#d.wallet()?.holder(account);
      if (who) {
        const ps = book.positions.filter((p) => p.person === who.person && p.company === code);
        if (ps.length > 0) {
          const price = priceOf(book, code);
          mine = {
            qty: ps.filter((p) => p.leverage <= 1).reduce((t, p) => t + p.qty, 0),
            cost: ps.reduce((t, p) => t + p.cost, 0),
            value: round2(
              ps.reduce(
                (t, p) =>
                  t + (p.leverage > 1 ? Math.max(0, equityOf(p, price)) : exactValue(p.qty, price)),
                0,
              ),
            ),
            leveraged: ps.filter((p) => p.leverage > 1).length,
          };
        }
      }
    }
    return {
      company: line,
      history: rounds.map((r) => ({
        round: r.round,
        at: r.due_at,
        price: r.prices.find((x) => x.code === code)?.price ?? 0,
      })),
      closes: [...closes.entries()].map(([day, price]) => ({
        day,
        date: dateOf(day, offset),
        price,
      })),
      news: this.#d.store.news({ company: code, limit: 20 }).map((n) => this.#newsLine(n)),
      mine,
    };
  }

  // ---- who is asking ----------------------------------------------------------------------

  /** The person behind `account`: may they buy (`member`), only sell (`blocked`), or neither. */
  async #who(
    account: AccountRef,
  ): Promise<{ person: PersonId; name: string; blocked: boolean } | null> {
    const wallet = this.#d.wallet();
    if (!wallet) return null;
    const member = await wallet.member(account);
    if (member) return { ...member, blocked: false };
    const holder = await wallet.holder(account);
    return holder ? { ...holder, blocked: true } : null;
  }

  async #trader(
    account: AccountRef,
    who: { person: PersonId; blocked: boolean },
    acct: AccountRecord | null,
  ): Promise<Trader> {
    const info = await this.#d.traders.about(account, who.person);
    return {
      known_days: info.known_days,
      tier: info.tier,
      insider: info.insider,
      self: info.self,
      blocked: who.blocked,
      opened: acct !== null,
      leverage_opt_in: acct?.leverage_at != null,
    };
  }

  async accountView(account: AccountRef): Promise<AccountView | null> {
    const who = await this.#who(account);
    if (!who) return null;
    const loaded = this.#ensure();
    const acct = this.#d.store.account(who.person);
    const t = await this.#trader(account, who, acct);
    const rules = this.#rules(loaded.state.paused);
    const counted = this.#d.config.local_enabled
      ? this.#d.store.countedToday(who.person, this.#dayStartMs(this.#today()))
      : this.#d.store.real.countedToday(who.person, this.#dayStartMs(this.#today()));
    const wallet = this.#d.wallet();
    const balance = wallet ? await wallet.balance(who.person) : null;
    const transferred = wallet
      ? await wallet.transferredIn(
          who.person,
          toTimestamp(this.#now() - rules.transfer_lock_hours * HOUR_MS),
        )
      : 0;
    const lev = checkLeverageOptIn(rules, this.#leverageParams(), t);
    return {
      currency: this.currency,
      known: !who.blocked,
      blocked: who.blocked,
      opened: acct !== null,
      opened_at: acct?.opened_at ?? null,
      cannot_open: acct ? null : (checkOpen(rules, t)?.message ?? null),
      leverage: {
        allowed: lev === null,
        why: lev?.message ?? null,
        opted_in: acct?.leverage_at != null,
      },
      limits: limitsFor(rules, t),
      today: {
        orders: counted.orders,
        bought: counted.bought,
        orders_left: Math.max(0, rules.orders_per_day - counted.orders),
        // `null`: no daily cap.
        buy_left: rules.buy_per_day > 0 ? Math.max(0, rules.buy_per_day - counted.bought) : null,
      },
      balance,
      investable: balance === null ? null : Math.max(0, balance - transferred),
      hide_boards: acct?.hide_boards ?? false,
      show_holdings: acct?.show_holdings ?? false,
    };
  }

  async openAccount(account: AccountRef): Promise<Ok<{ account: AccountView }> | Refusal> {
    const r = await this.#turns.run(async (): Promise<Refusal | null> => {
      const who = await this.#who(account);
      if (!who) return refuse(403, "stranger", "她還不認識你,先和她說說話吧");
      const { state } = this.#ensure();
      if (this.#d.store.account(who.person)) return null;
      const t = await this.#trader(account, who, null);
      const no = checkOpen(this.#rules(state.paused), t);
      if (no) return refuse(403, no.code, no.message);
      this.#d.store.openAccount(who.person, this.#ts());
      return null;
    });
    if (r) return r;
    return { ok: true, account: (await this.accountView(account)) as AccountView };
  }

  /** The one-time opt-in to leverage, after the risks were shown (`accepted` must be true). */
  async optInLeverage(
    account: AccountRef,
    accepted: boolean,
  ): Promise<Ok<{ account: AccountView }> | Refusal> {
    if (!accepted) return refuse(400, "not_accepted", "要先看過並同意槓桿的風險");
    const r = await this.#turns.run(async (): Promise<Refusal | null> => {
      const who = await this.#who(account);
      if (!who) return refuse(403, "stranger", "她還不認識你,先和她說說話吧");
      const { state } = this.#ensure();
      const acct = this.#d.store.account(who.person);
      if (!acct) return refuse(409, "no_account", "還沒開戶");
      if (acct.leverage_at) return null;
      const no = checkLeverageOptIn(
        this.#rules(state.paused),
        this.#leverageParams(),
        await this.#trader(account, who, acct),
      );
      if (no) return refuse(403, no.code, no.message);
      this.#d.store.updateAccount(who.person, { leverage_at: this.#ts() }, this.#ts());
      return null;
    });
    if (r) return r;
    return { ok: true, account: (await this.accountView(account)) as AccountView };
  }

  async setVisibility(
    account: AccountRef,
    patch: { hide_boards?: boolean; show_holdings?: boolean },
  ): Promise<Ok<{ account: AccountView }> | Refusal> {
    const who = await this.#who(account);
    if (!who) return refuse(403, "stranger", "她還不認識你,先和她說說話吧");
    if (!this.#d.store.account(who.person)) return refuse(409, "no_account", "還沒開戶");
    const clean: { hide_boards?: boolean; show_holdings?: boolean } = {};
    if (patch.hide_boards !== undefined) clean.hide_boards = patch.hide_boards;
    if (patch.show_holdings !== undefined) clean.show_holdings = patch.show_holdings;
    this.#d.store.updateAccount(who.person, clean, this.#ts());
    return { ok: true, account: (await this.accountView(account)) as AccountView };
  }

  // ---- facts for the guards ---------------------------------------------------------------

  #holdings(book: Book, person: PersonId, company: string) {
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
    for (const o of this.#d.store.orders(person, { open: true })) {
      if (o.side !== "buy") continue;
      total += o.exposure;
      if (o.company === company) companyCost += o.exposure;
      if (o.leverage > 1) margin += o.margin;
    }
    return {
      company_cost: companyCost,
      total_cost: total,
      margin,
      company_value: all,
      my_company_value: mine,
    };
  }

  /** Plain shares of `company` they can sell today, less what open sales reserve. */
  #sellable(book: Book, person: PersonId, company: string): number {
    const day = this.#nextRoundDay(book);
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

  /** The local day of the round an order placed now would fill at. */
  #nextRoundDay(book: Book): number {
    return Math.max(roundDay(book.market.round + 1, this.params), this.#today());
  }

  // ---- quotes and orders ------------------------------------------------------------------

  /** What an order would do, for the confirmation; a refusal when it would not go through. */
  async quote(account: AccountRef, req: OrderRequest): Promise<Ok<{ quote: QuoteView }> | Refusal> {
    const checked = await this.#check(account, req);
    if (!checked.ok) return checked;
    return { ok: true, quote: checked.quote };
  }

  async #check(
    account: AccountRef,
    req: OrderRequest,
  ): Promise<
    | Ok<{
        quote: QuoteView;
        person: PersonId;
        name: string;
        book: Book;
        split: ReturnType<typeof splitBuy>;
      }>
    | Refusal
  > {
    const spec = this.#company(req.company);
    if (!spec && !req.position) return refuse(400, "company", "沒有這家公司");
    const who = await this.#who(account);
    if (!who) return refuse(403, "stranger", "她還不認識你,先和她說說話吧");
    const { book, state } = this.#ensure();
    const rules = this.#rules(state.paused);
    const acct = this.#d.store.account(who.person);
    const t = await this.#trader(account, who, acct);
    const counted = this.#d.store.countedToday(who.person, this.#dayStartMs(this.#today()));
    const limit =
      req.limit === undefined || req.limit === null ? null : Math.round(req.limit * 100);
    const days = req.days ?? 1;
    if (req.side === "buy") {
      const wallet = this.#d.wallet();
      if (!wallet) return refuse(503, "wallet", "錢包現在打不開");
      const balance = await wallet.balance(who.person);
      const transferred = await wallet.transferredIn(
        who.person,
        toTimestamp(this.#now() - rules.transfer_lock_hours * HOUR_MS),
      );
      const leverage = req.leverage ?? 1;
      const buy: BuyRequest = {
        company: req.company,
        coins: req.coins ?? 0,
        limit,
        leverage,
        days,
      };
      const r = checkBuy(
        rules,
        this.params,
        t,
        buy,
        {
          balance,
          transferred,
          orders_today: counted.orders,
          bought_today: counted.bought,
          ...this.#holdings(book, who.person, req.company),
        },
        this.currency,
      );
      if (!r.ok)
        return refuse(
          r.code === "short" || r.code === "transfer_lock" ? 402 : 409,
          r.code,
          r.message,
        );
      const price = limit ?? priceOf(book, req.company);
      const qty = qtyFor(r.split.exposure, price);
      const pos: Position = {
        id: "",
        person: who.person,
        company: req.company,
        leverage,
        qty,
        cost: r.split.exposure,
        margin: r.split.margin,
        loan: r.split.exposure - r.split.margin,
        carry: 0,
        day: 0,
        round: 0,
        warned_half: null,
        warned_near: null,
      };
      const lev = leverage > 1;
      const line = lev ? linePrice(pos, this.params) : null;
      const quote: QuoteView = {
        side: "buy",
        code: req.company,
        price,
        coins: r.split.margin + r.split.fee,
        margin: r.split.margin,
        exposure: r.split.exposure,
        fee: r.split.fee,
        qty,
        leverage,
        gross: 0,
        tax: 0,
        net: 0,
        max_loss: lev ? r.split.margin : null,
        line_price: line,
        warn_half_price: lev ? warnPrice(pos, this.params.leverage.warn_half) : null,
        warn_near_price: lev ? warnPrice(pos, this.params.leverage.warn_near) : null,
        sentence: lev
          ? `最多賠掉 ${r.split.margin} ${this.currency}(這筆的保證金),跌到 ${(line ?? 0) / 100} 會自動賣出。你錢包裡的其他${this.currency}不會被動到,也不會欠錢。`
          : `花 ${r.split.margin + r.split.fee} ${this.currency}(含手續費 ${r.split.fee}),下一盤成交。今天買的明天才能賣。`,
      };
      return { ok: true, quote, person: who.person, name: who.name, book, split: r.split };
    }
    // A sale.
    if (req.position) {
      const pos = book.positions.find(
        (p) => p.id === req.position && p.person === who.person && p.leverage > 1,
      );
      const pending = book.orders.some((o) => o.position === req.position);
      const day = this.#nextRoundDay(book);
      const no = checkSell(
        rules,
        t,
        { qty: pos?.qty ?? 0, limit, days, position: req.position },
        {
          sellable: 0,
          orders_today: counted.orders,
          position_ok: pos ? pos.day < day : null,
          pending_close: pending,
        },
      );
      if (no || !pos)
        return refuse(409, no?.code ?? "no_position", no?.message ?? "找不到這個槓桿部位");
      const price = priceOf(book, pos.company);
      const gross = coinsOf(pos.qty, price);
      const burns = saleBurns(gross, this.params);
      const carry = Math.ceil(pos.carry / 1000);
      const net = Math.max(0, gross - pos.loan - burns.fee - burns.tax - carry);
      return {
        ok: true,
        person: who.person,
        name: who.name,
        book,
        split: null,
        quote: {
          side: "sell",
          code: pos.company,
          price,
          coins: 0,
          margin: pos.margin,
          exposure: pos.cost,
          fee: burns.fee,
          qty: pos.qty,
          leverage: pos.leverage,
          gross,
          tax: burns.tax,
          net,
          max_loss: null,
          line_price: null,
          warn_half_price: null,
          warn_near_price: null,
          sentence: `下一盤以那時的價格賣出整個部位;現價算,大約拿回 ${net} ${this.currency}(扣掉借的、手續費、稅和利息)。`,
        },
      };
    }
    const sellable = this.#sellable(book, who.person, req.company);
    const qty = req.all ? sellable : Math.round((req.shares ?? 0) * 1000);
    const no = checkSell(
      rules,
      t,
      { qty, limit, days, position: null },
      { sellable, orders_today: counted.orders, position_ok: null, pending_close: false },
    );
    if (no) return refuse(409, no.code, no.message);
    const price = limit ?? priceOf(book, req.company);
    const gross = coinsOf(qty, price);
    const burns = saleBurns(gross, this.params);
    const net = gross - burns.fee - burns.tax;
    return {
      ok: true,
      person: who.person,
      name: who.name,
      book,
      split: null,
      quote: {
        side: "sell",
        code: req.company,
        price,
        coins: 0,
        margin: 0,
        exposure: 0,
        fee: burns.fee,
        qty,
        leverage: 1,
        gross,
        tax: burns.tax,
        net,
        max_loss: null,
        line_price: null,
        warn_half_price: null,
        warn_near_price: null,
        sentence: `下一盤賣出;現價算,大約拿回 ${net} ${this.currency}(手續費 ${burns.fee}、交易稅 ${burns.tax} 都燒掉)。`,
      },
    };
  }

  /** Places an order; the same `key` is the same order. */
  async place(
    account: AccountRef,
    req: OrderRequest,
    key: string,
  ): Promise<Ok<{ order: OrderLine }> | Refusal> {
    const r = await this.#turns.run(async (): Promise<Ok<{ order: OrderLine }> | Refusal> => {
      const wallet = this.#d.wallet();
      const known = wallet ? await wallet.holder(account) : null;
      if (known) {
        const first = this.#d.store.orderByKey(known.person, key);
        if (first)
          return first.status === "void"
            ? refuse(409, "void", `這筆沒有成立(${this.currency}不夠),請再下一次`)
            : { ok: true, order: orderLine(first) };
      }
      const checked = await this.#check(account, req);
      if (!checked.ok) return checked;
      const { book, person, name } = checked;
      const day = this.#nextRoundDay(book);
      const limit =
        req.limit === undefined || req.limit === null ? null : Math.round(req.limit * 100);
      const base: OrderRecord = {
        id: newId(),
        person,
        account,
        name,
        request_key: key,
        company: checked.quote.code,
        side: req.side,
        kind: limit === null ? "market" : "limit",
        limit,
        coins: 0,
        margin: 0,
        exposure: 0,
        fee: 0,
        leverage: 1,
        qty: 0,
        position: null,
        placed_round: book.market.round,
        expires_day: day + (limit === null ? 0 : (req.days ?? 1) - 1),
        status: "open",
        why: null,
        fill: null,
        created_at: this.#ts(),
        ended_at: null,
      };
      if (req.side === "sell") {
        const order: OrderRecord = {
          ...base,
          qty: checked.quote.qty,
          position: req.position ?? null,
          leverage: checked.quote.leverage,
        };
        this.#d.store.commit({
          outcome: outcomeOf(book.market.round),
          book,
          round: null,
          placed: [order],
          now: this.#ts(),
        });
        return { ok: true, order: orderLine(order) };
      }
      const split = checked.split;
      if (!split || !wallet) return refuse(409, "size", "這筆太小了");
      const order: OrderRecord = {
        ...base,
        status: "charging",
        coins: split.margin + split.fee,
        margin: split.margin,
        exposure: split.exposure,
        fee: split.fee,
        leverage: req.leverage ?? 1,
      };
      const postKey = `exchange:order:${order.id}`;
      const entries = postingEntries(postKey, buyEntries(order));
      this.#d.store.startBuy(order, postKey, entries, this.#ts());
      const post = await wallet.post(person, entries, order.id, true);
      this.#d.store.settleBuy(order.id, postKey, post.ok, this.#ts());
      if (!post.ok)
        return post.reason === "short"
          ? refuse(402, "short", `${this.currency}不夠`)
          : refuse(409, "refused", post.message);
      return { ok: true, order: orderLine({ ...order, status: "open" }) };
    });
    return r;
  }

  /** Takes an open order back; a buy's coins and fee go back. */
  async cancel(account: AccountRef, orderId: string): Promise<Ok<{ refunded: number }> | Refusal> {
    const r = await this.#turns.run(async (): Promise<Ok<{ refunded: number }> | Refusal> => {
      const who = await this.#who(account);
      if (!who) return refuse(403, "stranger", "她還不認識你,先和她說說話吧");
      const { book } = this.#ensure();
      const order = book.orders.find((o) => o.id === orderId && o.person === who.person);
      if (!order) return refuse(404, "no_order", "沒有這筆還沒成交的委託");
      const c = cancelOrder(book, order.id, "cancelled");
      if (!c) return refuse(404, "no_order", "沒有這筆還沒成交的委託");
      const out = outcomeOf(book.market.round);
      out.ended.push(c.end);
      if (c.posting) out.postings.push(c.posting);
      this.#d.store.commit({ outcome: out, book, round: null, now: this.#ts() });
      return { ok: true, refunded: order.side === "buy" ? order.coins : 0 };
    });
    await this.flush();
    return r;
  }

  /** Adds margin to a leveraged position (it pays down what the vault lent; the line moves down). */
  async addMargin(
    account: AccountRef,
    positionId: string,
    coins: number,
    key: string,
  ): Promise<Ok<{ position: LeveragedLine | null; added: number }> | Refusal> {
    return this.#turns.run(async () => {
      const who = await this.#who(account);
      if (!who) return refuse(403, "stranger", "她還不認識你,先和她說說話吧");
      const wallet = this.#d.wallet();
      if (!wallet) return refuse(503, "wallet", "錢包現在打不開");
      const { book, state } = this.#ensure();
      const rules = this.#rules(state.paused);
      if (!rules.enabled || rules.paused) return refuse(409, "closed", "交易所現在暫停");
      const postKey = `exchange:margin:${who.person}:${key}`;
      if (this.#d.store.postingPerson(postKey) !== null)
        return refuse(409, "duplicate", "這筆已經加過了");
      const pos = book.positions.find(
        (p) => p.id === positionId && p.person === who.person && p.leverage > 1,
      );
      if (!pos) return refuse(404, "no_position", "找不到這個槓桿部位");
      if (!Number.isSafeInteger(coins) || coins < 1) return refuse(400, "size", "要加多少?");
      const amount = Math.min(coins, pos.loan);
      if (amount <= 0) return refuse(409, "no_loan", "這個部位已經沒有借的部分了");
      const capLeft =
        rules.leverage_margin_cap -
        book.positions
          .filter((p) => p.person === who.person && p.leverage > 1)
          .reduce((t, p) => t + p.margin, 0);
      if (rules.leverage_margin_cap > 0 && amount > capLeft)
        return refuse(
          409,
          "margin_cap",
          `槓桿的保證金合計最多 ${rules.leverage_margin_cap} ${this.currency}`,
        );
      const balance = await wallet.balance(who.person);
      const transferred = await wallet.transferredIn(
        who.person,
        toTimestamp(this.#now() - rules.transfer_lock_hours * HOUR_MS),
      );
      if (amount > balance - Math.max(0, transferred))
        return refuse(402, "short", `${this.currency}不夠(轉來不到一天的不能投入)`);
      const entries = postingEntries(postKey, [{ reason: "exchange_in", delta: -amount }]);
      if (
        !this.#d.store.startMargin(
          postKey,
          who.person,
          entries,
          `margin:${pos.id}:${amount}`,
          this.#ts(),
        )
      ) {
        return refuse(409, "duplicate", "這筆已經加過了");
      }
      const post = await wallet.post(who.person, entries, pos.id, true);
      const applied = this.#applyMargin(postKey, `margin:${pos.id}:${amount}`, amount, post.ok);
      if (!post.ok)
        return post.reason === "short"
          ? refuse(402, "short", `${this.currency}不夠`)
          : refuse(409, "refused", post.message);
      const after = this.#d.store.book()?.book.positions.find((p) => p.id === pos.id) ?? null;
      return {
        ok: true,
        added: applied,
        position: after ? this.#leveragedLine(this.#d.store.book()?.book as Book, after) : null,
      };
    });
  }

  /**
   * Applies (or drops) margin whose charge was asked. A position sold in between gets the coins
   * back as a payout: the coins are never kept.
   */
  #applyMargin(postKey: string, ref: string, amount: number, charged: boolean): number {
    const { book } = this.#ensure();
    const positionId = ref.split(":")[1] ?? "";
    if (!charged) {
      this.#d.store.settleMargin(postKey, false, this.#ts());
      return 0;
    }
    const out = outcomeOf(book.market.round);
    const r = addMargin(book, positionId, amount, postKey, this.params);
    if (r) {
      out.changed.push(r.position);
      out.vault.push({ kind: "margin", amount: r.added, ref: postKey });
      if (r.added < amount)
        out.postings.push(marginBack(postKey, r.position.person, amount - r.added));
    } else {
      const person = this.#d.store.postingPerson(postKey);
      if (person) out.postings.push(marginBack(postKey, person, amount));
    }
    this.#d.store.commit({ outcome: out, book, round: null, now: this.#ts() });
    this.#d.store.settleMargin(postKey, true, this.#ts());
    return r?.added ?? 0;
  }

  // ---- their own book ---------------------------------------------------------------------

  #leveragedLine(book: Book, p: Position): LeveragedLine {
    const price = priceOf(book, p.company);
    const equity = equityOf(p, price);
    return {
      id: p.id,
      code: p.company,
      name: this.#company(p.company)?.name ?? p.company,
      qty: p.qty,
      leverage: p.leverage,
      exposure: p.cost,
      margin: p.margin,
      loan: p.loan,
      carry: Math.ceil(p.carry / 1000),
      price,
      value: round2(exactValue(p.qty, price)),
      equity: round2(equity),
      ratio: round4(marginRatio(p, price)),
      line_price: linePrice(p, this.params),
      warn_half_price: warnPrice(p, this.params.leverage.warn_half),
      warn_near_price: warnPrice(p, this.params.leverage.warn_near),
      opened_day: p.day,
      can_close: p.day < this.#nextRoundDay(book) && !book.orders.some((o) => o.position === p.id),
      at_risk: Math.max(0, Math.floor(equity)),
    };
  }

  async portfolio(account: AccountRef): Promise<PortfolioView | null> {
    const view = await this.accountView(account);
    if (!view) return null;
    const who = (await this.#who(account)) as { person: PersonId };
    const { book } = this.#ensure();
    const mine = book.positions.filter((p) => p.person === who.person);
    const holdings: HoldingLine[] = [];
    for (const spec of this.params.companies) {
      const lots = mine.filter((p) => p.company === spec.code && p.leverage <= 1);
      if (lots.length === 0) continue;
      const price = priceOf(book, spec.code);
      const qty = lots.reduce((t, p) => t + p.qty, 0);
      holdings.push({
        code: spec.code,
        name: spec.name,
        qty,
        sellable: this.#sellable(book, who.person, spec.code),
        cost: lots.reduce((t, p) => t + p.cost, 0),
        value: round2(exactValue(qty, price)),
        price,
      });
    }
    const leveraged = mine.filter((p) => p.leverage > 1).map((p) => this.#leveragedLine(book, p));
    const cost =
      holdings.reduce((t, h) => t + h.cost, 0) + leveraged.reduce((t, l) => t + l.margin, 0);
    const value =
      holdings.reduce((t, h) => t + h.value, 0) +
      leveraged.reduce((t, l) => t + Math.max(0, l.equity), 0);
    const escrow = book.orders
      .filter((o) => o.person === who.person && o.side === "buy")
      .reduce((t, o) => t + o.coins, 0);
    return {
      account: view,
      holdings,
      leveraged,
      orders: this.#d.store.orders(who.person, { limit: 30 }).map(orderLine),
      fills: this.#d.store.fills(who.person, 30).map(fillLine),
      notices: this.#d.store
        .notices(who.person, 20)
        .map((n) => ({ id: n.id, kind: n.kind, text: n.text, at: n.created_at })),
      totals: {
        cost,
        value: round2(value),
        worth: view.balance === null ? null : round2(view.balance + value + escrow),
      },
    };
  }

  // ---- the boards -------------------------------------------------------------------------

  /**
   * The rich list (wallet plus holdings at market value) and this week's volume, without the
   * hidden. `members`: only these persons (one server's members, `Places.members`), ranked among
   * themselves; everyone without. Prices and holdings are the same global ones either way.
   */
  async boards(
    account: AccountRef | null,
    members?: ReadonlySet<string> | null,
  ): Promise<BoardsView> {
    const { book } = this.#ensure();
    const wallet = this.#d.wallet();
    const viewer = account ? await this.#who(account) : null;
    const accounts = this.#d.store.accounts().filter((a) => !members || members.has(a.person));
    const hidden = new Set(accounts.filter((a) => a.hide_boards).map((a) => a.person));
    const worth: {
      person: string;
      worth: number;
      holdings: { code: string; value: number }[];
      show: boolean;
    }[] = [];
    for (const a of accounts) {
      const balance = wallet ? await wallet.balance(a.person) : 0;
      const held = new Map<string, number>();
      const real = this.real.worth(a.person);
      if (real.held > 0 || real.escrow > 0) {
        for (const code of real.codes) held.set(code, 0);
        held.set(real.codes[0] ?? "-", real.held);
      }
      for (const p of this.#d.config.local_enabled ? book.positions : []) {
        if (p.person !== a.person) continue;
        const price = priceOf(book, p.company);
        const v = p.leverage > 1 ? Math.max(0, equityOf(p, price)) : exactValue(p.qty, price);
        held.set(p.company, (held.get(p.company) ?? 0) + v);
      }
      const escrow = book.orders
        .filter((o) => o.person === a.person && o.side === "buy")
        .reduce((t, o) => t + o.coins, 0);
      const total = balance + escrow + real.escrow + [...held.values()].reduce((t, v) => t + v, 0);
      worth.push({
        person: a.person,
        worth: Math.floor(total),
        holdings: [...held.entries()].map(([code, value]) => ({ code, value: Math.floor(value) })),
        show: a.show_holdings,
      });
    }
    worth.sort((x, y) => y.worth - x.worth || (x.person < y.person ? -1 : 1));
    const week = weekOf(this.#today());
    const volumes = this.#d.store
      .volumeSince(week * this.params.rounds_per_day)
      .filter((v) => !members || members.has(v.person))
      .sort((x, y) => y.volume - x.volume || (x.person < y.person ? -1 : 1));
    const shownRich = worth.filter((w) => !hidden.has(w.person));
    const shownVolume = volumes.filter((v) => !hidden.has(v.person));
    const name = async (p: string) => (await this.#d.traders.name(p)) ?? "某人";
    const rich: BoardsView["rich"] = [];
    for (const [i, w] of shownRich.slice(0, BOARD_ROWS).entries()) {
      rich.push({
        rank: i + 1,
        name: await name(w.person),
        worth: w.worth,
        holdings: w.show ? w.holdings : null,
        me: viewer?.person === w.person,
      });
    }
    const volume: BoardsView["volume"] = [];
    for (const [i, v] of shownVolume.slice(0, BOARD_ROWS).entries()) {
      volume.push({
        rank: i + 1,
        name: await name(v.person),
        volume: v.volume,
        trades: v.trades,
        me: viewer?.person === v.person,
      });
    }
    let me: BoardsView["me"] = null;
    if (viewer) {
      const isHidden = hidden.has(viewer.person);
      const r = (isHidden ? worth : shownRich).findIndex((w) => w.person === viewer.person);
      const v = (isHidden ? volumes : shownVolume).findIndex((x) => x.person === viewer.person);
      me = { rich: r < 0 ? null : r + 1, volume: v < 0 ? null : v + 1, hidden: isHidden };
    }
    return {
      currency: this.currency,
      rich,
      volume,
      me,
      week_start: dateOf(week, this.#d.config.utc_offset_minutes),
    };
  }

  // ---- for her (totals only) ---------------------------------------------------------------

  /** What she may know of the market: public numbers and totals, never anyone's holdings. */
  summary(): MarketSummary {
    const view = this.market();
    const today = this.#today();
    const rounds = this.#d.store.rounds({ from: today * this.params.rounds_per_day });
    return {
      day: today,
      date: dateOf(today, this.#d.config.utc_offset_minutes),
      fish: view.fish,
      fish_ref: view.fish_ref,
      level: view.level,
      volume: rounds.reduce((t, r) => t + r.volume, 0),
      burned: rounds.reduce((t, r) => t + r.burned, 0),
      halted: view.halted,
      companies: view.companies.map((c) => ({
        code: c.code,
        name: c.name,
        price: c.price,
        change: c.change,
        limit: c.limit,
      })),
      news: view.news
        .filter((n) => n.round >= today * this.params.rounds_per_day)
        .map((n) => ({
          company: n.company,
          kind: n.kind,
          direction: n.direction,
          size: n.size,
          headline: n.headline,
        })),
    };
  }

  /** The news the program drew that nobody has worded yet. */
  unworded(limit = 20): NewsRecord[] {
    return this.#d.store.news({ unworded: true, limit });
  }

  wordNews(id: string, headline: string, body: string, by: "her" | "plain"): void {
    this.#d.store.wordNews(id, headline, body, by, this.#ts());
  }

  /** The day and the round of now, for her hooks. */
  clock(): { day: number; round: number; status: string | null } {
    const last = this.#d.store.rounds({ limit: 1 })[0] ?? null;
    return { day: this.#today(), round: last?.round ?? -1, status: last?.status ?? null };
  }

  get store(): ExchangeStore {
    return this.#d.store;
  }
}

/** What she sees of a day. */
export interface MarketSummary {
  day: number;
  date: string;
  fish: number;
  fish_ref: number;
  level: number | null;
  volume: number;
  burned: number;
  halted: boolean;
  companies: {
    code: string;
    name: string;
    price: number;
    change: number;
    limit: "up" | "down" | null;
  }[];
  news: {
    company: string | null;
    kind: string;
    direction: string;
    size: string;
    headline: string;
  }[];
}

/** An order as a member asks for it (prices in coins with two decimals). */
export interface OrderRequest {
  side: "buy" | "sell";
  company: string;
  /** A buy: coins to pay, fee included. */
  coins?: number;
  /** A sale of plain holdings: shares (three decimals), or `all`. */
  shares?: number;
  all?: boolean;
  /** A limit price in coins (`123.45`); none: a market order. */
  limit?: number | null;
  /** A limit order's trading days. */
  days?: number;
  leverage?: number;
  /** A sale that closes this leveraged position. */
  position?: string;
}

function buyEntries(order: Pick<Order, "margin" | "fee">): { reason: string; delta: number }[] {
  return [
    { reason: "exchange_in", delta: -order.margin },
    { reason: "exchange_fee", delta: -order.fee },
  ].filter((e) => e.delta !== 0);
}

function marginBack(key: string, person: string, coins: number) {
  return {
    key: `${key}:back`,
    person,
    ref: key,
    entries: [{ reason: "exchange_out", delta: coins }],
  };
}

function orderLine(o: OrderRecord): OrderLine {
  return {
    id: o.id,
    code: o.company,
    side: o.side,
    kind: o.kind,
    limit: o.limit,
    coins: o.coins,
    qty: o.qty,
    leverage: o.leverage,
    position: o.position,
    status: o.status,
    why: o.why === null ? null : END_WHY[o.why],
    at: o.created_at,
  };
}

function fillLine(f: {
  id: string;
  company: string;
  side: "buy" | "sell";
  kind: string;
  qty: number;
  price: number;
  gross: number;
  fee: number;
  tax: number;
  carry: number;
  paid: number;
  leverage: number;
  created_at: Timestamp;
}): FillLine {
  return {
    id: f.id,
    code: f.company,
    side: f.side,
    kind: f.kind,
    qty: f.qty,
    price: f.price,
    gross: f.gross,
    fee: f.fee,
    tax: f.tax,
    carry: f.carry,
    paid: f.paid,
    leverage: f.leverage,
    at: f.created_at,
  };
}

/** The plain words of a piece of news, when she has not worded it (or cannot). */
export function plainNews(
  n: Pick<NewsRecord, "company" | "kind" | "direction" | "size">,
  companies: readonly CompanySpec[] = COMPANIES,
): {
  headline: string;
  body: string;
} {
  const c = n.company ? companyOf(n.company, companies) : null;
  const who = c ? `${c.name}(${c.code})` : "市場";
  const up = n.direction === "up";
  const size = n.size === "large" ? "大" : n.size === "medium" ? "中" : "小";
  if (n.kind === "earnings") {
    return {
      headline: `${who} 公布本週財報:${up ? "優於" : "不如"}預期`,
      body: `${who} 這一週的營收${up ? "比預期好" : "比預期差"},幅度${size}。影響在下一盤開盤時反映。`,
    };
  }
  return {
    headline: `${who} ${up ? "傳出利多" : "傳出利空"}`,
    body: `${who} 有一則${up ? "利多" : "利空"}消息,影響${size}。這一盤的價格已經反映。`,
  };
}

function parseRating(data: string | null): { code: string; rating: string; reason: string }[] {
  if (!data) return [];
  try {
    const v = JSON.parse(data) as unknown;
    return Array.isArray(v) ? (v as { code: string; rating: string; reason: string }[]) : [];
  } catch {
    return [];
  }
}

/** `YYYY-MM-DD` of a local day (the day number counts local days, so its UTC date is the date). */
function dateOf(day: number, _offset: number): string {
  return new Date(day * DAY_MS).toISOString().slice(0, 10);
}

const round2 = (x: number) => Math.round(x * 100) / 100;
const round4 = (x: number) => Math.round(x * 10_000) / 10_000;
const roundLevel = (x: number | null) => (x === null ? null : round4(x));

export type { ExchangeEntry };
