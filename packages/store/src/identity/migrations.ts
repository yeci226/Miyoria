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

// v2, phase 6 (docs/design/v5-places.md §5): the primary Space, and a person's Spaces by account.
// An install that already has servers makes primary the one she is still in with the most
// members (then the oldest, then the lowest id): for the single-server install, its only server.
// A database with no Space gets none; the first one `Identity` sees later becomes primary. Columns
// and indexes as drizzle-kit writes them from `schema.ts`; the UPDATE is by hand.
const PLACES = `ALTER TABLE \`spaces\` ADD \`is_primary\` integer DEFAULT false NOT NULL;

UPDATE \`spaces\` SET \`is_primary\` = 1 WHERE \`id\` = (
	SELECT s.\`id\` FROM \`spaces\` s WHERE s.\`left_at\` IS NULL
	ORDER BY (SELECT COUNT(*) FROM \`space_members\` m WHERE m.\`space_id\` = s.\`id\`) DESC, s.\`joined_at\`, s.\`id\`
	LIMIT 1
);

CREATE INDEX \`space_members_account_idx\` ON \`space_members\` (\`account_id\`) WHERE "space_members"."left_at" IS NULL;

CREATE UNIQUE INDEX \`spaces_primary_idx\` ON \`spaces\` (\`is_primary\`) WHERE "spaces"."is_primary" = 1;
`;

// v3, phase 6 (docs/design/v5-places.md §2): anyone who acts in a Space is its member, not only
// someone who wrote there. Until now only a message made a member; this gives the members the log
// can prove to the people who acted there before without a `space_members` row. Only rows that
// name the Space: an event's own `space_id` (identity resolved it from the event's context) with
// the account that acted (`account_id`), and the people her voice presence lines saw in one of the
// Space's voice channels (`voice.joined` / `voice.participants`, kept in the facts observation
// with their accounts; never her own, `is_self`). Only accounts identity already has, on the
// Space's platform, and never hers. An existing row is never touched, so someone who left stays
// left. A command left no such trace: whoever only used commands becomes a member the next time
// they act there. Data only; by hand.
const ACTED = `WITH voice AS MATERIALIZED (
	SELECT e.\`space_id\`, e.\`at\`, e.\`data\` FROM \`events\` e
	WHERE e.\`type\` IN ('facts.observation', 'facts.observation.ambient')
		AND e.\`space_id\` IS NOT NULL AND e.\`redacted_at\` IS NULL AND json_valid(e.\`data\`)
		AND json_extract(e.\`data\`, '$.origin.topic') IN ('voice.joined', 'voice.participants')
),
acted (\`space_id\`, \`account_id\`, \`at\`) AS (
	SELECT e.\`space_id\`, e.\`account_id\`, e.\`at\` FROM \`events\` e
	WHERE e.\`space_id\` IS NOT NULL AND e.\`account_id\` IS NOT NULL
	UNION ALL
	SELECT v.\`space_id\`, a.\`id\`, v.\`at\`
	FROM voice v, json_each(v.\`data\`, '$.origin.event.data.participants') p, \`accounts\` a
	WHERE json_extract(p.\`value\`, '$.is_self') IS 0
		AND a.\`platform\` = json_extract(p.\`value\`, '$.account.platform')
		AND a.\`external_id\` = json_extract(p.\`value\`, '$.account.id')
)
INSERT INTO \`space_members\` (\`space_id\`, \`account_id\`, \`last_seen\`)
SELECT x.\`space_id\`, x.\`account_id\`, MAX(x.\`at\`)
FROM acted x
JOIN \`spaces\` s ON s.\`id\` = x.\`space_id\`
JOIN \`accounts\` a ON a.\`id\` = x.\`account_id\` AND a.\`platform\` = s.\`platform\` AND a.\`is_self\` = 0
WHERE NOT EXISTS (
	SELECT 1 FROM \`space_members\` m WHERE m.\`space_id\` = x.\`space_id\` AND m.\`account_id\` = x.\`account_id\`
)
GROUP BY x.\`space_id\`, x.\`account_id\`;
`;

// v4, phase 6 (docs/design/v5-places.md §1): which Spaces were already hers before servers were
// told apart. Every Space that exists when this runs is established, the primary and every other
// server she was already in (one she left too: its row existed, so coming back is coming home):
// each goes on as it did, with the cluster's settings. A Space first seen later starts quiet until
// someone sets it up; the first Space of a fresh install (the primary) is established when it is
// made (`Identity`). The column as drizzle-kit writes it from `schema.ts`; the UPDATE by hand.
const ESTABLISHED = `ALTER TABLE \`spaces\` ADD \`established\` integer DEFAULT false NOT NULL;

UPDATE \`spaces\` SET \`established\` = 1;
`;

/** Persons, accounts, link codes, spaces, rooms, sessions and space members. */
export const identitySchema: PluginSchema = {
  plugin: "identity",
  migrations: [
    { version: 1, name: "init", sql: INIT },
    { version: 2, name: "places", sql: PLACES },
    { version: 3, name: "members_who_acted", sql: ACTED },
    { version: 4, name: "established", sql: ESTABLISHED },
  ],
};
