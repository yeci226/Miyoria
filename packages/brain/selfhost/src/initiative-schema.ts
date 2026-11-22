// The tables of the `initiative` plugin: what wakes her when nobody spoke to her, on the phase-3
// turn runner (docs/design/v5-architecture.md §7.3 「排程」, §7.6 「主動」; docs/design/v5-brain.md
// B6).
//
// - `initiative_schedules`: the times she set herself (`schedule`, and `remind_me` while the new
//   runner serves it): one-off or daily at a local clock time, with the place to wake her in
//   (`null`: her home, no place). A row stays after it ended, with how it ended.
// - `initiative_inbox`: what is not a line of a conversation but is for her: a due schedule, a
//   salient world event, a followup that is due, a promise that is overdue, a long action's
//   result. One row per thing (`key`); `session` is the place it belongs to (`null`: home). An
//   item is shown in block 6 of the next run in its place and is seen once a run that showed it
//   finished; a home item is shown in the runs of its Space (`space_id`, the server it came from)
//   and, without one (her own timers, her morning), in any run. `woke_at` is set when it woke her
//   itself: an item wakes her at most once, whatever came of that run.
// - `space_id` (both tables, phase 6, docs/design/v5-places.md): identity's Space of the place a
//   row came from; `null` for one of no server (a DM, her home). Not a foreign key, like the rest.
//
// No foreign keys, like the transcripts: a place or a person need not be known to identity.
// `initiative-migrations.ts` holds the SQL drizzle-kit generates from these tables, `STRICT`
// added; the store's drift test keeps the two together.

import { micros } from "@miyoria/store";
import type { AccountRef, ContextKey } from "@miyoria/types";
import { sql } from "drizzle-orm";
import { check, index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

/** Who set a schedule: her own tool, or `remind_me` (someone may have asked for it). */
export const SCHEDULE_SOURCES = ["schedule", "remind_me"] as const;
export type ScheduleSource = (typeof SCHEDULE_SOURCES)[number];

/** How a schedule stands: waiting, or how it ended. */
export const SCHEDULE_STATES = ["open", "fired", "cancelled", "missed"] as const;
export type ScheduleState = (typeof SCHEDULE_STATES)[number];

/**
 * What an inbox item is: a due schedule, a salient world event, a due followup of memory, an
 * overdue promise of hers, a long action's result.
 */
export const INBOX_KINDS = ["timer", "world", "followup", "commitment", "result"] as const;
export type InboxKind = (typeof INBOX_KINDS)[number];

const oneOf = (values: readonly string[]) => sql.raw(values.map((v) => `'${v}'`).join(","));

export const initiativeSchedules = sqliteTable(
  "initiative_schedules",
  {
    id: text().primaryKey(),
    /** What it is about, in her words. */
    note: text().notNull(),
    /** When it is next due. */
    due: micros().notNull(),
    /** Daily at this local clock time (`HH:MM`); `null`: once. */
    daily: text(),
    /** Where it wakes her; `null`: home. */
    context: text({ mode: "json" }).$type<ContextKey>(),
    /** The handle of the person it is about, when one. */
    person: text(),
    /** The Space of `context` (identity's id); `null`: none (home, a DM). */
    space_id: text(),
    /** Who asked for it (`remind_me` for someone); `null`: she set it herself. */
    for_account: text({ mode: "json" }).$type<AccountRef>(),
    source: text({ enum: SCHEDULE_SOURCES }).notNull(),
    /** Times it came due. */
    fired: integer().notNull().default(0),
    state: text({ enum: SCHEDULE_STATES }).notNull().default("open"),
    created_at: micros().notNull(),
    updated_at: micros().notNull(),
  },
  (t) => [
    index("initiative_schedules_due_idx").on(t.due).where(sql`${t.state} = 'open'`),
    check("initiative_schedules_source_check", sql`${t.source} IN (${oneOf(SCHEDULE_SOURCES)})`),
    check("initiative_schedules_state_check", sql`${t.state} IN (${oneOf(SCHEDULE_STATES)})`),
    check("initiative_schedules_fired_check", sql`${t.fired} >= 0`),
  ],
);

export const initiativeInbox = sqliteTable(
  "initiative_inbox",
  {
    id: integer().primaryKey({ autoIncrement: true }),
    /** Names the thing (`timer:<id>:<n>`, `world:<key>:<at>`, ...): one row per thing. */
    key: text().notNull(),
    kind: text({ enum: INBOX_KINDS }).notNull(),
    /** The transcript session it belongs to; `null`: home. */
    session: text(),
    /** The place of that session, to wake her there. */
    context: text({ mode: "json" }).$type<ContextKey>(),
    /**
     * The Space it came from (identity's id), also for a home item (a voice event of a server):
     * a run sees only its own Space's items and items of none. `null`: no server.
     */
    space_id: text(),
    /** What she is told (may quote others: shown as data). */
    text: text().notNull(),
    /** The handle of the person it is about, when one. */
    person: text(),
    created_at: micros().notNull(),
    /** When it woke her itself; `null`: it has not. */
    woke_at: micros(),
    woke_turn: text(),
    /** When a run that showed it finished. */
    seen_at: micros(),
    seen_turn: text(),
  },
  (t) => [
    uniqueIndex("initiative_inbox_key").on(t.key),
    index("initiative_inbox_open_idx").on(t.session).where(sql`${t.seen_at} IS NULL`),
    index("initiative_inbox_space_idx").on(t.space_id).where(sql`${t.seen_at} IS NULL`),
    check("initiative_inbox_kind_check", sql`${t.kind} IN (${oneOf(INBOX_KINDS)})`),
  ],
);

export type ScheduleRow = typeof initiativeSchedules.$inferSelect;
export type InboxRow = typeof initiativeInbox.$inferSelect;
