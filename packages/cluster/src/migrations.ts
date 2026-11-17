// The `cluster` plugin's migrations (docs/design/v5-data.md §3.2).
//
// Generated from the Drizzle tables in `schema.ts` with drizzle-kit (the store's
// `scripts/schema-sql.ts`, plus `STRICT`) and never edited after they are released: the runner
// refuses a database whose recorded checksum differs.

import type { PluginSchema } from "@miyoria/store";

const INIT = `CREATE TABLE \`cluster_hosts\` (
	\`id\` text PRIMARY KEY,
	\`name\` text NOT NULL,
	\`key_hash\` text NOT NULL,
	\`status\` text NOT NULL,
	\`capabilities\` text DEFAULT '[]' NOT NULL,
	\`platform\` text,
	\`version\` text,
	\`created_at\` integer NOT NULL,
	\`last_seen_at\` integer,
	CONSTRAINT "cluster_hosts_status_check" CHECK("status" IN ('pending','approved','revoked'))
) STRICT;

CREATE TABLE \`cluster_invites\` (
	\`code_hash\` text PRIMARY KEY,
	\`name\` text,
	\`expires_at\` integer NOT NULL,
	\`used_at\` integer,
	\`created_by\` text NOT NULL
) STRICT;

CREATE UNIQUE INDEX \`cluster_hosts_name_idx\` ON \`cluster_hosts\` (\`name\`);

CREATE INDEX \`cluster_invites_expires_idx\` ON \`cluster_invites\` (\`expires_at\`);
`;

/** The hosts that joined and the codes to join with. */
export const clusterSchema: PluginSchema = {
  plugin: "cluster",
  migrations: [{ version: 1, name: "init", sql: INIT }],
};
