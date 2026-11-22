// The `economy` plugin's migrations (docs/design/v5-data.md §3.2).
//
// Generated from the Drizzle tables in `schema.ts` with `pnpm --filter @miyoria/store schema:sql
// economy` (drizzle-kit, plus `STRICT`) and never edited after they are released: the runner
// refuses a database whose recorded checksum differs. The store's drift test proves the migrated
// database and the Drizzle tables agree. Version 1 is that; 2 to 5 are hand-written SQL that
// retires a feature (phase 5): refunds what it held, then drops its tables; 6 is what drizzle-kit
// generated for the Space columns, with the backfill after it.

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

/**
 * Gives back what a removed feature still held (phase 5, docs/design/v5-play.md §10): one
 * `refund_removed` row per held ledger row (`held` selects their ids), shaped like a refund (the
 * original row as `ref`, key `refund:<id>`), and its `economy.posted` event. A row that was
 * refunded already is skipped, so it is safe to run on any database. The new ids are the
 * original's with the first random character changed (still a ULID, and not the next one a
 * monotonic generator would make); the event's balance is the person's
 * own rows up to the refund. Versions 2 to 5 use it: never edit it once released.
 */
const refundHeld = (
  held: string,
): string => `INSERT INTO economy_ledger (id, person_id, delta, reason, ref, idem_key, ts)
SELECT substr(e.id, 1, 10) || CASE substr(e.id, 11, 1) WHEN '0' THEN '1' ELSE '0' END || substr(e.id, 12),
  e.person_id, -e.delta, 'refund_removed', e.id, 'refund:' || e.id,
  CAST(strftime('%s', 'now') AS INTEGER) * 1000000
FROM economy_ledger e
WHERE e.delta < 0 AND e.id IN (${held})
  AND NOT EXISTS (SELECT 1 FROM economy_ledger r WHERE r.ref = e.id
    AND r.reason IN ('refund', 'refund_removed'));

INSERT INTO events (id, at, type, v, source, person_id, scope, tier, key, data)
SELECT substr(l.ref, 1, 10) || CASE substr(l.ref, 11, 1) WHEN '2' THEN '3' ELSE '2' END || substr(l.ref, 12),
  l.ts, 'economy.posted', 1, 'economy',
  CASE l.person_id WHEN 'self' THEN NULL ELSE l.person_id END, 'owner', 'keep',
  'ledger:' || l.id,
  json_object('entry_id', l.id, 'person_id', l.person_id, 'delta', l.delta, 'reason', l.reason,
    'ref', l.ref, 'idem_key', l.idem_key, 'balance',
    (SELECT SUM(b.delta) FROM economy_ledger b WHERE b.person_id = l.person_id AND b.seq <= l.seq))
FROM economy_ledger l
WHERE l.reason = 'refund_removed'
  AND NOT EXISTS (SELECT 1 FROM events x WHERE x.key = 'ledger:' || l.id);`;

/**
 * Deals are gone: the escrow of every prepaid deal she had not yet done goes back to its payer (a
 * `refund_removed` row), then the table is dropped. A paid deal (`settled`) already was hers.
 */
const RETIRE_DEALS = `${refundHeld(
  "SELECT escrow_entry FROM economy_deals WHERE prepaid = 1 AND status = 'open' AND escrow_entry IS NOT NULL",
)}

DROP TABLE economy_deals;`;

/**
 * Commissions are gone: the price of every commission still waiting for her (its document is
 * `open`; the document's id is the charge's ledger row) goes back to whoever paid it, and the
 * document is marked declined with a note. Delivered, declined and expired commissions stay as
 * documents: they are what people were given, and nothing reads them any more.
 */
const RETIRE_COMMISSIONS = `${refundHeld("SELECT id FROM economy_docs WHERE kind = 'commission' AND status = 'open'")}

UPDATE economy_docs
SET status = 'declined', version = version + 1,
  updated_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000000,
  data = json_set(data, '$.note', '委託功能已移除,錢已退回')
WHERE kind = 'commission' AND status = 'open';`;

/**
 * Goals are gone: a pledge whose goal was never funded (no `goal_funds` row of the purse for it)
 * goes back to its pledger, then both tables are dropped. The pledges of a funded goal were
 * hers already and stay as spent.
 */
const RETIRE_GOALS = `${refundHeld(
  "SELECT l.id FROM economy_ledger l WHERE l.reason = 'goal_pledge' AND NOT EXISTS (SELECT 1 FROM economy_ledger f WHERE f.reason = 'goal_funds' AND f.ref = l.ref)",
)}

DROP TABLE economy_goal_pledges;
DROP TABLE economy_goals;`;

/**
 * Song tickets and dedications are gone: the singer's set list (the settings row `sing:setlist` of
 * `plugin_state`) still holds the ledger rows of the ones charged for songs not yet sung (state
 * `preparing`, `ready` or `playing`); they go back to their payers. A song sung already keeps its
 * charge. A database without that row has nothing to give back.
 */
const RETIRE_SONG_EXTRAS = refundHeld(
  `SELECT json_extract(e.value, '$.ticket_entry') FROM plugin_state s, json_each(s.value, '$.entries') e
  WHERE s.plugin = 'settings' AND s.key = 'sing:setlist'
    AND json_extract(e.value, '$.state') IN ('preparing', 'ready', 'playing')
  UNION
  SELECT json_extract(e.value, '$.dedication_entry') FROM plugin_state s, json_each(s.value, '$.entries') e
  WHERE s.plugin = 'settings' AND s.key = 'sing:setlist'
    AND json_extract(e.value, '$.state') IN ('preparing', 'ready', 'playing')`,
);

/**
 * Phase 6, many servers (docs/design/v5-places.md): a bounty, a prediction and its bets belong to
 * the Space they were opened in. What was there before belongs to the primary Space (identity v2
 * chose it; a database without one keeps `null`, which means open to everyone she knows). Her
 * room and the retired kinds belong to no Space. Columns only: no row moves or goes.
 */
const SPACES = `ALTER TABLE \`economy_bounties\` ADD \`space_id\` text REFERENCES spaces(id);
ALTER TABLE \`economy_docs\` ADD \`space_id\` text REFERENCES spaces(id);
CREATE INDEX \`economy_bounties_space_idx\` ON \`economy_bounties\` (\`space_id\`,\`status\`,\`created_at\`);
CREATE INDEX \`economy_docs_space_idx\` ON \`economy_docs\` (\`kind\`,\`space_id\`,\`created_at\`);

UPDATE economy_bounties SET space_id = (SELECT id FROM spaces WHERE is_primary = 1)
WHERE space_id IS NULL;
UPDATE economy_docs SET space_id = (SELECT id FROM spaces WHERE is_primary = 1)
WHERE space_id IS NULL AND kind IN ('prediction', 'bet');`;

/** The coin ledger, the wallets, fortune slips, bounties and the 2.0 documents. */
export const economySchema: PluginSchema = {
  plugin: "economy",
  requires: ["identity", "config"],
  migrations: [
    { version: 1, name: "init", sql: INIT },
    { version: 2, name: "retire_deals", sql: RETIRE_DEALS },
    { version: 3, name: "retire_commissions", sql: RETIRE_COMMISSIONS },
    { version: 4, name: "retire_goals", sql: RETIRE_GOALS },
    { version: 5, name: "retire_song_extras", sql: RETIRE_SONG_EXTRAS },
    { version: 6, name: "spaces", sql: SPACES },
  ],
};
