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

/**
 * Version 2 (phase 6, docs/design/v5-places.md): the Space each row came from. Filled from the
 * row's own place (`context`'s platform and server, as identity knows them); a row without a
 * place stays `NULL` (home). Additive.
 */
const SPACES = `ALTER TABLE \`initiative_inbox\` ADD \`space_id\` text;

ALTER TABLE \`initiative_schedules\` ADD \`space_id\` text;

UPDATE \`initiative_inbox\` SET \`space_id\` = (
	SELECT s.\`id\` FROM \`spaces\` s
	WHERE s.\`platform\` = json_extract(\`initiative_inbox\`.\`context\`, '$.platform')
		AND s.\`external_id\` = json_extract(\`initiative_inbox\`.\`context\`, '$.scope')
) WHERE \`context\` IS NOT NULL;

UPDATE \`initiative_schedules\` SET \`space_id\` = (
	SELECT s.\`id\` FROM \`spaces\` s
	WHERE s.\`platform\` = json_extract(\`initiative_schedules\`.\`context\`, '$.platform')
		AND s.\`external_id\` = json_extract(\`initiative_schedules\`.\`context\`, '$.scope')
) WHERE \`context\` IS NOT NULL;

CREATE INDEX \`initiative_inbox_space_idx\` ON \`initiative_inbox\` (\`space_id\`) WHERE "initiative_inbox"."seen_at" IS NULL;
`;

/** Her schedules and her inbox. */
export const initiativeSchema: PluginSchema = {
  plugin: "initiative",
  // Version 2 reads identity's `spaces`.
  requires: ["identity"],
  migrations: [
    { version: 1, name: "init", sql: INIT },
    { version: 2, name: "spaces", sql: SPACES },
  ],
};
