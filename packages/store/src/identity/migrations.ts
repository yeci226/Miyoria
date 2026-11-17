// The `identity` plugin's migrations (docs/design/v5-data.md §4.1).
//
// Generated from the Drizzle tables in `schema.ts` with `pnpm --filter @miyoria/store schema:sql
// identity` (drizzle-kit, plus `STRICT`) and never edited after they are released: the runner
// refuses a database whose recorded checksum differs. `test/identity-schema.test.ts` proves the
// migrated database and the Drizzle tables agree. The tables carry no prefix: identity is core.

import type { PluginSchema } from "../migrate.js";

const INIT = `CREATE TABLE \`accounts\` (
	\`id\` text PRIMARY KEY,
	\`platform\` text NOT NULL,
	\`external_id\` text NOT NULL,
	\`person_id\` text,
	\`display_name\` text NOT NULL,
	\`is_self\` integer DEFAULT false NOT NULL,
	\`first_seen\` integer NOT NULL,
	\`last_seen\` integer NOT NULL,
	\`linked_at\` integer,
	\`linked_by\` text,
	CONSTRAINT \`fk_accounts_person_id_persons_id_fk\` FOREIGN KEY (\`person_id\`) REFERENCES \`persons\`(\`id\`),
	CONSTRAINT \`accounts_platform_external_id_key\` UNIQUE(\`platform\`,\`external_id\`),
	CONSTRAINT "accounts_linked_by_check" CHECK("linked_by" IN ('first_sight','code','owner','import'))
) STRICT;

CREATE TABLE \`link_codes\` (
	\`code_hash\` text PRIMARY KEY,
	\`account_id\` text NOT NULL,
	\`expires_at\` integer NOT NULL,
	CONSTRAINT \`fk_link_codes_account_id_accounts_id_fk\` FOREIGN KEY (\`account_id\`) REFERENCES \`accounts\`(\`id\`) ON DELETE CASCADE
) STRICT;

CREATE TABLE \`persons\` (
	\`id\` text PRIMARY KEY,
	\`name\` text NOT NULL,
	\`handle\` text NOT NULL,
	\`prefs\` text DEFAULT '{}' NOT NULL,
	\`created_at\` integer NOT NULL,
	\`merged_into\` text,
	\`legacy\` text,
	CONSTRAINT \`fk_persons_merged_into_persons_id_fk\` FOREIGN KEY (\`merged_into\`) REFERENCES \`persons\`(\`id\`)
) STRICT;

CREATE TABLE \`rooms\` (
	\`id\` text PRIMARY KEY,
	\`platform\` text NOT NULL,
	\`external_id\` text NOT NULL,
	\`space_id\` text,
	\`parent_id\` text,
	\`kind\` text NOT NULL,
	\`name\` text,
	\`caps\` text DEFAULT '{}' NOT NULL,
	\`dm_person\` text,
	\`created_at\` integer NOT NULL,
	\`archived_at\` integer,
	CONSTRAINT \`fk_rooms_space_id_spaces_id_fk\` FOREIGN KEY (\`space_id\`) REFERENCES \`spaces\`(\`id\`),
	CONSTRAINT \`fk_rooms_parent_id_rooms_id_fk\` FOREIGN KEY (\`parent_id\`) REFERENCES \`rooms\`(\`id\`),
	CONSTRAINT \`fk_rooms_dm_person_persons_id_fk\` FOREIGN KEY (\`dm_person\`) REFERENCES \`persons\`(\`id\`),
	CONSTRAINT \`rooms_platform_external_id_key\` UNIQUE(\`platform\`,\`external_id\`),
	CONSTRAINT "rooms_kind_check" CHECK("kind" IN ('text','voice','thread','forum','stage','dm'))
) STRICT;

CREATE TABLE \`sessions\` (
	\`key\` text PRIMARY KEY,
	\`space_id\` text,
	\`room_id\` text,
	\`person_id\` text,
	\`lane\` text DEFAULT 'text' NOT NULL,
	\`created_at\` integer NOT NULL,
	\`last_at\` integer NOT NULL,
	CONSTRAINT \`fk_sessions_space_id_spaces_id_fk\` FOREIGN KEY (\`space_id\`) REFERENCES \`spaces\`(\`id\`),
	CONSTRAINT \`fk_sessions_room_id_rooms_id_fk\` FOREIGN KEY (\`room_id\`) REFERENCES \`rooms\`(\`id\`),
	CONSTRAINT \`fk_sessions_person_id_persons_id_fk\` FOREIGN KEY (\`person_id\`) REFERENCES \`persons\`(\`id\`),
	CONSTRAINT "sessions_lane_check" CHECK("lane" IN ('text','voice','home'))
) STRICT;

CREATE TABLE \`space_members\` (
	\`space_id\` text NOT NULL,
	\`account_id\` text NOT NULL,
	\`nick\` text,
	\`roles\` text DEFAULT '[]' NOT NULL,
	\`joined_at\` integer,
	\`left_at\` integer,
	\`last_seen\` integer NOT NULL,
	CONSTRAINT \`space_members_pk\` PRIMARY KEY(\`space_id\`, \`account_id\`),
	CONSTRAINT \`fk_space_members_space_id_spaces_id_fk\` FOREIGN KEY (\`space_id\`) REFERENCES \`spaces\`(\`id\`),
	CONSTRAINT \`fk_space_members_account_id_accounts_id_fk\` FOREIGN KEY (\`account_id\`) REFERENCES \`accounts\`(\`id\`)
) STRICT;

CREATE TABLE \`spaces\` (
	\`id\` text PRIMARY KEY,
	\`platform\` text NOT NULL,
	\`external_id\` text NOT NULL,
	\`name\` text NOT NULL,
	\`joined_at\` integer NOT NULL,
	\`left_at\` integer,
	CONSTRAINT \`spaces_platform_external_id_key\` UNIQUE(\`platform\`,\`external_id\`)
) STRICT;

CREATE INDEX \`accounts_person_idx\` ON \`accounts\` (\`person_id\`) WHERE "accounts"."person_id" IS NOT NULL;

CREATE UNIQUE INDEX \`persons_handle_idx\` ON \`persons\` ("handle" COLLATE NOCASE);

CREATE INDEX \`rooms_space_idx\` ON \`rooms\` (\`space_id\`);
`;

/** Persons, accounts, link codes, spaces, rooms, sessions and space members. */
export const identitySchema: PluginSchema = {
  plugin: "identity",
  migrations: [{ version: 1, name: "init", sql: INIT }],
};
