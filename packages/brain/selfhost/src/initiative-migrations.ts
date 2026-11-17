// The `initiative` plugin's migrations.
//
// Generated from the Drizzle tables in `initiative-schema.ts` with `pnpm --filter @miyoria/store
// schema:sql initiative` (drizzle-kit, plus `STRICT`) and never edited after they are released:
// the runner refuses a database whose recorded checksum differs. The store's drift test proves
// the migrated database and the Drizzle tables agree.

import type { PluginSchema } from "@miyoria/store";

const INIT = `CREATE TABLE \`initiative_inbox\` (
	\`id\` integer PRIMARY KEY AUTOINCREMENT,
	\`key\` text NOT NULL,
	\`kind\` text NOT NULL,
	\`session\` text,
	\`context\` text,
	\`text\` text NOT NULL,
	\`person\` text,
	\`created_at\` integer NOT NULL,
	\`woke_at\` integer,
	\`woke_turn\` text,
	\`seen_at\` integer,
	\`seen_turn\` text,
	CONSTRAINT "initiative_inbox_kind_check" CHECK("kind" IN ('timer','world','followup','commitment','result'))
) STRICT;

CREATE TABLE \`initiative_schedules\` (
	\`id\` text PRIMARY KEY,
	\`note\` text NOT NULL,
	\`due\` integer NOT NULL,
	\`daily\` text,
	\`context\` text,
	\`person\` text,
	\`for_account\` text,
	\`source\` text NOT NULL,
	\`fired\` integer DEFAULT 0 NOT NULL,
	\`state\` text DEFAULT 'open' NOT NULL,
	\`created_at\` integer NOT NULL,
	\`updated_at\` integer NOT NULL,
	CONSTRAINT "initiative_schedules_source_check" CHECK("source" IN ('schedule','remind_me')),
	CONSTRAINT "initiative_schedules_state_check" CHECK("state" IN ('open','fired','cancelled','missed')),
	CONSTRAINT "initiative_schedules_fired_check" CHECK("fired" >= 0)
) STRICT;

CREATE UNIQUE INDEX \`initiative_inbox_key\` ON \`initiative_inbox\` (\`key\`);

CREATE INDEX \`initiative_inbox_open_idx\` ON \`initiative_inbox\` (\`session\`) WHERE "initiative_inbox"."seen_at" IS NULL;

CREATE INDEX \`initiative_schedules_due_idx\` ON \`initiative_schedules\` (\`due\`) WHERE "initiative_schedules"."state" = 'open';
`;

/** Her schedules and her inbox. */
export const initiativeSchema: PluginSchema = {
  plugin: "initiative",
  migrations: [{ version: 1, name: "init", sql: INIT }],
};
