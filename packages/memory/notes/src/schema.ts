// The tables of the `notes` plugin: L3 of her memory (docs/design/v5-architecture.md §7.4,
// docs/design/v5-brain.md B7), as Drizzle definitions. One document per subject (a person, a
// place, a topic, herself), made of lines; a line is never edited or deleted, it is marked
// outdated and, when something took its place, points at it.
//
// The design names this `memory_notes` under the `memory` plugin. It is a plugin of its own, like
// `transcript`: a store plugin is one schema with one piece of code over it, and the runner's lint
// wants every table of a plugin under its prefix, so the tables are `notes_*`.
//
// - `notes_documents`: one row per subject (`person:<person id>`, `place:<space or room id>`,
//   `topic:<slug>`, `self`). `version` is the number of the last change set (`notes_history`).
// - `notes_lines`: what a document says, one statement per row, each with where it may be shown
//   (`scope`, `scope_id`: the event log's vocabulary plus `person`), where it came from
//   (`provenance`, `told_by`, the segment it was written from) and who wrote it (`author`).
// - `notes_evidence`: what a line rests on: quoted words with the transcript entries, the platform
//   message or the event they are from. A redaction finds lines through this table.
// - `notes_history`: every change of a document, one row per line touched; the rows of one call
//   share a `version`.
// - `notes_vectors`: the embedding of a line in use (`vectors.ts`), for finding it by meaning.
//   Derived from the line's text, which never changes: a line that goes out of use (outdated,
//   redacted, deleted) loses its vector in the same transaction, and one made by another model
//   counts as missing.
//
// No foreign keys: like the event log and the transcripts, a line must accept a person, a place
// or a session that identity has not resolved (or that a wipe of another category removed); the
// store keeps the four tables together in one transaction. `migrations.ts` holds the SQL
// drizzle-kit generates from these tables, `STRICT` added; the store's drift test keeps the two
// together.

import { micros } from "@miyoria/store";
import { sql } from "drizzle-orm";
import {
  check,
  customType,
  index,
  integer,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

/** What a document is about. */
export const DOCUMENT_KINDS = ["person", "place", "topic", "self"] as const;
export type DocumentKind = (typeof DOCUMENT_KINDS)[number];

/**
 * Where a line may be shown: the event log's scopes (docs/design/v5-data.md §2.4) without
 * `owner`, plus `person` ("anywhere this person is").
 */
export const NOTE_SCOPES = ["public", "space", "room", "dm", "person", "self"] as const;
export type NoteScopeType = (typeof NOTE_SCOPES)[number];

/**
 * How she knows a line:
 * - `told_by_subject`: the person the document is about said so themself;
 * - `told_by_other`: someone else said so (`told_by`);
 * - `observed`: she was there (her own words and acts, what a tool returned);
 * - `concluded`: she worked it out.
 */
export const PROVENANCES = ["told_by_subject", "told_by_other", "observed", "concluded"] as const;
export type Provenance = (typeof PROVENANCES)[number];

/**
 * Who wrote a line or made a change: the segment pass, her nightly reflection, a tool call of
 * hers, the importer, the owner's panel, or the store itself (a redaction, a forgotten person).
 */
export const NOTE_AUTHORS = ["segment", "reflect", "tool", "import", "panel", "system"] as const;
export type NoteAuthor = (typeof NOTE_AUTHORS)[number];

/** What a history row records about a line. */
export const HISTORY_OPS = ["add", "outdate", "restore", "redact"] as const;
export type HistoryOp = (typeof HISTORY_OPS)[number];

const oneOf = (values: readonly string[]) => sql.raw(values.map((v) => `'${v}'`).join(","));

export const notesDocuments = sqliteTable(
  "notes_documents",
  {
    /** ULID. */
    id: text().primaryKey(),
    /** `person:<person id>`, `place:<space or room id>`, `topic:<slug>` or `self`. */
    subject: text().notNull(),
    kind: text({ enum: DOCUMENT_KINDS }).notNull(),
    /** `person` documents: identity's `persons.id`. */
    person_id: text(),
    /** What it is called when listed (a name at the time, a topic as she wrote it). */
    title: text().notNull().default(""),
    /** The number of the last change set; 0: never changed. */
    version: integer().notNull().default(0),
    created_at: micros().notNull(),
    updated_at: micros().notNull(),
  },
  (t) => [
    uniqueIndex("notes_documents_subject_key").on(t.subject),
    index("notes_documents_person_idx").on(t.person_id).where(sql`${t.person_id} IS NOT NULL`),
    check("notes_documents_kind_check", sql`${t.kind} IN (${oneOf(DOCUMENT_KINDS)})`),
    check("notes_documents_version_check", sql`${t.version} >= 0`),
    // A person document names its person; there is one `self` document, and its subject says so.
    check(
      "notes_documents_subject_check",
      sql`(${t.kind} = 'person') = (${t.person_id} IS NOT NULL) AND (${t.kind} = 'self') = (${t.subject} = 'self')`,
    ),
  ],
);

export const notesLines = sqliteTable(
  "notes_lines",
  {
    /** ULID. */
    id: text().primaryKey(),
    document_id: text().notNull(),
    /** One of the document kind's sections (`sections.ts`), by key. */
    section: text().notNull(),
    /** The statement, one line. Empty once redacted. */
    text: text().notNull(),
    provenance: text({ enum: PROVENANCES }).notNull(),
    /** `told_by_subject`, `told_by_other`: the person who said it, when known. */
    told_by: text(),
    scope: text({ enum: NOTE_SCOPES }).notNull(),
    /** The space, room or person the scope names; `null` for `public` and `self`. */
    scope_id: text(),
    /** 0..1 */
    confidence: real().notNull(),
    author: text({ enum: NOTE_AUTHORS }).notNull(),
    /** The transcript segment it was written from: the session and its first and last sequence. */
    session: text(),
    seq_from: integer(),
    seq_to: integer(),
    /** The importer's key of the thing it stands for: a second import finds the line by it. */
    import_key: text(),
    created_at: micros().notNull(),
    /** When it was last marked outdated, restored or given more evidence. */
    updated_at: micros().notNull(),
    /** Set when it stopped being true or was replaced; the row stays. */
    outdated_at: micros(),
    outdated_reason: text(),
    /** The line that took its place. */
    replaced_by: text(),
    /** Set when its text was removed (a redaction, a forgotten person); it is then outdated too. */
    redacted_at: micros(),
  },
  (t) => [
    index("notes_lines_document_idx").on(t.document_id, t.outdated_at),
    index("notes_lines_told_by_idx").on(t.told_by).where(sql`${t.told_by} IS NOT NULL`),
    index("notes_lines_scope_idx").on(t.scope, t.scope_id).where(sql`${t.scope_id} IS NOT NULL`),
    uniqueIndex("notes_lines_import_key").on(t.import_key).where(sql`${t.import_key} IS NOT NULL`),
    check("notes_lines_provenance_check", sql`${t.provenance} IN (${oneOf(PROVENANCES)})`),
    check("notes_lines_author_check", sql`${t.author} IN (${oneOf(NOTE_AUTHORS)})`),
    check(
      "notes_lines_scope_check",
      sql`${t.scope} IN (${oneOf(NOTE_SCOPES)}) AND (${t.scope} IN ('public','self')) = (${t.scope_id} IS NULL)`,
    ),
    check("notes_lines_confidence_check", sql`${t.confidence} >= 0 AND ${t.confidence} <= 1`),
    check(
      "notes_lines_outdated_check",
      sql`${t.redacted_at} IS NULL OR ${t.outdated_at} IS NOT NULL`,
    ),
  ],
);

export const notesEvidence = sqliteTable(
  "notes_evidence",
  {
    id: integer().primaryKey({ autoIncrement: true }),
    line_id: text().notNull(),
    /** The words quoted. Empty once redacted, and for a source without words. */
    quote: text().notNull().default(""),
    /** Who said the quoted words; `null`: herself, a tool, or not known. */
    person_id: text(),
    /** The transcript entries quoted: the session and the first and last sequence. */
    session: text(),
    seq_from: integer(),
    seq_to: integer(),
    /** The platform's id of the message quoted: how "do not remember this" finds it. */
    message_id: text(),
    /** The event log's id of the event quoted. */
    event_id: text(),
    at: micros().notNull(),
    /** Set when the source was redacted; the row stays, without its quote. */
    redacted_at: micros(),
  },
  (t) => [
    index("notes_evidence_line_idx").on(t.line_id),
    index("notes_evidence_message_idx").on(t.message_id).where(sql`${t.message_id} IS NOT NULL`),
    index("notes_evidence_event_idx").on(t.event_id).where(sql`${t.event_id} IS NOT NULL`),
    index("notes_evidence_session_idx")
      .on(t.session, t.seq_from)
      .where(sql`${t.session} IS NOT NULL`),
    index("notes_evidence_person_idx").on(t.person_id).where(sql`${t.person_id} IS NOT NULL`),
  ],
);

export const notesHistory = sqliteTable(
  "notes_history",
  {
    /** The order changes were made in. */
    id: integer().primaryKey({ autoIncrement: true }),
    document_id: text().notNull(),
    /** The change set: every row of one call has the same number, 1, 2, 3, ... per document. */
    version: integer().notNull(),
    line_id: text().notNull(),
    op: text({ enum: HISTORY_OPS }).notNull(),
    author: text({ enum: NOTE_AUTHORS }).notNull(),
    /** Why, in a few words. Never anybody's words. */
    reason: text(),
    at: micros().notNull(),
  },
  (t) => [
    index("notes_history_document_idx").on(t.document_id, t.version),
    index("notes_history_line_idx").on(t.line_id),
    check("notes_history_op_check", sql`${t.op} IN (${oneOf(HISTORY_OPS)})`),
    check("notes_history_author_check", sql`${t.author} IN (${oneOf(NOTE_AUTHORS)})`),
    check("notes_history_version_check", sql`${t.version} >= 1`),
  ],
);

/** A vector as little-endian float32 components, as `memory_records.embedding` holds one. */
const f32 = customType<{ data: Uint8Array; driverData: Uint8Array }>({
  dataType: () => "blob",
});

export const notesVectors = sqliteTable(
  "notes_vectors",
  {
    /** The line it is of. */
    line_id: text().primaryKey(),
    /** What made it (the embedder's `embeddingModel`). */
    model: text().notNull(),
    vector: f32().notNull(),
    at: micros().notNull(),
  },
  (t) => [
    check(
      "notes_vectors_vector_check",
      sql`length(${t.vector}) > 0 AND length(${t.vector}) % 4 = 0`,
    ),
  ],
);

export type NotesDocumentRow = typeof notesDocuments.$inferSelect;
export type NotesLineRow = typeof notesLines.$inferSelect;
export type NotesEvidenceRow = typeof notesEvidence.$inferSelect;
export type NotesHistoryRow = typeof notesHistory.$inferSelect;
export type NotesVectorRow = typeof notesVectors.$inferSelect;
