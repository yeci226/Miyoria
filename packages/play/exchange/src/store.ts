// The `exchange` plugin's tables on the store's database (`schema.ts`). The engine runs on a
// `Book` read from them; whatever a round (or an order, a cancel, added margin, the owner's sale)
// did is written back in one `Db.tx` with the postings it owes the wallets, and those are posted
// to the economy's ledger after, under their keys, so a restart in between posts them once.
//
// Core's store opens this plugin (`STORE_PLUGINS`); the module `exchange` owns it. The rows are
// money records: a person asking to be forgotten keeps them, as the wallet keeps its rows; a merge
// moves them to the person kept.

import {
  type CategoryData,
  type Db,
  declined,
  type PersonHookResult,
  type PersonMerge,
  type StorePlugin,
  tablePart,
} from "@miyoria/store";
import {
  type AccountRef,
  type ExchangeEntry,
  type PersonId,
  type Timestamp,
  toTimestamp,
} from "@miyoria/types";
import { and, asc, desc, eq, gte, inArray, lte, ne, sql } from "drizzle-orm";
import type {
  Book,
  CompanyRound,
  EndWhy,
  Fill,
  MarketState,
  Order,
  Owed,
  Position,
  RoundOutcome,
  RoundStatus,
} from "./engine/index.js";
import { exchangeSchema } from "./migrations.js";
import { RealStore } from "./real/store.js";
import {
  exchangeAccounts,
  exchangeFills,
  exchangeNews,
  exchangeNotices,
  exchangeOrders,
  exchangePositions,
  exchangePostings,
  exchangeRounds,
  exchangeState,
  exchangeVault,
  exchangeWords,
} from "./schema.js";

export type OrderStatus = "charging" | "open" | "filled" | "cancelled" | "expired" | "void";

/** An order as its row has it. */
export interface OrderRecord extends Order {
  account: AccountRef;
  name: string;
  request_key: string;
  status: OrderStatus;
  why: EndWhy | null;
  fill: string | null;
  created_at: Timestamp;
  ended_at: Timestamp | null;
}

export interface PositionRecord extends Position {
  status: "open" | "closed" | "liquidated";
  closed_round: number | null;
  created_at: Timestamp;
  closed_at: Timestamp | null;
}

export interface FillRecord extends Fill {
  by: string | null;
  created_at: Timestamp;
}

export interface PostingRecord {
  key: string;
  person: PersonId;
  entries: ExchangeEntry[];
  ref: string;
  covered: boolean;
  status: "pending" | "posted" | "short";
  created_at: Timestamp;
}

export interface RoundRecord {
  round: number;
  day: number;
  due_at: Timestamp;
  status: RoundStatus;
  fish: number;
  level: number | null;
  vault: number;
  obligations: number;
  burned: number;
  volume: number;
  breaker: boolean;
  prices: CompanyRound[];
  settled_at: Timestamp;
}

export interface NewsRecord {
  id: string;
  round: number;
  day: number;
  company: string | null;
  kind: "event" | "earnings";
  direction: "up" | "down";
  size: "small" | "medium" | "large";
  /** Hidden: never leaves the module. */
  move: number;
  headline: string | null;
  body: string | null;
  worded_by: "her" | "plain" | null;
  created_at: Timestamp;
}

export interface AccountRecord {
  person: PersonId;
  opened_at: Timestamp;
  leverage_at: Timestamp | null;
  hide_boards: boolean;
  show_holdings: boolean;
}

export interface NoticeRecord {
  id: string;
  person: PersonId;
  kind: "warn_half" | "warn_near" | "liquidated" | "owed_paid" | "refunded";
  position: string | null;
  order: string | null;
  round: number;
  text: string;
  created_at: Timestamp;
  sent_at: Timestamp | null;
}

export interface WordsRecord {
  key: string;
  kind: "open" | "close" | "rating";
  day: number;
  text: string;
  by: "her" | "plain";
  data: string | null;
  created_at: Timestamp;
  posted_at: Timestamp | null;
}

export interface StateRecord {
  seed: string;
  market: MarketState;
  vault: number;
  burned: number;
  held_day: number | null;
  owed: Owed[];
  paused: boolean;
  paused_by: string | null;
}

/** Everything one step changed, to write in one transaction. */
export interface Changes {
  outcome: RoundOutcome;
  book: Book;
  /** The round's own row (`null`: not a round, e.g. a cancel). */
  round: { due_at: Timestamp; day: number } | null;
  /** Orders placed in this step (written as `open`). */
  placed?: OrderRecord[];
  notices?: NoticeRecord[];
  news?: NewsRecord[];
  /** Who sold, for the owner's sale. */
  by?: string | null;
  now: Timestamp;
}

type OrderRow = typeof exchangeOrders.$inferSelect;
type PositionRow = typeof exchangePositions.$inferSelect;
type FillRow = typeof exchangeFills.$inferSelect;

function orderOf(r: OrderRow): OrderRecord {
  return {
    id: r.id,
    person: r.person_id,
    account: { platform: r.platform, id: r.account_id },
    name: r.name,
    request_key: r.request_key,
    company: r.company,
    side: r.side as Order["side"],
    kind: r.kind as Order["kind"],
    limit: r.limit_price,
    coins: r.coins,
    margin: r.margin,
    exposure: r.exposure,
    fee: r.fee,
    leverage: r.leverage,
    qty: r.qty,
    position: r.position_id,
    placed_round: r.placed_round,
    expires_day: r.expires_day,
    status: r.status as OrderStatus,
    why: (r.why as EndWhy | null) ?? null,
    fill: r.fill_id,
    created_at: r.created_at,
    ended_at: r.ended_at,
  };
}

function positionOf(r: PositionRow): PositionRecord {
  return {
    id: r.id,
    person: r.person_id,
    company: r.company,
    leverage: r.leverage,
    qty: r.qty,
    cost: r.cost,
    margin: r.margin,
    loan: r.loan,
    carry: r.carry,
    day: r.day,
    round: r.round,
    warned_half: r.warned_half,
    warned_near: r.warned_near,
    status: r.status as PositionRecord["status"],
    closed_round: r.closed_round,
    created_at: r.created_at,
    closed_at: r.closed_at,
  };
}

function fillOf(r: FillRow): FillRecord {
  return {
    id: r.id,
    order: r.order_id,
    person: r.person_id,
    company: r.company,
    side: r.side as Fill["side"],
    kind: r.kind as Fill["kind"],
    position: r.position_id,
    leverage: r.leverage,
    qty: r.qty,
    price: r.price,
    gross: r.gross,
    fee: r.fee,
    tax: r.tax,
    carry: r.carry,
    paid: r.paid,
    vault: r.vault,
    round: r.round,
    by: r.by,
    created_at: r.created_at,
  };
}

const at = (ms: number): Timestamp => toTimestamp(ms);

/** A posting's rows: each entry keyed under the posting's key. */
export function postingEntries(
  key: string,
  entries: readonly { reason: string; delta: number }[],
): ExchangeEntry[] {
  return entries.map((e) => ({
    reason: e.reason as ExchangeEntry["reason"],
    delta: e.delta,
    key: `${key}:${e.reason}`,
  }));
}

export class ExchangeStore {
  readonly #db: Db;
  /** The real instruments' tables (the house as counterparty). */
  readonly real: RealStore;

  constructor(db: Db) {
    this.#db = db;
    this.real = new RealStore(db);
  }

  #write<T>(fn: () => T): T {
    return this.#db.tx(fn);
  }

  // ---- the state ------------------------------------------------------------------------------

  state(): StateRecord | null {
    this.#db.ensureOpen();
    const r = this.#db.orm.select().from(exchangeState).where(eq(exchangeState.id, 1)).get();
    if (!r) return null;
    return {
      seed: r.seed,
      market: JSON.parse(r.market) as MarketState,
      vault: r.vault,
      burned: r.burned,
      held_day: r.held_day,
      owed: JSON.parse(r.owed) as Owed[],
      paused: r.paused,
      paused_by: r.paused_by,
    };
  }

  /** The first state, once; a second call keeps the first. */
  init(seed: string, market: MarketState, now: Timestamp): StateRecord {
    this.#write(() => {
      this.#db.orm
        .insert(exchangeState)
        .values({
          id: 1,
          seed,
          market: JSON.stringify(market),
          vault: 0,
          burned: 0,
          created_at: now,
          updated_at: now,
        })
        .onConflictDoNothing()
        .run();
    });
    return this.state() as StateRecord;
  }

  setPaused(paused: boolean, by: string | null, now: Timestamp): void {
    this.#write(() => {
      this.#db.orm
        .update(exchangeState)
        .set({ paused, paused_by: by, updated_at: now })
        .where(eq(exchangeState.id, 1))
        .run();
    });
  }

  /** The book as the engine runs on it: the state, the open orders and positions, what is owed. */
  book(): { book: Book; state: StateRecord } | null {
    const state = this.state();
    if (!state) return null;
    const orders = this.#db.orm
      .select()
      .from(exchangeOrders)
      .where(eq(exchangeOrders.status, "open"))
      .orderBy(asc(exchangeOrders.placed_round), asc(exchangeOrders.id))
      .all()
      .map((r) => strip(orderOf(r)));
    const positions = this.openPositions().map(stripPosition);
    return {
      state,
      book: {
        market: state.market,
        orders,
        positions,
        owed: state.owed,
        vault: state.vault,
        held_day: state.held_day,
      },
    };
  }

  // ---- writing what a step did ----------------------------------------------------------------

  /** Writes `changes` in one transaction: the book, the vault's rows, the postings, the state. */
  commit(c: Changes): void {
    const o = c.outcome;
    const orm = this.#db.orm;
    this.#write(() => {
      const prev = this.state();
      if (!prev) throw new Error("the exchange has no state");
      for (const order of c.placed ?? []) this.#insertOrder(order, "open");
      for (const pos of o.opened) {
        orm
          .insert(exchangePositions)
          .values({ ...positionValues(pos), status: "open", created_at: c.now })
          .run();
      }
      for (const pos of o.changed)
        orm
          .update(exchangePositions)
          .set(positionValues(pos))
          .where(eq(exchangePositions.id, pos.id))
          .run();
      for (const { position, status } of o.closed) {
        orm
          .update(exchangePositions)
          .set({ ...positionValues(position), status, closed_round: o.round, closed_at: c.now })
          .where(eq(exchangePositions.id, position.id))
          .run();
      }
      for (const f of o.fills) {
        orm
          .insert(exchangeFills)
          .values({
            id: f.id,
            order_id: f.order,
            person_id: f.person,
            company: f.company,
            side: f.side,
            kind: f.kind,
            position_id: f.position,
            leverage: f.leverage,
            qty: f.qty,
            price: f.price,
            gross: f.gross,
            fee: f.fee,
            tax: f.tax,
            carry: f.carry,
            paid: f.paid,
            vault: f.vault,
            round: f.round,
            by: f.kind === "admin" ? (c.by ?? null) : null,
            created_at: c.now,
          })
          .run();
      }
      for (const e of o.ended) {
        const status =
          e.status === "filled" ? "filled" : e.status === "expired" ? "expired" : "cancelled";
        orm
          .update(exchangeOrders)
          .set({ status, why: e.why, fill_id: e.fill, ended_at: c.now })
          .where(and(eq(exchangeOrders.id, e.order.id), eq(exchangeOrders.status, "open")))
          .run();
      }
      for (const p of o.postings)
        this.#insertPosting(p.key, p.person, postingEntries(p.key, p.entries), p.ref, false, c.now);
      let balance = prev.vault;
      for (const v of o.vault) {
        balance += v.amount;
        orm
          .insert(exchangeVault)
          .values({
            round: o.round,
            kind: v.kind,
            amount: v.amount,
            balance,
            ref: v.ref,
            at: c.now,
          })
          .run();
      }
      if (balance !== c.book.vault)
        throw new Error(`the vault's rows (${balance}) and the book (${c.book.vault}) disagree`);
      for (const n of c.notices ?? []) {
        orm
          .insert(exchangeNotices)
          .values({
            id: n.id,
            person_id: n.person,
            kind: n.kind,
            position_id: n.position,
            order_id: n.order,
            round: n.round,
            text: n.text,
            created_at: n.created_at,
            sent_at: null,
          })
          .run();
      }
      for (const n of c.news ?? []) {
        orm
          .insert(exchangeNews)
          .values({
            id: n.id,
            round: n.round,
            day: n.day,
            company: n.company,
            kind: n.kind,
            direction: n.direction,
            size: n.size,
            move: n.move,
            headline: n.headline,
            body: n.body,
            worded_by: n.worded_by,
            created_at: n.created_at,
          })
          .run();
      }
      if (c.round) {
        orm
          .insert(exchangeRounds)
          .values({
            round: o.round,
            day: c.round.day,
            due_at: c.round.due_at,
            status: o.status,
            fish: o.fish,
            level: o.level,
            vault: o.vault_after,
            obligations: o.obligations,
            burned: o.burned,
            volume: o.fills.reduce((t, f) => t + f.gross, 0),
            breaker: o.breaker,
            prices: JSON.stringify(o.companies),
            settled_at: c.now,
          })
          .onConflictDoNothing()
          .run();
      }
      orm
        .update(exchangeState)
        .set({
          market: JSON.stringify(c.book.market),
          vault: c.book.vault,
          burned: prev.burned + o.burned,
          held_day: c.book.held_day,
          owed: JSON.stringify(c.book.owed),
          updated_at: c.now,
        })
        .where(eq(exchangeState.id, 1))
        .run();
    });
  }

  #insertOrder(order: OrderRecord, status: OrderStatus): void {
    this.#db.orm
      .insert(exchangeOrders)
      .values({
        id: order.id,
        person_id: order.person,
        platform: order.account.platform,
        account_id: order.account.id,
        name: order.name,
        request_key: order.request_key,
        company: order.company,
        side: order.side,
        kind: order.kind,
        limit_price: order.limit,
        coins: order.coins,
        margin: order.margin,
        exposure: order.exposure,
        fee: order.fee,
        leverage: order.leverage,
        qty: order.qty,
        position_id: order.position,
        placed_round: order.placed_round,
        expires_day: order.expires_day,
        status,
        created_at: order.created_at,
      })
      .run();
  }

  #insertPosting(
    key: string,
    person: string,
    entries: ExchangeEntry[],
    ref: string,
    covered: boolean,
    now: Timestamp,
  ): void {
    if (entries.length === 0) return;
    this.#db.orm
      .insert(exchangePostings)
      .values({
        key,
        person_id: person,
        entries: JSON.stringify(entries),
        ref,
        covered,
        status: "pending",
        created_at: now,
      })
      .onConflictDoNothing()
      .run();
  }

  // ---- placing a buy --------------------------------------------------------------------------

  /** The order of `(person, request_key)`, if one was placed. */
  orderByKey(person: PersonId, key: string): OrderRecord | null {
    this.#db.ensureOpen();
    const r = this.#db.orm
      .select()
      .from(exchangeOrders)
      .where(and(eq(exchangeOrders.person_id, person), eq(exchangeOrders.request_key, key)))
      .get();
    return r ? orderOf(r) : null;
  }

  /** A buy written before the wallet is asked (`charging`), with the posting that charges it. */
  startBuy(order: OrderRecord, key: string, entries: ExchangeEntry[], now: Timestamp): void {
    this.#write(() => {
      this.#insertOrder(order, "charging");
      this.#db.orm
        .insert(exchangePostings)
        .values({
          key,
          person_id: order.person,
          entries: JSON.stringify(entries),
          ref: order.id,
          covered: true,
          status: "pending",
          created_at: now,
        })
        .run();
    });
  }

  /** The charge went through (`open`, in the book from the next round) or it did not (`void`). */
  settleBuy(order: string, key: string, charged: boolean, now: Timestamp): void {
    this.#write(() => {
      this.#db.orm
        .update(exchangeOrders)
        .set(charged ? { status: "open" } : { status: "void", why: "cancelled", ended_at: now })
        .where(and(eq(exchangeOrders.id, order), eq(exchangeOrders.status, "charging")))
        .run();
      this.#db.orm
        .update(exchangePostings)
        .set({ status: charged ? "posted" : "short", posted_at: now })
        .where(and(eq(exchangePostings.key, key), eq(exchangePostings.status, "pending")))
        .run();
    });
  }

  /** Buys that were being charged when something stopped. */
  charging(): OrderRecord[] {
    this.#db.ensureOpen();
    return this.#db.orm
      .select()
      .from(exchangeOrders)
      .where(eq(exchangeOrders.status, "charging"))
      .all()
      .map(orderOf);
  }

  // ---- postings -------------------------------------------------------------------------------

  /** Payouts and refunds not posted yet, oldest first. */
  pendingPostings(limit = 200): PostingRecord[] {
    this.#db.ensureOpen();
    return this.#db.orm
      .select()
      .from(exchangePostings)
      .where(and(eq(exchangePostings.status, "pending"), eq(exchangePostings.covered, false)))
      .orderBy(asc(exchangePostings.created_at), asc(exchangePostings.key))
      .limit(limit)
      .all()
      .map((r) => ({
        key: r.key,
        person: r.person_id,
        entries: JSON.parse(r.entries) as ExchangeEntry[],
        ref: r.ref,
        covered: r.covered,
        status: r.status as PostingRecord["status"],
        created_at: r.created_at,
      }));
  }

  /** Margin to add, written before the wallet is asked; `false` when this key was asked already. */
  startMargin(
    key: string,
    person: PersonId,
    entries: ExchangeEntry[],
    ref: string,
    now: Timestamp,
  ): boolean {
    return this.#write(() => {
      const r = this.#db.orm
        .insert(exchangePostings)
        .values({
          key,
          person_id: person,
          entries: JSON.stringify(entries),
          ref,
          covered: true,
          status: "pending",
          created_at: now,
        })
        .onConflictDoNothing()
        .run();
      return Number(r.changes) > 0;
    });
  }

  settleMargin(key: string, charged: boolean, now: Timestamp): void {
    this.#write(() => {
      this.#db.orm
        .update(exchangePostings)
        .set({ status: charged ? "posted" : "short", posted_at: now })
        .where(and(eq(exchangePostings.key, key), eq(exchangePostings.status, "pending")))
        .run();
    });
  }

  /** Margin whose charge was asked when something stopped. */
  pendingMargin(): PostingRecord[] {
    this.#db.ensureOpen();
    return this.#db.orm
      .select()
      .from(exchangePostings)
      .where(
        and(
          eq(exchangePostings.status, "pending"),
          eq(exchangePostings.covered, true),
          sql`${exchangePostings.ref} LIKE 'margin:%'`,
        ),
      )
      .all()
      .map((r) => ({
        key: r.key,
        person: r.person_id,
        entries: JSON.parse(r.entries) as ExchangeEntry[],
        ref: r.ref,
        covered: r.covered,
        status: r.status as PostingRecord["status"],
        created_at: r.created_at,
      }));
  }

  postingPerson(key: string): PersonId | null {
    this.#db.ensureOpen();
    return (
      this.#db.orm
        .select({ p: exchangePostings.person_id })
        .from(exchangePostings)
        .where(eq(exchangePostings.key, key))
        .get()?.p ?? null
    );
  }

  postingPosted(key: string, now: Timestamp): void {
    this.#write(() => {
      this.#db.orm
        .update(exchangePostings)
        .set({ status: "posted", posted_at: now })
        .where(eq(exchangePostings.key, key))
        .run();
    });
  }

  /** Every posting's rows as one sum per status (the books check). */
  postingTotals(): { posted: number; pending: number } {
    this.#db.ensureOpen();
    const rows = this.#db.orm
      .select({ status: exchangePostings.status, entries: exchangePostings.entries })
      .from(exchangePostings)
      .all();
    let posted = 0;
    let pending = 0;
    for (const r of rows) {
      const sum = (JSON.parse(r.entries) as ExchangeEntry[]).reduce((t, e) => t + e.delta, 0);
      if (r.status === "posted") posted += sum;
      else if (r.status === "pending") pending += sum;
    }
    return { posted, pending };
  }

  // ---- reading --------------------------------------------------------------------------------

  order(id: string): OrderRecord | null {
    this.#db.ensureOpen();
    const r = this.#db.orm.select().from(exchangeOrders).where(eq(exchangeOrders.id, id)).get();
    return r ? orderOf(r) : null;
  }

  /** A person's orders, newest first; `open` narrows to the ones in the book. */
  orders(
    person: PersonId,
    options: { open?: boolean; since?: number; limit?: number } = {},
  ): OrderRecord[] {
    this.#db.ensureOpen();
    const where = [eq(exchangeOrders.person_id, person)];
    if (options.open) where.push(inArray(exchangeOrders.status, ["open", "charging"]));
    if (options.since !== undefined) where.push(gte(exchangeOrders.created_at, at(options.since)));
    return this.#db.orm
      .select()
      .from(exchangeOrders)
      .where(and(...where))
      .orderBy(desc(exchangeOrders.created_at), desc(exchangeOrders.id))
      .limit(options.limit ?? 200)
      .all()
      .map(orderOf);
  }

  openPositions(person?: PersonId): PositionRecord[] {
    this.#db.ensureOpen();
    const where = [eq(exchangePositions.status, "open")];
    if (person !== undefined) where.push(eq(exchangePositions.person_id, person));
    return this.#db.orm
      .select()
      .from(exchangePositions)
      .where(and(...where))
      .orderBy(asc(exchangePositions.round), asc(exchangePositions.id))
      .all()
      .map(positionOf);
  }

  position(id: string): PositionRecord | null {
    this.#db.ensureOpen();
    const r = this.#db.orm
      .select()
      .from(exchangePositions)
      .where(eq(exchangePositions.id, id))
      .get();
    return r ? positionOf(r) : null;
  }

  fills(person: PersonId, limit = 50): FillRecord[] {
    this.#db.ensureOpen();
    return this.#db.orm
      .select()
      .from(exchangeFills)
      .where(eq(exchangeFills.person_id, person))
      .orderBy(desc(exchangeFills.created_at), desc(exchangeFills.id))
      .limit(limit)
      .all()
      .map(fillOf);
  }

  /** Coins traded per person since `since` (rounds from `round` on). */
  volumeSince(round: number): { person: PersonId; volume: number; trades: number }[] {
    this.#db.ensureOpen();
    return this.#db.orm
      .select({
        person: exchangeFills.person_id,
        volume: sql<number>`SUM(${exchangeFills.gross})`,
        trades: sql<number>`COUNT(*)`,
      })
      .from(exchangeFills)
      .where(and(gte(exchangeFills.round, round), eq(exchangeFills.kind, "order")))
      .groupBy(exchangeFills.person_id)
      .all()
      .map((r) => ({ person: r.person, volume: Number(r.volume), trades: Number(r.trades) }));
  }

  /** Rounds from `from` on (or the newest `limit`), oldest first. */
  rounds(options: { from?: number; limit?: number; held?: boolean } = {}): RoundRecord[] {
    this.#db.ensureOpen();
    const where = [];
    if (options.from !== undefined) where.push(gte(exchangeRounds.round, options.from));
    if (options.held) where.push(eq(exchangeRounds.status, "held"));
    const rows = this.#db.orm
      .select()
      .from(exchangeRounds)
      .where(where.length > 0 ? and(...where) : undefined)
      .orderBy(desc(exchangeRounds.round))
      .limit(options.limit ?? 2000)
      .all();
    return rows.reverse().map((r) => ({
      round: r.round,
      day: r.day,
      due_at: r.due_at,
      status: r.status as RoundStatus,
      fish: r.fish,
      level: r.level,
      vault: r.vault,
      obligations: r.obligations,
      burned: r.burned,
      volume: r.volume,
      breaker: r.breaker,
      prices: JSON.parse(r.prices) as CompanyRound[],
      settled_at: r.settled_at,
    }));
  }

  /** Coins burned at rounds from `from` on. */
  burnedSince(from: number): number {
    this.#db.ensureOpen();
    const r = this.#db.orm
      .select({ n: sql<number>`COALESCE(SUM(${exchangeRounds.burned}), 0)` })
      .from(exchangeRounds)
      .where(gte(exchangeRounds.round, from))
      .get();
    return Number(r?.n ?? 0);
  }

  /** The vault's rows from the newest, and the balance of the last one (`null`: none). */
  vaultBalance(): number | null {
    this.#db.ensureOpen();
    const r = this.#db.orm
      .select({ balance: exchangeVault.balance })
      .from(exchangeVault)
      .orderBy(desc(exchangeVault.id))
      .limit(1)
      .get();
    return r?.balance ?? null;
  }

  news(options: { company?: string; limit?: number; unworded?: boolean } = {}): NewsRecord[] {
    this.#db.ensureOpen();
    const where = [];
    if (options.company !== undefined) where.push(eq(exchangeNews.company, options.company));
    if (options.unworded) where.push(sql`${exchangeNews.worded_by} IS NULL`);
    return this.#db.orm
      .select()
      .from(exchangeNews)
      .where(where.length > 0 ? and(...where) : undefined)
      .orderBy(desc(exchangeNews.round), desc(exchangeNews.id))
      .limit(options.limit ?? 50)
      .all()
      .map((r) => ({
        id: r.id,
        round: r.round,
        day: r.day,
        company: r.company,
        kind: r.kind as NewsRecord["kind"],
        direction: r.direction as NewsRecord["direction"],
        size: r.size as NewsRecord["size"],
        move: r.move,
        headline: r.headline,
        body: r.body,
        worded_by: (r.worded_by as NewsRecord["worded_by"]) ?? null,
        created_at: r.created_at,
      }));
  }

  wordNews(id: string, headline: string, body: string, by: "her" | "plain", now: Timestamp): void {
    this.#write(() => {
      this.#db.orm
        .update(exchangeNews)
        .set({ headline, body, worded_by: by, worded_at: now })
        .where(and(eq(exchangeNews.id, id), sql`${exchangeNews.worded_by} IS NULL`))
        .run();
    });
  }

  // ---- accounts -------------------------------------------------------------------------------

  account(person: PersonId): AccountRecord | null {
    this.#db.ensureOpen();
    const r = this.#db.orm
      .select()
      .from(exchangeAccounts)
      .where(eq(exchangeAccounts.person_id, person))
      .get();
    return r ? accountOf(r) : null;
  }

  accounts(): AccountRecord[] {
    this.#db.ensureOpen();
    return this.#db.orm
      .select()
      .from(exchangeAccounts)
      .orderBy(asc(exchangeAccounts.opened_at))
      .all()
      .map(accountOf);
  }

  openAccount(person: PersonId, now: Timestamp): AccountRecord {
    this.#write(() => {
      this.#db.orm
        .insert(exchangeAccounts)
        .values({ person_id: person, opened_at: now, updated_at: now })
        .onConflictDoNothing()
        .run();
    });
    return this.account(person) as AccountRecord;
  }

  updateAccount(
    person: PersonId,
    patch: Partial<Pick<AccountRecord, "hide_boards" | "show_holdings" | "leverage_at">>,
    now: Timestamp,
  ): AccountRecord | null {
    this.#write(() => {
      this.#db.orm
        .update(exchangeAccounts)
        .set({ ...patch, updated_at: now })
        .where(eq(exchangeAccounts.person_id, person))
        .run();
    });
    return this.account(person);
  }

  // ---- notices and her words ------------------------------------------------------------------

  notices(person: PersonId, limit = 20): NoticeRecord[] {
    this.#db.ensureOpen();
    return this.#db.orm
      .select()
      .from(exchangeNotices)
      .where(eq(exchangeNotices.person_id, person))
      .orderBy(desc(exchangeNotices.created_at), desc(exchangeNotices.id))
      .limit(limit)
      .all()
      .map(noticeOf);
  }

  /** Notices not sent by DM yet, written after `since`, oldest first. */
  unsent(since: number, limit = 50): NoticeRecord[] {
    this.#db.ensureOpen();
    return this.#db.orm
      .select()
      .from(exchangeNotices)
      .where(
        and(sql`${exchangeNotices.sent_at} IS NULL`, gte(exchangeNotices.created_at, at(since))),
      )
      .orderBy(asc(exchangeNotices.created_at), asc(exchangeNotices.id))
      .limit(limit)
      .all()
      .map(noticeOf);
  }

  markSent(id: string, now: Timestamp): void {
    this.#write(() => {
      this.#db.orm
        .update(exchangeNotices)
        .set({ sent_at: now })
        .where(eq(exchangeNotices.id, id))
        .run();
    });
  }

  words(key: string): WordsRecord | null {
    this.#db.ensureOpen();
    const r = this.#db.orm.select().from(exchangeWords).where(eq(exchangeWords.key, key)).get();
    return r ? wordsOf(r) : null;
  }

  recentWords(limit = 10): WordsRecord[] {
    this.#db.ensureOpen();
    return this.#db.orm
      .select()
      .from(exchangeWords)
      .orderBy(desc(exchangeWords.created_at))
      .limit(limit)
      .all()
      .map(wordsOf);
  }

  /** Her words for `key`, once: a second writer keeps the first. */
  writeWords(w: Omit<WordsRecord, "posted_at">): WordsRecord {
    this.#write(() => {
      this.#db.orm
        .insert(exchangeWords)
        .values({ ...w, posted_at: null })
        .onConflictDoNothing()
        .run();
    });
    return this.words(w.key) as WordsRecord;
  }

  markPosted(key: string, now: Timestamp): void {
    this.#write(() => {
      this.#db.orm
        .update(exchangeWords)
        .set({ posted_at: now })
        .where(eq(exchangeWords.key, key))
        .run();
    });
  }

  // ---- people ---------------------------------------------------------------------------------

  /** Moves `absorb`'s rows to `keep`; their accounts become one (the older, any flag either set). */
  merge(keep: PersonId, absorb: PersonId): PersonHookResult {
    if (keep === absorb) return { counts: {} };
    return this.#write((): PersonHookResult => {
      const orm = this.#db.orm;
      const move = <
        T extends
          | typeof exchangeOrders
          | typeof exchangePositions
          | typeof exchangeFills
          | typeof exchangeNotices
          | typeof exchangePostings,
      >(
        table: T,
      ) =>
        Number(
          orm
            .update(table)
            .set({ person_id: keep } as never)
            .where(eq(table.person_id, absorb))
            .run().changes,
        );
      // A request key was a retry's of the absorbed person; the moved ones get one nobody will send.
      const orders = Number(
        orm
          .update(exchangeOrders)
          .set({ person_id: keep, request_key: sql`'merged:' || ${exchangeOrders.id}` })
          .where(eq(exchangeOrders.person_id, absorb))
          .run().changes,
      );
      const positions = move(exchangePositions);
      const fills = move(exchangeFills);
      const notices = move(exchangeNotices);
      const postings = move(exchangePostings);
      const mine = this.account(keep);
      const theirs = this.account(absorb);
      let accounts = 0;
      if (theirs) {
        const opened =
          mine && mine.opened_at < theirs.opened_at ? mine.opened_at : theirs.opened_at;
        const leverage =
          [mine?.leverage_at, theirs.leverage_at]
            .filter((x): x is Timestamp => x != null)
            .sort()[0] ?? null;
        orm
          .insert(exchangeAccounts)
          .values({
            person_id: keep,
            opened_at: opened,
            leverage_at: leverage,
            hide_boards: (mine?.hide_boards ?? false) || theirs.hide_boards,
            show_holdings: (mine?.show_holdings ?? false) && theirs.show_holdings,
            updated_at: theirs.opened_at,
          })
          .onConflictDoUpdate({
            target: exchangeAccounts.person_id,
            set: {
              opened_at: opened,
              leverage_at: leverage,
              hide_boards: (mine?.hide_boards ?? false) || theirs.hide_boards,
              show_holdings: (mine?.show_holdings ?? false) && theirs.show_holdings,
            },
          })
          .run();
        orm.delete(exchangeAccounts).where(eq(exchangeAccounts.person_id, absorb)).run();
        accounts = 1;
      }
      const real = this.real.merge(keep, absorb);
      return {
        counts: {
          ...real,
          exchange_orders: orders,
          exchange_positions: positions,
          exchange_fills: fills,
          exchange_notices: notices,
          exchange_postings: postings,
          exchange_accounts: accounts,
        },
      };
    });
  }

  /** Open positions of anyone but `except` (the boards and the level). */
  allOpen(): PositionRecord[] {
    return this.openPositions();
  }

  /** Whether anyone still holds anything or has an order open. */
  busy(): boolean {
    this.#db.ensureOpen();
    const o = this.#db.orm
      .select({ n: sql<number>`COUNT(*)` })
      .from(exchangeOrders)
      .where(inArray(exchangeOrders.status, ["open", "charging"]))
      .get();
    const p = this.#db.orm
      .select({ n: sql<number>`COUNT(*)` })
      .from(exchangePositions)
      .where(eq(exchangePositions.status, "open"))
      .get();
    return Number(o?.n ?? 0) + Number(p?.n ?? 0) > 0;
  }

  /** Orders placed by `person` since `since` that count against the day's limits. */
  countedToday(person: PersonId, since: number): { orders: number; bought: number } {
    this.#db.ensureOpen();
    const rows = this.#db.orm
      .select({
        side: exchangeOrders.side,
        coins: exchangeOrders.coins,
        status: exchangeOrders.status,
      })
      .from(exchangeOrders)
      .where(
        and(
          eq(exchangeOrders.person_id, person),
          gte(exchangeOrders.created_at, at(since)),
          ne(exchangeOrders.status, "void"),
        ),
      )
      .all();
    return {
      orders: rows.length,
      bought: rows
        .filter(
          (r) =>
            r.side === "buy" &&
            (r.status === "open" || r.status === "filled" || r.status === "charging"),
        )
        .reduce((t, r) => t + r.coins, 0),
    };
  }

  /** Rounds older than `before` (epoch ms) are pruned past `keepRounds`: not used yet. */
  oldestRound(): number | null {
    this.#db.ensureOpen();
    const r = this.#db.orm
      .select({ round: exchangeRounds.round })
      .from(exchangeRounds)
      .orderBy(asc(exchangeRounds.round))
      .limit(1)
      .get();
    return r?.round ?? null;
  }

  /** Rounds at or before `round`, newest first (for the day's close). */
  roundAtOrBefore(round: number): RoundRecord | null {
    this.#db.ensureOpen();
    const r = this.#db.orm
      .select({ round: exchangeRounds.round })
      .from(exchangeRounds)
      .where(lte(exchangeRounds.round, round))
      .orderBy(desc(exchangeRounds.round))
      .limit(1)
      .get();
    if (!r) return null;
    return this.rounds({ from: r.round, limit: 1 })[0] ?? null;
  }
}

function strip(o: OrderRecord): Order {
  return {
    id: o.id,
    person: o.person,
    company: o.company,
    side: o.side,
    kind: o.kind,
    limit: o.limit,
    coins: o.coins,
    margin: o.margin,
    exposure: o.exposure,
    fee: o.fee,
    leverage: o.leverage,
    qty: o.qty,
    position: o.position,
    placed_round: o.placed_round,
    expires_day: o.expires_day,
  };
}

function stripPosition(p: PositionRecord): Position {
  return {
    id: p.id,
    person: p.person,
    company: p.company,
    leverage: p.leverage,
    qty: p.qty,
    cost: p.cost,
    margin: p.margin,
    loan: p.loan,
    carry: p.carry,
    day: p.day,
    round: p.round,
    warned_half: p.warned_half,
    warned_near: p.warned_near,
  };
}

function positionValues(p: Position) {
  return {
    id: p.id,
    person_id: p.person,
    company: p.company,
    leverage: p.leverage,
    qty: p.qty,
    cost: p.cost,
    margin: p.margin,
    loan: p.loan,
    carry: p.carry,
    day: p.day,
    round: p.round,
    warned_half: p.warned_half,
    warned_near: p.warned_near,
  };
}

function accountOf(r: typeof exchangeAccounts.$inferSelect): AccountRecord {
  return {
    person: r.person_id,
    opened_at: r.opened_at,
    leverage_at: r.leverage_at,
    hide_boards: r.hide_boards,
    show_holdings: r.show_holdings,
  };
}

function noticeOf(r: typeof exchangeNotices.$inferSelect): NoticeRecord {
  return {
    id: r.id,
    person: r.person_id,
    kind: r.kind as NoticeRecord["kind"],
    position: r.position_id,
    order: r.order_id,
    round: r.round,
    text: r.text,
    created_at: r.created_at,
    sent_at: r.sent_at,
  };
}

function wordsOf(r: typeof exchangeWords.$inferSelect): WordsRecord {
  return {
    key: r.key,
    kind: r.kind as WordsRecord["kind"],
    day: r.day,
    text: r.text,
    by: r.by as WordsRecord["by"],
    data: r.data,
    created_at: r.created_at,
    posted_at: r.posted_at,
  };
}

// ---- the plugin -------------------------------------------------------------------------------

const cols = (names: Record<string, "text" | "num" | "ts" | "bool">) => names;

/** What people bought and sold is part of their coins, kept with the ledger. */
const exchangeData: readonly CategoryData[] = [
  {
    category: "relationships",
    parts: [
      tablePart(
        "exchange_accounts",
        "exchange_accounts",
        "node",
        "updated_at",
        "opened_at, person_id",
        cols({
          person_id: "text",
          opened_at: "ts",
          leverage_at: "ts",
          hide_boards: "bool",
          show_holdings: "bool",
          updated_at: "ts",
        }),
      ),
      tablePart(
        "exchange_orders",
        "exchange_orders",
        "node",
        "created_at",
        "created_at, id",
        cols({
          id: "text",
          person_id: "text",
          platform: "text",
          account_id: "text",
          name: "text",
          request_key: "text",
          company: "text",
          side: "text",
          kind: "text",
          limit_price: "num",
          coins: "num",
          margin: "num",
          exposure: "num",
          fee: "num",
          leverage: "num",
          qty: "num",
          position_id: "text",
          placed_round: "num",
          expires_day: "num",
          status: "text",
          why: "text",
          fill_id: "text",
          created_at: "ts",
          ended_at: "ts",
        }),
      ),
      tablePart(
        "exchange_positions",
        "exchange_positions",
        "node",
        "created_at",
        "created_at, id",
        cols({
          id: "text",
          person_id: "text",
          company: "text",
          leverage: "num",
          qty: "num",
          cost: "num",
          margin: "num",
          loan: "num",
          carry: "num",
          day: "num",
          round: "num",
          warned_half: "num",
          warned_near: "num",
          status: "text",
          closed_round: "num",
          created_at: "ts",
          closed_at: "ts",
        }),
      ),
      tablePart(
        "exchange_fills",
        "exchange_fills",
        "node",
        "created_at",
        "created_at, id",
        cols({
          id: "text",
          order_id: "text",
          person_id: "text",
          company: "text",
          side: "text",
          kind: "text",
          position_id: "text",
          leverage: "num",
          qty: "num",
          price: "num",
          gross: "num",
          fee: "num",
          tax: "num",
          carry: "num",
          paid: "num",
          vault: "num",
          round: "num",
          by: "text",
          created_at: "ts",
        }),
      ),
      tablePart(
        "exchange_postings",
        "exchange_postings",
        "node",
        "created_at",
        "created_at, key",
        cols({
          key: "text",
          person_id: "text",
          entries: "text",
          ref: "text",
          covered: "bool",
          status: "text",
          created_at: "ts",
          posted_at: "ts",
        }),
      ),
      tablePart(
        "exchange_notices",
        "exchange_notices",
        "node",
        "created_at",
        "created_at, id",
        cols({
          id: "text",
          person_id: "text",
          kind: "text",
          position_id: "text",
          order_id: "text",
          round: "num",
          text: "text",
          created_at: "ts",
          sent_at: "ts",
        }),
      ),
      tablePart(
        "exchange_rounds",
        "exchange_rounds",
        "node",
        "settled_at",
        "round",
        cols({
          round: "num",
          day: "num",
          due_at: "ts",
          status: "text",
          fish: "num",
          level: "num",
          vault: "num",
          obligations: "num",
          burned: "num",
          volume: "num",
          breaker: "bool",
          prices: "text",
          settled_at: "ts",
        }),
      ),
      tablePart(
        "exchange_news",
        "exchange_news",
        "node",
        "created_at",
        "round, id",
        cols({
          id: "text",
          round: "num",
          day: "num",
          company: "text",
          kind: "text",
          direction: "text",
          size: "text",
          move: "num",
          headline: "text",
          body: "text",
          worded_by: "text",
          created_at: "ts",
          worded_at: "ts",
        }),
      ),
      tablePart(
        "exchange_vault",
        "exchange_vault",
        "node",
        "at",
        "id",
        cols({
          id: "num",
          round: "num",
          kind: "text",
          amount: "num",
          balance: "num",
          ref: "text",
          at: "ts",
        }),
      ),
      tablePart(
        "exchange_words",
        "exchange_words",
        "node",
        "created_at",
        "created_at, key",
        cols({
          key: "text",
          kind: "text",
          day: "num",
          text: "text",
          by: "text",
          data: "text",
          created_at: "ts",
          posted_at: "ts",
        }),
      ),
      tablePart(
        "exchange_state",
        "exchange_state",
        "node",
        "updated_at",
        "id",
        cols({
          id: "num",
          seed: "text",
          market: "text",
          vault: "num",
          burned: "num",
          held_day: "num",
          owed: "text",
          paused: "bool",
          paused_by: "text",
          created_at: "ts",
          updated_at: "ts",
        }),
      ),
    ],
  },
];

/** The `exchange` plugin's tables and code (`StorePlugin`). */
export const exchangeTables: StorePlugin<ExchangeStore> = {
  schema: exchangeSchema,
  open: ({ db }) => new ExchangeStore(db),
  data: exchangeData,
  // Money is kept (v5-data §2.5), like the ledger the coins are in.
  forgetPerson: () => declined("orders, holdings and fills are money records and are kept"),
  mergePerson: (opened, { keep, absorb }: PersonMerge) => opened.merge(keep, absorb),
};
