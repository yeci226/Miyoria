// The table of the `report` plugin, as a Drizzle definition: `migrations.ts` holds the SQL
// drizzle-kit generates from it, `STRICT` added, and the store's drift test
// (`packages/store/test/drizzle-schemas.test.ts`) keeps the two together.
//
// `report_drafts`: one row per problem a member reported through her. The fields are already
// cleaned (`sanitize.ts`); who reported it (`person_id`, `account`) and where (`context`) are kept
// here only, never in an issue, and go when the person is forgotten. A row is a `draft` until the
// owner decides: `opened` (an issue was made from it), `commented` (added to issue #N instead),
// `duplicate` (of #N, nothing written on GitHub) or `rejected`. `opening` and `commenting` hold
// the row while GitHub is asked, so a second click cannot write twice.

import { micros } from "@miyoria/store";
import type { AccountRef, ContextKey } from "@miyoria/types";
import { sql } from "drizzle-orm";
import { check, index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const REPORT_STATUSES = [
  "draft",
  "opening",
  "opened",
  "commenting",
  "commented",
  "duplicate",
  "rejected",
] as const;
export type ReportStatus = (typeof REPORT_STATUSES)[number];

const oneOf = (values: readonly string[]) => sql.raw(values.map((v) => `'${v}'`).join(","));

export const reportDrafts = sqliteTable(
  "report_drafts",
  {
    id: text().primaryKey(),
    /** The same report asked for again (a retried call): one row. */
    dedupe_key: text().notNull(),
    status: text({ enum: REPORT_STATUSES }).notNull(),
    area: text().notNull(),
    title: text().notNull(),
    happened: text().notNull(),
    expected: text().notNull(),
    steps: text(),
    /**
     * Who the caps count it for: the person id, or `account:<platform>:<id>` for someone she does
     * not know yet. `null` once they are forgotten.
     */
    reporter: text(),
    /** Who reported it; `null` once they are forgotten (or when she did not know them). */
    person_id: text(),
    account: text({ mode: "json" }).$type<AccountRef>(),
    /** Where it was reported. */
    context: text({ mode: "json" }).$type<ContextKey>(),
    created_at: micros().notNull(),
    /** The open issue the search found most alike. */
    dup_number: integer(),
    dup_title: text(),
    dup_url: text(),
    /** The issue it became, was added to, or is a duplicate of. */
    issue_number: integer(),
    issue_url: text(),
    /** What was sent to GitHub (the owner may edit both first). */
    issue_title: text(),
    issue_body: text(),
    /** Who decided (`discord:<id>`, `api`, `auto`), when, and a rejection's reason. */
    decided_by: text(),
    decided_at: micros(),
    reason: text(),
    /** The last call to GitHub that failed for this row. */
    last_error: text(),
    /** The issue was found closed, and how (`completed`, `not_planned`, ...). */
    closed_at: micros(),
    close_reason: text(),
    /** When the issue was last read back. */
    checked_at: micros(),
    /** The reporter was told it was fixed (a follow-up for her was queued). */
    notified_at: micros(),
    /** Version 2: the owner took the reporter's GitHub mention off this report. */
    no_mention: integer({ mode: "boolean" }).notNull().default(false),
  },
  (t) => [
    uniqueIndex("report_drafts_dedupe_idx").on(t.dedupe_key),
    index("report_drafts_status_idx").on(t.status, t.created_at),
    index("report_drafts_reporter_idx").on(t.reporter, t.created_at),
    index("report_drafts_created_idx").on(t.created_at),
    index("report_drafts_issue_idx").on(t.closed_at, t.issue_number),
    check("report_drafts_status_check", sql`${t.status} IN (${oneOf(REPORT_STATUSES)})`),
  ],
);

export type ReportDraftRow = typeof reportDrafts.$inferSelect;

/**
 * `report_github_links` (version 2): the GitHub account a member linked on the member page, one
 * per person and one person per account. Only GitHub's numeric id and the login it had when it was
 * last read are kept, never a token. `mention`: the member's switch "在我回報的問題上標記我".
 * The row goes when they unlink or ask to be forgotten.
 */
export const reportGithubLinks = sqliteTable(
  "report_github_links",
  {
    person_id: text().primaryKey(),
    github_id: integer().notNull(),
    login: text().notNull(),
    mention: integer({ mode: "boolean" }).notNull().default(true),
    linked_at: micros().notNull(),
  },
  (t) => [uniqueIndex("report_github_links_github_idx").on(t.github_id)],
);

export type ReportGithubLinkRow = typeof reportGithubLinks.$inferSelect;
