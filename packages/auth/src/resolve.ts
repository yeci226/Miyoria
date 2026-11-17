// Pure role resolution and node checks over a cached snapshot of the `AuthStore`.

import type {
  AuthScope,
  NodeOverride,
  RoleAssignment,
  RoleDefinition,
  RoleMapping,
} from "@miyoria/store";
import { type AccountRef, accountRefString, type ContextKey, type Subject } from "@miyoria/types";
import { ADMIN, BLOCKED_RANK, OWNER } from "./builtin.js";
import { matches } from "./node.js";

/** `(platform, guild id)`. */
export type GuildKey = readonly [platform: string, guild: string];

/** Map key of a guild. */
export function guildKeyId(key: GuildKey): string {
  return `${key[0]}\u0000${key[1]}`;
}

/** Map key of an account (`"platform:id"`). */
export function accountKey(account: AccountRef): string {
  return accountRefString(account);
}

/** Structural equality of scopes. */
export function scopeEquals(a: AuthScope, b: AuthScope): boolean {
  switch (a.type) {
    case "global":
      return b.type === "global";
    case "guild":
      return b.type === "guild" && a.platform === b.platform && a.guild === b.guild;
    case "channel":
      return (
        b.type === "channel" &&
        a.context.platform === b.context.platform &&
        a.context.scope === b.context.scope &&
        a.context.channel === b.context.channel &&
        a.context.kind === b.context.kind
      );
  }
}

/** Why a subject may hold a role. Serialized as `{ type, ... }`. */
export type Source =
  /** Listed in `[modules.auth] owners` (or `[modules.commands] owners`). */
  | { type: "config_owner" }
  | { type: "assignment"; scope: AuthScope; granted_by: string }
  /** A platform role (e.g. Discord role id) mapped in this guild. */
  | { type: "platform_role"; platform_role: string }
  /** Platform-level administrator of the guild; at least `admin`. */
  | { type: "guild_admin" }
  /** Nothing else applied. */
  | { type: "default" };

export function sourceEquals(a: Source, b: Source): boolean {
  if (a.type !== b.type) return false;
  switch (a.type) {
    case "assignment":
      return (
        b.type === "assignment" && a.granted_by === b.granted_by && scopeEquals(a.scope, b.scope)
      );
    case "platform_role":
      return b.type === "platform_role" && a.platform_role === b.platform_role;
    default:
      return true;
  }
}

/** Breaks rank ties: more specific sources win. */
function specificity(source: Source): number {
  switch (source.type) {
    case "config_owner":
      return 4;
    case "assignment":
      return source.scope.type === "channel" ? 3 : source.scope.type === "guild" ? 2 : 1;
    case "platform_role":
    case "guild_admin":
      return 2;
    case "default":
      return 0;
  }
}

export interface Candidate {
  role: string;
  rank: number;
  source: Source;
}

export function candidateEquals(a: Candidate, b: Candidate): boolean {
  return a.role === b.role && a.rank === b.rank && sourceEquals(a.source, b.source);
}

/** The effective role of a subject and every role that applied. */
export interface Resolution {
  effective: Candidate;
  /** All applicable roles, best first (includes `effective`). */
  candidates: Candidate[];
  /** The guild's platform role mappings were not cached yet and were ignored. */
  mappings_missing: boolean;
}

export function isConfigOwner(resolution: Resolution): boolean {
  return resolution.effective.source.type === "config_owner";
}

/**
 * May this subject manage something at `rank` (assign that role, edit someone holding it)?
 * Config owners may manage everything, everyone else only strictly lower ranks.
 */
export function outranks(resolution: Resolution, rank: number): boolean {
  return isConfigOwner(resolution) || rank < resolution.effective.rank;
}

/** Everything the authorizer needs, cached from the store. */
export class Snapshot {
  roles = new Map<string, RoleDefinition>();
  assignments = new Map<string, RoleAssignment[]>();
  overrides: NodeOverride[] = [];
  /** Per guild (`guildKeyId`); guilds not in the map have not been loaded yet. */
  mappings = new Map<string, RoleMapping[]>();
  owners = new Set<string>();
  defaultRole = "";

  setOwners(owners: Iterable<AccountRef>): void {
    this.owners = new Set([...owners].map(accountKey));
  }

  setAssignments(all: readonly RoleAssignment[]): void {
    this.assignments.clear();
    for (const a of all) {
      const key = accountKey(a.account);
      const list = this.assignments.get(key);
      if (list) list.push(a);
      else this.assignments.set(key, [a]);
    }
  }

  #candidate(role: string, source: Source): Candidate | undefined {
    const def = this.roles.get(role);
    return def ? { role: def.name, rank: def.rank, source } : undefined;
  }

  /**
   * Resolves the effective role:
   *
   * 1. config owners -> `owner`;
   * 2. explicit assignments whose scope covers the subject's context;
   * 3. platform role mappings of the subject's guild;
   * 4. guild admins -> `admin`;
   * 5. nothing applied -> the default role (`user`).
   *
   * The highest rank wins (ties: the more specific source), except that an explicit assignment
   * of a blocked role (rank <= 0) beats everything but config owners.
   */
  resolve(subject: Subject): Resolution {
    const ctx = subject.context;
    const candidates: Candidate[] = [];
    const push = (candidate: Candidate | undefined) => {
      if (candidate) candidates.push(candidate);
    };
    if (this.owners.has(accountKey(subject.account))) {
      candidates.push({
        role: OWNER,
        rank: this.roles.get(OWNER)?.rank ?? 100,
        source: { type: "config_owner" },
      });
    }
    for (const a of this.assignments.get(accountKey(subject.account)) ?? []) {
      if (scopeCovers(a.scope, ctx)) {
        push(
          this.#candidate(a.role, { type: "assignment", scope: a.scope, granted_by: a.granted_by }),
        );
      }
    }
    let mappingsMissing = false;
    const guild = guildOf(ctx);
    if (guild) {
      const maps = this.mappings.get(guildKeyId(guild));
      if (maps) {
        for (const m of maps) {
          if (subject.platform_roles.includes(m.platform_role)) {
            push(
              this.#candidate(m.role, { type: "platform_role", platform_role: m.platform_role }),
            );
          }
        }
      } else {
        mappingsMissing = subject.platform_roles.length > 0;
      }
    }
    if (subject.is_guild_admin) push(this.#candidate(ADMIN, { type: "guild_admin" }));
    if (candidates.length === 0) {
      candidates.push(
        this.#candidate(this.defaultRole, { type: "default" }) ?? {
          role: this.defaultRole,
          rank: BLOCKED_RANK,
          source: { type: "default" },
        },
      );
    }
    // Stable sort: rank desc, specificity desc, role name asc.
    candidates.sort(
      (a, b) =>
        b.rank - a.rank ||
        specificity(b.source) - specificity(a.source) ||
        (a.role < b.role ? -1 : a.role > b.role ? 1 : 0),
    );
    const blocked = candidates.find(
      (c) => c.rank <= BLOCKED_RANK && c.source.type === "assignment",
    );
    const first = candidates[0] as Candidate;
    const effective = first.source.type === "config_owner" ? first : (blocked ?? first);
    return { effective, candidates, mappings_missing: mappingsMissing };
  }

  /**
   * May `subject`, resolved as `resolution`, use `node`?
   *
   * Config owners may use everything. Otherwise the effective role's overrides are checked from
   * the most specific scope that has a matching one (channel > guild > global), then the role's
   * own lists. Within one level a deny beats a grant. The empty node ("no permission needed")
   * is open to every role above the blocked rank.
   */
  check(subject: Subject, resolution: Resolution, node: string): boolean {
    if (isConfigOwner(resolution)) return true;
    const role = resolution.effective.role;
    if (node === "") return resolution.effective.rank > BLOCKED_RANK && this.roles.has(role);
    const ctx = subject.context;
    for (const level of ["channel", "guild", "global"] as const) {
      let allowed: boolean | undefined;
      for (const o of this.overrides) {
        if (
          o.role === role &&
          o.scope.type === level &&
          scopeCovers(o.scope, ctx) &&
          matches(o.node, node)
        ) {
          allowed = (allowed ?? true) && o.allow;
        }
      }
      if (allowed !== undefined) return allowed;
    }
    const def = this.roles.get(role);
    if (!def) return false;
    return !def.denies.some((p) => matches(p, node)) && def.grants.some((p) => matches(p, node));
  }
}

export function guildOf(ctx: ContextKey | null): GuildKey | null {
  if (!ctx || ctx.scope === null) return null;
  return [ctx.platform, ctx.scope];
}

/**
 * Same platform, guild and channel id; the context kind is ignored, so a channel scope also
 * covers the channel's threads-as-channel and voice chat.
 */
function sameChannel(a: ContextKey, b: ContextKey): boolean {
  return a.platform === b.platform && a.scope === b.scope && a.channel === b.channel;
}

/** Does `scope` apply in `ctx`? Global always does; guild and channel scopes need a matching context. */
export function scopeCovers(scope: AuthScope, ctx: ContextKey | null): boolean {
  switch (scope.type) {
    case "global":
      return true;
    case "guild":
      return ctx !== null && ctx.platform === scope.platform && ctx.scope === scope.guild;
    case "channel":
      return ctx !== null && sameChannel(ctx, scope.context);
  }
}
