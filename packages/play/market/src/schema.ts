// The tables of the `market` plugin (docs/design/v5-play.md §11.4), as Drizzle definitions:
// `migrations.ts` holds the SQL drizzle-kit generates from them, `STRICT` added, and the store's
// drift test (`packages/store/test/drizzle-schemas.test.ts`) keeps the two together.
//
// - `market_lots`: one row per auction week (the local day it opens): what is sold, who picked it,
//   when it opens and ends, the winning bid and what became of the lot. A week the owner set or
//   skipped ahead is a `planned` or `skipped` row.
// - `market_bids`: every bid, with the coins its row holds (a raise holds only the difference) and
//   when they went back.
// - `market_lottery_draws` (version 3): one row per Space and draw (the local day it is drawn): the
//   totals, the winner and the draw itself, and the week's notice.
// - `market_lottery_weeks`: the draws of before version 3, one per week for the one server there
//   was. Copied into `market_lottery_draws` (the primary Space's) by version 3, then never read or
//   written again; it stays as it was.
// - `market_lottery_tickets`: one row per purchase, `pending` until it is paid.
// - `market_song_tickets` (version 2): one row per song priority ticket, written before the wallet
//   is asked, until the song is sung (`consumed`) or the ticket is given back (`refunded`).
//
// Every row of a Space carries its `space_id` (identity's `spaces.id`, version 3). A row from before
// version 3 got its Space then: a lot from its channel's room, anything else the primary Space's;
// `null` (or `''` for a draw) only when the database had no Space yet, and the module gives those
// to the primary Space once there is one. No foreign key to `spaces` or `persons`: the rows are
// money records and stay whatever happens to a Space or a person.

import { micros } from "@miyoria/store";
import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const marketLots = sqliteTable(
  "market_lots",
  {
    id: text().primaryKey(),
    /** The local day number the lot opens on. */
    week: integer().notNull(),
    /** The Space it runs in (version 3). */
    space_id: text(),
    /** `call_name`, `frame`; `null` for a week the owner skipped. */
    kind: text(),
    status: text().notNull(),
    /** `owner`, `her`, `rotation`. */
    picked_by: text().notNull(),
    opens_at: micros().notNull(),
    ends_at: micros().notNull(),
    /** A bid near the end moved `ends_at`. */
    extended: integer({ mode: "boolean" }).notNull().default(false),
    /** The channel it is posted in, and its message. */
    channel: text(),
    message_id: text(),
    /** The bid that won, and the price. */
    winner_bid: text(),
    price: integer(),
    /** A name lot: until when the winner may give a name, the accepted one, the one it replaced. */
    name_due: micros(),
    call_name: text(),
    previous_call_name: text(),
    /** A name lot: the name is hers to use until then. */
    applied_until: micros(),
    /** Why she picked it, or the owner's note. */
    note: text(),
    created_at: micros().notNull(),
    closed_at: micros(),
    settled_at: micros(),
  },
  (t) => [
    uniqueIndex("market_lots_space_week_idx").on(t.space_id, t.week),
    index("market_lots_status_idx").on(t.status, t.ends_at),
    check(
      "market_lots_status_check",
      sql`${t.status} IN ('planned', 'skipped', 'open', 'closing', 'naming', 'applied', 'done', 'refunded', 'cancelled')`,
    ),
    check("market_lots_kind_check", sql`${t.kind} IS NULL OR ${t.kind} IN ('call_name', 'frame')`),
    check("market_lots_picked_by_check", sql`${t.picked_by} IN ('owner', 'her', 'rotation')`),
  ],
);

export const marketBids = sqliteTable(
  "market_bids",
  {
    id: text().primaryKey(),
    lot_id: text().notNull(),
    person_id: text().notNull(),
    /** The account that bid (what the coins are moved through). */
    platform: text().notNull(),
    account_id: text().notNull(),
    /** Their display name when they bid (untrusted). */
    name: text().notNull(),
    /** The bid. */
    amount: integer().notNull(),
    /** The coins this row holds: the bid, or a raise of one's own bid by the difference. */
    hold: integer().notNull(),
    /** `pending` (holding), `leading`, `outbid`, `won`, `void` (the hold never stood). */
    status: text().notNull(),
    created_at: micros().notNull(),
    /** When the hold went back (the winner's too, after the price was burned). */
    released_at: micros(),
  },
  (t) => [
    index("market_bids_lot_idx").on(t.lot_id, t.created_at),
    index("market_bids_status_idx").on(t.status, t.released_at),
    check(
      "market_bids_status_check",
      sql`${t.status} IN ('pending', 'leading', 'outbid', 'won', 'void')`,
    ),
    check("market_bids_amount_check", sql`${t.amount} > 0 AND ${t.hold} >= 0`),
  ],
);

/** The columns of a draw, shared by the legacy weeks and the draws per Space. */
const drawColumns = () => ({
  /** `open`, `drawing` (winner picked, prize not paid yet), `drawn`, `refunding`, `refunded`. */
  status: text().notNull(),
  draw_at: micros().notNull(),
  tickets: integer().notNull().default(0),
  buyers: integer().notNull().default(0),
  pot: integer().notNull().default(0),
  prize: integer().notNull().default(0),
  burned: integer().notNull().default(0),
  winner_person: text(),
  winner_platform: text(),
  winner_account_id: text(),
  winner_name: text(),
  winner_tickets: integer(),
  /** The winning ticket's index in the week's tickets (the system CSPRNG drew it). */
  pick: integer(),
  drawn_at: micros(),
  paid_at: micros(),
  announced_at: micros(),
  /** The week's notice with its buy button. */
  notice_message: text(),
  notice_at: micros(),
});

/** The draws per Space (version 3): what the lottery reads and writes. */
export const marketLotteryDraws = sqliteTable(
  "market_lottery_draws",
  {
    /** The Space it is drawn in; `''` for a draw of before there was any Space. */
    space_id: text().notNull(),
    /** The local day number it is drawn on. */
    week: integer().notNull(),
    ...drawColumns(),
  },
  (t) => [
    primaryKey({ name: "market_lottery_draws_pk", columns: [t.space_id, t.week] }),
    index("market_lottery_draws_status_idx").on(t.status, t.draw_at),
    check(
      "market_lottery_draws_status_check",
      sql`${t.status} IN ('open', 'drawing', 'drawn', 'refunding', 'refunded')`,
    ),
  ],
);

/** The draws of before version 3 (one server): copied into `market_lottery_draws`, kept, unused. */
export const marketLotteryWeeks = sqliteTable(
  "market_lottery_weeks",
  {
    /** The local day number it is drawn on. */
    week: integer().primaryKey(),
    /** `open`, `drawing` (winner picked, prize not paid yet), `drawn`, `refunding`, `refunded`. */
    status: text().notNull(),
    draw_at: micros().notNull(),
    tickets: integer().notNull().default(0),
    buyers: integer().notNull().default(0),
    pot: integer().notNull().default(0),
    prize: integer().notNull().default(0),
    burned: integer().notNull().default(0),
    winner_person: text(),
    winner_platform: text(),
    winner_account_id: text(),
    winner_name: text(),
    winner_tickets: integer(),
    /** The winning ticket's index in the week's tickets (the system CSPRNG drew it). */
    pick: integer(),
    drawn_at: micros(),
    paid_at: micros(),
    announced_at: micros(),
    /** The week's notice with its buy button. */
    notice_message: text(),
    notice_at: micros(),
  },
  (t) => [
    index("market_lottery_weeks_status_idx").on(t.status, t.draw_at),
    check(
      "market_lottery_weeks_status_check",
      sql`${t.status} IN ('open', 'drawing', 'drawn', 'refunding', 'refunded')`,
    ),
  ],
);

export const marketLotteryTickets = sqliteTable(
  "market_lottery_tickets",
  {
    id: text().primaryKey(),
    week: integer().notNull(),
    /** The Space whose draw it is in (version 3). */
    space_id: text(),
    person_id: text().notNull(),
    platform: text().notNull(),
    account_id: text().notNull(),
    name: text().notNull(),
    /** The purchase's key (a retry is the same purchase). */
    purchase_key: text().notNull(),
    count: integer().notNull(),
    amount: integer().notNull(),
    /** `pending` (being charged), `paid`, `refunded`. */
    status: text().notNull(),
    created_at: micros().notNull(),
    refunded_at: micros(),
  },
  (t) => [
    uniqueIndex("market_lottery_tickets_key_idx").on(t.person_id, t.purchase_key),
    index("market_lottery_tickets_week_idx").on(t.week, t.status),
    check(
      "market_lottery_tickets_status_check",
      sql`${t.status} IN ('pending', 'paid', 'refunded')`,
    ),
    check("market_lottery_tickets_count_check", sql`${t.count} > 0 AND ${t.amount} >= 0`),
  ],
);

export const marketSongTickets = sqliteTable(
  "market_song_tickets",
  {
    /** The key it was charged under (the singer's `song:<uuid>`), the ledger row's key too. */
    key: text().primaryKey(),
    /**
     * The Space whose request queue it is used in (version 3); price and the daily limit are
     * everyone's, across Spaces.
     */
    space_id: text(),
    person_id: text().notNull(),
    platform: text().notNull(),
    account_id: text().notNull(),
    amount: integer().notNull(),
    /**
     * `charging` (the wallet is asked), `charged`, `void` (it was not charged), `consumed` (the
     * song started being sung), `refunded`.
     */
    status: text().notNull(),
    created_at: micros().notNull(),
    /** When it became `void`, `consumed` or `refunded`. */
    settled_at: micros(),
  },
  (t) => [
    index("market_song_tickets_status_idx").on(t.status, t.created_at),
    check(
      "market_song_tickets_status_check",
      sql`${t.status} IN ('charging', 'charged', 'void', 'consumed', 'refunded')`,
    ),
    check("market_song_tickets_amount_check", sql`${t.amount} >= 0`),
  ],
);
