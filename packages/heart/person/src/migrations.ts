// The `heart` plugin's migrations (docs/design/v5-heart.md §2.2).
//
// Generated from the Drizzle tables in `schema.ts` with `pnpm --filter @miyoria/store schema:sql
// heart` (drizzle-kit, plus `STRICT`) and never edited after they are released: the runner
// refuses a database whose recorded checksum differs. The store's drift test proves the migrated
// database and the Drizzle tables agree.

import type { PluginSchema } from "@miyoria/store";

const INIT = `CREATE TABLE \`heart_person\` (
	\`person_id\` text PRIMARY KEY,
	\`bond\` real DEFAULT 0 NOT NULL,
	\`trust\` real NOT NULL,
	\`familiarity\` real DEFAULT 0 NOT NULL,
	\`warmth\` real DEFAULT 0 NOT NULL,
	\`respect\` real DEFAULT 0 NOT NULL,
	\`ease\` real DEFAULT 0 NOT NULL,
	\`grudge\` real DEFAULT 0 NOT NULL,
	\`longing\` real DEFAULT 0 NOT NULL,
	\`rapport\` real DEFAULT 0 NOT NULL,
	\`stance\` text DEFAULT '' NOT NULL,
	\`impression\` text DEFAULT '' NOT NULL,
	\`unfinished\` text DEFAULT '' NOT NULL,
	\`jokes\` text DEFAULT '' NOT NULL,
	\`dislikes\` text DEFAULT '' NOT NULL,
	\`public_feeling\` text,
	\`call_name\` text,
	\`tags\` text DEFAULT '[]' NOT NULL,
	\`tier_floor\` integer DEFAULT 0 NOT NULL,
	\`anchors\` text DEFAULT '[]' NOT NULL,
	\`interactions\` integer DEFAULT 0 NOT NULL,
	\`last_interaction\` integer,
	\`last_seen\` integer,
	\`last_together\` integer,
	\`decayed_on\` integer,
	\`legacy\` text DEFAULT '{}' NOT NULL,
	\`created_at\` integer NOT NULL,
	\`updated_at\` integer NOT NULL,
	CONSTRAINT "heart_person_bond_check" CHECK("bond" BETWEEN -100 AND 1000),
	CONSTRAINT "heart_person_range_check" CHECK("trust" BETWEEN 0 AND 100 AND "familiarity" BETWEEN 0 AND 100 AND "warmth" BETWEEN -1 AND 1 AND "respect" BETWEEN -1 AND 1),
	CONSTRAINT "heart_person_unit_check" CHECK("ease" BETWEEN 0 AND 1 AND "grudge" BETWEEN 0 AND 1 AND "longing" BETWEEN 0 AND 1 AND "rapport" BETWEEN 0 AND 1)
) STRICT;

CREATE TABLE \`heart_self\` (
	\`id\` integer PRIMARY KEY,
	\`state\` text NOT NULL,
	\`updated_at\` integer NOT NULL,
	CONSTRAINT "heart_self_id_check" CHECK("id" = 1)
) STRICT;

CREATE INDEX \`heart_person_bond_idx\` ON \`heart_person\` (\`bond\`,\`person_id\`);

CREATE INDEX \`heart_person_decayed_idx\` ON \`heart_person\` (\`decayed_on\`);
`;

/** Her numbers and words for each person, and her own state. */
export const heartSchema: PluginSchema = {
  plugin: "heart",
  requires: ["identity"],
  migrations: [{ version: 1, name: "init", sql: INIT }],
};
