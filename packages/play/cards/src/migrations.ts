// The `cards` plugin's migrations (docs/design/v5-data.md §3.2, docs/design/v5-play.md §2, §6.3).
//
// Generated from the Drizzle tables in `schema.ts` with `pnpm --filter @miyoria/store schema:sql
// cards` (drizzle-kit, plus `STRICT`; for a later migration, what the migrated database lacks),
// migration 1 then the catalogue of `catalogue.ts` seeded by hand (`CARDS_CATALOGUE_SQL`; a test
// keeps the migrated catalogue equal to `SEED_PARTS`). Never edited after they are released: the
// runner refuses a database whose recorded checksum differs. A later change of the catalogue is a
// new migration (migration 9), never an edit of this one. The store's drift test proves the
// migrated database and the Drizzle tables agree.

import type { PluginSchema } from "@miyoria/store";

const TABLES = `CREATE TABLE \`cards_card\` (
	\`serial\` text PRIMARY KEY,
	\`person_id\` text NOT NULL,
	\`kind\` text NOT NULL,
	\`rarity\` text NOT NULL,
	\`parts\` text NOT NULL,
	\`face\` text DEFAULT '{}' NOT NULL,
	\`relationship\` text DEFAULT '{}' NOT NULL,
	\`artifact_id\` text,
	\`price\` integer DEFAULT 0 NOT NULL,
	\`pity_hit\` integer DEFAULT false NOT NULL,
	\`wished\` text DEFAULT '[]' NOT NULL,
	\`frame\` text,
	\`created_at\` integer NOT NULL,
	CONSTRAINT "cards_card_kind_check" CHECK("kind" IN ('daily', 'milestone', 'keepsake', 'drop')),
	CONSTRAINT "cards_card_rarity_check" CHECK("rarity" IN ('N', 'R', 'SR', 'SSR')),
	CONSTRAINT "cards_card_price_check" CHECK("price" >= 0)
) STRICT;

CREATE TABLE \`cards_dex\` (
	\`person_id\` text NOT NULL,
	\`part_id\` text NOT NULL,
	\`first_at\` integer NOT NULL,
	\`first_card\` text,
	\`count\` integer DEFAULT 1 NOT NULL,
	CONSTRAINT \`cards_dex_pk\` PRIMARY KEY(\`person_id\`, \`part_id\`),
	CONSTRAINT \`fk_cards_dex_part_id_cards_parts_id_fk\` FOREIGN KEY (\`part_id\`) REFERENCES \`cards_parts\`(\`id\`),
	CONSTRAINT "cards_dex_count_check" CHECK("count" >= 1)
) STRICT;

CREATE TABLE \`cards_legacy\` (
	\`id\` text PRIMARY KEY,
	\`account_id\` text NOT NULL,
	\`item\` text NOT NULL,
	\`name\` text NOT NULL,
	\`rarity\` text NOT NULL,
	\`series\` text,
	\`source\` text NOT NULL,
	\`acquired_at\` integer NOT NULL,
	CONSTRAINT \`fk_cards_legacy_account_id_accounts_id_fk\` FOREIGN KEY (\`account_id\`) REFERENCES \`accounts\`(\`id\`) ON DELETE CASCADE
) STRICT;

CREATE TABLE \`cards_parts\` (
	\`id\` text PRIMARY KEY,
	\`slot\` text NOT NULL,
	\`rarity\` text NOT NULL,
	\`series\` text,
	\`name\` text NOT NULL,
	\`weight\` real DEFAULT 1 NOT NULL,
	\`enabled\` integer DEFAULT true NOT NULL,
	\`drop_only\` integer DEFAULT false NOT NULL,
	\`blank\` integer DEFAULT false NOT NULL,
	CONSTRAINT "cards_parts_slot_check" CHECK("slot" IN ('hand', 'accessory', 'outfit', 'pose', 'background')),
	CONSTRAINT "cards_parts_rarity_check" CHECK("rarity" IN ('N', 'R', 'SR', 'SSR')),
	CONSTRAINT "cards_parts_weight_check" CHECK("weight" > 0)
) STRICT;

CREATE TABLE \`cards_pity\` (
	\`person_id\` text PRIMARY KEY,
	\`since\` integer DEFAULT 0 NOT NULL,
	\`drawn\` integer DEFAULT 0 NOT NULL,
	\`updated_at\` integer NOT NULL,
	CONSTRAINT "cards_pity_check" CHECK("since" >= 0 AND "drawn" >= 0)
) STRICT;

CREATE TABLE \`cards_titles\` (
	\`person_id\` text NOT NULL,
	\`series\` text NOT NULL,
	\`title\` text NOT NULL,
	\`card\` text,
	\`public\` integer DEFAULT false NOT NULL,
	\`earned_at\` integer NOT NULL,
	CONSTRAINT \`cards_titles_pk\` PRIMARY KEY(\`person_id\`, \`series\`)
) STRICT;

CREATE TABLE \`cards_wishlist\` (
	\`person_id\` text NOT NULL,
	\`part_id\` text NOT NULL,
	\`position\` integer NOT NULL,
	\`added_at\` integer NOT NULL,
	CONSTRAINT \`cards_wishlist_pk\` PRIMARY KEY(\`person_id\`, \`part_id\`),
	CONSTRAINT \`fk_cards_wishlist_part_id_cards_parts_id_fk\` FOREIGN KEY (\`part_id\`) REFERENCES \`cards_parts\`(\`id\`),
	CONSTRAINT "cards_wishlist_position_check" CHECK("position" BETWEEN 1 AND 3)
) STRICT;

CREATE INDEX \`cards_card_person_idx\` ON \`cards_card\` (\`person_id\`,\`created_at\`);

CREATE INDEX \`cards_card_day_idx\` ON \`cards_card\` (\`person_id\`,\`kind\`,\`created_at\`);

CREATE INDEX \`cards_legacy_account_idx\` ON \`cards_legacy\` (\`account_id\`,\`acquired_at\`);

CREATE UNIQUE INDEX \`cards_wishlist_position_idx\` ON \`cards_wishlist\` (\`person_id\`,\`position\`);
`;

/** The catalogue of `SEED_PARTS` (`catalogue.ts`), as released, after the generated tables. */
export const CARDS_CATALOGUE_SQL = `INSERT INTO \`cards_parts\` (\`id\`, \`slot\`, \`rarity\`, \`series\`, \`name\`, \`weight\`, \`enabled\`, \`drop_only\`, \`blank\`) VALUES
	('hand.none', 'hand', 'N', NULL, '空手', 1, 1, 0, 1),
	('hand.finger', 'hand', 'R', 'hands', '豎食指', 1, 1, 0, 0),
	('hand.chest', 'hand', 'R', 'hands', '撫胸', 1, 1, 0, 0),
	('hand.foxtail', 'hand', 'R', 'hands', '狗尾草', 1, 1, 0, 0),
	('accessory.none', 'accessory', 'N', NULL, '無配件', 2, 1, 0, 1),
	('accessory.glasses', 'accessory', 'N', 'glasses', '黑框眼鏡', 1, 1, 0, 0),
	('accessory.tail', 'accessory', 'R', 'curios', '尾巴', 1, 1, 0, 0),
	('accessory.monocle', 'accessory', 'SR', 'glasses', '單片眼鏡', 1, 1, 0, 0),
	('accessory.basin', 'accessory', 'SR', 'curios', '大鋼盆', 1, 1, 0, 0),
	('accessory.monocle_tail', 'accessory', 'SSR', 'curios', '單片眼鏡和尾巴', 1, 1, 0, 0),
	('outfit.usual', 'outfit', 'N', 'wardrobe', '平常的衣服', 1, 1, 0, 0),
	('outfit.long_skirt', 'outfit', 'R', 'wardrobe', '長裙', 1, 1, 0, 0),
	('outfit.short_skirt', 'outfit', 'R', 'wardrobe', '短裙', 1, 1, 0, 0),
	('outfit.shoes', 'outfit', 'R', 'wardrobe', '換一雙鞋', 1, 1, 0, 0),
	('outfit.top', 'outfit', 'R', 'wardrobe', '胸口的衣服', 1, 1, 0, 0),
	('pose.front', 'pose', 'N', 'poses', '正面', 1, 1, 0, 0),
	('pose.tilt_left', 'pose', 'N', 'poses', '歪頭(左)', 1, 1, 0, 0),
	('pose.tilt_right', 'pose', 'N', 'poses', '歪頭(右)', 1, 1, 0, 0),
	('pose.look_up', 'pose', 'N', 'poses', '抬頭', 1, 1, 0, 0),
	('pose.lean_in', 'pose', 'R', 'poses', '湊近', 1, 1, 0, 0),
	('pose.shy', 'pose', 'R', 'poses', '害羞低頭', 1, 1, 0, 0),
	('pose.sway', 'pose', 'R', 'poses', '搖擺', 1, 1, 0, 0),
	('pose.turn_left', 'pose', 'R', 'poses', '側身回頭(左)', 1, 1, 0, 0),
	('pose.turn_right', 'pose', 'R', 'poses', '側身回頭(右)', 1, 1, 0, 0),
	('background.gradient_pink', 'background', 'N', 'colours', '她的顏色・粉', 1, 1, 0, 0),
	('background.gradient_blue', 'background', 'N', 'colours', '她的顏色・藍', 1, 1, 0, 0),
	('background.bokeh', 'background', 'N', 'colours', '光斑', 1, 1, 0, 0),
	('background.bokeh_night', 'background', 'R', 'colours', '夜裡的光斑', 1, 1, 0, 0),
	('background.stars', 'background', 'R', 'sky', '星點', 1, 1, 0, 0),
	('background.water', 'background', 'R', 'water', '水面', 1, 1, 0, 0),
	('background.night_sky', 'background', 'SR', 'sky', '夜空', 1, 1, 0, 0),
	('background.moon_water', 'background', 'SR', 'water', '月下的水面', 1, 1, 0, 0),
	('background.meteor', 'background', 'SSR', 'sky', '流星夜空', 1, 1, 0, 0),
	('background.aurora', 'background', 'SSR', 'sky', '極光', 1, 1, 0, 0),
	('background.fireworks', 'background', 'SR', NULL, '頻道裡的煙火', 1, 1, 1, 0);
`;

/**
 * Migration 2 (`schema:sql cards`): what a card was issued for, once per person (a milestone's
 * tier, the keepsake), so it is never issued twice, a restart included.
 */
const ISSUE_KEY = `ALTER TABLE \`cards_card\` ADD \`issue_key\` text;
CREATE UNIQUE INDEX \`cards_card_key_idx\` ON \`cards_card\` (\`person_id\`,\`issue_key\`);
`;

/**
 * Migration 3: the cards she drops in a channel (§6.2). `schema:sql cards` stops at drizzle-kit's
 * "rename or create?" question for a new table, so this is the script's `createSql` of the new
 * table alone (what migration 1 is made of); the drift test checks it like the rest.
 */
const DROPS = `CREATE TABLE \`cards_drop\` (
	\`id\` text PRIMARY KEY,
	\`channel\` text NOT NULL,
	\`created_at\` integer NOT NULL,
	\`expires_at\` integer NOT NULL,
	\`claimed_by\` text,
	\`claimed_at\` integer,
	\`serial\` text
) STRICT;

CREATE INDEX \`cards_drop_channel_idx\` ON \`cards_drop\` (\`channel\`,\`created_at\`);

CREATE INDEX \`cards_drop_claimed_idx\` ON \`cards_drop\` (\`claimed_by\`);
`;

/**
 * Migration 4: a paid card's request key kept across a restart (`cards_pending`, and the card's
 * own `issue_key`), made like migration 3.
 */
const PENDING = `CREATE TABLE \`cards_pending\` (
	\`person_id\` text NOT NULL,
	\`issue_key\` text NOT NULL,
	\`serial\` text NOT NULL,
	\`created_at\` integer NOT NULL,
	CONSTRAINT \`cards_pending_pk\` PRIMARY KEY(\`person_id\`, \`issue_key\`)
) STRICT;
`;

/**
 * Migration 5: who was given their keepsake card (`cards_keepsake`), kept when they are forgotten
 * so nobody gets a second one; made like migration 3, then filled from the keepsake cards already
 * there (by hand: drizzle-kit does not write data).
 */
const KEEPSAKE = `CREATE TABLE \`cards_keepsake\` (
	\`person_id\` text PRIMARY KEY,
	\`given_at\` integer NOT NULL
) STRICT;

INSERT OR IGNORE INTO \`cards_keepsake\` (\`person_id\`, \`given_at\`)
	SELECT \`person_id\`, min(\`created_at\`) FROM \`cards_card\` WHERE \`kind\` = 'keepsake' GROUP BY \`person_id\`;
`;

/**
 * Migration 6 (`schema:sql cards`): whether a kept paid card was ordered with a foil finish, so a
 * retry is the same order. A row kept before it was ordered without one, as the old code charged
 * the foil apart from the card.
 */
const PENDING_FOIL = `ALTER TABLE \`cards_pending\` ADD \`foil\` integer DEFAULT false NOT NULL;
`;

/**
 * Migration 7: what the day's limits count, apart from the cards (`cards_tally`), so a forget
 * resets none of them; made like migration 3 (`schema:sql cards` stops at the new table's "rename
 * or create?"), then filled from the daily and dropped cards of the last two days (by hand), so
 * the day the migration runs keeps its count.
 */
const TALLY = `CREATE TABLE \`cards_tally\` (
	\`person_id\` text NOT NULL,
	\`kind\` text NOT NULL,
	\`at\` integer NOT NULL
) STRICT;

CREATE INDEX \`cards_tally_person_idx\` ON \`cards_tally\` (\`person_id\`,\`kind\`,\`at\`);

CREATE INDEX \`cards_tally_at_idx\` ON \`cards_tally\` (\`at\`);

INSERT INTO \`cards_tally\` (\`person_id\`, \`kind\`, \`at\`)
	SELECT \`person_id\`, \`kind\`, \`created_at\` FROM \`cards_card\`
	WHERE \`kind\` IN ('daily', 'drop') AND \`created_at\` >= (CAST(strftime('%s', 'now') AS INTEGER) - 172800) * 1000000;
`;

/**
 * Migration 8: the tiers each person was given a milestone card for (`cards_milestone`), kept when
 * they are forgotten so no tier gives a second card; made like migration 3, then filled from the
 * milestone cards already there (by hand), each at its earliest card.
 */
const MILESTONES = `CREATE TABLE \`cards_milestone\` (
	\`person_id\` text NOT NULL,
	\`tier_min\` integer NOT NULL,
	\`given_at\` integer NOT NULL,
	CONSTRAINT \`cards_milestone_pk\` PRIMARY KEY(\`person_id\`, \`tier_min\`)
) STRICT;

INSERT OR IGNORE INTO \`cards_milestone\` (\`person_id\`, \`tier_min\`, \`given_at\`)
	SELECT \`person_id\`, CAST(substr(\`issue_key\`, 11) AS INTEGER), min(\`created_at\`) FROM \`cards_card\`
	WHERE \`kind\` = 'milestone' AND \`issue_key\` LIKE 'milestone:%' GROUP BY \`person_id\`, \`issue_key\`;
`;

/**
 * Migration 9: 「短裙」 is taken out of the draw (owner decision 2026-11-17: it draws the same
 * picture as 平常的衣服). A catalogue change, by hand (drizzle-kit does not write data): the part
 * is disabled, so no card gives it, it cannot be wished for and its series no longer counts it;
 * the cards and dex rows that have it keep it.
 */
const SHORT_SKIRT_OFF = `UPDATE \`cards_parts\` SET \`enabled\` = 0 WHERE \`id\` = 'outfit.short_skirt';
`;

/** Her cards for each person, the catalogue they are drawn from, the pity, the dex, wishes, titles. */
export const cardsSchema: PluginSchema = {
  plugin: "cards",
  requires: ["identity"],
  migrations: [
    { version: 1, name: "init", sql: `${TABLES}\n${CARDS_CATALOGUE_SQL}` },
    { version: 2, name: "issue_key", sql: ISSUE_KEY },
    { version: 3, name: "drops", sql: DROPS },
    { version: 4, name: "pending", sql: PENDING },
    { version: 5, name: "keepsake", sql: KEEPSAKE },
    { version: 6, name: "pending_foil", sql: PENDING_FOIL },
    { version: 7, name: "tally", sql: TALLY },
    { version: 8, name: "milestones", sql: MILESTONES },
    { version: 9, name: "short_skirt_off", sql: SHORT_SKIRT_OFF },
  ],
};
