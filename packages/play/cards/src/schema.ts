// The tables of the `cards` plugin (docs/design/v5-play.md §2, §6.3), as Drizzle definitions:
// `migrations.ts` holds the SQL drizzle-kit generates from them, `STRICT` added, with the catalogue
// of `catalogue.ts` seeded after it by hand, and the store's drift test
// (`packages/store/test/drizzle-schemas.test.ts`) keeps the two together.
//
// - `cards_card`: one row per card. The drawn parts, her expression, foil and the pose's seed are a
//   snapshot (`parts`), as are the words on it (`face`) and the relationship it shows
//   (`relationship`, words only, never the raw bond); `artifact_id` is its picture once rendered.
// - `cards_parts`: the catalogue a draw picks from (`catalogue.ts`).
// - `cards_pity`: per person, cards in a row without an SR-or-better part.
// - `cards_dex`: per person and part, when it was first drawn, on which card, and how often.
// - `cards_wishlist`: per person, at most three parts (`position` 1..3).
// - `cards_titles`: per person, the series they completed and the title it gave; private unless
//   they make it public.
// - `cards_tally`: what the day's limits count, kept apart from the cards so a forget resets none.
//
// No foreign key to `persons`, like the heart's tables: forgetting a person deletes their rows
// through the plugin's hook (`store.ts`).

import { accounts, micros } from "@miyoria/store";
import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import type { DrawSnapshot } from "./draw.js";

export const cardsParts = sqliteTable(
  "cards_parts",
  {
    /** `<slot>.<name>`. */
    id: text().primaryKey(),
    slot: text().notNull(),
    rarity: text().notNull(),
    series: text(),
    name: text().notNull(),
    weight: real().notNull().default(1),
    enabled: integer({ mode: "boolean" }).notNull().default(true),
    drop_only: integer({ mode: "boolean" }).notNull().default(false),
    /** "Nothing there": drawn, not collected. */
    blank: integer({ mode: "boolean" }).notNull().default(false),
  },
  (t) => [
    check(
      "cards_parts_slot_check",
      sql`${t.slot} IN ('hand', 'accessory', 'outfit', 'pose', 'background')`,
    ),
    check("cards_parts_rarity_check", sql`${t.rarity} IN ('N', 'R', 'SR', 'SSR')`),
    check("cards_parts_weight_check", sql`${t.weight} > 0`),
  ],
);

export const cardsCard = sqliteTable(
  "cards_card",
  {
    /** `MYR-XXXX-XXXX-XXXX`. */
    serial: text().primaryKey(),
    person_id: text().notNull(),
    kind: text().notNull(),
    rarity: text().notNull(),
    parts: text({ mode: "json" }).$type<DrawSnapshot>().notNull(),
    face: text({ mode: "json" }).$type<Record<string, unknown>>().notNull().default({}),
    relationship: text({ mode: "json" }).$type<Record<string, unknown>>().notNull().default({}),
    artifact_id: text(),
    /** Coins it cost. */
    price: integer().notNull().default(0),
    pity_hit: integer({ mode: "boolean" }).notNull().default(false),
    /** Wished parts it has. */
    wished: text({ mode: "json" }).$type<string[]>().notNull().default([]),
    /** Its frame (a cosmetic the person chose), `null`: none. */
    frame: text(),
    created_at: micros().notNull(),
    /**
     * What it was issued for, once per person (`store.ts` `issueKey`): a milestone's tier, the
     * keepsake. `null`: a card that needs no such key.
     */
    issue_key: text(),
  },
  (t) => [
    index("cards_card_person_idx").on(t.person_id, t.created_at),
    index("cards_card_day_idx").on(t.person_id, t.kind, t.created_at),
    uniqueIndex("cards_card_key_idx").on(t.person_id, t.issue_key),
    check("cards_card_kind_check", sql`${t.kind} IN ('daily', 'milestone', 'keepsake', 'drop')`),
    check("cards_card_rarity_check", sql`${t.rarity} IN ('N', 'R', 'SR', 'SSR')`),
    check("cards_card_price_check", sql`${t.price} >= 0`),
  ],
);

export const cardsPity = sqliteTable(
  "cards_pity",
  {
    person_id: text().primaryKey(),
    since: integer().notNull().default(0),
    drawn: integer().notNull().default(0),
    updated_at: micros().notNull(),
  },
  (t) => [check("cards_pity_check", sql`${t.since} >= 0 AND ${t.drawn} >= 0`)],
);

export const cardsDex = sqliteTable(
  "cards_dex",
  {
    person_id: text().notNull(),
    part_id: text()
      .notNull()
      .references(() => cardsParts.id),
    first_at: micros().notNull(),
    first_card: text(),
    count: integer().notNull().default(1),
  },
  (t) => [
    primaryKey({ name: "cards_dex_pk", columns: [t.person_id, t.part_id] }),
    check("cards_dex_count_check", sql`${t.count} >= 1`),
  ],
);

export const cardsWishlist = sqliteTable(
  "cards_wishlist",
  {
    person_id: text().notNull(),
    part_id: text()
      .notNull()
      .references(() => cardsParts.id),
    position: integer().notNull(),
    added_at: micros().notNull(),
  },
  (t) => [
    primaryKey({ name: "cards_wishlist_pk", columns: [t.person_id, t.part_id] }),
    uniqueIndex("cards_wishlist_position_idx").on(t.person_id, t.position),
    check("cards_wishlist_position_check", sql`${t.position} BETWEEN 1 AND 3`),
  ],
);

export const cardsTitles = sqliteTable(
  "cards_titles",
  {
    person_id: text().notNull(),
    series: text().notNull(),
    title: text().notNull(),
    card: text(),
    public: integer({ mode: "boolean" }).notNull().default(false),
    earned_at: micros().notNull(),
  },
  (t) => [primaryKey({ name: "cards_titles_pk", columns: [t.person_id, t.series] })],
);

/**
 * The collectibles of the old "draw a collectible" (`economy_docs` of kind `item`), copied once
 * and kept as they were: the dex shows them as the closed 舊收藏 series. Keyed by the account that
 * owned them, as they were; whose they are is the account's person at the time they are read.
 */
export const cardsLegacy = sqliteTable(
  "cards_legacy",
  {
    /** The old document's id. */
    id: text().primaryKey(),
    account_id: text()
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    /** The old collectible's id (`glasses_black`). */
    item: text().notNull(),
    name: text().notNull(),
    rarity: text().notNull(),
    /** The old series' name; `null`: none known. */
    series: text(),
    /** `draw`, `shop`, `card` or `gift`, as the old album had it. */
    source: text().notNull(),
    acquired_at: micros().notNull(),
  },
  (t) => [index("cards_legacy_account_idx").on(t.account_id, t.acquired_at)],
);

/**
 * A card she dropped in a channel (docs/design/v5-play.md §6.2): the first person to pick it up
 * before it expires gets it, as a card of kind `drop` (`serial`). Kept after it is picked up or
 * gone: the day's drops of a channel, and who picked up the last one, are counted from here.
 */
export const cardsDrop = sqliteTable(
  "cards_drop",
  {
    id: text().primaryKey(),
    /** The channel, as `contextKeyString` writes it. */
    channel: text().notNull(),
    created_at: micros().notNull(),
    expires_at: micros().notNull(),
    /** Who picked it up; `null`: nobody (yet). */
    claimed_by: text(),
    claimed_at: micros(),
    /** The card it became. */
    serial: text(),
  },
  (t) => [
    index("cards_drop_channel_idx").on(t.channel, t.created_at),
    index("cards_drop_claimed_idx").on(t.claimed_by),
  ],
);

/**
 * A paid card asked for under a key (a request's Idempotency-Key) and charged, not written yet:
 * the serial it is charged under, and whether a foil finish was ordered with it, so a retry after
 * a restart is the same order and pays (the wallet keys both charges by the serial) and is given
 * the same card instead of a second one. Gone once the card is written, or when no card follows
 * and the coins go back.
 */
export const cardsPending = sqliteTable(
  "cards_pending",
  {
    person_id: text().notNull(),
    issue_key: text().notNull(),
    serial: text().notNull(),
    created_at: micros().notNull(),
    foil: integer({ mode: "boolean" }).notNull().default(false),
  },
  (t) => [primaryKey({ name: "cards_pending_pk", columns: [t.person_id, t.issue_key] })],
);

/**
 * Who was given their keepsake card (§10.2 P5): one row per person, nothing else of theirs. It
 * stays when they ask her to forget them, while their cards go, so nobody is given a second one;
 * it is part of the people data category with `persons.legacy`, which makes them eligible.
 */
export const cardsKeepsake = sqliteTable("cards_keepsake", {
  person_id: text().primaryKey(),
  given_at: micros().notNull(),
});

/**
 * What the day's limits count (a daily card, a card picked up from a drop), one row per card,
 * apart from the cards: a forget deletes the cards but not these rows, so asking to be forgotten
 * gives nobody a fresh day's cards. Only the last two days are kept (`issue` drops older rows):
 * a local day is at most a day back.
 */
export const cardsTally = sqliteTable(
  "cards_tally",
  {
    person_id: text().notNull(),
    kind: text().notNull(),
    at: micros().notNull(),
  },
  (t) => [
    index("cards_tally_person_idx").on(t.person_id, t.kind, t.at),
    index("cards_tally_at_idx").on(t.at),
  ],
);

/**
 * The tiers a person was given a milestone card for (§6.1, P4), by the tier's lowest bond: kept
 * when they ask her to forget them, while the cards go (and the heart's tier floor with them), so
 * climbing back gives no second card for a tier. It goes with the relationships, as the floor does:
 * a wipe of those starts the milestones again.
 */
export const cardsMilestone = sqliteTable(
  "cards_milestone",
  {
    person_id: text().notNull(),
    tier_min: integer().notNull(),
    given_at: micros().notNull(),
  },
  (t) => [primaryKey({ name: "cards_milestone_pk", columns: [t.person_id, t.tier_min] })],
);

export type CardsCardRow = typeof cardsCard.$inferSelect;
export type CardsPartRow = typeof cardsParts.$inferSelect;
