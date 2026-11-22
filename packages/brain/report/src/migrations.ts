// The `report` plugin's migrations.
//
// Generated from the Drizzle table in `schema.ts` with `pnpm --filter @miyoria/store schema:sql
// report` (drizzle-kit, plus `STRICT`) and never edited after they are released: the runner
// refuses a database whose recorded checksum differs. The store's drift test proves the migrated
// database and the Drizzle table agree.

import type { PluginSchema } from "@miyoria/store";

const INIT = `CREATE TABLE \`report_drafts\` (
	\`id\` text PRIMARY KEY,
	\`dedupe_key\` text NOT NULL,
	\`status\` text NOT NULL,
	\`area\` text NOT NULL,
	\`title\` text NOT NULL,
	\`happened\` text NOT NULL,
	\`expected\` text NOT NULL,
	\`steps\` text,
	\`reporter\` text,
	\`person_id\` text,
	\`account\` text,
	\`context\` text,
	\`created_at\` integer NOT NULL,
	\`dup_number\` integer,
	\`dup_title\` text,
	\`dup_url\` text,
	\`issue_number\` integer,
	\`issue_url\` text,
	\`issue_title\` text,
	\`issue_body\` text,
	\`decided_by\` text,
	\`decided_at\` integer,
	\`reason\` text,
	\`last_error\` text,
	\`closed_at\` integer,
	\`close_reason\` text,
	\`checked_at\` integer,
	\`notified_at\` integer,
	CONSTRAINT "report_drafts_status_check" CHECK("status" IN ('draft','opening','opened','commenting','commented','duplicate','rejected'))
) STRICT;

CREATE UNIQUE INDEX \`report_drafts_dedupe_idx\` ON \`report_drafts\` (\`dedupe_key\`);

CREATE INDEX \`report_drafts_status_idx\` ON \`report_drafts\` (\`status\`,\`created_at\`);

CREATE INDEX \`report_drafts_reporter_idx\` ON \`report_drafts\` (\`reporter\`,\`created_at\`);

CREATE INDEX \`report_drafts_created_idx\` ON \`report_drafts\` (\`created_at\`);

CREATE INDEX \`report_drafts_issue_idx\` ON \`report_drafts\` (\`closed_at\`,\`issue_number\`);
`;

/**
 * Version 2: the GitHub account a member linked (one per person, one person per account), and the
 * owner's switch that takes the reporter's mention off one report. Additive.
 */
const GITHUB_LINKS = `ALTER TABLE \`report_drafts\` ADD \`no_mention\` integer DEFAULT false NOT NULL;

CREATE TABLE \`report_github_links\` (
	\`person_id\` text PRIMARY KEY,
	\`github_id\` integer NOT NULL,
	\`login\` text NOT NULL,
	\`mention\` integer DEFAULT true NOT NULL,
	\`linked_at\` integer NOT NULL
) STRICT;

CREATE UNIQUE INDEX \`report_github_links_github_idx\` ON \`report_github_links\` (\`github_id\`);
`;

/** Problem reports members made through her, and the issues they became. */
export const reportSchema: PluginSchema = {
  plugin: "report",
  migrations: [
    { version: 1, name: "init", sql: INIT },
    { version: 2, name: "github_links", sql: GITHUB_LINKS },
  ],
};
