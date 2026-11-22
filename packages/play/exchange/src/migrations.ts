// The `exchange` plugin's migrations (docs/design/v5-data.md §3.2, exchange.md §11).
//
// Generated from the Drizzle tables in `schema.ts` with `pnpm --filter @miyoria/store schema:sql
// exchange` (drizzle-kit, plus `STRICT`) and never edited after they are released: the runner
// refuses a database whose recorded checksum differs. The store's drift test proves the migrated
// database and the Drizzle tables agree.

import type { PluginSchema } from "@miyoria/store";

const INIT = `CREATE TABLE \`exchange_accounts\` (
	\`person_id\` text PRIMARY KEY,
	\`opened_at\` integer NOT NULL,
	\`leverage_at\` integer,
	\`hide_boards\` integer DEFAULT false NOT NULL,
	\`show_holdings\` integer DEFAULT false NOT NULL,
	\`updated_at\` integer NOT NULL
) STRICT;

CREATE TABLE \`exchange_fills\` (
	\`id\` text PRIMARY KEY,
	\`order_id\` text,
	\`person_id\` text NOT NULL,
	\`company\` text NOT NULL,
	\`side\` text NOT NULL,
	\`kind\` text NOT NULL,
	\`position_id\` text,
	\`leverage\` integer NOT NULL,
	\`qty\` integer NOT NULL,
	\`price\` integer NOT NULL,
	\`gross\` integer NOT NULL,
	\`fee\` integer NOT NULL,
	\`tax\` integer NOT NULL,
	\`carry\` integer NOT NULL,
	\`paid\` integer NOT NULL,
	\`vault\` integer NOT NULL,
	\`round\` integer NOT NULL,
	\`by\` text,
	\`created_at\` integer NOT NULL,
	CONSTRAINT "exchange_fills_kind_check" CHECK("kind" IN ('order', 'liquidation', 'admin', 'owed')),
	CONSTRAINT "exchange_fills_paid_check" CHECK("paid" >= 0)
) STRICT;

CREATE TABLE \`exchange_news\` (
	\`id\` text PRIMARY KEY,
	\`round\` integer NOT NULL,
	\`day\` integer NOT NULL,
	\`company\` text,
	\`kind\` text NOT NULL,
	\`direction\` text NOT NULL,
	\`size\` text NOT NULL,
	\`move\` real NOT NULL,
	\`headline\` text,
	\`body\` text,
	\`worded_by\` text,
	\`created_at\` integer NOT NULL,
	\`worded_at\` integer,
	CONSTRAINT "exchange_news_kind_check" CHECK("kind" IN ('event', 'earnings'))
) STRICT;

CREATE TABLE \`exchange_notices\` (
	\`id\` text PRIMARY KEY,
	\`person_id\` text NOT NULL,
	\`kind\` text NOT NULL,
	\`position_id\` text,
	\`order_id\` text,
	\`round\` integer NOT NULL,
	\`text\` text NOT NULL,
	\`created_at\` integer NOT NULL,
	\`sent_at\` integer
) STRICT;

CREATE TABLE \`exchange_orders\` (
	\`id\` text PRIMARY KEY,
	\`person_id\` text NOT NULL,
	\`platform\` text NOT NULL,
	\`account_id\` text NOT NULL,
	\`name\` text NOT NULL,
	\`request_key\` text NOT NULL,
	\`company\` text NOT NULL,
	\`side\` text NOT NULL,
	\`kind\` text NOT NULL,
	\`limit_price\` integer,
	\`coins\` integer NOT NULL,
	\`margin\` integer NOT NULL,
	\`exposure\` integer NOT NULL,
	\`fee\` integer NOT NULL,
	\`leverage\` integer NOT NULL,
	\`qty\` integer NOT NULL,
	\`position_id\` text,
	\`placed_round\` integer NOT NULL,
	\`expires_day\` integer NOT NULL,
	\`status\` text NOT NULL,
	\`why\` text,
	\`fill_id\` text,
	\`created_at\` integer NOT NULL,
	\`ended_at\` integer,
	CONSTRAINT "exchange_orders_status_check" CHECK("status" IN ('charging', 'open', 'filled', 'cancelled', 'expired', 'void')),
	CONSTRAINT "exchange_orders_side_check" CHECK("side" IN ('buy', 'sell')),
	CONSTRAINT "exchange_orders_kind_check" CHECK("kind" IN ('market', 'limit')),
	CONSTRAINT "exchange_orders_amount_check" CHECK("coins" >= 0 AND "margin" >= 0 AND "fee" >= 0 AND "qty" >= 0 AND "leverage" >= 1)
) STRICT;

CREATE TABLE \`exchange_positions\` (
	\`id\` text PRIMARY KEY,
	\`person_id\` text NOT NULL,
	\`company\` text NOT NULL,
	\`leverage\` integer NOT NULL,
	\`qty\` integer NOT NULL,
	\`cost\` integer NOT NULL,
	\`margin\` integer NOT NULL,
	\`loan\` integer NOT NULL,
	\`carry\` integer DEFAULT 0 NOT NULL,
	\`day\` integer NOT NULL,
	\`round\` integer NOT NULL,
	\`warned_half\` integer,
	\`warned_near\` integer,
	\`status\` text NOT NULL,
	\`closed_round\` integer,
	\`created_at\` integer NOT NULL,
	\`closed_at\` integer,
	CONSTRAINT "exchange_positions_status_check" CHECK("status" IN ('open', 'closed', 'liquidated')),
	CONSTRAINT "exchange_positions_amount_check" CHECK("qty" >= 0 AND "cost" >= 0 AND "margin" >= 0 AND "loan" >= 0 AND "carry" >= 0)
) STRICT;

CREATE TABLE \`exchange_postings\` (
	\`key\` text PRIMARY KEY,
	\`person_id\` text NOT NULL,
	\`entries\` text NOT NULL,
	\`ref\` text NOT NULL,
	\`covered\` integer NOT NULL,
	\`status\` text NOT NULL,
	\`created_at\` integer NOT NULL,
	\`posted_at\` integer,
	CONSTRAINT "exchange_postings_status_check" CHECK("status" IN ('pending', 'posted', 'short'))
) STRICT;

CREATE TABLE \`exchange_rounds\` (
	\`round\` integer PRIMARY KEY,
	\`day\` integer NOT NULL,
	\`due_at\` integer NOT NULL,
	\`status\` text NOT NULL,
	\`fish\` real NOT NULL,
	\`level\` real,
	\`vault\` integer NOT NULL,
	\`obligations\` real NOT NULL,
	\`burned\` integer NOT NULL,
	\`volume\` integer NOT NULL,
	\`breaker\` integer DEFAULT false NOT NULL,
	\`prices\` text NOT NULL,
	\`settled_at\` integer NOT NULL,
	CONSTRAINT "exchange_rounds_status_check" CHECK("status" IN ('held', 'skipped', 'halted', 'paused'))
) STRICT;

CREATE TABLE \`exchange_state\` (
	\`id\` integer PRIMARY KEY,
	\`seed\` text NOT NULL,
	\`market\` text NOT NULL,
	\`vault\` integer NOT NULL,
	\`burned\` integer DEFAULT 0 NOT NULL,
	\`held_day\` integer,
	\`owed\` text DEFAULT '[]' NOT NULL,
	\`paused\` integer DEFAULT false NOT NULL,
	\`paused_by\` text,
	\`created_at\` integer NOT NULL,
	\`updated_at\` integer NOT NULL,
	CONSTRAINT "exchange_state_one" CHECK("id" = 1),
	CONSTRAINT "exchange_state_vault_check" CHECK("vault" >= 0 AND "burned" >= 0)
) STRICT;

CREATE TABLE \`exchange_vault\` (
	\`id\` integer PRIMARY KEY AUTOINCREMENT,
	\`round\` integer NOT NULL,
	\`kind\` text NOT NULL,
	\`amount\` integer NOT NULL,
	\`balance\` integer NOT NULL,
	\`ref\` text NOT NULL,
	\`at\` integer NOT NULL,
	CONSTRAINT "exchange_vault_balance_check" CHECK("balance" >= 0),
	CONSTRAINT "exchange_vault_kind_check" CHECK("kind" IN ('buy', 'sell', 'burn', 'owed', 'margin', 'admin'))
) STRICT;

CREATE TABLE \`exchange_words\` (
	\`key\` text PRIMARY KEY,
	\`kind\` text NOT NULL,
	\`day\` integer NOT NULL,
	\`text\` text NOT NULL,
	\`by\` text NOT NULL,
	\`data\` text,
	\`created_at\` integer NOT NULL,
	\`posted_at\` integer
) STRICT;

CREATE INDEX \`exchange_fills_person_idx\` ON \`exchange_fills\` (\`person_id\`,\`created_at\`);

CREATE INDEX \`exchange_fills_round_idx\` ON \`exchange_fills\` (\`round\`);

CREATE INDEX \`exchange_news_company_idx\` ON \`exchange_news\` (\`company\`,\`round\`);

CREATE INDEX \`exchange_news_round_idx\` ON \`exchange_news\` (\`round\`);

CREATE INDEX \`exchange_notices_person_idx\` ON \`exchange_notices\` (\`person_id\`,\`created_at\`);

CREATE INDEX \`exchange_notices_sent_idx\` ON \`exchange_notices\` (\`sent_at\`,\`created_at\`);

CREATE UNIQUE INDEX \`exchange_orders_key_idx\` ON \`exchange_orders\` (\`person_id\`,\`request_key\`);

CREATE INDEX \`exchange_orders_status_idx\` ON \`exchange_orders\` (\`status\`,\`created_at\`);

CREATE INDEX \`exchange_orders_person_idx\` ON \`exchange_orders\` (\`person_id\`,\`created_at\`);

CREATE INDEX \`exchange_positions_person_idx\` ON \`exchange_positions\` (\`person_id\`,\`status\`);

CREATE INDEX \`exchange_positions_status_idx\` ON \`exchange_positions\` (\`status\`,\`company\`);

CREATE INDEX \`exchange_postings_status_idx\` ON \`exchange_postings\` (\`status\`,\`created_at\`);

CREATE INDEX \`exchange_rounds_day_idx\` ON \`exchange_rounds\` (\`day\`);

CREATE INDEX \`exchange_vault_round_idx\` ON \`exchange_vault\` (\`round\`);

CREATE INDEX \`exchange_words_day_idx\` ON \`exchange_words\` (\`day\`);
`;

/**
 * Version 2 (owner 2026-11-21, real prices): the house's state, the last good quotes and their
 * history, the instruments people looked up, the real orders, positions and fills, and the
 * house's own lines. Written the way drizzle-kit generates new
 * tables (`createSql` over these tables alone: `schema:sql` asks to confirm new tables of a plugin
 * that has migrations); the drift test checks it.
 */
const REAL = `CREATE TABLE \`exchange_house\` (
	\`id\` integer PRIMARY KEY,
	\`state\` text NOT NULL,
	\`updated_at\` integer NOT NULL,
	CONSTRAINT "exchange_house_one" CHECK("id" = 1)
) STRICT;

CREATE TABLE \`exchange_house_lines\` (
	\`id\` integer PRIMARY KEY AUTOINCREMENT,
	\`day\` integer NOT NULL,
	\`kind\` text NOT NULL,
	\`person_id\` text NOT NULL,
	\`code\` text NOT NULL,
	\`amount\` integer NOT NULL,
	\`ref\` text NOT NULL,
	\`at\` integer NOT NULL,
	CONSTRAINT "exchange_house_lines_kind_check" CHECK("kind" IN ('burn', 'mint', 'fee', 'loss', 'refund', 'escrow', 'release', 'writeoff'))
) STRICT;

CREATE TABLE \`exchange_instruments\` (
	\`code\` text PRIMARY KEY,
	\`market\` text NOT NULL,
	\`name\` text NOT NULL,
	\`exchange\` text NOT NULL,
	\`type\` text NOT NULL,
	\`currency\` text NOT NULL,
	\`provider\` text NOT NULL,
	\`status\` text NOT NULL,
	\`reason\` text,
	\`added_at\` integer NOT NULL,
	\`added_by\` text,
	\`last_quote_at\` integer,
	\`missing_days\` integer DEFAULT 0 NOT NULL,
	\`last_viewed_at\` integer,
	\`updated_at\` integer NOT NULL,
	CONSTRAINT "exchange_instruments_status_check" CHECK("status" IN ('active', 'blocked', 'paused', 'suspended', 'removed')),
	CONSTRAINT "exchange_instruments_market_check" CHECK("market" IN ('tw', 'us', 'crypto', 'local'))
) STRICT;

CREATE TABLE \`exchange_marks\` (
	\`person_id\` text NOT NULL,
	\`kind\` text NOT NULL,
	\`code\` text NOT NULL,
	\`at\` integer NOT NULL,
	CONSTRAINT \`exchange_marks_pk\` PRIMARY KEY(\`person_id\`, \`kind\`, \`code\`),
	CONSTRAINT "exchange_marks_kind_check" CHECK("kind" IN ('watch', 'view'))
) STRICT;

CREATE TABLE \`exchange_quote_ticks\` (
	\`code\` text NOT NULL,
	\`at\` integer NOT NULL,
	\`price\` real NOT NULL,
	CONSTRAINT \`exchange_quote_ticks_pk\` PRIMARY KEY(\`code\`, \`at\`)
) STRICT;

CREATE TABLE \`exchange_quotes\` (
	\`code\` text PRIMARY KEY,
	\`price\` real NOT NULL,
	\`at\` integer NOT NULL,
	\`prev_close\` real,
	\`refused\` integer DEFAULT 0 NOT NULL,
	\`last_refusal\` text,
	\`updated_at\` integer NOT NULL
) STRICT;

CREATE TABLE \`exchange_real_fills\` (
	\`id\` text PRIMARY KEY,
	\`order_id\` text,
	\`person_id\` text NOT NULL,
	\`code\` text NOT NULL,
	\`side\` text NOT NULL,
	\`kind\` text NOT NULL,
	\`position_id\` text,
	\`leverage\` real NOT NULL,
	\`qty\` integer NOT NULL,
	\`price\` real NOT NULL,
	\`gross\` integer NOT NULL,
	\`fee\` integer NOT NULL,
	\`tax\` integer NOT NULL,
	\`carry\` integer NOT NULL,
	\`paid\` integer NOT NULL,
	\`shortfall\` integer NOT NULL,
	\`by\` text,
	\`created_at\` integer NOT NULL,
	CONSTRAINT "exchange_real_fills_paid_check" CHECK("paid" >= 0 AND "shortfall" >= 0)
) STRICT;

CREATE TABLE \`exchange_real_orders\` (
	\`id\` text PRIMARY KEY,
	\`person_id\` text NOT NULL,
	\`platform\` text NOT NULL,
	\`account_id\` text NOT NULL,
	\`name\` text NOT NULL,
	\`request_key\` text NOT NULL,
	\`code\` text NOT NULL,
	\`side\` text NOT NULL,
	\`limit_price\` real,
	\`coins\` integer NOT NULL,
	\`margin\` integer NOT NULL,
	\`exposure\` integer NOT NULL,
	\`fee\` integer NOT NULL,
	\`leverage\` real NOT NULL,
	\`qty\` integer NOT NULL,
	\`position_id\` text,
	\`placed_at\` integer NOT NULL,
	\`expires_at\` integer NOT NULL,
	\`status\` text NOT NULL,
	\`why\` text,
	\`ended_at\` integer,
	CONSTRAINT "exchange_real_orders_status_check" CHECK("status" IN ('charging', 'open', 'filled', 'cancelled', 'expired', 'void')),
	CONSTRAINT "exchange_real_orders_amount_check" CHECK("coins" >= 0 AND "margin" >= 0 AND "fee" >= 0 AND "qty" >= 0 AND "leverage" >= 1)
) STRICT;

CREATE TABLE \`exchange_real_positions\` (
	\`id\` text PRIMARY KEY,
	\`person_id\` text NOT NULL,
	\`code\` text NOT NULL,
	\`leverage\` real NOT NULL,
	\`qty\` integer NOT NULL,
	\`cost\` integer NOT NULL,
	\`margin\` integer NOT NULL,
	\`loan\` integer NOT NULL,
	\`carry\` integer DEFAULT 0 NOT NULL,
	\`opened_at\` integer NOT NULL,
	\`warned_half\` integer,
	\`warned_near\` integer,
	\`status\` text NOT NULL,
	\`closed_at\` integer,
	CONSTRAINT "exchange_real_positions_status_check" CHECK("status" IN ('open', 'closed', 'liquidated')),
	CONSTRAINT "exchange_real_positions_amount_check" CHECK("qty" >= 0 AND "cost" >= 0 AND "margin" >= 0 AND "loan" >= 0 AND "carry" >= 0)
) STRICT;

CREATE INDEX \`exchange_house_lines_day_idx\` ON \`exchange_house_lines\` (\`day\`,\`kind\`);

CREATE INDEX \`exchange_instruments_status_idx\` ON \`exchange_instruments\` (\`status\`);

CREATE INDEX \`exchange_marks_kind_idx\` ON \`exchange_marks\` (\`kind\`,\`at\`);

CREATE INDEX \`exchange_real_fills_person_idx\` ON \`exchange_real_fills\` (\`person_id\`,\`created_at\`);

CREATE INDEX \`exchange_real_fills_created_idx\` ON \`exchange_real_fills\` (\`created_at\`);

CREATE UNIQUE INDEX \`exchange_real_orders_key_idx\` ON \`exchange_real_orders\` (\`person_id\`,\`request_key\`);

CREATE INDEX \`exchange_real_orders_status_idx\` ON \`exchange_real_orders\` (\`status\`,\`code\`);

CREATE INDEX \`exchange_real_orders_person_idx\` ON \`exchange_real_orders\` (\`person_id\`,\`placed_at\`);

CREATE INDEX \`exchange_real_positions_person_idx\` ON \`exchange_real_positions\` (\`person_id\`,\`status\`);

CREATE INDEX \`exchange_real_positions_status_idx\` ON \`exchange_real_positions\` (\`status\`,\`code\`);
`;

/**
 * Version 3 (2026-11-22, after the first live start): the owner's display name of a ticker, and the
 * provider's previous close fetched while its market is closed (shown, never traded at).
 */
const NAMES_AND_CLOSES = `ALTER TABLE \`exchange_instruments\` ADD \`name_override\` text;
ALTER TABLE \`exchange_instruments\` ADD \`close_price\` real;
ALTER TABLE \`exchange_instruments\` ADD \`close_prev\` real;
ALTER TABLE \`exchange_instruments\` ADD \`close_at\` integer;
`;

/** The market's state, the book, the vault, the news, the accounts, the notices, her words; the real side. */
export const exchangeSchema: PluginSchema = {
  plugin: "exchange",
  migrations: [
    { version: 1, name: "init", sql: INIT },
    { version: 2, name: "real", sql: REAL },
    { version: 3, name: "names_and_closes", sql: NAMES_AND_CLOSES },
  ],
};
