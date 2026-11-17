// Fallback permissions, used when no `Authorizer` service (the `auth` module's RBAC) is
// available. They apply the built-in role grants of `nodes.ts` to three fixed roles, so every
// node means the same as with `auth`: configured owners are `owner`, guild admins (Administrator
// or Manage Server) are `admin`, everyone else is `user`.

import { type AccountRef, BaseAuthorizer, type PlatformId, type Subject } from "@miyoria/types";
import { type BuiltinRole, builtinRole, granted } from "./nodes.js";
import { CommandError, type InvocationData } from "./spec.js";

/** `owner` (a configured owner) > `admin` (guild admin) > `user`. */
export type Role = "user" | "admin" | "owner";

const accountKey = (account: AccountRef): string => `${account.platform}\0${account.id}`;

const GRANTS: Readonly<Record<Role, BuiltinRole>> = {
  owner: builtinRole("owner") as BuiltinRole,
  admin: builtinRole("admin") as BuiltinRole,
  user: builtinRole("user") as BuiltinRole,
};

/** Resolves the role of an invoker. Also the fallback `Authorizer`. */
export class Permissions extends BaseAuthorizer {
  readonly #owners = new Map<string, AccountRef>();

  constructor(owners: Iterable<AccountRef> = []) {
    super();
    this.setOwners(owners);
  }

  /** Parses `"platform:id"` strings such as `"discord:123"`. */
  static fromStrings(owners: readonly string[]): Permissions {
    return new Permissions(owners.map(parseAccount));
  }

  /** Replaces the configured owners. */
  setOwners(owners: Iterable<AccountRef>): void {
    this.#owners.clear();
    for (const owner of owners) this.#owners.set(accountKey(owner), owner);
  }

  isOwner(account: AccountRef): boolean {
    return this.#owners.has(accountKey(account));
  }

  /** The configured owners. */
  owners(): AccountRef[] {
    return [...this.#owners.values()];
  }

  roleOf(invocation: Pick<InvocationData, "invoker" | "invoker_is_guild_admin">): Role {
    return this.#role(invocation.invoker, invocation.invoker_is_guild_admin);
  }

  allowsInvocation(
    invocation: Pick<InvocationData, "invoker" | "invoker_is_guild_admin">,
    permission: string,
  ): boolean {
    return allowed(this.roleOf(invocation), permission);
  }

  /**
   * Account-only checks (e.g. tools run on behalf of the user who triggered a turn) carry no
   * guild-admin information, so such accounts are owners or plain users.
   */
  allowsSubject(subject: Subject, node: string): boolean {
    return allowed(this.#role(subject.account, subject.is_guild_admin), node);
  }

  #role(account: AccountRef, isGuildAdmin: boolean): Role {
    if (this.isOwner(account)) return "owner";
    return isGuildAdmin ? "admin" : "user";
  }
}

function allowed(role: Role, node: string): boolean {
  if (node === "") return true;
  const def = GRANTS[role];
  return granted(def.grants, def.denies, node);
}

/** Parses `"platform:id"` into an `AccountRef`. */
export function parseAccount(s: string): AccountRef {
  const trimmed = s.trim();
  const colon = trimmed.indexOf(":");
  if (colon > 0 && colon < trimmed.length - 1) {
    const platform: PlatformId = trimmed.slice(0, colon);
    return { platform, id: trimmed.slice(colon + 1) };
  }
  throw new CommandError(`invalid account \`${s}\`, expected \`platform:id\``);
}
