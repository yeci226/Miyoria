// The `economy` plugin's migrations (docs/design/v5-data.md §3.2).
//
// Generated from the Drizzle tables in `schema.ts` with `pnpm --filter @miyoria/store schema:sql
// economy` (drizzle-kit, plus `STRICT`) and never edited after they are released: the runner
// refuses a database whose recorded checksum differs. The store's drift test proves the migrated
// database and the Drizzle tables agree.

import type { PluginSchema } from "@miyoria/store";

const INIT = `CREATE TABLE \`economy_bounties\` (
	\`id\` text PRIMARY KEY,
	\`task\` text NOT NULL,
	\`reward\` integer NOT NULL,
	\`hold_entry\` text NOT NULL,
	\`status\` text NOT NULL,
	\`created_at\` integer NOT NULL,
	\`expires_at\` integer NOT NULL,
	\`closed_at\` integer,
	\`winner_account_id\` text,
	CONSTRAINT \`fk_economy_bounties_winner_account_id_accounts_id_fk\` FOREIGN KEY (\`winner_account_id\`) REFERENCES \`accounts\`(\`id\`) ON DELETE SET NULL,
	CONSTRAINT "economy_bounties_status_check" CHECK("status" IN ('open','awarded','cancelled','expired'))
) STRICT;

CREATE TABLE \`economy_deals\` (
	\`id\` text PRIMARY KEY,
	\`account_id\` text NOT NULL,
	\`reward_item\` text NOT NULL,
	\`reward_count\` integer NOT NULL,
	\`reward_value\` integer NOT NULL,
	\`task\` text NOT NULL,
	\`prepaid\` integer DEFAULT false NOT NULL,
	\`escrow_entry\` text,
	\`status\` text NOT NULL,
	\`created_at\` integer NOT NULL,
	\`done_at\` integer,
	\`due_at\` integer,
	\`closed_at\` integer,
	CONSTRAINT \`fk_economy_deals_account_id_accounts_id_fk\` FOREIGN KEY (\`account_id\`) REFERENCES \`accounts\`(\`id\`) ON DELETE CASCADE,
	CONSTRAINT "economy_deals_status_check" CHECK("status" IN ('open','owed','settled','broken','refunded','cancelled'))
) STRICT;

CREATE TABLE \`economy_docs\` (
	\`kind\` text NOT NULL,
	\`id\` text NOT NULL,
	\`owner_account_id\` text,
	\`status\` text NOT NULL,
	\`version\` integer NOT NULL,
	\`data\` text NOT NULL,
	\`created_at\` integer NOT NULL,
	\`updated_at\` integer NOT NULL,
	CONSTRAINT \`economy_docs_pk\` PRIMARY KEY(\`kind\`, \`id\`),
	CONSTRAINT \`fk_economy_docs_owner_account_id_accounts_id_fk\` FOREIGN KEY (\`owner_account_id\`) REFERENCES \`accounts\`(\`id\`) ON DELETE CASCADE
) STRICT;

CREATE TABLE \`economy_fortunes\` (
	\`id\` text PRIMARY KEY,
	\`account_id\` text NOT NULL,
	\`person_id\` text,
	\`day\` integer NOT NULL,
	\`issued_at\` integer NOT NULL,
	\`entry_id\` text,
	\`slip\` text NOT NULL,
	CONSTRAINT \`fk_economy_fortunes_account_id_accounts_id_fk\` FOREIGN KEY (\`account_id\`) REFERENCES \`accounts\`(\`id\`) ON DELETE CASCADE,
	CONSTRAINT \`fk_economy_fortunes_person_id_persons_id_fk\` FOREIGN KEY (\`person_id\`) REFERENCES \`persons\`(\`id\`) ON DELETE CASCADE
) STRICT;

CREATE TABLE \`economy_goal_pledges\` (
	\`id\` text PRIMARY KEY,
	\`goal_id\` text NOT NULL,
	\`account_id\` text NOT NULL,
	\`amount\` integer NOT NULL,
	\`created_at\` integer NOT NULL,
	CONSTRAINT \`fk_economy_goal_pledges_goal_id_economy_goals_id_fk\` FOREIGN KEY (\`goal_id\`) REFERENCES \`economy_goals\`(\`id\`) ON DELETE CASCADE,
	CONSTRAINT \`fk_economy_goal_pledges_account_id_accounts_id_fk\` FOREIGN KEY (\`account_id\`) REFERENCES \`accounts\`(\`id\`) ON DELETE CASCADE
) STRICT;

CREATE TABLE \`economy_goals\` (
	\`id\` text PRIMARY KEY,
	\`title\` text NOT NULL,
	\`promise\` text NOT NULL,
	\`target\` integer NOT NULL,
	\`status\` text NOT NULL,
	\`created_at\` integer NOT NULL,
	\`deadline\` integer NOT NULL,
	\`closed_at\` integer,
	\`fulfilled_at\` integer,
	\`fulfilled_by\` text,
	CONSTRAINT "economy_goals_status_check" CHECK("status" IN ('open','reached','expired','cancelled')),
	CONSTRAINT "economy_goals_fulfilled_by_check" CHECK("fulfilled_by" IN ('owner','self'))
) STRICT;

CREATE TABLE \`economy_ledger\` (
	\`seq\` integer PRIMARY KEY AUTOINCREMENT,
	\`id\` text NOT NULL,
	\`person_id\` text NOT NULL,
	\`delta\` integer NOT NULL,
	\`reason\` text NOT NULL,
	\`ref\` text,
	\`idem_key\` text,
	\`ts\` integer NOT NULL
) STRICT;

CREATE TABLE \`economy_wallets\` (
	\`person_id\` text PRIMARY KEY,
	\`frame\` text,
	\`updated_at\` integer NOT NULL,
	\`off_board\` integer DEFAULT false NOT NULL,
	CONSTRAINT \`fk_economy_wallets_person_id_persons_id_fk\` FOREIGN KEY (\`person_id\`) REFERENCES \`persons\`(\`id\`) ON DELETE CASCADE
) STRICT;

CREATE INDEX \`economy_bounties_status_idx\` ON \`economy_bounties\` (\`status\`,\`created_at\`);

CREATE INDEX \`economy_deals_account_idx\` ON \`economy_deals\` (\`account_id\`,\`created_at\`);

CREATE INDEX \`economy_deals_status_idx\` ON \`economy_deals\` (\`status\`,\`due_at\`);

CREATE INDEX \`economy_docs_recent_idx\` ON \`economy_docs\` (\`kind\`,\`created_at\`,\`id\`);

CREATE INDEX \`economy_docs_owner_idx\` ON \`economy_docs\` (\`kind\`,\`owner_account_id\`,\`created_at\`);

CREATE UNIQUE INDEX \`economy_fortunes_day_idx\` ON \`economy_fortunes\` (\`account_id\`,\`day\`);

CREATE INDEX \`economy_goal_pledges_goal_idx\` ON \`economy_goal_pledges\` (\`goal_id\`,\`created_at\`);

CREATE INDEX \`economy_goals_status_idx\` ON \`economy_goals\` (\`status\`,\`created_at\`);

CREATE UNIQUE INDEX \`economy_ledger_id_idx\` ON \`economy_ledger\` (\`id\`);

CREATE UNIQUE INDEX \`economy_ledger_idem_idx\` ON \`economy_ledger\` (\`person_id\`,\`idem_key\`);

CREATE INDEX \`economy_ledger_person_idx\` ON \`economy_ledger\` (\`person_id\`,\`ts\`);

CREATE INDEX \`economy_ledger_reason_idx\` ON \`economy_ledger\` (\`reason\`,\`ts\`);
`;

/** The coin ledger, the wallets, deals, fortune slips, goals, bounties and the 2.0 documents. */
export const economySchema: PluginSchema = {
  plugin: "economy",
  requires: ["identity"],
  migrations: [{ version: 1, name: "init", sql: INIT }],
};
