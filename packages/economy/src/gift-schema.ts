// The tables of the `gifts` plugin (docs/design/economy.md §16), as Drizzle definitions:
// `gift-migrations.ts` holds the SQL drizzle-kit generates from them, `STRICT` added, and the
// store's drift test (`packages/store/test/drizzle-schemas.test.ts`) keeps the two together.
//
// - `gifts_requests`: one row per gift a member named, from the price they were shown to what she
//   did with it. Nothing is charged before `confirmed`; the charge is the economy ledger's `gift`
//   row (`entry_id`, keyed `gift:<id>`), given back by a `refund` row when she says no or an admin
//   refunds it. When the giver is forgotten their identity (person, account, name) is taken out;
//   the ledger keeps its rows.
// - `gifts_prices`: one row per gift name (`giftKey`): the model's estimate in NT$ (a cache, so the
//   same name costs the same for everyone, and follows the rate), or the owner's pin (coins or NT$)
//   or block, which wins over the model. Version 2 added the estimates and coin pins; the old
//   scheme's tiers were kept as pinned coin prices (`gift-migrations.ts`).
//
// No foreign key to `persons`: the rows outlive a forgotten giver (without the giver in them).

import { micros } from "@miyoria/store";
import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

const oneOf = (values: readonly string[]) => sql.raw(values.map((v) => `'${v}'`).join(","));

export const GIFT_STATUSES = [
  "pending",
  "cancelled",
  "expired",
  "rejected",
  "confirmed",
  "accepted",
  "refused",
  "refunded",
  "refund_due",
] as const;
export const PRICE_SOURCES = ["model", "pinned", "blocked"] as const;

export const giftsRequests = sqliteTable(
  "gifts_requests",
  {
    /** ULID. */
    id: text().primaryKey(),
    /** The giver's person (their wallet); `null` once they were forgotten. */
    person_id: text(),
    /** The account that asked; `null` once forgotten. */
    platform: text(),
    account_id: text(),
    /** The giver's display name when they asked; `""` once forgotten. */
    name: text().notNull(),
    /** The gift as it is shown (`giftName`) and its cache key (`giftKey`). */
    item: text().notNull(),
    item_key: text().notNull(),
    /** `food`, `drink`, `small_object`, `big_object`, `experience`; `null` when refused first. */
    kind: text(),
    /** The old scheme's tier (1-based), kept on its rows; `null` from version 2 on. */
    tier: integer(),
    price: integer().notNull().default(0),
    /** The NT$ estimate the price came from (version 2); `null` for a pin in coins or a fallback. */
    twd: integer(),
    /** `model`, `cache`, `pinned`, `fallback` or `rule` (refused before anyone was asked). */
    priced_by: text().notNull(),
    /** This ask cost a price question to the model (the daily caps count these). */
    asked_model: integer({ mode: "boolean" }).notNull().default(false),
    /** What it takes off her hunger when eaten (food and drink). */
    hunger: real().notNull().default(0),
    status: text({ enum: GIFT_STATUSES }).notNull(),
    /** Why it was refused (`GiftRefusal`), or a note. */
    reason: text(),
    /** `discord` or `web`. */
    source: text().notNull(),
    /** The asking request's key: the same key asks once. */
    request_key: text().notNull(),
    /** The ledger's `gift` row, once confirmed. */
    entry_id: text(),
    /** Her one line about it (screened); `null`: none, or taken on her behalf. */
    line: text(),
    favourite: integer({ mode: "boolean" }).notNull().default(false),
    /** `her`, `system` (she did not answer in time) or `admin`. */
    answered_by: text(),
    refunded_by: text(),
    created_at: micros().notNull(),
    /** Until when 確認 may be pressed. */
    expires_at: micros().notNull(),
    confirmed_at: micros(),
    /** Until when she may answer; then it is taken for her. */
    answer_due: micros(),
    answered_at: micros(),
    refunded_at: micros(),
  },
  (t) => [
    uniqueIndex("gifts_requests_key_idx").on(t.person_id, t.request_key),
    index("gifts_requests_person_idx").on(t.person_id, t.created_at),
    index("gifts_requests_status_idx").on(t.status, t.created_at),
    index("gifts_requests_created_idx").on(t.created_at),
    check("gifts_requests_status_check", sql`${t.status} IN (${oneOf(GIFT_STATUSES)})`),
    check("gifts_requests_price_check", sql`${t.price} >= 0 AND ${t.hunger} >= 0`),
  ],
);

export const giftsPrices = sqliteTable(
  "gifts_prices",
  {
    item_key: text().primaryKey(),
    /** The name it was first priced as. */
    item: text().notNull(),
    kind: text(),
    /** The old scheme's tier; the migration turned it into `coins`. */
    tier: integer(),
    /** The estimate (the model's) or the owner's pin, in NT$: coins follow the rate. */
    twd: integer(),
    /** The owner's pin in coins (and the old tiers), which does not follow the rate. */
    coins: integer(),
    /** A refusal the model gave (`GiftRefusal`); `null` with a tier. */
    refuse: text(),
    /** `model` (a cached answer), `pinned` (the owner's tier) or `blocked` (the owner's no). */
    source: text({ enum: PRICE_SOURCES }).notNull(),
    /** Who pinned or blocked it. */
    by: text(),
    at: micros().notNull(),
  },
  (t) => [
    index("gifts_prices_source_idx").on(t.source, t.at),
    check("gifts_prices_source_check", sql`${t.source} IN (${oneOf(PRICE_SOURCES)})`),
  ],
);

export type GiftRequestRow = typeof giftsRequests.$inferSelect;
export type GiftPriceRow = typeof giftsPrices.$inferSelect;
