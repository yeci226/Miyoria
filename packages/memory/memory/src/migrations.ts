// The `memory` plugin's migrations (docs/design/v5-data.md §3.2): the V4 store's memory tables,
// moved as they were (without `profile_id`).
//
// Migration 1 is two parts, never edited after release (the runner refuses a database whose
// recorded checksum differs):
// - `MEMORY_TABLES_SQL`: generated from the Drizzle tables in `schema.ts` with `pnpm --filter
//   @miyoria/store schema:sql memory` (drizzle-kit, plus `STRICT`);
// - `MEMORY_SEARCH_SQL`: what Drizzle cannot declare, by hand: the vector counter's one row, the
//   FTS5 index over `tokens` with the triggers that keep it in step, and the triggers that bump the
//   vector counter.
// The store's drift test proves the migrated database and the Drizzle tables agree, and that
// migration 1 is exactly the two parts.

import type { PluginSchema } from "@miyoria/store";

/** drizzle-kit's SQL for `schema.ts`, `STRICT` added. */
export const MEMORY_TABLES_SQL = `CREATE TABLE \`memory_records\` (
	\`seq\` integer PRIMARY KEY,
	\`id\` text NOT NULL UNIQUE,
	\`kind\` text NOT NULL,
	\`scope\` text NOT NULL,
	\`scope_key\` text NOT NULL,
	\`subjects\` text DEFAULT '[]' NOT NULL,
	\`content\` text NOT NULL,
	\`tokens\` text NOT NULL,
	\`embedding\` blob,
	\`embedding_model\` text,
	\`importance\` real NOT NULL,
	\`confidence\` real NOT NULL,
	\`created_at\` integer NOT NULL,
	\`updated_at\` integer NOT NULL,
	\`last_accessed\` integer,
	\`access_count\` integer DEFAULT 0 NOT NULL,
	\`source_context\` text,
	\`source\` text,
	\`origin\` text DEFAULT 'unknown' NOT NULL,
	\`source_events\` text DEFAULT '[]' NOT NULL,
	\`due\` integer,
	\`done\` integer DEFAULT false NOT NULL,
	\`superseded_by\` text
) STRICT;

CREATE TABLE \`memory_vector_version\` (
	\`id\` integer PRIMARY KEY,
	\`n\` integer NOT NULL,
	CONSTRAINT "memory_vector_version_id_check" CHECK("id" = 1)
) STRICT;

CREATE INDEX \`memory_records_list_idx\` ON \`memory_records\` (\`created_at\`,\`id\`);

CREATE INDEX \`memory_records_scope_idx\` ON \`memory_records\` (\`scope_key\`);

CREATE INDEX \`memory_records_due_idx\` ON \`memory_records\` (\`due\`) WHERE "memory_records"."kind" = 'followup' AND NOT "memory_records"."done" AND "memory_records"."due" IS NOT NULL;
`;

/** By hand, after the tables: what drizzle-kit neither generates nor compares. */
export const MEMORY_SEARCH_SQL = `-- The counter vector search keeps its decoded vectors by: one row.
INSERT INTO memory_vector_version (id, n) VALUES (1, 0);

-- Full-text index over \`tokens\`: unicode61 folds case and keeps CJK words whole; diacritics
-- are kept. External content: the text lives in memory_records, keyed by \`seq\`.
CREATE VIRTUAL TABLE memory_fts USING fts5(
    tokens,
    content = 'memory_records',
    content_rowid = 'seq',
    tokenize = 'unicode61 remove_diacritics 0'
);

CREATE TRIGGER memory_records_fts_insert AFTER INSERT ON memory_records BEGIN
    INSERT INTO memory_fts (rowid, tokens) VALUES (new.seq, new.tokens);
END;

CREATE TRIGGER memory_records_fts_delete AFTER DELETE ON memory_records BEGIN
    INSERT INTO memory_fts (memory_fts, rowid, tokens) VALUES ('delete', old.seq, old.tokens);
END;

CREATE TRIGGER memory_records_fts_update AFTER UPDATE OF tokens ON memory_records BEGIN
    INSERT INTO memory_fts (memory_fts, rowid, tokens) VALUES ('delete', old.seq, old.tokens);
    INSERT INTO memory_fts (rowid, tokens) VALUES (new.seq, new.tokens);
END;

-- Bumped by every change to which records vector search compares and what it compares them by
-- (membership, vector and the model that made it, scope, kind, superseded, time, id). Updates
-- that leave those columns as they were do not bump it, even when they name them: an upsert
-- sets every column, so
-- reinforcing, touching or closing a memory compares values (\`IS NOT\`, since \`embedding\` and
-- \`superseded_by\` may be NULL).
CREATE TRIGGER memory_records_vector_insert AFTER INSERT ON memory_records BEGIN
    UPDATE memory_vector_version SET n = n + 1 WHERE id = 1;
END;

CREATE TRIGGER memory_records_vector_delete AFTER DELETE ON memory_records BEGIN
    UPDATE memory_vector_version SET n = n + 1 WHERE id = 1;
END;

CREATE TRIGGER memory_records_vector_update AFTER UPDATE ON memory_records
WHEN OLD.id IS NOT NEW.id
    OR OLD.kind IS NOT NEW.kind
    OR OLD.scope_key IS NOT NEW.scope_key
    OR OLD.embedding IS NOT NEW.embedding
    OR OLD.embedding_model IS NOT NEW.embedding_model
    OR OLD.created_at IS NOT NEW.created_at
    OR OLD.superseded_by IS NOT NEW.superseded_by
BEGIN
    UPDATE memory_vector_version SET n = n + 1 WHERE id = 1;
END;
`;

/** Memory records, their full-text index and the vector counter. */
export const memorySchema: PluginSchema = {
  plugin: "memory",
  migrations: [{ version: 1, name: "init", sql: `${MEMORY_TABLES_SQL}\n${MEMORY_SEARCH_SQL}` }],
};
