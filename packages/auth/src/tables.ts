// The `auth` plugin's tables on the store's database (`schema.ts`): the `AuthStore` that
// `AuthService` caches, and the panel's login sessions.
//
// Core opens the store with `authTables` and provides `store.plugin(authTables)` as `AuthStoreKey`.
// The `AuthStore` interface keeps naming accounts and guilds by platform id; the rows key them by
// identity's `accounts.id` and `spaces.id`, made on first use like a link code's account.
//
// Panel sessions: `@miyoria/api` still keeps them through `SettingsStore` under
// `panel_session:<sha256>`. `AuthSessions` is that key family over `auth_sessions`, routed by the
// store (`StorePlugin.settings`), so the family is never written to `plugin_state`. Step 14 of
// docs/design/v5-data.md §8 moves the API onto `AuthSessions` and drops the route.

import {
  type AuthScope,
  type AuthStore,
  accounts,
  authScopeKey,
  type CategoryData,
  type Db,
  declined,
  type Identity,
  type NodeOverride,
  type RoleAssignment,
  type RoleDefinition,
  type RoleMapping,
  type SettingsFamily,
  StoreError,
  type StorePlugin,
  spaces,
  tablePart,
} from "@miyoria/store";
import {
  type AccountRef,
  isJsonObject,
  type JsonValue,
  type PlatformId,
  type Timestamp,
} from "@miyoria/types";
import { and, asc, desc, eq } from "drizzle-orm";
import { authSchema } from "./migrations.js";
import {
  type AuthSessionRow,
  authAssignments,
  authOverrides,
  authRoleMappings,
  authRoles,
  authSessions,
  SESSION_TIERS,
  type SessionTier,
} from "./schema.js";

function parseScope(text: string): AuthScope {
  try {
    return JSON.parse(text) as AuthScope;
  } catch (cause) {
    throw new StoreError("cannot parse a stored auth scope", { cause });
  }
}

/** Roles, assignments, platform role mappings and node overrides (`AuthStore`). */
export class AuthTables implements AuthStore {
  readonly #db: Db;
  readonly #identity: Identity;

  constructor(db: Db, identity: Identity) {
    this.#db = db;
    this.#identity = identity;
  }

  /** The space `(platform, guild)`, or `null` when it was never seen. */
  #spaceId(platform: PlatformId, guild: string): string | null {
    const row = this.#db.orm
      .select({ id: spaces.id })
      .from(spaces)
      .where(and(eq(spaces.platform, platform), eq(spaces.external_id, guild)))
      .get();
    return row?.id ?? null;
  }

  async roles(): Promise<RoleDefinition[]> {
    return this.#db.orm
      .select()
      .from(authRoles)
      .orderBy(desc(authRoles.rank), asc(authRoles.name))
      .all();
  }

  async upsertRole(role: RoleDefinition): Promise<void> {
    const { rank, grants, denies, builtin } = role;
    this.#db.orm
      .insert(authRoles)
      .values({ name: role.name, rank, grants, denies, builtin })
      .onConflictDoUpdate({ target: authRoles.name, set: { rank, grants, denies, builtin } })
      .run();
  }

  async deleteRole(name: string): Promise<boolean> {
    const orm = this.#db.orm;
    return this.#db.tx(() => {
      const row = orm
        .select({ builtin: authRoles.builtin })
        .from(authRoles)
        .where(eq(authRoles.name, name))
        .get();
      if (!row) return false;
      if (row.builtin) throw new StoreError(`role \`${name}\` is built in`);
      orm.delete(authAssignments).where(eq(authAssignments.role, name)).run();
      orm.delete(authRoleMappings).where(eq(authRoleMappings.role, name)).run();
      orm.delete(authOverrides).where(eq(authOverrides.role, name)).run();
      orm.delete(authRoles).where(eq(authRoles.name, name)).run();
      return true;
    });
  }

  #assignments(account: AccountRef | null): RoleAssignment[] {
    const rows = this.#db.orm
      .select({
        platform: accounts.platform,
        external_id: accounts.external_id,
        role: authAssignments.role,
        scope: authAssignments.scope,
        granted_by: authAssignments.granted_by,
        at: authAssignments.at,
      })
      .from(authAssignments)
      .innerJoin(accounts, eq(accounts.id, authAssignments.account_id))
      .where(
        account === null
          ? undefined
          : and(eq(accounts.platform, account.platform), eq(accounts.external_id, account.id)),
      )
      .orderBy(
        asc(authAssignments.at),
        asc(accounts.platform),
        asc(accounts.external_id),
        asc(authAssignments.role),
        asc(authAssignments.scope),
      )
      .all();
    return rows.map((r) => ({
      account: { platform: r.platform, id: r.external_id },
      role: r.role,
      scope: parseScope(r.scope),
      granted_by: r.granted_by,
      at: r.at,
    }));
  }

  async assignmentsFor(account: AccountRef): Promise<RoleAssignment[]> {
    return this.#assignments(account);
  }

  async allAssignments(): Promise<RoleAssignment[]> {
    return this.#assignments(null);
  }

  async assign(a: RoleAssignment): Promise<void> {
    this.#db.tx(() => {
      const account = this.#identity.ensureAccount(a.account);
      const row = {
        account_id: account.id,
        role: a.role,
        scope: authScopeKey(a.scope),
        granted_by: a.granted_by,
        at: a.at,
      };
      this.#db.orm
        .insert(authAssignments)
        .values(row)
        .onConflictDoUpdate({
          target: [authAssignments.account_id, authAssignments.role, authAssignments.scope],
          set: { granted_by: row.granted_by, at: row.at },
        })
        .run();
    });
  }

  async revoke(account: AccountRef, role: string, scope: AuthScope): Promise<boolean> {
    const row = this.#identity.account(account);
    if (row === null) return false;
    const removed = this.#db.orm
      .delete(authAssignments)
      .where(
        and(
          eq(authAssignments.account_id, row.id),
          eq(authAssignments.role, role),
          eq(authAssignments.scope, authScopeKey(scope)),
        ),
      )
      .run();
    return removed.changes > 0;
  }

  async mappings(platform: PlatformId, guild: string): Promise<RoleMapping[]> {
    const space = this.#spaceId(platform, guild);
    if (space === null) return [];
    const rows = this.#db.orm
      .select({ platform_role: authRoleMappings.platform_role, role: authRoleMappings.role })
      .from(authRoleMappings)
      .where(eq(authRoleMappings.space_id, space))
      .orderBy(asc(authRoleMappings.platform_role))
      .all();
    return rows.map((r) => ({ platform, guild, ...r }));
  }

  async setMapping(m: RoleMapping): Promise<void> {
    this.#db.tx(() => {
      const space = this.#identity.ensureSpace(m.platform, m.guild);
      this.#db.orm
        .insert(authRoleMappings)
        .values({ space_id: space, platform_role: m.platform_role, role: m.role })
        .onConflictDoUpdate({
          target: [authRoleMappings.space_id, authRoleMappings.platform_role],
          set: { role: m.role },
        })
        .run();
    });
  }

  async removeMapping(platform: PlatformId, guild: string, platformRole: string): Promise<boolean> {
    const space = this.#spaceId(platform, guild);
    if (space === null) return false;
    const removed = this.#db.orm
      .delete(authRoleMappings)
      .where(
        and(eq(authRoleMappings.space_id, space), eq(authRoleMappings.platform_role, platformRole)),
      )
      .run();
    return removed.changes > 0;
  }

  async overrides(): Promise<NodeOverride[]> {
    const rows = this.#db.orm
      .select()
      .from(authOverrides)
      .orderBy(asc(authOverrides.scope), asc(authOverrides.role), asc(authOverrides.node))
      .all();
    return rows.map((r) => ({ ...r, scope: parseScope(r.scope) }));
  }

  async setOverride(o: NodeOverride): Promise<void> {
    this.#db.orm
      .insert(authOverrides)
      .values({ scope: authScopeKey(o.scope), role: o.role, node: o.node, allow: o.allow })
      .onConflictDoUpdate({
        target: [authOverrides.scope, authOverrides.role, authOverrides.node],
        set: { allow: o.allow },
      })
      .run();
  }

  async removeOverride(scope: AuthScope, role: string, node: string): Promise<boolean> {
    const removed = this.#db.orm
      .delete(authOverrides)
      .where(
        and(
          eq(authOverrides.scope, authScopeKey(scope)),
          eq(authOverrides.role, role),
          eq(authOverrides.node, node),
        ),
      )
      .run();
    return removed.changes > 0;
  }
}

/** The settings key family of panel sessions (`@miyoria/api` `STORE_PREFIX`). */
export const SESSION_PREFIX = "panel_session:";

/** A logged-in panel user, in the JSON shape `@miyoria/api` keeps (`SessionRecord`). */
export interface AuthSession {
  account: AccountRef;
  name: string;
  avatar_url: string | null;
  tier: SessionTier;
  created_at: Timestamp;
  expires_at: Timestamp;
}

function isTimestamp(value: unknown): value is Timestamp {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

/** `value` as a session, or `null` when it is not one. */
function parseSession(value: JsonValue): AuthSession | null {
  if (!isJsonObject(value)) return null;
  const { account, name, avatar_url, tier, created_at, expires_at } = value;
  if (
    !isJsonObject(account) ||
    typeof account.platform !== "string" ||
    typeof account.id !== "string" ||
    typeof name !== "string" ||
    !(avatar_url === null || avatar_url === undefined || typeof avatar_url === "string") ||
    !isTimestamp(created_at) ||
    !isTimestamp(expires_at)
  ) {
    return null;
  }
  return {
    account: { platform: account.platform, id: account.id },
    name,
    avatar_url: avatar_url ?? null,
    // The API's reader takes a missing tier as an admin login, so the row does too.
    tier: (SESSION_TIERS as readonly unknown[]).includes(tier) ? (tier as SessionTier) : "admin",
    created_at,
    expires_at,
  };
}

function sessionJson(row: AuthSessionRow): JsonValue {
  return {
    account: { platform: row.platform, id: row.external_id },
    name: row.name,
    avatar_url: row.avatar_url,
    tier: row.tier,
    created_at: row.created_at,
    expires_at: row.expires_at,
  };
}

/** The panel's login sessions, by the sha256 of their token. */
export class AuthSessions {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  get(tokenHash: string): AuthSession | null {
    const row = this.#db.orm
      .select()
      .from(authSessions)
      .where(eq(authSessions.token_hash, tokenHash))
      .get();
    return row === undefined ? null : (parseSession(sessionJson(row)) as AuthSession);
  }

  put(tokenHash: string, session: AuthSession): void {
    const row = {
      token_hash: tokenHash,
      platform: session.account.platform,
      external_id: session.account.id,
      name: session.name,
      avatar_url: session.avatar_url,
      tier: session.tier,
      created_at: session.created_at,
      expires_at: session.expires_at,
    };
    const { token_hash: _, ...set } = row;
    this.#db.orm
      .insert(authSessions)
      .values(row)
      .onConflictDoUpdate({ target: authSessions.token_hash, set })
      .run();
  }

  /** `false` when there was no such session. */
  remove(tokenHash: string): boolean {
    return (
      this.#db.orm.delete(authSessions).where(eq(authSessions.token_hash, tokenHash)).run()
        .changes > 0
    );
  }

  /** Every session, expired ones too, by token hash. */
  all(): Map<string, AuthSession> {
    const rows = this.#db.orm.select().from(authSessions).orderBy(asc(authSessions.token_hash));
    return new Map(
      rows.all().map((r) => [r.token_hash, parseSession(sessionJson(r)) as AuthSession]),
    );
  }

  /** The `panel_session:<hash>` settings keys over these rows (see the file comment). */
  settingsFamily(): SettingsFamily {
    const hashOf = (key: string) => key.slice(SESSION_PREFIX.length);
    return {
      prefix: SESSION_PREFIX,
      get: (key) => {
        const session = this.get(hashOf(key));
        return session === null ? null : (session as unknown as JsonValue);
      },
      set: (key, value) => {
        if (value === null) {
          this.remove(hashOf(key));
          return;
        }
        const session = parseSession(value);
        if (session === null) throw new StoreError(`\`${key}\` is not a panel session`);
        this.put(hashOf(key), session);
      },
      entries: () =>
        new Map(
          [...this.all()].map(([hash, s]) => [
            `${SESSION_PREFIX}${hash}`,
            s as unknown as JsonValue,
          ]),
        ),
    };
  }
}

/** What the `auth` plugin attaches to the store. */
export interface AuthPlugin {
  /** Provided as `AuthStoreKey`. */
  readonly store: AuthTables;
  readonly sessions: AuthSessions;
}

/**
 * The `roles` category (assignments name identity's `accounts.id` and mappings its `spaces.id`;
 * they go with their account or space too), reset to the built-in roles a wipe is given, and the
 * panel's logins (`panel_sessions`, by the hash of the token; kept, never exported).
 */
const authData: readonly CategoryData[] = [
  {
    category: "roles",
    parts: [
      tablePart("roles", "auth_roles", "node", null, "rank DESC, name", {
        name: "text",
        rank: "num",
        grants: "json",
        denies: "json",
        builtin: "bool",
      }),
      tablePart(
        "role_assignments",
        "auth_assignments",
        "node",
        "at",
        "at, account_id, role, scope",
        {
          account_id: "text",
          role: "text",
          scope: "json",
          granted_by: "text",
          at: "ts",
        },
      ),
      tablePart("role_mappings", "auth_role_mappings", "node", null, "space_id, platform_role", {
        space_id: "text",
        platform_role: "text",
        role: "text",
      }),
      tablePart("node_overrides", "auth_overrides", "node", null, "scope, role, node", {
        scope: "json",
        role: "text",
        node: "text",
        allow: "bool",
      }),
    ],
    refill: (d, options) =>
      (options.seedRoles ?? []).map((role) => ({
        sql: "INSERT INTO auth_roles (name, rank, grants, denies, builtin) VALUES ($1, $2, $3, $4, $5)",
        params: [
          role.name,
          role.rank,
          d.list(role.grants),
          d.list(role.denies),
          d.bool(role.builtin),
        ],
      })),
  },
  {
    category: "panel_sessions",
    parts: [
      tablePart("panel_sessions", "auth_sessions", "node", "created_at", "token_hash", {
        token_hash: "text",
        platform: "text",
        external_id: "text",
        name: "text",
        avatar_url: "text",
        tier: "text",
        created_at: "ts",
        expires_at: "ts",
      }),
    ],
  },
];

/** The `auth` plugin's tables and code (`StorePlugin`). */
export const authTables: StorePlugin<AuthPlugin> = {
  schema: authSchema,
  open: ({ db, identity }) => ({
    store: new AuthTables(db, identity),
    sessions: new AuthSessions(db),
  }),
  settings: (opened) => [opened.sessions.settingsFamily()],
  data: authData,
  // What someone may do is not something she remembers about them.
  forgetPerson: () => declined("roles and panel logins are permissions, kept like the audit log"),
  mergePerson: () =>
    declined("assignments are by account and logins by platform id: the accounts move as they are"),
};
