// The tables of the `auth` plugin (docs/design/v5-data.md §3.2), as Drizzle definitions:
// `migrations.ts` holds the SQL drizzle-kit generates from them, `STRICT` added, and the store's
// drift test (`packages/store/test/drizzle-schemas.test.ts`) keeps the two together.
//
// - `auth_roles`: role definitions, the built-in ones seeded by `AuthService`.
// - `auth_assignments`: a role given to an account (identity's `accounts.id`) in a scope.
// - `auth_role_mappings`: a platform role of a space (identity's `spaces.id`) mapped to a role.
// - `auth_overrides`: a node allowed or denied for a role in a scope.
// - `auth_sessions`: the panel's logins, by the sha256 of the cookie token.
//
// Scopes are the canonical JSON of an `AuthScope` (`authScopeKey`), so equal scopes are equal
// text. Assignments and mappings go with their account or space. A session names its account by
// platform and platform id, without a foreign key: sessions are kept data, and a factory reset
// deletes the accounts but never logs the owner out.

import { accounts, micros, spaces } from "@miyoria/store";
import { sql } from "drizzle-orm";
import { check, index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const SESSION_TIERS = ["admin", "member"] as const;
/** What a panel session was opened as (`@miyoria/api` `SessionTier`). */
export type SessionTier = (typeof SESSION_TIERS)[number];

const oneOf = (values: readonly string[]) => sql.raw(values.map((v) => `'${v}'`).join(","));

export const authRoles = sqliteTable("auth_roles", {
  name: text().primaryKey(),
  /** Higher outranks lower (owner 100 ... blocked 0). */
  rank: integer().notNull(),
  grants: text({ mode: "json" }).$type<string[]>().notNull().default([]),
  denies: text({ mode: "json" }).$type<string[]>().notNull().default([]),
  /** Built-in roles can be edited but not deleted. */
  builtin: integer({ mode: "boolean" }).notNull().default(false),
});

export const authAssignments = sqliteTable(
  "auth_assignments",
  {
    account_id: text()
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    role: text().notNull(),
    /** Canonical JSON of the `AuthScope`. */
    scope: text().notNull(),
    /** e.g. `discord:123` or `config`. */
    granted_by: text().notNull(),
    at: micros().notNull(),
  },
  (t) => [
    primaryKey({ name: "auth_assignments_pk", columns: [t.account_id, t.role, t.scope] }),
    index("auth_assignments_role_idx").on(t.role),
  ],
);

export const authRoleMappings = sqliteTable(
  "auth_role_mappings",
  {
    space_id: text()
      .notNull()
      .references(() => spaces.id, { onDelete: "cascade" }),
    /** The platform's role id (a Discord role snowflake). */
    platform_role: text().notNull(),
    role: text().notNull(),
  },
  (t) => [primaryKey({ name: "auth_role_mappings_pk", columns: [t.space_id, t.platform_role] })],
);

export const authOverrides = sqliteTable(
  "auth_overrides",
  {
    /** Canonical JSON of the `AuthScope`. */
    scope: text().notNull(),
    role: text().notNull(),
    node: text().notNull(),
    allow: integer({ mode: "boolean" }).notNull(),
  },
  (t) => [primaryKey({ name: "auth_overrides_pk", columns: [t.scope, t.role, t.node] })],
);

export const authSessions = sqliteTable(
  "auth_sessions",
  {
    /** Lowercase hex sha256 of the session token; the token itself is never stored. */
    token_hash: text().primaryKey(),
    platform: text().notNull(),
    /** The platform's account id. */
    external_id: text().notNull(),
    name: text().notNull(),
    avatar_url: text(),
    tier: text({ enum: SESSION_TIERS }).notNull(),
    created_at: micros().notNull(),
    expires_at: micros().notNull(),
  },
  (t) => [
    index("auth_sessions_expires_idx").on(t.expires_at),
    check("auth_sessions_tier_check", sql`${t.tier} IN (${oneOf(SESSION_TIERS)})`),
  ],
);

export type AuthRoleRow = typeof authRoles.$inferSelect;
export type AuthSessionRow = typeof authSessions.$inferSelect;
