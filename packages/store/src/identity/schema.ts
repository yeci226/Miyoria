// The tables of the `identity` plugin (docs/design/v5-data.md §4.1), as Drizzle definitions.
//
// They are the source of truth for the columns: `migrations.ts` holds the SQL drizzle-kit
// generates from them (plus `STRICT`, which Drizzle cannot declare), and
// `test/identity-schema.test.ts` fails when the two drift apart. Times are INTEGER microseconds
// read as `Timestamp`s (`micros`); JSON columns are TEXT with a typed shape.

import type { JsonValue, Timestamp } from "@miyoria/types";
import { sql } from "drizzle-orm";
import {
  type AnySQLiteColumn,
  check,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  unique,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { micros } from "../orm.js";

/**
 * A person's own choices, one entry per feature that owns it, stored as that feature wrote it:
 * `privacy` is the `/me privacy` record (`@miyoria/types` `PersonPrivacy` fields), and
 * `voice_consent` the voice module's flag. A missing entry means the feature's default.
 */
export interface PersonPrefs {
  privacy?: JsonValue;
  voice_consent?: JsonValue;
}

/** What the V4 import keeps for the keepsake card (§4.3, decision D4). */
export interface LegacySnapshot {
  first_seen: Timestamp;
  old_tier: string | null;
  cards: number;
}

/** What a room can do; a missing flag is unknown. */
export interface RoomCaps {
  text?: boolean;
  voice?: boolean;
  buttons?: boolean;
  stickers?: boolean;
  threads?: boolean;
  attach_max_bytes?: number;
}

export const LINKED_BY = ["first_sight", "code", "owner", "import"] as const;
export type LinkedBy = (typeof LINKED_BY)[number];
export const ROOM_KINDS = ["text", "voice", "thread", "forum", "stage", "dm"] as const;
export type RoomKind = (typeof ROOM_KINDS)[number];
export const LANES = ["text", "voice", "home"] as const;
export type Lane = (typeof LANES)[number];

const oneOf = (values: readonly string[]) => sql.raw(values.map((v) => `'${v}'`).join(","));

export const persons = sqliteTable(
  "persons",
  {
    /** ULID; imported people keep their V4 id. */
    id: text().primaryKey(),
    /** The display name of the account the person was first seen with. */
    name: text().notNull(),
    /** Her stable name for them in prompts (`Owen`, `Owen#2`); unique ignoring case. */
    handle: text().notNull(),
    prefs: text({ mode: "json" }).$type<PersonPrefs>().notNull().default({}),
    created_at: micros().notNull(),
    /** Set when another person absorbed this one; the row stays so old ids resolve. */
    merged_into: text().references((): AnySQLiteColumn => persons.id),
    legacy: text({ mode: "json" }).$type<LegacySnapshot>(),
  },
  (t) => [uniqueIndex("persons_handle_idx").on(sql`${t.handle} COLLATE NOCASE`)],
);

export const accounts = sqliteTable(
  "accounts",
  {
    /** ULID. */
    id: text().primaryKey(),
    platform: text().notNull(),
    /** The platform's id (a Discord snowflake). */
    external_id: text().notNull(),
    /** `null`: seen (or named by a link code) but not a person yet. */
    person_id: text().references(() => persons.id),
    /** The latest display name; the external id until the account is seen. */
    display_name: text().notNull(),
    /** One of her own accounts. */
    is_self: integer({ mode: "boolean" }).notNull().default(false),
    first_seen: micros().notNull(),
    last_seen: micros().notNull(),
    linked_at: micros(),
    linked_by: text({ enum: LINKED_BY }),
  },
  (t) => [
    unique("accounts_platform_external_id_key").on(t.platform, t.external_id),
    index("accounts_person_idx").on(t.person_id).where(sql`${t.person_id} IS NOT NULL`),
    check("accounts_linked_by_check", sql`${t.linked_by} IN (${oneOf(LINKED_BY)})`),
  ],
);

/** One-time link codes, stored as sha256. */
export const linkCodes = sqliteTable("link_codes", {
  code_hash: text().primaryKey(),
  account_id: text()
    .notNull()
    .references(() => accounts.id, { onDelete: "cascade" }),
  expires_at: micros().notNull(),
});

/** A guild or group. */
export const spaces = sqliteTable(
  "spaces",
  {
    id: text().primaryKey(),
    platform: text().notNull(),
    external_id: text().notNull(),
    name: text().notNull(),
    joined_at: micros().notNull(),
    /** She left it (or was removed); `null` while she is there. */
    left_at: micros(),
    /**
     * The install's original server (identity v2): the default where no Space is given. At most
     * one row (a partial unique index); set once, never moved by itself.
     */
    is_primary: integer({ mode: "boolean" }).notNull().default(false),
    /**
     * A server she was in before servers were told apart (identity v4), or the first one of a
     * fresh install: it goes on with the cluster's settings. A Space first seen later is not, and
     * starts quiet until it is set up. Set once, never cleared.
     */
    established: integer({ mode: "boolean" }).notNull().default(false),
  },
  (t) => [
    unique("spaces_platform_external_id_key").on(t.platform, t.external_id),
    uniqueIndex("spaces_primary_idx").on(t.is_primary).where(sql`${t.is_primary} = 1`),
  ],
);

/** A channel, thread, voice room or DM. */
export const rooms = sqliteTable(
  "rooms",
  {
    id: text().primaryKey(),
    platform: text().notNull(),
    external_id: text().notNull(),
    /** `null` for DMs. */
    space_id: text().references(() => spaces.id),
    /** A thread's channel. */
    parent_id: text().references((): AnySQLiteColumn => rooms.id),
    kind: text({ enum: ROOM_KINDS }).notNull(),
    name: text(),
    caps: text({ mode: "json" }).$type<RoomCaps>().notNull().default({}),
    /** The other side of a DM. */
    dm_person: text().references(() => persons.id),
    created_at: micros().notNull(),
    archived_at: micros(),
  },
  (t) => [
    unique("rooms_platform_external_id_key").on(t.platform, t.external_id),
    index("rooms_space_idx").on(t.space_id),
    check("rooms_kind_check", sql`${t.kind} IN (${oneOf(ROOM_KINDS)})`),
  ],
);

/** Her conversation context in one place; `key` is the session key (§4.1). */
export const sessions = sqliteTable(
  "sessions",
  {
    key: text().primaryKey(),
    space_id: text().references(() => spaces.id),
    /** The room she last talked in (for a DM, the account to reply through). */
    room_id: text().references(() => rooms.id),
    /** The person of a DM session. */
    person_id: text().references(() => persons.id),
    lane: text({ enum: LANES }).notNull().default("text"),
    created_at: micros().notNull(),
    last_at: micros().notNull(),
  },
  (t) => [check("sessions_lane_check", sql`${t.lane} IN (${oneOf(LANES)})`)],
);

/** Who is in a space, by account (artifact visibility, auth role mappings). */
export const spaceMembers = sqliteTable(
  "space_members",
  {
    space_id: text()
      .notNull()
      .references(() => spaces.id),
    account_id: text()
      .notNull()
      .references(() => accounts.id),
    nick: text(),
    /** Platform role ids (auth maps them). */
    roles: text({ mode: "json" }).$type<string[]>().notNull().default([]),
    joined_at: micros(),
    left_at: micros(),
    last_seen: micros().notNull(),
  },
  (t) => [
    primaryKey({ name: "space_members_pk", columns: [t.space_id, t.account_id] }),
    // A person's Spaces (`Places.spacesOf`), the members still there.
    index("space_members_account_idx").on(t.account_id).where(sql`${t.left_at} IS NULL`),
  ],
);

export type PersonRow = typeof persons.$inferSelect;
export type AccountRow = typeof accounts.$inferSelect;
export type SpaceRow = typeof spaces.$inferSelect;
export type RoomRow = typeof rooms.$inferSelect;
export type SessionRow = typeof sessions.$inferSelect;
export type SpaceMemberRow = typeof spaceMembers.$inferSelect;
