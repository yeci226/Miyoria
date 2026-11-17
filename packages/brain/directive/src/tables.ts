// The `directive` plugin's table on the store's database (`schema.ts`): the `DirectiveStore`
// `DirectiveService` reads and writes. Core opens the store with `directiveTables` and hands
// `store.plugin(directiveTables)` to the service. One database is one character, so the
// `profile` the interface still takes is not part of any key.

import {
  type CategoryData,
  type Db,
  type DirectiveStore,
  declined,
  StoreError,
  type StorePlugin,
  tablePart,
} from "@miyoria/store";
import type { Directive, DirectiveRecord, ProfileId, Timestamp } from "@miyoria/types";
import { and, asc, desc, eq, gt, isNull, lt, or } from "drizzle-orm";
import { directiveSchema } from "./migrations.js";
import { type DirectiveRuleRow, directiveRules } from "./schema.js";

function record(row: DirectiveRuleRow): DirectiveRecord {
  return { ...row, expires: row.expires ?? "until_revoked" };
}

/** `limit` as SQLite's `LIMIT`: a negative one is none (the store's `sqlLimit`). */
function limitOf(limit: number): number {
  if (Number.isNaN(limit)) return 0;
  if (!Number.isFinite(limit) || limit >= Number.MAX_SAFE_INTEGER) return limit > 0 ? -1 : 0;
  return Math.max(0, Math.floor(limit));
}

/** The owner's rules (`DirectiveStore`) on `directive_rules`. */
export class DirectiveTables implements DirectiveStore {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  async insert(_profile: ProfileId, d: Directive): Promise<void> {
    try {
      this.#db.orm
        .insert(directiveRules)
        .values({
          id: d.id,
          issuer: d.issuer,
          authority: d.authority,
          scope: d.scope,
          effect: d.effect,
          text: d.text,
          expires: d.expires === "until_revoked" ? null : d.expires,
          source_event: d.source_event,
          created_at: d.created_at,
        })
        .run();
    } catch (cause) {
      if (cause instanceof StoreError) throw cause;
      throw new StoreError("cannot store the directive", { cause });
    }
  }

  async active(_profile: ProfileId, now: Timestamp): Promise<DirectiveRecord[]> {
    const rows = this.#db.orm
      .select()
      .from(directiveRules)
      .where(
        and(
          isNull(directiveRules.revoked_at),
          or(isNull(directiveRules.expires), gt(directiveRules.expires, now)),
        ),
      )
      .orderBy(asc(directiveRules.created_at), asc(directiveRules.id))
      .all();
    return rows.map(record);
  }

  async all(_profile: ProfileId, limit: number): Promise<DirectiveRecord[]> {
    const rows = this.#db.orm
      .select()
      .from(directiveRules)
      .orderBy(desc(directiveRules.created_at), desc(directiveRules.id))
      .limit(limitOf(limit))
      .all();
    return rows.map(record);
  }

  async revoke(_profile: ProfileId, id: string, by: string, at: Timestamp): Promise<boolean> {
    const changed = this.#db.orm
      .update(directiveRules)
      .set({ revoked_at: at, revoked_by: by })
      .where(and(eq(directiveRules.id, id), isNull(directiveRules.revoked_at)))
      .run();
    return changed.changes > 0;
  }

  async prune(_profile: ProfileId, before: Timestamp): Promise<number> {
    const removed = this.#db.orm
      .delete(directiveRules)
      .where(or(lt(directiveRules.revoked_at, before), lt(directiveRules.expires, before)))
      .run();
    return Number(removed.changes);
  }
}

/**
 * The owner's rules, the `directives` category. One database is one character, so every rule is
 * this profile's.
 */
const directiveData: readonly CategoryData[] = [
  {
    category: "directives",
    parts: [
      tablePart("directives", "directive_rules", "node", "created_at", "created_at, id", {
        id: "text",
        issuer: "json",
        authority: "text",
        scope: "json",
        effect: "text",
        text: "text",
        expires: "ts",
        source_event: "text",
        created_at: "ts",
        revoked_at: "ts",
        revoked_by: "text",
      }),
    ],
    // The facts writer's record of each change of the rules (`facts.directive`) goes with them.
    keptEvents: "type = 'facts.directive'",
  },
];

/** The `directive` plugin's table and code (`StorePlugin`). */
export const directiveTables: StorePlugin<DirectiveTables> = {
  schema: directiveSchema,
  open: ({ db }) => new DirectiveTables(db),
  data: directiveData,
  forgetPerson: () => declined("the rules someone set stay until they are revoked"),
  mergePerson: () => declined("a rule names the account that set it, which moves as it is"),
};
