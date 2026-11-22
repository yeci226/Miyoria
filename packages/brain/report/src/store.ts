// The `report` plugin's table on the store's database (`schema.ts`). A new report is written in
// one transaction with the caps it is counted against, so two calls at once cannot both pass the
// last free place, and a retried call (the same dedupe key) is the row it already made.

import {
  type CategoryData,
  type Db,
  type PersonHookResult,
  type PersonMerge,
  type StorePlugin,
  tablePart,
} from "@miyoria/store";
import type { AccountRef, ContextKey, PersonId, Timestamp } from "@miyoria/types";
import { and, asc, count, desc, eq, gte, inArray, isNotNull, isNull } from "drizzle-orm";
import { reportSchema } from "./migrations.js";
import {
  type ReportDraftRow,
  type ReportGithubLinkRow,
  type ReportStatus,
  reportDrafts,
  reportGithubLinks,
} from "./schema.js";

export type ReportRow = ReportDraftRow;
export type GithubLink = ReportGithubLinkRow;

/** What linking an account did: `taken` when it is linked to someone else already. */
export type LinkOutcome =
  | { ok: true; link: GithubLink; replaced: boolean }
  | { ok: false; why: "taken" };

/** A cleaned report, ready to be written. */
export interface NewReport {
  id: string;
  dedupe_key: string;
  area: string;
  title: string;
  happened: string;
  expected: string;
  steps: string | null;
  reporter: string;
  person_id: PersonId | null;
  account: AccountRef | null;
  context: ContextKey | null;
  created_at: Timestamp;
  duplicate: { number: number; title: string; url: string } | null;
}

export interface Caps {
  /** Rows since this time count. */
  since: Timestamp;
  perPerson: number;
  global: number;
}

export type InsertOutcome =
  | { ok: true; row: ReportRow; again: boolean }
  | { ok: false; cap: "person" | "global" };

/** The fields a decision writes. */
export type Decision = Partial<
  Pick<
    ReportRow,
    | "status"
    | "issue_number"
    | "issue_url"
    | "issue_title"
    | "issue_body"
    | "decided_by"
    | "decided_at"
    | "reason"
    | "last_error"
    | "no_mention"
  >
>;

/** Statuses whose issue is followed until it is closed. */
export const FOLLOWED: readonly ReportStatus[] = ["opened", "commented", "duplicate"];

/** `report_drafts`. */
export class ReportTables {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  /** The row made for `dedupe_key`, if one was. */
  byKey(key: string): ReportRow | null {
    return (
      this.#db.orm.select().from(reportDrafts).where(eq(reportDrafts.dedupe_key, key)).get() ?? null
    );
  }

  /** Rows made since `since`, all of them or `reporter`'s. */
  countSince(since: Timestamp, reporter: string | null = null): number {
    const where =
      reporter === null
        ? gte(reportDrafts.created_at, since)
        : and(gte(reportDrafts.created_at, since), eq(reportDrafts.reporter, reporter));
    return this.#db.orm.select({ n: count() }).from(reportDrafts).where(where).get()?.n ?? 0;
  }

  /**
   * Writes `report` when its reporter and everyone together are under their caps; the row of the
   * same dedupe key, uncounted, when it was written already.
   */
  insert(report: NewReport, caps: Caps): InsertOutcome {
    return this.#db.tx((): InsertOutcome => {
      const existing = this.byKey(report.dedupe_key);
      if (existing !== null) return { ok: true, row: existing, again: true };
      if (this.countSince(caps.since, report.reporter) >= caps.perPerson) {
        return { ok: false, cap: "person" };
      }
      if (this.countSince(caps.since) >= caps.global) return { ok: false, cap: "global" };
      this.#db.orm
        .insert(reportDrafts)
        .values({
          id: report.id,
          dedupe_key: report.dedupe_key,
          status: "draft",
          area: report.area,
          title: report.title,
          happened: report.happened,
          expected: report.expected,
          steps: report.steps,
          reporter: report.reporter,
          person_id: report.person_id,
          account: report.account,
          context: report.context,
          created_at: report.created_at,
          dup_number: report.duplicate?.number ?? null,
          dup_title: report.duplicate?.title ?? null,
          dup_url: report.duplicate?.url ?? null,
        })
        .run();
      return { ok: true, row: this.get(report.id) as ReportRow, again: false };
    });
  }

  get(id: string): ReportRow | null {
    return this.#db.orm.select().from(reportDrafts).where(eq(reportDrafts.id, id)).get() ?? null;
  }

  /** Newest first, of `statuses` when given. */
  list(statuses: readonly ReportStatus[] | null, limit: number): ReportRow[] {
    const query = this.#db.orm.select().from(reportDrafts);
    const filtered =
      statuses === null ? query : query.where(inArray(reportDrafts.status, [...statuses]));
    return filtered
      .orderBy(desc(reportDrafts.created_at), desc(reportDrafts.id))
      .limit(Math.max(0, Math.floor(limit)))
      .all();
  }

  /**
   * Moves row `id` from `from` to what `decision` says; `null` when it was not in `from` (someone
   * else decided first, or it is gone).
   */
  move(id: string, from: ReportStatus, decision: Decision): ReportRow | null {
    const changed = this.#db.orm
      .update(reportDrafts)
      .set(decision)
      .where(and(eq(reportDrafts.id, id), eq(reportDrafts.status, from)))
      .run();
    return changed.changes > 0 ? this.get(id) : null;
  }

  /** Rows left `opening` or `commenting` by a Core that stopped while GitHub was asked. */
  unfinished(): ReportRow[] {
    return this.#db.orm
      .select()
      .from(reportDrafts)
      .where(inArray(reportDrafts.status, ["opening", "commenting"]))
      .all();
  }

  /** The rows whose issue is still followed, the least recently read first. */
  followed(limit: number): ReportRow[] {
    return this.#db.orm
      .select()
      .from(reportDrafts)
      .where(
        and(
          inArray(reportDrafts.status, [...FOLLOWED]),
          isNotNull(reportDrafts.issue_number),
          isNull(reportDrafts.closed_at),
        ),
      )
      .orderBy(asc(reportDrafts.checked_at), asc(reportDrafts.created_at))
      .limit(Math.max(0, Math.floor(limit)))
      .all();
  }

  checked(id: string, at: Timestamp): void {
    this.#db.orm.update(reportDrafts).set({ checked_at: at }).where(eq(reportDrafts.id, id)).run();
  }

  /** Records the issue closed; `false` when it was already. */
  closed(id: string, at: Timestamp, reason: string | null): boolean {
    const changed = this.#db.orm
      .update(reportDrafts)
      .set({ closed_at: at, close_reason: reason, checked_at: at })
      .where(and(eq(reportDrafts.id, id), isNull(reportDrafts.closed_at)))
      .run();
    return changed.changes > 0;
  }

  /** Records the reporter told; `false` when they were already. */
  notified(id: string, at: Timestamp): boolean {
    const changed = this.#db.orm
      .update(reportDrafts)
      .set({ notified_at: at })
      .where(and(eq(reportDrafts.id, id), isNull(reportDrafts.notified_at)))
      .run();
    return changed.changes > 0;
  }

  // ---- the GitHub account a member linked ----------------------------------------------------

  /** The account `person` linked, if any. */
  linkOf(person: PersonId): GithubLink | null {
    return (
      this.#db.orm
        .select()
        .from(reportGithubLinks)
        .where(eq(reportGithubLinks.person_id, person))
        .get() ?? null
    );
  }

  /**
   * Links GitHub account `githubId` to `person`, replacing the account they had linked before.
   * An account linked to someone else is refused (`taken`): it never moves on its own.
   */
  link(
    person: PersonId,
    githubId: number,
    login: string,
    mention: boolean,
    at: Timestamp,
  ): LinkOutcome {
    return this.#db.tx((): LinkOutcome => {
      const holder = this.#db.orm
        .select()
        .from(reportGithubLinks)
        .where(eq(reportGithubLinks.github_id, githubId))
        .get();
      if (holder !== undefined && holder.person_id !== person) return { ok: false, why: "taken" };
      const replaced = this.unlink(person);
      this.#db.orm
        .insert(reportGithubLinks)
        .values({ person_id: person, github_id: githubId, login, mention, linked_at: at })
        .run();
      return { ok: true, link: this.linkOf(person) as GithubLink, replaced };
    });
  }

  unlink(person: PersonId): boolean {
    const removed = this.#db.orm
      .delete(reportGithubLinks)
      .where(eq(reportGithubLinks.person_id, person))
      .run();
    return removed.changes > 0;
  }

  /** The member's switch; `false` when they have no link. */
  setMention(person: PersonId, on: boolean): boolean {
    const changed = this.#db.orm
      .update(reportGithubLinks)
      .set({ mention: on })
      .where(eq(reportGithubLinks.person_id, person))
      .run();
    return changed.changes > 0;
  }

  /** The login GitHub gave for the linked id just now. */
  relogin(person: PersonId, login: string): void {
    this.#db.orm
      .update(reportGithubLinks)
      .set({ login })
      .where(eq(reportGithubLinks.person_id, person))
      .run();
  }

  /** Forgets who reported: the report itself stays, nobody's. */
  forget(ids: readonly PersonId[], accounts: readonly AccountRef[]): number {
    return this.#db.tx(() => {
      const keys = [...ids, ...accounts.map((a) => `account:${a.platform}:${a.id}`)];
      if (keys.length === 0) return 0;
      if (ids.length > 0) {
        this.#db.orm
          .delete(reportGithubLinks)
          .where(inArray(reportGithubLinks.person_id, [...ids]))
          .run();
      }
      const changed = this.#db.orm
        .update(reportDrafts)
        .set({ reporter: null, person_id: null, account: null, context: null })
        .where(inArray(reportDrafts.reporter, keys))
        .run();
      const more =
        ids.length === 0
          ? 0
          : this.#db.orm
              .update(reportDrafts)
              .set({ reporter: null, person_id: null, account: null, context: null })
              .where(inArray(reportDrafts.person_id, [...ids]))
              .run().changes;
      return Number(changed.changes) + Number(more);
    });
  }

  merge(keep: PersonId, absorb: PersonId): PersonHookResult {
    if (keep === absorb) return { counts: {} };
    return this.#db.tx((): PersonHookResult => {
      const reporters = this.#db.orm
        .update(reportDrafts)
        .set({ reporter: keep })
        .where(eq(reportDrafts.reporter, absorb))
        .run().changes;
      const persons = this.#db.orm
        .update(reportDrafts)
        .set({ person_id: keep })
        .where(eq(reportDrafts.person_id, absorb))
        .run().changes;
      // One link per person: the one kept wins, the other goes.
      const links =
        this.linkOf(keep) === null
          ? this.#db.orm
              .update(reportGithubLinks)
              .set({ person_id: keep })
              .where(eq(reportGithubLinks.person_id, absorb))
              .run().changes
          : this.#db.orm
              .delete(reportGithubLinks)
              .where(eq(reportGithubLinks.person_id, absorb))
              .run().changes;
      return {
        counts: {
          report_drafts: Math.max(Number(reporters), Number(persons)),
          report_github_links: Number(links),
        },
      };
    });
  }
}

/** What members reported: it is what they said, so it goes with their messages. */
const reportData: readonly CategoryData[] = [
  {
    category: "messages",
    parts: [
      tablePart("report_drafts", "report_drafts", "node", "created_at", "created_at, id", {
        id: "text",
        status: "text",
        area: "text",
        title: "text",
        happened: "text",
        expected: "text",
        steps: "text",
        person_id: "text",
        created_at: "ts",
        dup_number: "num",
        issue_number: "num",
        issue_url: "text",
        decided_by: "text",
        decided_at: "ts",
        reason: "text",
        closed_at: "ts",
        close_reason: "text",
        notified_at: "ts",
      }),
    ],
  },
  {
    // Who someone is on GitHub, when they linked it themselves.
    category: "people",
    parts: [
      tablePart(
        "report_github_links",
        "report_github_links",
        "node",
        "linked_at",
        "linked_at, person_id",
        {
          person_id: "text",
          github_id: "num",
          login: "text",
          mention: "bool",
          linked_at: "ts",
        },
      ),
    ],
  },
];

/** The `report` plugin's table and code (`StorePlugin`). */
export const reportTables: StorePlugin<ReportTables> = {
  schema: reportSchema,
  open: ({ db }) => new ReportTables(db),
  data: reportData,
  forgetPerson: (opened, { ids, accounts }) => ({
    counts: { report_drafts: opened.forget(ids, accounts) },
  }),
  mergePerson: (opened, { keep, absorb }: PersonMerge) => opened.merge(keep, absorb),
};
