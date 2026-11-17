// The `config` plugin's migrations (docs/design/v5-data.md §6).
//
// Generated from the Drizzle tables in `schema.ts` with `pnpm --filter @miyoria/store schema:sql
// config` (drizzle-kit, plus `STRICT`) and never edited after they are released: the runner
// refuses a database whose recorded checksum differs. The drift test proves the migrated database
// and the Drizzle tables agree. The tables carry no prefix: config is core, like identity.

import type { PluginSchema } from "../migrate.js";

const INIT = `CREATE TABLE \`config_persona_overrides\` (
	\`section_key\` text NOT NULL,
	\`version\` integer NOT NULL,
	\`body\` text NOT NULL,
	\`edited_by\` text NOT NULL,
	\`edited_at\` integer NOT NULL,
	CONSTRAINT \`config_persona_overrides_pk\` PRIMARY KEY(\`section_key\`, \`version\`)
) STRICT;

CREATE TABLE \`config_revisions\` (
	\`version\` integer PRIMARY KEY,
	\`doc\` text NOT NULL,
	\`created_at\` integer NOT NULL,
	\`created_by\` text NOT NULL,
	\`note\` text
) STRICT;

CREATE TABLE \`place_settings\` (
	\`scope\` text NOT NULL,
	\`scope_id\` text NOT NULL,
	\`plugin\` text NOT NULL,
	\`key\` text NOT NULL,
	\`value\` text NOT NULL,
	\`updated_at\` integer NOT NULL,
	\`updated_by\` text NOT NULL,
	CONSTRAINT \`place_settings_pk\` PRIMARY KEY(\`scope\`, \`scope_id\`, \`plugin\`, \`key\`),
	CONSTRAINT "place_settings_scope_check" CHECK("scope" IN ('space','room'))
) STRICT;

CREATE TABLE \`plugin_state\` (
	\`plugin\` text NOT NULL,
	\`key\` text NOT NULL,
	\`value\` text NOT NULL,
	\`v\` integer DEFAULT 1 NOT NULL,
	\`updated_at\` integer NOT NULL,
	CONSTRAINT \`plugin_state_pk\` PRIMARY KEY(\`plugin\`, \`key\`)
) STRICT;
`;

/** Config revisions, per-place settings and plugin state. */
export const configSchema: PluginSchema = {
  plugin: "config",
  migrations: [{ version: 1, name: "init", sql: INIT }],
};
