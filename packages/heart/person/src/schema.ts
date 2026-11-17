// The tables of the `heart` plugin (docs/design/v5-heart.md §2.2), as Drizzle definitions:
// `migrations.ts` holds the SQL drizzle-kit generates from them, `STRICT` added, and the store's
// drift test (`packages/store/test/drizzle-schemas.test.ts`) keeps the two together. One database
// is one character, so no table has a profile column.
//
// - `heart_person`: one row per person, the shape of `HeartPerson` (`model.ts`): nine numbers,
//   her words about them, the tier anchors, when she last saw them and what the migration carried
//   over. Every change of a number is also one `heart.changed` event, appended in the transaction
//   that writes the row (`store.ts`); there is no delta table.
// - `heart_self`: her own emotions and drives, one JSON row, written only when it changed.
//
// No foreign key to `persons`: like the notes and the coin ledger, a row must accept a person the
// migration found in the old records that identity has not resolved; forgetting a person deletes
// their row through the plugin's hook.

import { micros } from "@miyoria/store";
import type { JsonObject } from "@miyoria/types";
import { sql } from "drizzle-orm";
import { check, index, integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";
import type { TierAnchor } from "./model.js";

export const heartPerson = sqliteTable(
  "heart_person",
  {
    /** Identity's `persons.id`. */
    person_id: text().primaryKey(),
    /** -100..1000 */
    bond: real().notNull().default(0),
    /** 0..100 */
    trust: real().notNull(),
    /** 0..100 */
    familiarity: real().notNull().default(0),
    /** -1..1 */
    warmth: real().notNull().default(0),
    /** -1..1 */
    respect: real().notNull().default(0),
    /** 0..1 */
    ease: real().notNull().default(0),
    /** 0..1 */
    grudge: real().notNull().default(0),
    /** 0..1 */
    longing: real().notNull().default(0),
    /** 0..1 */
    rapport: real().notNull().default(0),
    stance: text().notNull().default(""),
    impression: text().notNull().default(""),
    unfinished: text().notNull().default(""),
    jokes: text().notNull().default(""),
    dislikes: text().notNull().default(""),
    public_feeling: text(),
    call_name: text(),
    tags: text({ mode: "json" }).$type<string[]>().notNull().default([]),
    /** The lowest bond of the highest tier ever entered. */
    tier_floor: integer().notNull().default(0),
    anchors: text({ mode: "json" }).$type<TierAnchor[]>().notNull().default([]),
    interactions: integer().notNull().default(0),
    last_interaction: micros(),
    last_seen: micros(),
    last_together: micros(),
    /** Her local day number the daily pass last ran for them. */
    decayed_on: integer(),
    legacy: text({ mode: "json" }).$type<JsonObject>().notNull().default({}),
    created_at: micros().notNull(),
    updated_at: micros().notNull(),
  },
  (t) => [
    // The panel's list, closest first.
    index("heart_person_bond_idx").on(t.bond, t.person_id),
    // The daily pass: who it has not run for today.
    index("heart_person_decayed_idx").on(t.decayed_on),
    check("heart_person_bond_check", sql`${t.bond} BETWEEN -100 AND 1000`),
    check(
      "heart_person_range_check",
      sql`${t.trust} BETWEEN 0 AND 100 AND ${t.familiarity} BETWEEN 0 AND 100 AND ${t.warmth} BETWEEN -1 AND 1 AND ${t.respect} BETWEEN -1 AND 1`,
    ),
    check(
      "heart_person_unit_check",
      sql`${t.ease} BETWEEN 0 AND 1 AND ${t.grudge} BETWEEN 0 AND 1 AND ${t.longing} BETWEEN 0 AND 1 AND ${t.rapport} BETWEEN 0 AND 1`,
    ),
  ],
);

export const heartSelf = sqliteTable(
  "heart_self",
  {
    /** Always 1: there is one of her. */
    id: integer().primaryKey(),
    state: text({ mode: "json" }).$type<JsonObject>().notNull(),
    updated_at: micros().notNull(),
  },
  (t) => [check("heart_self_id_check", sql`${t.id} = 1`)],
);

export type HeartPersonRow = typeof heartPerson.$inferSelect;
export type HeartSelfRow = typeof heartSelf.$inferSelect;
