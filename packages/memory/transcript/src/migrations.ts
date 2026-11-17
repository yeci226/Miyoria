// The `transcript` plugin's migrations.
//
// Generated from the Drizzle tables in `schema.ts` with `pnpm --filter @miyoria/store schema:sql
// transcript` (drizzle-kit, plus `STRICT`) and never edited after they are released: the runner
// refuses a database whose recorded checksum differs. The store's drift test proves the migrated
// database and the Drizzle tables agree. The tables carry the plugin's prefix and have no foreign
// keys (`schema.ts`).

import type { PluginSchema } from "@miyoria/store";

const INIT = `CREATE TABLE \`transcript_entries\` (
	\`session\` text NOT NULL,
	\`seq\` integer NOT NULL,
	\`kind\` text NOT NULL,
	\`person_id\` text,
	\`account\` text,
	\`author\` text,
	\`content\` text DEFAULT '' NOT NULL,
	\`images\` text,
	\`tool_calls\` text,
	\`tool_call_id\` text,
	\`reasoning\` text,
	\`turn\` text,
	\`message_id\` text,
	\`reply_to\` text,
	\`label\` text,
	\`about_seq\` integer,
	\`addressed\` integer DEFAULT false NOT NULL,
	\`bot\` integer DEFAULT false NOT NULL,
	\`spoken\` integer DEFAULT false NOT NULL,
	\`flagged\` text,
	\`interrupted\` integer DEFAULT false NOT NULL,
	\`heard\` text,
	\`tokens\` integer DEFAULT 0 NOT NULL,
	\`at\` integer NOT NULL,
	\`redacted_at\` integer,
	CONSTRAINT \`transcript_entries_pk\` PRIMARY KEY(\`session\`, \`seq\`),
	CONSTRAINT "transcript_entries_kind_check" CHECK("kind" IN ('other','self','tool_calls','tool_result','note')),
	CONSTRAINT "transcript_entries_seq_check" CHECK("seq" >= 1),
	CONSTRAINT "transcript_entries_tool_check" CHECK(("kind" = 'tool_result') = ("tool_call_id" IS NOT NULL) AND ("kind" = 'tool_calls') = ("tool_calls" IS NOT NULL))
) STRICT;

CREATE TABLE \`transcript_sessions\` (
	\`session\` text PRIMARY KEY,
	\`context\` text,
	\`context_key\` text,
	\`next_seq\` integer DEFAULT 1 NOT NULL,
	\`state\` text,
	\`state_version\` integer DEFAULT 0 NOT NULL,
	\`created_at\` integer NOT NULL,
	\`last_at\` integer NOT NULL,
	CONSTRAINT "transcript_sessions_next_seq_check" CHECK("next_seq" >= 1)
) STRICT;

CREATE TABLE \`transcript_summaries\` (
	\`id\` integer PRIMARY KEY AUTOINCREMENT,
	\`session\` text NOT NULL,
	\`upto_seq\` integer NOT NULL,
	\`summary\` text NOT NULL,
	\`tokens\` integer DEFAULT 0 NOT NULL,
	\`tokens_replaced\` integer DEFAULT 0 NOT NULL,
	\`turn\` text,
	\`made_at\` integer NOT NULL,
	\`stale_at\` integer,
	CONSTRAINT "transcript_summaries_upto_check" CHECK("upto_seq" >= 1)
) STRICT;

CREATE INDEX \`transcript_entries_message_idx\` ON \`transcript_entries\` (\`message_id\`) WHERE "transcript_entries"."message_id" IS NOT NULL;

CREATE INDEX \`transcript_entries_person_idx\` ON \`transcript_entries\` (\`person_id\`) WHERE "transcript_entries"."person_id" IS NOT NULL;

CREATE INDEX \`transcript_entries_turn_idx\` ON \`transcript_entries\` (\`session\`,\`turn\`) WHERE "transcript_entries"."turn" IS NOT NULL;

CREATE INDEX \`transcript_sessions_context_idx\` ON \`transcript_sessions\` (\`context_key\`) WHERE "transcript_sessions"."context_key" IS NOT NULL;

CREATE INDEX \`transcript_sessions_last_idx\` ON \`transcript_sessions\` (\`last_at\`);

CREATE INDEX \`transcript_summaries_session_idx\` ON \`transcript_summaries\` (\`session\`,\`id\`);
`;

/** Session transcripts, their summaries and the per-session state. */
export const transcriptSchema: PluginSchema = {
  plugin: "transcript",
  migrations: [{ version: 1, name: "init", sql: INIT }],
};
