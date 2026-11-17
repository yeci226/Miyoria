// The `directive` plugin's migrations (docs/design/v5-data.md §3.2).
//
// Generated from the Drizzle table in `schema.ts` with `pnpm --filter @miyoria/store schema:sql
// directive` (drizzle-kit, plus `STRICT`) and never edited after they are released: the runner
// refuses a database whose recorded checksum differs. The store's drift test proves the migrated
// database and the Drizzle table agree.

import type { PluginSchema } from "@miyoria/store";

const INIT = `CREATE TABLE \`directive_rules\` (
	\`id\` text PRIMARY KEY,
	\`issuer\` text NOT NULL,
	\`authority\` text NOT NULL,
	\`scope\` text NOT NULL,
	\`effect\` text NOT NULL,
	\`text\` text NOT NULL,
	\`expires\` integer,
	\`source_event\` text NOT NULL,
	\`created_at\` integer NOT NULL,
	\`revoked_at\` integer,
	\`revoked_by\` text,
	CONSTRAINT "directive_rules_authority_check" CHECK("authority" IN ('owner','moderator','system','viewer')),
	CONSTRAINT "directive_rules_effect_check" CHECK("effect" IN ('deny','require_approval','prefer','avoid'))
) STRICT;

CREATE INDEX \`directive_rules_live_idx\` ON \`directive_rules\` (\`expires\`) WHERE "directive_rules"."revoked_at" IS NULL;

CREATE INDEX \`directive_rules_recent_idx\` ON \`directive_rules\` (\`created_at\`);
`;

/** The owner's standing rules. */
export const directiveSchema: PluginSchema = {
  plugin: "directive",
  migrations: [{ version: 1, name: "init", sql: INIT }],
};
