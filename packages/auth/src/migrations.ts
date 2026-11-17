// The `auth` plugin's migrations (docs/design/v5-data.md §3.2).
//
// Generated from the Drizzle tables in `schema.ts` with `pnpm --filter @miyoria/store schema:sql
// auth` (drizzle-kit, plus `STRICT`) and never edited after they are released: the runner refuses
// a database whose recorded checksum differs. The store's drift test proves the migrated database
// and the Drizzle tables agree.

import type { PluginSchema } from "@miyoria/store";

const INIT = `CREATE TABLE \`auth_assignments\` (
	\`account_id\` text NOT NULL,
	\`role\` text NOT NULL,
	\`scope\` text NOT NULL,
	\`granted_by\` text NOT NULL,
	\`at\` integer NOT NULL,
	CONSTRAINT \`auth_assignments_pk\` PRIMARY KEY(\`account_id\`, \`role\`, \`scope\`),
	CONSTRAINT \`fk_auth_assignments_account_id_accounts_id_fk\` FOREIGN KEY (\`account_id\`) REFERENCES \`accounts\`(\`id\`) ON DELETE CASCADE
) STRICT;

CREATE TABLE \`auth_overrides\` (
	\`scope\` text NOT NULL,
	\`role\` text NOT NULL,
	\`node\` text NOT NULL,
	\`allow\` integer NOT NULL,
	CONSTRAINT \`auth_overrides_pk\` PRIMARY KEY(\`scope\`, \`role\`, \`node\`)
) STRICT;

CREATE TABLE \`auth_role_mappings\` (
	\`space_id\` text NOT NULL,
	\`platform_role\` text NOT NULL,
	\`role\` text NOT NULL,
	CONSTRAINT \`auth_role_mappings_pk\` PRIMARY KEY(\`space_id\`, \`platform_role\`),
	CONSTRAINT \`fk_auth_role_mappings_space_id_spaces_id_fk\` FOREIGN KEY (\`space_id\`) REFERENCES \`spaces\`(\`id\`) ON DELETE CASCADE
) STRICT;

CREATE TABLE \`auth_roles\` (
	\`name\` text PRIMARY KEY,
	\`rank\` integer NOT NULL,
	\`grants\` text DEFAULT '[]' NOT NULL,
	\`denies\` text DEFAULT '[]' NOT NULL,
	\`builtin\` integer DEFAULT false NOT NULL
) STRICT;

CREATE TABLE \`auth_sessions\` (
	\`token_hash\` text PRIMARY KEY,
	\`platform\` text NOT NULL,
	\`external_id\` text NOT NULL,
	\`name\` text NOT NULL,
	\`avatar_url\` text,
	\`tier\` text NOT NULL,
	\`created_at\` integer NOT NULL,
	\`expires_at\` integer NOT NULL,
	CONSTRAINT "auth_sessions_tier_check" CHECK("tier" IN ('admin','member'))
) STRICT;

CREATE INDEX \`auth_assignments_role_idx\` ON \`auth_assignments\` (\`role\`);

CREATE INDEX \`auth_sessions_expires_idx\` ON \`auth_sessions\` (\`expires_at\`);
`;

/** Roles, role assignments and mappings, node overrides and panel sessions. */
export const authSchema: PluginSchema = {
  plugin: "auth",
  requires: ["identity"],
  migrations: [{ version: 1, name: "init", sql: INIT }],
};
