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

/** What Core measured of each host, and the owner's routing controls (v5-hostd §15). */
const ROUTING = `CREATE TABLE \`cluster_controls\` (
	\`kind\` text NOT NULL,
	\`capability\` text DEFAULT '' NOT NULL,
	\`host\` text NOT NULL,
	\`value\` real,
	\`by\` text NOT NULL,
	\`at\` integer NOT NULL,
	CONSTRAINT \`cluster_controls_pk\` PRIMARY KEY(\`kind\`, \`capability\`, \`host\`),
	CONSTRAINT "cluster_controls_kind_check" CHECK("kind" IN ('pin','exclude','weight','drain'))
) STRICT;

CREATE TABLE \`cluster_estimates\` (
	\`host\` text NOT NULL,
	\`capability\` text NOT NULL,
	\`unit_ms\` real,
	\`unit_n\` integer DEFAULT 0 NOT NULL,
	\`rate_bps\` real,
	\`rate_n\` integer DEFAULT 0 NOT NULL,
	\`size_bytes\` real,
	\`size_n\` integer DEFAULT 0 NOT NULL,
	\`updated_at\` integer NOT NULL,
	CONSTRAINT \`cluster_estimates_pk\` PRIMARY KEY(\`host\`, \`capability\`)
) STRICT;
`;

/** The hosts that joined and the codes to join with; the estimates and controls of routing. */
export const clusterSchema: PluginSchema = {
  plugin: "cluster",
  migrations: [
    { version: 1, name: "init", sql: INIT },
    { version: 2, name: "routing", sql: ROUTING },
  ],
};
