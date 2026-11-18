// The `market` plugin's migrations (docs/design/v5-data.md §3.2, v5-play.md §11.4).
//
// Generated from the Drizzle tables in `schema.ts` with `pnpm --filter @miyoria/store schema:sql
// market` (drizzle-kit, plus `STRICT`) and never edited after they are released: the runner
// refuses a database whose recorded checksum differs. The store's drift test proves the migrated
// database and the Drizzle tables agree.
//
// `retireMarketSql` is not a migration yet: it is the one to add when the auction or the lottery
// is removed, the way the economy's versions 2 to 5 retired the features of phase 5.

import type { PluginSchema } from "@miyoria/store";

const INIT = `CREATE TABLE \`market_bids\` (
	\`id\` text PRIMARY KEY,
	\`lot_id\` text NOT NULL,
	\`person_id\` text NOT NULL,
	\`platform\` text NOT NULL,
	\`account_id\` text NOT NULL,
	\`name\` text NOT NULL,
	\`amount\` integer NOT NULL,
	\`hold\` integer NOT NULL,
	\`status\` text NOT NULL,
	\`created_at\` integer NOT NULL,
	\`released_at\` integer,
	CONSTRAINT "market_bids_status_check" CHECK("status" IN ('pending', 'leading', 'outbid', 'won', 'void')),
	CONSTRAINT "market_bids_amount_check" CHECK("amount" > 0 AND "hold" >= 0)
) STRICT;

CREATE TABLE \`market_lots\` (
	\`id\` text PRIMARY KEY,
	\`week\` integer NOT NULL,
	\`kind\` text,
	\`status\` text NOT NULL,
	\`picked_by\` text NOT NULL,
	\`opens_at\` integer NOT NULL,
	\`ends_at\` integer NOT NULL,
	\`extended\` integer DEFAULT false NOT NULL,
	\`channel\` text,
	\`message_id\` text,
	\`winner_bid\` text,
	\`price\` integer,
	\`name_due\` integer,
	\`call_name\` text,
	\`previous_call_name\` text,
	\`applied_until\` integer,
	\`note\` text,
	\`created_at\` integer NOT NULL,
	\`closed_at\` integer,
	\`settled_at\` integer,
	CONSTRAINT "market_lots_status_check" CHECK("status" IN ('planned', 'skipped', 'open', 'closing', 'naming', 'applied', 'done', 'refunded', 'cancelled')),
	CONSTRAINT "market_lots_kind_check" CHECK("kind" IS NULL OR "kind" IN ('call_name', 'frame')),
	CONSTRAINT "market_lots_picked_by_check" CHECK("picked_by" IN ('owner', 'her', 'rotation'))
) STRICT;

CREATE TABLE \`market_lottery_tickets\` (
	\`id\` text PRIMARY KEY,
	\`week\` integer NOT NULL,
	\`person_id\` text NOT NULL,
	\`platform\` text NOT NULL,
	\`account_id\` text NOT NULL,
	\`name\` text NOT NULL,
	\`purchase_key\` text NOT NULL,
	\`count\` integer NOT NULL,
	\`amount\` integer NOT NULL,
	\`status\` text NOT NULL,
	\`created_at\` integer NOT NULL,
	\`refunded_at\` integer,
	CONSTRAINT "market_lottery_tickets_status_check" CHECK("status" IN ('pending', 'paid', 'refunded')),
	CONSTRAINT "market_lottery_tickets_count_check" CHECK("count" > 0 AND "amount" >= 0)
) STRICT;

CREATE TABLE \`market_lottery_weeks\` (
	\`week\` integer PRIMARY KEY,
	\`status\` text NOT NULL,
	\`draw_at\` integer NOT NULL,
	\`tickets\` integer DEFAULT 0 NOT NULL,
	\`buyers\` integer DEFAULT 0 NOT NULL,
	\`pot\` integer DEFAULT 0 NOT NULL,
	\`prize\` integer DEFAULT 0 NOT NULL,
	\`burned\` integer DEFAULT 0 NOT NULL,
	\`winner_person\` text,
	\`winner_platform\` text,
	\`winner_account_id\` text,
	\`winner_name\` text,
	\`winner_tickets\` integer,
	\`pick\` integer,
	\`drawn_at\` integer,
	\`paid_at\` integer,
	\`announced_at\` integer,
	\`notice_message\` text,
	\`notice_at\` integer,
	CONSTRAINT "market_lottery_weeks_status_check" CHECK("status" IN ('open', 'drawing', 'drawn', 'refunding', 'refunded'))
) STRICT;

CREATE INDEX \`market_bids_lot_idx\` ON \`market_bids\` (\`lot_id\`,\`created_at\`);

CREATE INDEX \`market_bids_status_idx\` ON \`market_bids\` (\`status\`,\`released_at\`);

CREATE UNIQUE INDEX \`market_lots_week_idx\` ON \`market_lots\` (\`week\`);

CREATE INDEX \`market_lots_status_idx\` ON \`market_lots\` (\`status\`,\`ends_at\`);

CREATE UNIQUE INDEX \`market_lottery_tickets_key_idx\` ON \`market_lottery_tickets\` (\`person_id\`,\`purchase_key\`);

CREATE INDEX \`market_lottery_tickets_week_idx\` ON \`market_lottery_tickets\` (\`week\`,\`status\`);

CREATE INDEX \`market_lottery_weeks_status_idx\` ON \`market_lottery_weeks\` (\`status\`,\`draw_at\`);
`;

/**
 * Version 2: the song priority tickets, one row per charge, kept from before the wallet is asked
 * until the song is sung or the coins went back (the pass gives back what is neither).
 */
const SONG_TICKETS = `CREATE TABLE \`market_song_tickets\` (
	\`key\` text PRIMARY KEY,
	\`person_id\` text NOT NULL,
	\`platform\` text NOT NULL,
	\`account_id\` text NOT NULL,
	\`amount\` integer NOT NULL,
	\`status\` text NOT NULL,
	\`created_at\` integer NOT NULL,
	\`settled_at\` integer,
	CONSTRAINT "market_song_tickets_status_check" CHECK("status" IN ('charging', 'charged', 'void', 'consumed', 'refunded')),
	CONSTRAINT "market_song_tickets_amount_check" CHECK("amount" >= 0)
) STRICT;

CREATE INDEX \`market_song_tickets_status_idx\` ON \`market_song_tickets\` (\`status\`,\`created_at\`);
`;

/** The lots, bids, lottery weeks and tickets; the song priority tickets. */
export const marketSchema: PluginSchema = {
  plugin: "market",
  migrations: [
    { version: 1, name: "init", sql: INIT },
    { version: 2, name: "song_tickets", sql: SONG_TICKETS },
  ],
};

/**
 * The migration that retires the auction and the lottery when they are removed: every bid's hold
 * that was never released, every lottery ticket of a week not drawn (open, or refunding when
 * Core stopped), and every song priority ticket not yet used or given back, goes back to its owner as one `refund_removed` row shaped like the economy's
 * (the original row as `ref`, key `refund:<id>`, with its `economy.posted` event), then the
 * tables are dropped. A hold or a ticket that went back already is skipped, so it is safe on any
 * database. It needs the economy's ledger: add `requires: ["economy"]` with it.
 */
export const retireMarketSql = `INSERT INTO economy_ledger (id, person_id, delta, reason, ref, idem_key, ts)
SELECT substr(e.id, 1, 10) || CASE substr(e.id, 11, 1) WHEN '0' THEN '1' ELSE '0' END || substr(e.id, 12),
  e.person_id, -e.delta, 'refund_removed', e.id, 'refund:' || e.id,
  CAST(strftime('%s', 'now') AS INTEGER) * 1000000
FROM economy_ledger e
WHERE e.delta < 0
  AND (
    (e.reason = 'auction_hold'
      AND NOT EXISTS (SELECT 1 FROM economy_ledger r WHERE r.ref = e.id AND r.reason = 'auction_release'))
    OR (e.reason = 'lottery_ticket'
      AND e.idem_key IN (SELECT 'lottery_ticket:' || t.id FROM market_lottery_tickets t
        JOIN market_lottery_weeks w ON w.week = t.week
        WHERE t.status = 'paid' AND w.status IN ('open', 'refunding')))
    OR (e.reason = 'song_priority'
      AND e.idem_key IN (SELECT 'song_priority:' || s.key FROM market_song_tickets s
        WHERE s.status IN ('charging', 'charged')))
  )
  AND NOT EXISTS (SELECT 1 FROM economy_ledger r WHERE r.ref = e.id
    AND r.reason IN ('refund', 'refund_removed', 'lottery_refund', 'song_priority_refund'));

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
  AND NOT EXISTS (SELECT 1 FROM events x WHERE x.key = 'ledger:' || l.id);

DROP TABLE market_bids;
DROP TABLE market_lots;
DROP TABLE market_lottery_tickets;
DROP TABLE market_lottery_weeks;
DROP TABLE market_song_tickets;`;
