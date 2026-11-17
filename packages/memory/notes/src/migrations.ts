// The `notes` plugin's migrations.
//
// Generated from the Drizzle tables in `schema.ts` with `pnpm --filter @miyoria/store schema:sql
// notes` (drizzle-kit, plus `STRICT`; for migration 2, which that command cannot write because
// drizzle-kit asks whether a new table is a renamed one, the store's drift test printed the
// statement) and never edited after they are released: the runner
// refuses a database whose recorded checksum differs. The store's drift test proves the migrated
// database and the Drizzle tables agree. The tables carry the plugin's prefix and have no foreign
// keys (`schema.ts`).

import type { PluginSchema } from "@miyoria/store";

const INIT = `CREATE TABLE \`notes_documents\` (
	\`id\` text PRIMARY KEY,
	\`subject\` text NOT NULL,
	\`kind\` text NOT NULL,
	\`person_id\` text,
	\`title\` text DEFAULT '' NOT NULL,
	\`version\` integer DEFAULT 0 NOT NULL,
	\`created_at\` integer NOT NULL,
	\`updated_at\` integer NOT NULL,
	CONSTRAINT "notes_documents_kind_check" CHECK("kind" IN ('person','place','topic','self')),
	CONSTRAINT "notes_documents_version_check" CHECK("version" >= 0),
	CONSTRAINT "notes_documents_subject_check" CHECK(("kind" = 'person') = ("person_id" IS NOT NULL) AND ("kind" = 'self') = ("subject" = 'self'))
) STRICT;

CREATE TABLE \`notes_evidence\` (
	\`id\` integer PRIMARY KEY AUTOINCREMENT,
	\`line_id\` text NOT NULL,
	\`quote\` text DEFAULT '' NOT NULL,
	\`person_id\` text,
	\`session\` text,
	\`seq_from\` integer,
	\`seq_to\` integer,
	\`message_id\` text,
	\`event_id\` text,
	\`at\` integer NOT NULL,
	\`redacted_at\` integer
) STRICT;

CREATE TABLE \`notes_history\` (
	\`id\` integer PRIMARY KEY AUTOINCREMENT,
	\`document_id\` text NOT NULL,
	\`version\` integer NOT NULL,
	\`line_id\` text NOT NULL,
	\`op\` text NOT NULL,
	\`author\` text NOT NULL,
	\`reason\` text,
	\`at\` integer NOT NULL,
	CONSTRAINT "notes_history_op_check" CHECK("op" IN ('add','outdate','restore','redact')),
	CONSTRAINT "notes_history_author_check" CHECK("author" IN ('segment','reflect','tool','import','panel','system')),
	CONSTRAINT "notes_history_version_check" CHECK("version" >= 1)
) STRICT;

CREATE TABLE \`notes_lines\` (
	\`id\` text PRIMARY KEY,
	\`document_id\` text NOT NULL,
	\`section\` text NOT NULL,
	\`text\` text NOT NULL,
	\`provenance\` text NOT NULL,
	\`told_by\` text,
	\`scope\` text NOT NULL,
	\`scope_id\` text,
	\`confidence\` real NOT NULL,
	\`author\` text NOT NULL,
	\`session\` text,
	\`seq_from\` integer,
	\`seq_to\` integer,
	\`import_key\` text,
	\`created_at\` integer NOT NULL,
	\`updated_at\` integer NOT NULL,
	\`outdated_at\` integer,
	\`outdated_reason\` text,
	\`replaced_by\` text,
	\`redacted_at\` integer,
	CONSTRAINT "notes_lines_provenance_check" CHECK("provenance" IN ('told_by_subject','told_by_other','observed','concluded')),
	CONSTRAINT "notes_lines_author_check" CHECK("author" IN ('segment','reflect','tool','import','panel','system')),
	CONSTRAINT "notes_lines_scope_check" CHECK("scope" IN ('public','space','room','dm','person','self') AND ("scope" IN ('public','self')) = ("scope_id" IS NULL)),
	CONSTRAINT "notes_lines_confidence_check" CHECK("confidence" >= 0 AND "confidence" <= 1),
	CONSTRAINT "notes_lines_outdated_check" CHECK("redacted_at" IS NULL OR "outdated_at" IS NOT NULL)
) STRICT;

CREATE UNIQUE INDEX \`notes_documents_subject_key\` ON \`notes_documents\` (\`subject\`);

CREATE INDEX \`notes_documents_person_idx\` ON \`notes_documents\` (\`person_id\`) WHERE "notes_documents"."person_id" IS NOT NULL;

CREATE INDEX \`notes_evidence_line_idx\` ON \`notes_evidence\` (\`line_id\`);

CREATE INDEX \`notes_evidence_message_idx\` ON \`notes_evidence\` (\`message_id\`) WHERE "notes_evidence"."message_id" IS NOT NULL;

CREATE INDEX \`notes_evidence_event_idx\` ON \`notes_evidence\` (\`event_id\`) WHERE "notes_evidence"."event_id" IS NOT NULL;

CREATE INDEX \`notes_evidence_session_idx\` ON \`notes_evidence\` (\`session\`,\`seq_from\`) WHERE "notes_evidence"."session" IS NOT NULL;

CREATE INDEX \`notes_evidence_person_idx\` ON \`notes_evidence\` (\`person_id\`) WHERE "notes_evidence"."person_id" IS NOT NULL;

CREATE INDEX \`notes_history_document_idx\` ON \`notes_history\` (\`document_id\`,\`version\`);

CREATE INDEX \`notes_history_line_idx\` ON \`notes_history\` (\`line_id\`);

CREATE INDEX \`notes_lines_document_idx\` ON \`notes_lines\` (\`document_id\`,\`outdated_at\`);

CREATE INDEX \`notes_lines_told_by_idx\` ON \`notes_lines\` (\`told_by\`) WHERE "notes_lines"."told_by" IS NOT NULL;

CREATE INDEX \`notes_lines_scope_idx\` ON \`notes_lines\` (\`scope\`,\`scope_id\`) WHERE "notes_lines"."scope_id" IS NOT NULL;

CREATE UNIQUE INDEX \`notes_lines_import_key\` ON \`notes_lines\` (\`import_key\`) WHERE "notes_lines"."import_key" IS NOT NULL;
`;

/** The embedding of each line in use (`vectors.ts`). */
const VECTORS = `CREATE TABLE \`notes_vectors\` (
	\`line_id\` text PRIMARY KEY,
	\`model\` text NOT NULL,
	\`vector\` blob NOT NULL,
	\`at\` integer NOT NULL,
	CONSTRAINT "notes_vectors_vector_check" CHECK(length("vector") > 0 AND length("vector") % 4 = 0)
) STRICT;
`;

/**
 * Her documents, their lines, what the lines rest on and every change made to them; the vectors
 * of the lines in use.
 */
export const notesSchema: PluginSchema = {
  plugin: "notes",
  migrations: [
    { version: 1, name: "init", sql: INIT },
    { version: 2, name: "vectors", sql: VECTORS },
  ],
};
