// The tables of the `artifact` plugin (docs/design/v5-data.md §5), as Drizzle definitions.
//
// - `artifact_blobs`: one row per distinct content, named by its sha256. The bytes are a file under
//   the store's root (`paths.ts`), never in the database.
// - `artifact_items`: what an artifact is: its content, what it is, who made it and for whom,
//   where, who may see it, how long it is kept. Rows never change content; only retention, review
//   and deletion are updated.
// - `artifact_shares`: share tokens, stored as a sha256 of the token only.
//
// §5 names these `artifact_blobs`, `artifacts` and `artifact_shares` in core. They migrate after
// identity (they point at persons, spaces and rooms), so they are a plugin schema of their own,
// and the runner's lint wants every table of a plugin under its prefix: `artifacts` is
// `artifact_items` here. `migrations.ts` holds the SQL drizzle-kit generates from these tables,
// `STRICT` added; the drift test keeps the two together.

import {
  type ArtifactKeptBy,
  ArtifactKeptBySchema,
  type ArtifactKind,
  ArtifactKindSchema,
  type ArtifactSource,
  ArtifactSourceSchema,
  type EventScope,
  EventScopeSchema,
  type ShareAudience,
  ShareAudienceSchema,
  type ShareMode,
  ShareModeSchema,
} from "@miyoria/contracts/events";
import { sql } from "drizzle-orm";
import {
  type AnySQLiteColumn,
  check,
  index,
  integer,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";
import { persons, rooms, spaces } from "../identity/schema.js";
import { micros } from "../orm.js";

export const ARTIFACT_KINDS: readonly ArtifactKind[] = ArtifactKindSchema.options;
export const ARTIFACT_SOURCES: readonly ArtifactSource[] = ArtifactSourceSchema.options;
export const KEPT_BY: readonly ArtifactKeptBy[] = ArtifactKeptBySchema.options;
export const ARTIFACT_SCOPES: readonly EventScope[] = EventScopeSchema.options;
export const SHARE_AUDIENCES: readonly ShareAudience[] = ShareAudienceSchema.options;
export const SHARE_MODES: readonly ShareMode[] = ShareModeSchema.options;
export const REVIEW_STATES = ["pending", "passed", "blocked", "taken_down"] as const;
export type ReviewState = (typeof REVIEW_STATES)[number];

/** The source of song covers, which are never downloadable (v5-architecture §16 #11). */
export const SONG_COVER_SOURCE: ArtifactSource = "sing";

const oneOf = (values: readonly string[]) => sql.raw(values.map((v) => `'${v}'`).join(","));
const tuple = <T extends string>(values: readonly T[]) => values as [T, ...T[]];

/** One distinct content. */
export const artifactBlobs = sqliteTable(
  "artifact_blobs",
  {
    /** Lowercase hex; also the file's name. */
    sha256: text().primaryKey(),
    size: integer().notNull(),
    /** `local` (under the store's root); later `s3:<bucket>`. */
    location: text().notNull().default("local"),
    stored_at: micros().notNull(),
  },
  (t) => [
    check(
      "artifact_blobs_sha256_check",
      sql`length(${t.sha256}) = 64 AND ${t.sha256} NOT GLOB '*[^0-9a-f]*'`,
    ),
    check("artifact_blobs_size_check", sql`${t.size} > 0`),
  ],
);

/** One artifact: immutable content plus its record. */
export const artifactItems = sqliteTable(
  "artifact_items",
  {
    /** ULID. Never a path: the content is found by `sha256`. */
    id: text().primaryKey(),
    sha256: text()
      .notNull()
      .references(() => artifactBlobs.sha256),
    size: integer().notNull(),
    /** Sniffed from the content, never taken from a name or a caller. */
    mime: text().notNull(),
    kind: text({ enum: tuple(ARTIFACT_KINDS) }).notNull(),
    /** Cleaned by the store; only ever a download name, never a path. */
    filename: text().notNull(),
    /** What made it. */
    source: text({ enum: tuple(ARTIFACT_SOURCES) }).notNull(),
    /** The plugin that stored it. */
    plugin: text().notNull(),
    /** The cleaned or re-encoded copy points at its original. */
    derived_from: text().references((): AnySQLiteColumn => artifactItems.id, {
      onDelete: "set null",
    }),
    turn: text(),
    /** Its `artifact.created` event. */
    event_id: text().notNull(),
    made_for: text().references(() => persons.id),
    /** Where it was made: the session key, and its space and room. */
    origin_session: text(),
    space_id: text().references(() => spaces.id),
    room_id: text().references(() => rooms.id),
    /** Who may see it (the event scopes); never wider than where it was made. */
    scope: text({ enum: tuple(ARTIFACT_SCOPES) }).notNull(),
    /** `false` for song covers: a share of one only streams. */
    downloadable: integer({ mode: "boolean" }).notNull().default(true),
    review: text({ enum: REVIEW_STATES }).notNull().default("pending"),
    created_at: micros().notNull(),
    /** Set while it is not kept; `null` once kept. */
    expires_at: micros(),
    /** Why it does not expire; `album`: it is in an album. */
    kept_by: text({ enum: tuple(KEPT_BY) }),
    /** Set when it expired or was wiped; the row goes for good after the sweep's grace. */
    deleted_at: micros(),
  },
  (t) => [
    index("artifact_items_person_idx").on(t.made_for, t.created_at),
    index("artifact_items_space_idx").on(t.space_id, t.created_at),
    index("artifact_items_blob_idx").on(t.sha256),
    index("artifact_items_expiry_idx")
      .on(t.expires_at)
      .where(sql`${t.expires_at} IS NOT NULL AND ${t.deleted_at} IS NULL`),
    index("artifact_items_deleted_idx").on(t.deleted_at).where(sql`${t.deleted_at} IS NOT NULL`),
    check("artifact_items_kind_check", sql`${t.kind} IN (${oneOf(ARTIFACT_KINDS)})`),
    check("artifact_items_source_check", sql`${t.source} IN (${oneOf(ARTIFACT_SOURCES)})`),
    check("artifact_items_scope_check", sql`${t.scope} IN (${oneOf(ARTIFACT_SCOPES)})`),
    check("artifact_items_review_check", sql`${t.review} IN (${oneOf(REVIEW_STATES)})`),
    check("artifact_items_kept_by_check", sql`${t.kept_by} IN (${oneOf(KEPT_BY)})`),
    check("artifact_items_size_check", sql`${t.size} > 0`),
    // Kept, or expiring: exactly one.
    check(
      "artifact_items_retention_check",
      sql`(${t.kept_by} IS NULL) <> (${t.expires_at} IS NULL)`,
    ),
    // Song covers are never downloadable.
    check(
      "artifact_items_song_cover_check",
      sql`${t.source} <> ${sql.raw(`'${SONG_COVER_SOURCE}'`)} OR ${t.downloadable} = 0`,
    ),
  ],
);

/** A share token of one artifact. */
export const artifactShares = sqliteTable(
  "artifact_shares",
  {
    id: text().primaryKey(),
    artifact_id: text()
      .notNull()
      .references(() => artifactItems.id, { onDelete: "cascade" }),
    /** sha256 (hex) of the token; the token itself is never stored. */
    token_hash: text().notNull().unique("artifact_shares_token_hash_key"),
    audience: text({ enum: tuple(SHARE_AUDIENCES) }).notNull(),
    /** The person of a `person` share. */
    person_id: text().references(() => persons.id),
    /** The space of a `space` share. */
    space_id: text().references(() => spaces.id),
    /** `stream` only, for an artifact that is not downloadable. */
    mode: text({ enum: tuple(SHARE_MODES) }).notNull(),
    /** Its `share.created` event (who asked, which turn). */
    event_id: text().notNull(),
    created_at: micros().notNull(),
    expires_at: micros(),
    revoked_at: micros(),
    /** Times it was used (streamed or downloaded); the one counter that changes. */
    uses: integer().notNull().default(0),
    /** `null`: no limit. */
    max_uses: integer(),
    last_used_at: micros(),
  },
  (t) => [
    index("artifact_shares_artifact_idx").on(t.artifact_id),
    check("artifact_shares_audience_check", sql`${t.audience} IN (${oneOf(SHARE_AUDIENCES)})`),
    check("artifact_shares_mode_check", sql`${t.mode} IN (${oneOf(SHARE_MODES)})`),
    check(
      "artifact_shares_target_check",
      sql`(${t.audience} <> 'person' OR ${t.person_id} IS NOT NULL) AND (${t.audience} <> 'space' OR ${t.space_id} IS NOT NULL)`,
    ),
    check(
      "artifact_shares_uses_check",
      sql`${t.uses} >= 0 AND (${t.max_uses} IS NULL OR ${t.max_uses} >= 1)`,
    ),
  ],
);

export type ArtifactBlobRow = typeof artifactBlobs.$inferSelect;
export type ArtifactRow = typeof artifactItems.$inferSelect;
export type ArtifactShareRow = typeof artifactShares.$inferSelect;
