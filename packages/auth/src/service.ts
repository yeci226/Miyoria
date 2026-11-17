// `AuthService`: the cached authorizer and role management API.

import { errorMessage, getLogger, withTimeout } from "@miyoria/runtime/kernel";
import type {
  AuditEntry,
  AuditLog,
  AuthScope,
  AuthStore,
  NodeOverride,
  RoleAssignment,
  RoleDefinition,
  RoleMapping,
} from "@miyoria/store";
import {
  type AccountRef,
  BaseAuthorizer,
  type Clock,
  type JsonValue,
  newId,
  type PlatformId,
  type Subject,
  systemClock,
  toTimestamp,
} from "@miyoria/types";
import { builtinRoles, builtinStatus } from "./builtin.js";
import { isValidPattern } from "./node.js";
import {
  accountKey,
  type GuildKey,
  guildKeyId,
  guildOf,
  type Resolution,
  Snapshot,
} from "./resolve.js";

const log = getLogger("auth");

/** How long a permission check may wait for a guild's role mappings. */
export const PRELOAD_TIMEOUT_MS = 2_000;
const MAX_ROLE_NAME = 32;

/** A rejected role management request or a failed store access. */
export class AuthError extends Error {
  override readonly name = "AuthError";

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
  }
}

/** Message plus the messages of its causes, like anyhow's `{:#}`. */
export function errorChain(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 8 && current !== undefined && current !== null; depth++) {
    parts.push(errorMessage(current));
    current = current instanceof Error ? current.cause : undefined;
  }
  return parts.join(": ");
}

async function withContext<T>(context: string, promise: Promise<T>): Promise<T> {
  try {
    return await promise;
  } catch (error) {
    throw new AuthError(context, { cause: error });
  }
}

export interface AuthServiceOptions {
  clock?: Clock;
}

/**
 * Role-based authorizer backed by an `AuthStore`, with everything cached in memory. Provided by
 * the `auth` module as `AuthServiceKey` and as `AuthorizerKey`.
 *
 * Every write goes to the store first, then refreshes the affected part of the cache, and is
 * recorded in the `AuditLog` when there is one. Platform role mappings are loaded per guild on
 * first use (see `preload`); `reload` re-reads everything.
 */
export class AuthService extends BaseAuthorizer {
  readonly #store: AuthStore;
  readonly #audit: AuditLog | null;
  readonly #clock: Clock;
  readonly #state = new Snapshot();
  readonly #loading = new Set<string>();

  private constructor(
    store: AuthStore,
    audit: AuditLog | null,
    owners: Iterable<AccountRef>,
    defaultRole: string,
    clock: Clock,
  ) {
    super();
    this.#store = store;
    this.#audit = audit;
    this.#clock = clock;
    this.#state.setOwners(owners);
    this.#state.defaultRole = defaultRole;
  }

  /** Seeds missing built-in roles and loads the cache. */
  static async load(
    store: AuthStore,
    audit: AuditLog | null,
    owners: Iterable<AccountRef>,
    defaultRole: string,
    options: AuthServiceOptions = {},
  ): Promise<AuthService> {
    const service = new AuthService(
      store,
      audit,
      owners,
      defaultRole,
      options.clock ?? systemClock,
    );
    const seeded = await service.seedBuiltins();
    if (seeded > 0) log.info({ count: seeded }, "seeded built-in roles");
    await service.reload();
    if (!service.#state.roles.has(defaultRole)) {
      log.warn({ role: defaultRole }, "default role does not exist; unassigned users get nothing");
    }
    return service;
  }

  /**
   * Writes the built-in roles that are missing from the store and upgrades stored ones that
   * still have an earlier version's default grants. Edited ones are left alone (logged). Returns
   * how many were written.
   */
  async seedBuiltins(): Promise<number> {
    const existing = new Map(
      (await withContext("loading roles", this.#store.roles())).map((r) => [r.name, r]),
    );
    let seeded = 0;
    for (const role of builtinRoles()) {
      const stored = existing.get(role.name);
      if (!stored) {
        await this.#store.upsertRole(role);
        seeded++;
        continue;
      }
      switch (builtinStatus(stored)) {
        case "upgrade":
          await this.#store.upsertRole(role);
          log.info({ role: role.name }, "upgraded built-in role to the current default nodes");
          seeded++;
          break;
        case "edited": {
          const missing = role.grants.filter((g) => !stored.grants.includes(g));
          if (missing.length > 0) {
            log.info(
              { role: role.name, missing },
              "built-in role was edited; new default nodes not added",
            );
          }
          break;
        }
        default:
          break;
      }
    }
    return seeded;
  }

  /** Re-reads roles, assignments, overrides and the mappings of every guild seen so far. */
  async reload(): Promise<void> {
    const roles = await withContext("loading roles", this.#store.roles());
    const assignments = await withContext("loading role assignments", this.#store.allAssignments());
    const overrides = await withContext("loading overrides", this.#store.overrides());
    const guilds = [...this.#state.mappings.keys()];
    const mappings: [string, RoleMapping[]][] = [];
    for (const id of guilds) {
      const [platform, guild] = id.split("\u0000") as [string, string];
      mappings.push([
        id,
        await withContext("loading role mappings", this.#store.mappings(platform, guild)),
      ]);
    }
    const state = this.#state;
    state.roles = new Map(roles.map((r) => [r.name, r]));
    state.setAssignments(assignments);
    state.overrides = overrides;
    for (const [id, maps] of mappings) state.mappings.set(id, maps);
  }

  /** Replaces the config owners. */
  setOwners(owners: Iterable<AccountRef>): void {
    this.#state.setOwners(owners);
  }

  isConfigOwner(account: AccountRef): boolean {
    return this.#state.owners.has(accountKey(account));
  }

  defaultRole(): string {
    return this.#state.defaultRole;
  }

  /** All roles, highest rank first. */
  roles(): RoleDefinition[] {
    return [...this.#state.roles.values()].sort(
      (a, b) => b.rank - a.rank || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
    );
  }

  role(name: string): RoleDefinition | undefined {
    return this.#state.roles.get(name);
  }

  assignmentsFor(account: AccountRef): RoleAssignment[] {
    return [...(this.#state.assignments.get(accountKey(account)) ?? [])];
  }

  overrides(): NodeOverride[] {
    return [...this.#state.overrides];
  }

  /** A guild's platform role mappings, loading them if needed. */
  async mappings(platform: PlatformId, guild: string): Promise<RoleMapping[]> {
    const cached = this.#state.mappings.get(guildKeyId([platform, guild]));
    if (cached) return [...cached];
    return this.#loadMappings([platform, guild]);
  }

  /**
   * Resolves the effective role from the cache. If the subject's guild mappings are not cached
   * yet they are ignored this time and loaded in the background; call `preload` first to avoid
   * that.
   */
  resolve(subject: Subject): Resolution {
    const resolution = this.#state.resolve(subject);
    if (resolution.mappings_missing) this.#loadInBackground(subject);
    return resolution;
  }

  /** May `subject` use `node`? Same caching rules as `resolve`. */
  check(subject: Subject, node: string): boolean {
    const resolution = this.#state.resolve(subject);
    const allowed = this.#state.check(subject, resolution, node);
    if (resolution.mappings_missing) this.#loadInBackground(subject);
    return allowed;
  }

  allowsSubject(subject: Subject, node: string): boolean {
    return this.check(subject, node);
  }

  /** Makes sure the role mappings of the subject's guild are cached. */
  async preload(subject: Subject): Promise<void> {
    const key = guildOf(subject.context);
    if (!key || this.#state.mappings.has(guildKeyId(key))) return;
    try {
      const loaded = await withTimeout(this.#loadMappings(key), PRELOAD_TIMEOUT_MS);
      if (loaded === undefined) log.warn("loading role mappings timed out");
    } catch (error) {
      log.warn({ error: errorChain(error) }, "cannot load role mappings");
    }
  }

  async #loadMappings(key: GuildKey): Promise<RoleMapping[]> {
    const maps = await withContext("loading role mappings", this.#store.mappings(key[0], key[1]));
    this.#state.mappings.set(guildKeyId(key), maps);
    return [...maps];
  }

  #loadInBackground(subject: Subject): void {
    const key = guildOf(subject.context);
    if (!key) return;
    const id = guildKeyId(key);
    if (this.#loading.has(id)) return;
    this.#loading.add(id);
    log.debug({ platform: key[0], guild: key[1] }, "loading role mappings in the background");
    // Fire and forget: the check that triggered this already answered without the mappings.
    void this.#loadMappings(key)
      .catch((error: unknown) => {
        log.warn({ error: errorChain(error) }, "cannot load role mappings");
      })
      .finally(() => {
        this.#loading.delete(id);
      });
  }

  /** Creates or replaces a role. Built-in roles stay built in; new roles never are. */
  async upsertRole(actor: string, role: RoleDefinition): Promise<void> {
    const next: RoleDefinition = {
      ...role,
      builtin: this.role(role.name)?.builtin ?? false,
    };
    const result = await attempt(async () => {
      validateRoleName(next.name);
      const bad = [...next.grants, ...next.denies].find((p) => !isValidPattern(p));
      if (bad !== undefined) throw new AuthError(`invalid permission node \`${bad}\``);
      await this.#store.upsertRole(next);
      await this.#refreshRoles();
    });
    await this.#record(actor, "role.upsert", next.name, toJson(next), result.ok);
    return unwrap(result);
  }

  /**
   * Deletes a custom role. Built-in roles and the default role cannot be deleted. Assignments
   * of a deleted role are ignored from then on.
   */
  async deleteRole(actor: string, name: string): Promise<boolean> {
    const result = await attempt(async () => {
      if (this.role(name)?.builtin) {
        throw new AuthError(`built-in role \`${name}\` cannot be deleted`);
      }
      if (name === this.defaultRole()) throw new AuthError(`\`${name}\` is the default role`);
      const deleted = await this.#store.deleteRole(name);
      await this.#refreshRoles();
      return deleted;
    });
    await this.#record(actor, "role.delete", name, {}, result.ok);
    return unwrap(result);
  }

  /** Assigns `role` to `account` in `scope`, replacing the same assignment. */
  async assign(actor: string, account: AccountRef, role: string, scope: AuthScope): Promise<void> {
    const assignment: RoleAssignment = {
      account,
      role,
      scope,
      granted_by: actor,
      at: toTimestamp(this.#clock.now()),
    };
    const result = await attempt(async () => {
      this.#requireRole(role);
      await this.#store.assign(assignment);
      await this.#refreshAccount(account);
    });
    await this.#record(
      actor,
      "role.assign",
      accountString(account),
      toJson({ role, scope }),
      result.ok,
    );
    return unwrap(result);
  }

  async revoke(
    actor: string,
    account: AccountRef,
    role: string,
    scope: AuthScope,
  ): Promise<boolean> {
    const result = await attempt(async () => {
      const removed = await this.#store.revoke(account, role, scope);
      await this.#refreshAccount(account);
      return removed;
    });
    await this.#record(
      actor,
      "role.revoke",
      accountString(account),
      toJson({ role, scope }),
      result.ok,
    );
    return unwrap(result);
  }

  /**
   * Maps a platform role to a Miyoria role in one guild, replacing any previous mapping of that
   * platform role.
   */
  async mapRole(actor: string, mapping: RoleMapping): Promise<void> {
    const result = await attempt(async () => {
      this.#requireRole(mapping.role);
      await this.#store.setMapping(mapping);
      await this.#loadMappings([mapping.platform, mapping.guild]);
    });
    await this.#record(
      actor,
      "role.map",
      `${mapping.platform}:${mapping.guild}`,
      toJson(mapping),
      result.ok,
    );
    return unwrap(result);
  }

  async unmapRole(
    actor: string,
    platform: PlatformId,
    guild: string,
    platformRole: string,
  ): Promise<boolean> {
    const result = await attempt(async () => {
      const removed = await this.#store.removeMapping(platform, guild, platformRole);
      await this.#loadMappings([platform, guild]);
      return removed;
    });
    await this.#record(
      actor,
      "role.unmap",
      `${platform}:${guild}`,
      { platform_role: platformRole },
      result.ok,
    );
    return unwrap(result);
  }

  /** Allows or denies a node (or pattern) for a role in one scope. */
  async setOverride(actor: string, nodeOverride: NodeOverride): Promise<void> {
    const result = await attempt(async () => {
      this.#requireRole(nodeOverride.role);
      if (!isValidPattern(nodeOverride.node)) {
        throw new AuthError(`invalid permission node \`${nodeOverride.node}\``);
      }
      await this.#store.setOverride(nodeOverride);
      await this.#refreshOverrides();
    });
    await this.#record(actor, "perm.set", nodeOverride.role, toJson(nodeOverride), result.ok);
    return unwrap(result);
  }

  async removeOverride(
    actor: string,
    scope: AuthScope,
    role: string,
    node: string,
  ): Promise<boolean> {
    const result = await attempt(async () => {
      const removed = await this.#store.removeOverride(scope, role, node);
      await this.#refreshOverrides();
      return removed;
    });
    await this.#record(actor, "perm.remove", role, toJson({ scope, node }), result.ok);
    return unwrap(result);
  }

  #requireRole(role: string): void {
    if (!this.#state.roles.has(role)) throw new AuthError(`unknown role \`${role}\``);
  }

  async #refreshRoles(): Promise<void> {
    const roles = await this.#store.roles();
    this.#state.roles = new Map(roles.map((r) => [r.name, r]));
  }

  async #refreshAccount(account: AccountRef): Promise<void> {
    const assignments = await this.#store.assignmentsFor(account);
    const key = accountKey(account);
    if (assignments.length === 0) this.#state.assignments.delete(key);
    else this.#state.assignments.set(key, assignments);
  }

  async #refreshOverrides(): Promise<void> {
    this.#state.overrides = await this.#store.overrides();
  }

  async #record(
    actor: string,
    action: string,
    target: string,
    detail: JsonValue,
    ok: boolean,
  ): Promise<void> {
    if (!this.#audit) return;
    const entry: AuditEntry = {
      id: newId(),
      at: toTimestamp(this.#clock.now()),
      actor,
      action,
      target,
      detail,
      ok,
    };
    try {
      await this.#audit.append(entry);
    } catch (error) {
      log.warn({ action, error: errorChain(error) }, "cannot write audit entry");
    }
  }
}

type Attempt<T> = { ok: true; value: T } | { ok: false; error: unknown };

async function attempt<T>(fn: () => Promise<T>): Promise<Attempt<T>> {
  try {
    return { ok: true, value: await fn() };
  } catch (error) {
    return { ok: false, error };
  }
}

function unwrap<T>(result: Attempt<T>): T {
  if (result.ok) return result.value;
  throw result.error;
}

/** `"platform:id"`. */
export function accountString(account: AccountRef): string {
  return `${account.platform}:${account.id}`;
}

function toJson(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function validateRoleName(name: string): void {
  const length = [...name].length;
  if (length >= 1 && length <= MAX_ROLE_NAME && /^[a-z0-9_-]+$/.test(name)) return;
  throw new AuthError(`invalid role name \`${name}\` (1-${MAX_ROLE_NAME} of a-z 0-9 _ -)`);
}
