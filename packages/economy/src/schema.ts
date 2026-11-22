// The tables of the `economy` plugin (docs/design/v5-data.md §3.2, §3.3), as Drizzle definitions:
// `migrations.ts` holds the SQL drizzle-kit generates from them, `STRICT` added, and the store's
// drift test (`packages/store/test/drizzle-schemas.test.ts`) keeps the two together. One database
// is one character, so no table has a profile column.
//
// - `economy_ledger`: the coins (decision D8: money stays a table with its own constraints). A
//   row is never changed; a refund is a row; a balance is a sum. Its key is the wallet: a person
//   (identity's `persons.id`) or `PURSE`, her own. A person another one absorbed keeps its rows,
//   and they are the absorbing person's wallet too (`tables.ts`). No foreign key: her purse is no
//   person, and coins never go by a cascade; a wipe deletes them as a data category.
// - `economy_wallets`: what a person chose about their wallet (the card frame, leaving the
//   sponsor board). It goes with the person.
// - `economy_fortunes`: the fortune slips she wrote on the member page (§13), at most one per
//   person per local day, by the session account it was written for.
// - `economy_bounties`: tasks she pays for out of her purse, and the account it was paid to.
// - `economy_docs`: economy 2.0's documents (predictions and bets, her room, and the collectibles
//   and commissions of before they were retired), one table, `kind` says which; by the account that owns one.
//
// Rows that name an account (identity's `accounts.id`) go with it; "a person's" are the rows of
// the person's accounts. Coins are never kept outside the ledger: these tables say what the coins
// were for and where the thing stands.

import { accounts, micros, persons, spaces } from "@miyoria/store";
import type { JsonObject } from "@miyoria/types";
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

const oneOf = (values: readonly string[]) => sql.raw(values.map((v) => `'${v}'`).join(","));

export const economyLedger = sqliteTable(
  "economy_ledger",
  {
    /** Commit order: a wallet's rows in the order they were written, never reused. */
    seq: integer().primaryKey({ autoIncrement: true }),
    /** ULID; a transfer's in row is its out row's id plus `~in` (`transfer.ts`). */
    id: text().notNull(),
    /** The wallet: a person, or `PURSE`. */
    person_id: text().notNull(),
    /** Positive: earned or refunded; negative: spent. A whole number (`STRICT`). */
    delta: integer().notNull(),
    /** `checkin`, `talked`, `voice`, `feed`, `expression`, `refund`, ... */
    reason: text().notNull(),
    /** What it is about: the food and count, the frame, her reason, the refunded row. */
    ref: text(),
    /** Counts once per wallet (a retried click, the day of a check-in); `null`: no key. */
    idem_key: text(),
    ts: micros().notNull(),
  },
  (t) => [
    uniqueIndex("economy_ledger_id_idx").on(t.id),
    // Once per person in the table; once per wallet (with the persons it absorbed) in `post`.
    uniqueIndex("economy_ledger_idem_idx").on(t.person_id, t.idem_key),
    index("economy_ledger_person_idx").on(t.person_id, t.ts),
    // Totals across everyone (what she gave today, the health table).
    index("economy_ledger_reason_idx").on(t.reason, t.ts),
  ],
);

export const economyWallets = sqliteTable("economy_wallets", {
  person_id: text()
    .primaryKey()
    .references(() => persons.id, { onDelete: "cascade" }),
  /** The card frame chosen; owning one is a `frame` row of the ledger. */
  frame: text(),
  /** When the frame was chosen; a row made only for the board is 0, the oldest. */
  updated_at: micros().notNull(),
  /** Left the sponsor board (it is opt-out). */
  off_board: integer({ mode: "boolean" }).notNull().default(false),
});

export const BOUNTY_STATUSES = ["open", "awarded", "cancelled", "expired"] as const;

export const economyFortunes = sqliteTable(
  "economy_fortunes",
  {
    /** ULID. */
    id: text().primaryKey(),
    /** The session account it was written for. */
    account_id: text()
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    person_id: text().references(() => persons.id, { onDelete: "cascade" }),
    /** The local day number (days since the epoch, at the API's UTC offset). */
    day: integer().notNull(),
    issued_at: micros().notNull(),
    /** The `fortune` row of the ledger that paid for it. */
    entry_id: text(),
    /** The slip: rank, title, poem, fields, line. */
    slip: text({ mode: "json" }).$type<JsonObject>().notNull(),
  },
  // One per account per day in the table; one per person (every account of theirs) in `put`.
  (t) => [uniqueIndex("economy_fortunes_day_idx").on(t.account_id, t.day)],
);

export const economyBounties = sqliteTable(
  "economy_bounties",
  {
    /** ULID. */
    id: text().primaryKey(),
    task: text().notNull(),
    reward: integer().notNull(),
    /** The purse's `bounty_hold` row in the ledger. */
    hold_entry: text().notNull(),
    status: text({ enum: BOUNTY_STATUSES }).notNull(),
    created_at: micros().notNull(),
    expires_at: micros().notNull(),
    closed_at: micros(),
    /** The account the reward was paid to. */
    winner_account_id: text().references(() => accounts.id, { onDelete: "set null" }),
    /**
     * The Space (identity's `spaces.id`) it was posted in, where it is shown and can be won; `null`
     * only before phase 6 found it one (economy v6 gave the old ones the primary Space).
     */
    space_id: text().references(() => spaces.id),
  },
  (t) => [
    index("economy_bounties_status_idx").on(t.status, t.created_at),
    index("economy_bounties_space_idx").on(t.space_id, t.status, t.created_at),
    check("economy_bounties_status_check", sql`${t.status} IN (${oneOf(BOUNTY_STATUSES)})`),
  ],
);

export const economyDocs = sqliteTable(
  "economy_docs",
  {
    /** `item`, `prediction`, `bet`, `commission` (retired, still kept), `room`. */
    kind: text().notNull(),
    /** ULID, or a deterministic id that makes a create idempotent. */
    id: text().notNull(),
    /** Who it belongs to; `null` for what belongs to nobody in particular. */
    owner_account_id: text().references(() => accounts.id, { onDelete: "cascade" }),
    /** Kind-specific state word (`open`, `held`, `unlocked`, ...). */
    status: text().notNull(),
    /** Starts at 1; an update only applies to the version the writer read. */
    version: integer().notNull(),
    data: text({ mode: "json" }).$type<JsonObject>().notNull(),
    created_at: micros().notNull(),
    updated_at: micros().notNull(),
    /**
     * The Space (identity's `spaces.id`) a prediction and its bets belong to: who sees it and may
     * bet. `null` for what belongs to no Space (her room, the retired kinds), and for a prediction
     * opened while she knew of no Space at all (open to everyone she knows).
     */
    space_id: text().references(() => spaces.id),
  },
  (t) => [
    primaryKey({ name: "economy_docs_pk", columns: [t.kind, t.id] }),
    index("economy_docs_space_idx").on(t.kind, t.space_id, t.created_at),
    index("economy_docs_recent_idx").on(t.kind, t.created_at, t.id),
    index("economy_docs_owner_idx").on(t.kind, t.owner_account_id, t.created_at),
  ],
);

export type LedgerRow = typeof economyLedger.$inferSelect;
export type WalletRow = typeof economyWallets.$inferSelect;
export type FortuneRow = typeof economyFortunes.$inferSelect;
export type BountyRow = typeof economyBounties.$inferSelect;
export type DocRow = typeof economyDocs.$inferSelect;
