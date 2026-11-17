// The table of the `directive` plugin (docs/design/v5-data.md §3.2), as a Drizzle definition:
// `migrations.ts` holds the SQL drizzle-kit generates from it, `STRICT` added, and the store's
// drift test (`packages/store/test/drizzle-schemas.test.ts`) keeps the two together.
//
// `directive_rules`: the owner's standing rules. A rule that ended (it expired, or someone removed
// it) stays as a row until it is pruned, so the panel can show what ended. One database is one
// character, so there is no profile column. The issuer stays the `AccountRef` the rule names,
// as JSON: it is what the rule says about who made it, not a key anything joins on.

import { micros } from "@miyoria/store";
import {
  type AccountRef,
  DIRECTIVE_AUTHORITIES,
  DIRECTIVE_EFFECTS,
  type DirectiveScope,
} from "@miyoria/types";
import { sql } from "drizzle-orm";
import { check, index, sqliteTable, text } from "drizzle-orm/sqlite-core";

const oneOf = (values: readonly string[]) => sql.raw(values.map((v) => `'${v}'`).join(","));

export const directiveRules = sqliteTable(
  "directive_rules",
  {
    id: text().primaryKey(),
    issuer: text({ mode: "json" }).$type<AccountRef>().notNull(),
    authority: text({ enum: DIRECTIVE_AUTHORITIES }).notNull(),
    scope: text({ mode: "json" }).$type<DirectiveScope>().notNull(),
    effect: text({ enum: DIRECTIVE_EFFECTS }).notNull(),
    /** In the issuer's words. */
    text: text().notNull(),
    /** `null`: until revoked. */
    expires: micros(),
    /** What it came from: an event id, `msg:<id>`, `command:<path>` or `panel:<actor>`. */
    source_event: text().notNull(),
    created_at: micros().notNull(),
    revoked_at: micros(),
    revoked_by: text(),
  },
  (t) => [
    index("directive_rules_live_idx").on(t.expires).where(sql`${t.revoked_at} IS NULL`),
    index("directive_rules_recent_idx").on(t.created_at),
    check(
      "directive_rules_authority_check",
      sql`${t.authority} IN (${oneOf(DIRECTIVE_AUTHORITIES)})`,
    ),
    check("directive_rules_effect_check", sql`${t.effect} IN (${oneOf(DIRECTIVE_EFFECTS)})`),
  ],
);

export type DirectiveRuleRow = typeof directiveRules.$inferSelect;
