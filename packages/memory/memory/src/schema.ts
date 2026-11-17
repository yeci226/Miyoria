// The tables of the `memory` plugin (docs/design/v5-data.md §3.2), as Drizzle definitions: the
// V4 store's `memory_records` and `memory_vector_version` moved as they were, without
// `profile_id` (one database is one character). `migrations.ts` holds the SQL drizzle-kit
// generates from them, `STRICT` added, and after it the hand-written full-text index and triggers
// Drizzle cannot declare; the store's drift test keeps the two together. Phase 3 redesigns these
// tables with the brain (§8 "Wait for phase 3"), so they keep their old shape until then, plus
// `embedding_model`: which model made a record's vector.
//
// - `memory_records`: episodes, facts, her own notes and followups. The privacy scope is kept both
//   as JSON (readable) and as its canonical JSON text `scope_key` (exact-match filtering and
//   deletion). `seq` is the stable integer key of the full-text index (an upsert keeps it).
//   People are identity's `persons.id` inside `subjects`, with no foreign key: forgetting a person
//   is `deleteBySubject`, merging one `mergePerson` (`tables.ts`).
// - `memory_vector_version`: one row, a counter the triggers bump on every change to what vector
//   search compares (`tables.ts` keeps decoded vectors while it is unchanged).

import type { MemoryScope, MemorySource } from "@miyoria/store";
import { micros } from "@miyoria/store";
import type { ContextKey, PersonId } from "@miyoria/types";
import { sql } from "drizzle-orm";
import {
  check,
  customType,
  index,
  integer,
  real,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";

/**
 * A vector as little-endian float32 components (`stored.ts` `encodeEmbedding`), read as the bytes
 * the driver gives, so a record decodes it only when asked (`lazyEmbedding`). No fixed dimension:
 * the embedding model may change, and searches compare only rows of the query's dimension (and,
 * when the tables know the embedder's model, only rows that model made).
 */
const f32 = customType<{ data: Uint8Array; driverData: Uint8Array }>({
  dataType: () => "blob",
});

export const memoryRecords = sqliteTable(
  "memory_records",
  {
    /** The full-text index's rowid: stable across upserts. */
    seq: integer().primaryKey(),
    /** ULID. */
    id: text().notNull().unique(),
    /** `episode`, `fact`, `self_note` or `followup`. */
    kind: text().notNull(),
    scope: text({ mode: "json" }).$type<MemoryScope>().notNull(),
    /** The canonical JSON text of `scope`. */
    scope_key: text().notNull(),
    /** The persons it is about. */
    subjects: text({ mode: "json" }).$type<PersonId[]>().notNull().default([]),
    content: text().notNull(),
    /** Space-separated, already segmented search tokens (the full-text index's column). */
    tokens: text().notNull(),
    embedding: f32(),
    /**
     * What made `embedding` (the embedder's `embeddingModel`: model, weights, pooling, passage
     * prefix); `null` when unknown. Search treats a vector of another model as missing.
     */
    embedding_model: text(),
    importance: real().notNull(),
    confidence: real().notNull(),
    created_at: micros().notNull(),
    updated_at: micros().notNull(),
    last_accessed: micros(),
    access_count: integer().notNull().default(0),
    /** Where it was learned: the context's canonical JSON text. */
    source_context: text({ mode: "json" }).$type<ContextKey>(),
    /** Who told her (`remember`); `null` for what she extracted herself. */
    source: text({ mode: "json" }).$type<MemorySource>(),
    /** Whether she lived it or was told it. */
    origin: text().notNull().default("unknown"),
    /** EventLog ids it came from (or `msg:<id>` of a chat line the log has no event for). */
    source_events: text({ mode: "json" }).$type<string[]>().notNull().default([]),
    /** Followups: earliest time to bring it up. */
    due: micros(),
    /** Followups: already brought up. */
    done: integer({ mode: "boolean" }).notNull().default(false),
    /** Replaced by a newer record (kept for history, never recalled). */
    superseded_by: text(),
  },
  (t) => [
    // Newest first (an index scanned backwards serves `created_at DESC, id DESC`).
    index("memory_records_list_idx").on(t.created_at, t.id),
    index("memory_records_scope_idx").on(t.scope_key),
    // Open followups only.
    index("memory_records_due_idx")
      .on(t.due)
      .where(sql`${t.kind} = 'followup' AND NOT ${t.done} AND ${t.due} IS NOT NULL`),
  ],
);

export const memoryVectorVersion = sqliteTable(
  "memory_vector_version",
  {
    id: integer().primaryKey(),
    n: integer().notNull(),
  },
  (t) => [check("memory_vector_version_id_check", sql`${t.id} = 1`)],
);

export type MemoryRow = typeof memoryRecords.$inferSelect;
