// The `market` plugin's tables on the store's database (`schema.ts`): the auction's lots and bids,
// the lottery's weeks and tickets (`MarketStore`). Every write is one `Db.tx`; the coins are moved
// by the service through the economy's wallet, keyed by the ids written here, so a step that
// stopped half way is finished by the next pass. A lot that closed and a week that was drawn are
// one `market.lot_closed` / `market.lottery_drawn` event each, appended in the transaction that
// records them.
//
// Core's store opens this plugin (`STORE_PLUGINS`); the module `market` (`module.ts`) owns it.
// The rows are money records: a person asking to be forgotten keeps them; a merge moves them.
//
// One `MarketStore` is a view of one Space (`forSpace`): it reads that Space's lots, draws and
// tickets and writes its rows with that `space_id`. The view the plugin opens has no Space: it
// reads every row and writes rows without one, the market of a single server as it was before
// phase 6 (the service's own tests); the module only ever uses `forSpace` views and the song
// priority tickets, which are everyone's.

import {
  type CategoryData,
  type Db,
  declined,
  type EventStore,
  type PersonHookResult,
  type PersonMerge,
  type StorePlugin,
  tablePart,
} from "@miyoria/store";
import { type AccountRef, type PersonId, type Timestamp, toTimestamp } from "@miyoria/types";
import { and, asc, desc, eq, inArray, isNull, lte, ne, type SQL, sql } from "drizzle-orm";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";
import type { LotKind } from "./config.js";
import {
  type LotClosedData,
  type LotteryDrawnData,
  lotClosedWrite,
  lotteryDrawnWrite,
} from "./events.js";
import { marketSchema } from "./migrations.js";
import {
  marketBids,
  marketLots,
  marketLotteryDraws,
  marketLotteryTickets,
  marketSongTickets,
} from "./schema.js";

export type LotStatus =
  | "planned"
  | "skipped"
  | "open"
  | "closing"
  | "naming"
  | "applied"
  | "done"
  | "refunded"
  | "cancelled";
export type LotPicker = "owner" | "her" | "rotation";
export type BidStatus = "pending" | "leading" | "outbid" | "won" | "void";
export type WeekStatus = "open" | "drawing" | "drawn" | "refunding" | "refunded";
export type TicketStatus = "pending" | "paid" | "refunded";
export type SongTicketStatus = "charging" | "charged" | "void" | "consumed" | "refunded";

/** A song priority ticket, kept from before it is charged until it is used or given back. */
export interface SongTicket {
  key: string;
  person: PersonId;
  account: AccountRef;
  amount: number;
  status: SongTicketStatus;
  created_at: Timestamp;
  settled_at: Timestamp | null;
}

export interface Lot {
  id: string;
  week: number;
  kind: LotKind | null;
  status: LotStatus;
  picked_by: LotPicker;
  opens_at: Timestamp;
  ends_at: Timestamp;
  extended: boolean;
  channel: string | null;
  message_id: string | null;
  winner_bid: string | null;
  price: number | null;
  name_due: Timestamp | null;
  call_name: string | null;
  previous_call_name: string | null;
  applied_until: Timestamp | null;
  note: string | null;
  created_at: Timestamp;
  closed_at: Timestamp | null;
  settled_at: Timestamp | null;
}

export interface Bid {
  id: string;
  lot: string;
  person: PersonId;
  account: AccountRef;
  name: string;
  amount: number;
  hold: number;
  status: BidStatus;
  created_at: Timestamp;
  released_at: Timestamp | null;
}

export interface LotteryWeek {
  week: number;
  status: WeekStatus;
  draw_at: Timestamp;
  tickets: number;
  buyers: number;
  pot: number;
  prize: number;
  burned: number;
  winner: { person: PersonId; account: AccountRef; name: string; tickets: number } | null;
  pick: number | null;
  drawn_at: Timestamp | null;
  paid_at: Timestamp | null;
  announced_at: Timestamp | null;
  notice_message: string | null;
  notice_at: Timestamp | null;
}

export interface Ticket {
  id: string;
  week: number;
  person: PersonId;
  account: AccountRef;
  name: string;
  key: string;
  count: number;
  amount: number;
  status: TicketStatus;
  created_at: Timestamp;
  refunded_at: Timestamp | null;
}

type LotRow = typeof marketLots.$inferSelect;
type BidRow = typeof marketBids.$inferSelect;
type WeekRow = typeof marketLotteryDraws.$inferSelect;
type TicketRow = typeof marketLotteryTickets.$inferSelect;
type SongTicketRow = typeof marketSongTickets.$inferSelect;

const at = (ms: number): Timestamp => toTimestamp(ms);

function songTicketOf(r: SongTicketRow): SongTicket {
  return {
    key: r.key,
    person: r.person_id as PersonId,
    account: { platform: r.platform, id: r.account_id },
    amount: r.amount,
    status: r.status as SongTicketStatus,
    created_at: r.created_at,
    settled_at: r.settled_at,
  };
}

function lotOf(r: LotRow): Lot {
  return {
    id: r.id,
    week: r.week,
    kind: r.kind as LotKind | null,
    status: r.status as LotStatus,
    picked_by: r.picked_by as LotPicker,
    opens_at: r.opens_at,
    ends_at: r.ends_at,
    extended: r.extended,
    channel: r.channel,
    message_id: r.message_id,
    winner_bid: r.winner_bid,
    price: r.price,
    name_due: r.name_due,
    call_name: r.call_name,
    previous_call_name: r.previous_call_name,
    applied_until: r.applied_until,
    note: r.note,
    created_at: r.created_at,
    closed_at: r.closed_at,
    settled_at: r.settled_at,
  };
}

function bidOf(r: BidRow): Bid {
  return {
    id: r.id,
    lot: r.lot_id,
    person: r.person_id,
    account: { platform: r.platform, id: r.account_id },
    name: r.name,
    amount: r.amount,
    hold: r.hold,
    status: r.status as BidStatus,
    created_at: r.created_at,
    released_at: r.released_at,
  };
}

function weekOf(r: WeekRow): LotteryWeek {
  return {
    week: r.week,
    status: r.status as WeekStatus,
    draw_at: r.draw_at,
    tickets: r.tickets,
    buyers: r.buyers,
    pot: r.pot,
    prize: r.prize,
    burned: r.burned,
    winner:
      r.winner_person !== null && r.winner_platform !== null && r.winner_account_id !== null
        ? {
            person: r.winner_person,
            account: { platform: r.winner_platform, id: r.winner_account_id },
            name: r.winner_name ?? "",
            tickets: r.winner_tickets ?? 0,
          }
        : null,
    pick: r.pick,
    drawn_at: r.drawn_at,
    paid_at: r.paid_at,
    announced_at: r.announced_at,
    notice_message: r.notice_message,
    notice_at: r.notice_at,
  };
}

function ticketOf(r: TicketRow): Ticket {
  return {
    id: r.id,
    week: r.week,
    person: r.person_id,
    account: { platform: r.platform, id: r.account_id },
    name: r.name,
    key: r.purchase_key,
    count: r.count,
    amount: r.amount,
    status: r.status as TicketStatus,
    created_at: r.created_at,
    refunded_at: r.refunded_at,
  };
}

/** What a lot row may change once it is made. */
export type LotPatch = Partial<
  Pick<
    LotRow,
    | "status"
    | "ends_at"
    | "extended"
    | "message_id"
    | "winner_bid"
    | "price"
    | "name_due"
    | "call_name"
    | "previous_call_name"
    | "applied_until"
    | "closed_at"
    | "settled_at"
    | "note"
  >
>;

/** What a lottery week may change. */
export type WeekPatch = Partial<Omit<WeekRow, "space_id" | "week" | "draw_at">>;

/** A new lot or a week's plan. */
export interface NewLot {
  id: string;
  week: number;
  kind: LotKind | null;
  status: "planned" | "skipped" | "open";
  picked_by: LotPicker;
  opens_at: number;
  ends_at: number;
  channel: string | null;
  note: string | null;
  now: number;
}

export class MarketStore {
  readonly #db: Db;
  readonly #events: EventStore;
  /** The Space of this view; `undefined`: every row (see the file comment). */
  readonly #space: string | undefined;

  constructor(db: Db, events: EventStore, space?: string) {
    this.#db = db;
    this.#events = events;
    this.#space = space;
  }

  /** The same tables as seen from one Space (identity's `spaces.id`). */
  forSpace(space: string): MarketStore {
    return new MarketStore(this.#db, this.#events, space);
  }

  /** The Space of this view; `undefined` for the view of every row. */
  get space(): string | undefined {
    return this.#space;
  }

  /** `space_id` of a row this view writes. */
  get #spaceValue(): string | null {
    return this.#space ?? null;
  }

  /** `space_id` of a draw this view reads and writes: a draw always has one (`''`: none). */
  get #drawSpace(): string {
    return this.#space ?? "";
  }

  /** The condition on `column` that keeps this view's rows; none for the view of every row. */
  #mine(column: SQLiteColumn): SQL | undefined {
    return this.#space === undefined ? undefined : eq(column, this.#space);
  }

  /** The bids of this view's lots (a bid has no Space of its own). */
  #mineBids(): SQL | undefined {
    if (this.#space === undefined) return undefined;
    return inArray(
      marketBids.lot_id,
      this.#db.orm
        .select({ id: marketLots.id })
        .from(marketLots)
        .where(eq(marketLots.space_id, this.#space)),
    );
  }

  #write<T>(fn: () => T): T {
    this.#db.ensureOpen();
    return this.#db.tx(fn);
  }

  // ---- Spaces -------------------------------------------------------------------------------

  /**
   * Gives the rows with no Space (written before there was any Space) to `space`, the primary;
   * how many. A draw of a week the primary already has keeps its `''` (nothing is overwritten).
   */
  adopt(space: string): number {
    return this.#write(() => {
      let n = 0;
      for (const table of ["market_lots", "market_lottery_tickets", "market_song_tickets"]) {
        n += this.#db.run(`UPDATE ${table} SET space_id = $space WHERE space_id IS NULL`, {
          space,
        });
      }
      n += this.#db.run(
        "UPDATE OR IGNORE market_lottery_draws SET space_id = $space WHERE space_id = ''",
        { space },
      );
      return n;
    });
  }

  /** The Spaces with a lot, a draw or a purchase not settled yet (a Space she left, too). */
  unsettledSpaces(): string[] {
    this.#db.ensureOpen();
    const rows = this.#db.all(
      `SELECT space_id FROM market_lots
         WHERE status IN ('open', 'closing', 'naming', 'applied') AND space_id IS NOT NULL
       UNION
       SELECT space_id FROM market_lottery_draws
         WHERE status IN ('open', 'drawing', 'refunding') OR announced_at IS NULL`,
    );
    return rows.map((r) => String(r.space_id)).filter((s) => s !== "");
  }

  // ---- lots ---------------------------------------------------------------------------------

  lot(id: string): Lot | null {
    this.#db.ensureOpen();
    const row = this.#db.orm
      .select()
      .from(marketLots)
      .where(and(eq(marketLots.id, id), this.#mine(marketLots.space_id)))
      .get();
    return row === undefined ? null : lotOf(row);
  }

  lotOfWeek(week: number): Lot | null {
    this.#db.ensureOpen();
    const row = this.#db.orm
      .select()
      .from(marketLots)
      .where(and(eq(marketLots.week, week), this.#mine(marketLots.space_id)))
      .get();
    return row === undefined ? null : lotOf(row);
  }

  /** Lots in any of `statuses`, oldest first. */
  lotsIn(statuses: readonly LotStatus[]): Lot[] {
    this.#db.ensureOpen();
    return this.#db.orm
      .select()
      .from(marketLots)
      .where(and(inArray(marketLots.status, [...statuses]), this.#mine(marketLots.space_id)))
      .orderBy(asc(marketLots.week))
      .all()
      .map(lotOf);
  }

  /** The lots that ran (not plans), newest first. */
  history(limit: number): Lot[] {
    this.#db.ensureOpen();
    return this.#db.orm
      .select()
      .from(marketLots)
      .where(
        and(
          ne(marketLots.status, "planned"),
          ne(marketLots.status, "skipped"),
          this.#mine(marketLots.space_id),
        ),
      )
      .orderBy(desc(marketLots.week))
      .limit(limit)
      .all()
      .map(lotOf);
  }

  /** The kinds of the latest lots that ran, newest first. */
  recentKinds(limit: number): LotKind[] {
    return this.history(limit)
      .map((l) => l.kind)
      .filter((k): k is LotKind => k !== null);
  }

  /**
   * Writes `lot` for its week: a plan replaces a plan or a skip; an opening opens a plan of the
   * week (keeping the planned kind's row) or makes the row. `null` when the week already has a
   * lot that is more than a plan (or a skip, for an opening).
   */
  putLot(lot: NewLot): Lot | null {
    return this.#write(() => {
      const L = marketLots;
      const found = this.#db.orm
        .select()
        .from(L)
        .where(and(eq(L.week, lot.week), this.#mine(L.space_id)))
        .get();
      const values = {
        kind: lot.kind,
        status: lot.status,
        picked_by: lot.picked_by,
        opens_at: at(lot.opens_at),
        ends_at: at(lot.ends_at),
        channel: lot.channel,
        note: lot.note,
      };
      if (found === undefined) {
        this.#db.orm
          .insert(L)
          .values({
            id: lot.id,
            week: lot.week,
            space_id: this.#spaceValue,
            created_at: at(lot.now),
            ...values,
          })
          .run();
        return this.lot(lot.id);
      }
      const replaceable =
        lot.status === "open"
          ? found.status === "planned"
          : ["planned", "skipped"].includes(found.status);
      if (!replaceable) return null;
      this.#db.orm.update(L).set(values).where(eq(L.id, found.id)).run();
      return this.lot(found.id);
    });
  }

  /** Changes a lot while it is in one of `from`; whether it was. */
  setLot(id: string, from: readonly LotStatus[], patch: LotPatch): boolean {
    return this.#write(
      () =>
        Number(
          this.#db.orm
            .update(marketLots)
            .set(patch)
            .where(and(eq(marketLots.id, id), inArray(marketLots.status, [...from])))
            .run().changes,
        ) > 0,
    );
  }

  /**
   * Closes the open lot `id`: its winning bid and price (or none), status `closing` (a winner) or
   * `done`, and its `market.lot_closed` event. Whether it was open.
   */
  closeLot(id: string, now: number, data: LotClosedData): boolean {
    return this.#write(() => {
      const winner = data.winner_bid;
      const changed = this.setLot(id, ["open"], {
        status: winner === null ? "done" : "closing",
        winner_bid: winner,
        price: data.price,
        closed_at: at(now),
        ...(winner === null ? { settled_at: at(now) } : {}),
      });
      if (changed) this.#events.appendNow(lotClosedWrite(data, at(now)));
      return changed;
    });
  }

  // ---- bids ---------------------------------------------------------------------------------

  bid(id: string): Bid | null {
    this.#db.ensureOpen();
    const row = this.#db.orm.select().from(marketBids).where(eq(marketBids.id, id)).get();
    return row === undefined ? null : bidOf(row);
  }

  /** The bids of a lot, oldest first. */
  bids(lot: string): Bid[] {
    this.#db.ensureOpen();
    return this.#db.orm
      .select()
      .from(marketBids)
      .where(eq(marketBids.lot_id, lot))
      .orderBy(asc(marketBids.created_at), asc(marketBids.id))
      .all()
      .map(bidOf);
  }

  /** The leader's rows of a lot (their holds add up to the top bid). */
  leading(lot: string): Bid[] {
    return this.bids(lot).filter((b) => b.status === "leading");
  }

  addBid(bid: Omit<Bid, "status" | "released_at" | "created_at">, now: number): void {
    this.#write(() => {
      this.#db.orm
        .insert(marketBids)
        .values({
          id: bid.id,
          lot_id: bid.lot,
          person_id: bid.person,
          platform: bid.account.platform,
          account_id: bid.account.id,
          name: bid.name,
          amount: bid.amount,
          hold: bid.hold,
          status: "pending",
          created_at: at(now),
        })
        .run();
    });
  }

  /**
   * The pending bid `id` now leads: the other bidders' leading rows are outbid (their holds go
   * back after), the lot's end moves to `endsAt` when given. The rows outbid.
   */
  lead(id: string, endsAt: number | null): Bid[] {
    return this.#write(() => {
      const bid = this.bid(id);
      if (bid === null || bid.status !== "pending") return [];
      const outbid = this.leading(bid.lot).filter((b) => b.person !== bid.person);
      if (outbid.length > 0) {
        this.#db.orm
          .update(marketBids)
          .set({ status: "outbid" })
          .where(
            inArray(
              marketBids.id,
              outbid.map((b) => b.id),
            ),
          )
          .run();
      }
      this.#db.orm.update(marketBids).set({ status: "leading" }).where(eq(marketBids.id, id)).run();
      if (endsAt !== null) {
        this.#db.orm
          .update(marketLots)
          .set({ ends_at: at(endsAt), extended: true })
          .where(eq(marketLots.id, bid.lot))
          .run();
      }
      return outbid.map((b) => ({ ...b, status: "outbid" as const }));
    });
  }

  setBid(id: string, patch: { status?: BidStatus; released_at?: number }): void {
    this.#write(() => {
      this.#db.orm
        .update(marketBids)
        .set({
          ...(patch.status === undefined ? {} : { status: patch.status }),
          ...(patch.released_at === undefined ? {} : { released_at: at(patch.released_at) }),
        })
        .where(eq(marketBids.id, id))
        .run();
    });
  }

  /** Holds still out on bids that no longer stand (outbid, void, or of a lot that ended without them). */
  unreleased(): Bid[] {
    this.#db.ensureOpen();
    return this.#db.orm
      .select()
      .from(marketBids)
      .where(
        and(
          inArray(marketBids.status, ["outbid", "void"]),
          isNull(marketBids.released_at),
          sql`${marketBids.hold} > 0`,
          this.#mineBids(),
        ),
      )
      .orderBy(asc(marketBids.created_at))
      .all()
      .map(bidOf);
  }

  /** Bids still `pending` that were made before `before` (epoch ms). */
  stalePending(before: number): Bid[] {
    this.#db.ensureOpen();
    return this.#db.orm
      .select()
      .from(marketBids)
      .where(
        and(
          eq(marketBids.status, "pending"),
          lte(marketBids.created_at, at(before)),
          this.#mineBids(),
        ),
      )
      .all()
      .map(bidOf);
  }

  // ---- the lottery --------------------------------------------------------------------------

  week(week: number): LotteryWeek | null {
    this.#db.ensureOpen();
    const D = marketLotteryDraws;
    const row = this.#db.orm
      .select()
      .from(D)
      .where(and(eq(D.space_id, this.#drawSpace), eq(D.week, week)))
      .get();
    return row === undefined ? null : weekOf(row);
  }

  /** The week drawn at `drawAt` (`week` is its local day), made open when it is not there. */
  ensureWeek(week: number, drawAt: number): LotteryWeek {
    return this.#write(() => {
      this.#db.orm
        .insert(marketLotteryDraws)
        .values({ space_id: this.#drawSpace, week, status: "open", draw_at: at(drawAt) })
        .onConflictDoNothing()
        .run();
      return this.week(week) as LotteryWeek;
    });
  }

  weeksIn(statuses: readonly WeekStatus[]): LotteryWeek[] {
    this.#db.ensureOpen();
    const D = marketLotteryDraws;
    return this.#db.orm
      .select()
      .from(D)
      .where(and(eq(D.space_id, this.#drawSpace), inArray(D.status, [...statuses])))
      .orderBy(asc(D.week))
      .all()
      .map(weekOf);
  }

  /** The weeks that were drawn or refunded, newest first. */
  pastWeeks(limit: number): LotteryWeek[] {
    this.#db.ensureOpen();
    const D = marketLotteryDraws;
    return this.#db.orm
      .select()
      .from(D)
      .where(
        and(
          eq(D.space_id, this.#drawSpace),
          inArray(D.status, ["drawn", "refunded", "drawing", "refunding"]),
        ),
      )
      .orderBy(desc(D.week))
      .limit(limit)
      .all()
      .map(weekOf);
  }

  /** Changes a week while it is in one of `from`; whether it was. */
  setWeek(week: number, from: readonly WeekStatus[], patch: WeekPatch): boolean {
    const D = marketLotteryDraws;
    return this.#write(
      () =>
        Number(
          this.#db.orm
            .update(D)
            .set(patch)
            .where(
              and(eq(D.space_id, this.#drawSpace), eq(D.week, week), inArray(D.status, [...from])),
            )
            .run().changes,
        ) > 0,
    );
  }

  /** Moves a week to `drawn` or `refunded` with its event, once; whether it moved. */
  finishWeek(week: number, from: WeekStatus, patch: WeekPatch, data: LotteryDrawnData): boolean {
    return this.#write(() => {
      const moved = this.setWeek(week, [from], patch);
      if (moved && patch.drawn_at !== undefined && patch.drawn_at !== null) {
        this.#events.appendNow(lotteryDrawnWrite(data, patch.drawn_at));
      }
      return moved;
    });
  }

  tickets(week: number, statuses: readonly TicketStatus[] = ["paid"]): Ticket[] {
    this.#db.ensureOpen();
    const T = marketLotteryTickets;
    return this.#db.orm
      .select()
      .from(T)
      .where(and(eq(T.week, week), inArray(T.status, [...statuses]), this.#mine(T.space_id)))
      .orderBy(asc(T.created_at), asc(T.id))
      .all()
      .map(ticketOf);
  }

  ticketByKey(person: PersonId, key: string): Ticket | null {
    this.#db.ensureOpen();
    const T = marketLotteryTickets;
    const row = this.#db.orm
      .select()
      .from(T)
      .where(and(eq(T.person_id, person), eq(T.purchase_key, key)))
      .get();
    return row === undefined ? null : ticketOf(row);
  }

  /** Tickets a person holds in a week, pending ones counted. */
  ticketCount(week: number, person: PersonId): number {
    this.#db.ensureOpen();
    const T = marketLotteryTickets;
    const row = this.#db.orm
      .select({ n: sql<number>`COALESCE(SUM(${T.count}), 0)` })
      .from(T)
      .where(
        and(
          eq(T.week, week),
          eq(T.person_id, person),
          inArray(T.status, ["pending", "paid"]),
          this.#mine(T.space_id),
        ),
      )
      .get();
    return Number(row?.n ?? 0);
  }

  /**
   * A purchase being charged (`pending`), unless it would take the person over `cap` tickets in
   * the week: then `null`, nothing written.
   */
  addTicket(
    t: Omit<Ticket, "status" | "created_at" | "refunded_at">,
    cap: number,
    now: number,
  ): Ticket | null {
    return this.#write(() => {
      if (this.ticketCount(t.week, t.person) + t.count > cap) return null;
      this.#db.orm
        .insert(marketLotteryTickets)
        .values({
          id: t.id,
          week: t.week,
          space_id: this.#spaceValue,
          person_id: t.person,
          platform: t.account.platform,
          account_id: t.account.id,
          name: t.name,
          purchase_key: t.key,
          count: t.count,
          amount: t.amount,
          status: "pending",
          created_at: at(now),
        })
        .run();
      return this.ticketByKey(t.person, t.key);
    });
  }

  setTicket(id: string, status: TicketStatus, now: number): void {
    this.#write(() => {
      this.#db.orm
        .update(marketLotteryTickets)
        .set({ status, ...(status === "refunded" ? { refunded_at: at(now) } : {}) })
        .where(eq(marketLotteryTickets.id, id))
        .run();
    });
  }

  /** Forgets a purchase that was never paid. */
  dropTicket(id: string): void {
    this.#write(() => {
      this.#db.orm
        .delete(marketLotteryTickets)
        .where(and(eq(marketLotteryTickets.id, id), eq(marketLotteryTickets.status, "pending")))
        .run();
    });
  }

  // ---- song priority tickets ----------------------------------------------------------------

  /**
   * A ticket about to be charged under `key` (`charging`); one already there is left alone. `space`:
   * the Space whose queue it is for (the view's own when not given).
   */
  addSongTicket(
    t: Omit<SongTicket, "status" | "created_at" | "settled_at">,
    now: number,
    space?: string | null,
  ): void {
    this.#write(() => {
      this.#db.orm
        .insert(marketSongTickets)
        .values({
          key: t.key,
          space_id: space ?? this.#spaceValue,
          person_id: t.person,
          platform: t.account.platform,
          account_id: t.account.id,
          amount: t.amount,
          status: "charging",
          created_at: at(now),
        })
        .onConflictDoNothing()
        .run();
    });
  }

  songTicket(key: string): SongTicket | null {
    this.#db.ensureOpen();
    const T = marketSongTickets;
    const row = this.#db.orm.select().from(T).where(eq(T.key, key)).get();
    return row === undefined ? null : songTicketOf(row);
  }

  /**
   * Moves the ticket of `key` to `status` when it is in one of `from`; whether it did. A ticket
   * that was used or given back stays so.
   */
  setSongTicket(
    key: string,
    status: SongTicketStatus,
    from: readonly SongTicketStatus[],
    now: number,
  ): boolean {
    return this.#write(() => {
      const T = marketSongTickets;
      const settled = status === "charged" ? {} : { settled_at: at(now) };
      const changed = this.#db.orm
        .update(T)
        .set({ status, ...settled })
        .where(and(eq(T.key, key), inArray(T.status, [...from])))
        .run().changes;
      return Number(changed) > 0;
    });
  }

  /** Tickets neither used nor given back (`charging`, `charged`) made before `before` (epoch ms). */
  openSongTickets(before: number): SongTicket[] {
    this.#db.ensureOpen();
    const T = marketSongTickets;
    return this.#db.orm
      .select()
      .from(T)
      .where(and(inArray(T.status, ["charging", "charged"]), lte(T.created_at, at(before))))
      .orderBy(asc(T.created_at))
      .all()
      .map(songTicketOf);
  }

  /** Purchases still `pending` that were made before `before` (epoch ms). */
  staleTickets(before: number): Ticket[] {
    this.#db.ensureOpen();
    const T = marketLotteryTickets;
    return this.#db.orm
      .select()
      .from(T)
      .where(and(eq(T.status, "pending"), lte(T.created_at, at(before)), this.#mine(T.space_id)))
      .all()
      .map(ticketOf);
  }

  // ---- people -------------------------------------------------------------------------------

  /** Moves `absorb`'s bids and tickets to `keep` (one person turned out to be two accounts). */
  merge(keep: PersonId, absorb: PersonId): PersonHookResult {
    if (keep === absorb) return { counts: {} };
    return this.#write((): PersonHookResult => {
      const bids = Number(
        this.#db.orm
          .update(marketBids)
          .set({ person_id: keep })
          .where(eq(marketBids.person_id, absorb))
          .run().changes,
      );
      // A purchase key is a retry's; the merged ones get one nobody will ask for.
      const tickets = Number(
        this.#db.orm
          .update(marketLotteryTickets)
          .set({
            person_id: keep,
            purchase_key: sql`'merged:' || ${marketLotteryTickets.id}`,
          })
          .where(eq(marketLotteryTickets.person_id, absorb))
          .run().changes,
      );
      // The draws per Space; the weeks of before them are a record that is no longer written.
      const winners = Number(
        this.#db.orm
          .update(marketLotteryDraws)
          .set({ winner_person: keep })
          .where(eq(marketLotteryDraws.winner_person, absorb))
          .run().changes,
      );
      const songs = Number(
        this.#db.orm
          .update(marketSongTickets)
          .set({ person_id: keep })
          .where(eq(marketSongTickets.person_id, absorb))
          .run().changes,
      );
      return {
        counts: {
          market_bids: bids,
          market_lottery_tickets: tickets,
          winners,
          market_song_tickets: songs,
        },
      };
    });
  }
}

// ---- the plugin -----------------------------------------------------------------------------

/** What people bid and bought is part of their coins, kept with the ledger. */
const marketData: readonly CategoryData[] = [
  {
    category: "relationships",
    parts: [
      tablePart("market_lots", "market_lots", "node", "created_at", "week", {
        id: "text",
        week: "num",
        space_id: "text",
        kind: "text",
        status: "text",
        picked_by: "text",
        opens_at: "ts",
        ends_at: "ts",
        extended: "bool",
        channel: "text",
        message_id: "text",
        winner_bid: "text",
        price: "num",
        name_due: "ts",
        call_name: "text",
        previous_call_name: "text",
        applied_until: "ts",
        note: "text",
        created_at: "ts",
        closed_at: "ts",
        settled_at: "ts",
      }),
      tablePart("market_bids", "market_bids", "node", "created_at", "created_at, id", {
        id: "text",
        lot_id: "text",
        person_id: "text",
        platform: "text",
        account_id: "text",
        name: "text",
        amount: "num",
        hold: "num",
        status: "text",
        created_at: "ts",
        released_at: "ts",
      }),
      tablePart(
        "market_lottery_draws",
        "market_lottery_draws",
        "node",
        "draw_at",
        "space_id, week",
        {
          space_id: "text",
          week: "num",
          status: "text",
          draw_at: "ts",
          tickets: "num",
          buyers: "num",
          pot: "num",
          prize: "num",
          burned: "num",
          winner_person: "text",
          winner_platform: "text",
          winner_account_id: "text",
          winner_name: "text",
          winner_tickets: "num",
          pick: "num",
          drawn_at: "ts",
          paid_at: "ts",
          announced_at: "ts",
          notice_message: "text",
          notice_at: "ts",
        },
      ),
      tablePart("market_lottery_weeks", "market_lottery_weeks", "node", "draw_at", "week", {
        week: "num",
        status: "text",
        draw_at: "ts",
        tickets: "num",
        buyers: "num",
        pot: "num",
        prize: "num",
        burned: "num",
        winner_person: "text",
        winner_platform: "text",
        winner_account_id: "text",
        winner_name: "text",
        winner_tickets: "num",
        pick: "num",
        drawn_at: "ts",
        paid_at: "ts",
        announced_at: "ts",
        notice_message: "text",
        notice_at: "ts",
      }),
      tablePart(
        "market_lottery_tickets",
        "market_lottery_tickets",
        "node",
        "created_at",
        "created_at, id",
        {
          id: "text",
          week: "num",
          space_id: "text",
          person_id: "text",
          platform: "text",
          account_id: "text",
          name: "text",
          purchase_key: "text",
          count: "num",
          amount: "num",
          status: "text",
          created_at: "ts",
          refunded_at: "ts",
        },
      ),
      tablePart(
        "market_song_tickets",
        "market_song_tickets",
        "node",
        "created_at",
        "created_at, key",
        {
          key: "text",
          space_id: "text",
          person_id: "text",
          platform: "text",
          account_id: "text",
          amount: "num",
          status: "text",
          created_at: "ts",
          settled_at: "ts",
        },
      ),
    ],
  },
];

/** The `market` plugin's tables and code (`StorePlugin`). */
export const marketTables: StorePlugin<MarketStore> = {
  schema: marketSchema,
  open: ({ db, events }) => new MarketStore(db, events),
  data: marketData,
  // Money is kept (v5-data §2.5), like the ledger the coins are in.
  forgetPerson: () => declined("bids and lottery tickets are money records and are kept"),
  mergePerson: (opened, { keep, absorb }: PersonMerge) => opened.merge(keep, absorb),
};
