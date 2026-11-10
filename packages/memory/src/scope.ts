// Privacy scopes: where a memory may be recalled, and where new memories go.
//
// Visible in a context:
// * `global` everywhere;
// * `guild` of the context's guild;
// * `channel` of exactly this context;
// * `dm { account }` only inside a DM, for the accounts in it;
// * `person` of people present (with a known `PersonId`).
//
// Anything learned in a DM is scoped to that DM, so it never surfaces elsewhere (unless
// `allow_global_from_dm` is set for person-wide facts).

import type { MemoryKind, MemoryScope } from "@miyoria/store";
import {
  type AccountRef,
  type ContextKey,
  contextKeyEquals,
  contextKeyString,
  type PersonId,
  type PromptRequest,
  sameAccount,
} from "@miyoria/types";
import type { MemoryConfig } from "./config.js";

/** Structural equality of two scopes (Rust `PartialEq`). */
export function scopeEquals(a: MemoryScope, b: MemoryScope): boolean {
  switch (a.type) {
    case "global":
      return b.type === "global";
    case "guild":
      return b.type === "guild" && a.platform === b.platform && a.guild === b.guild;
    case "channel":
      return b.type === "channel" && contextKeyEquals(a.context, b.context);
    case "dm":
      return b.type === "dm" && sameAccount(a.account, b.account);
    case "person":
      return b.type === "person" && a.person === b.person;
  }
}

/** `scopes` contains `scope`. */
export function hasScope(scopes: readonly MemoryScope[], scope: MemoryScope): boolean {
  return scopes.some((s) => scopeEquals(s, scope));
}

function pushUnique(scopes: MemoryScope[], scope: MemoryScope): void {
  if (!hasScope(scopes, scope)) scopes.push(scope);
}

/** Scopes whose memories may be recalled in `context` with these accounts and people present. */
export function visibleScopes(
  context: ContextKey,
  accounts: Iterable<AccountRef>,
  persons: Iterable<PersonId>,
): MemoryScope[] {
  const scopes: MemoryScope[] = [{ type: "global" }];
  if (context.scope !== null) {
    scopes.push({ type: "guild", platform: context.platform, guild: context.scope });
  }
  scopes.push({ type: "channel", context });
  if (isPrivate(context)) {
    for (const account of accounts) pushUnique(scopes, { type: "dm", account });
  }
  for (const person of persons) pushUnique(scopes, { type: "person", person });
  return scopes;
}

/**
 * Whether a memory about someone may be shown to that person alone, on a page of their own, where
 * there is no channel to scope by. Anything said in a private place belongs to whoever was there:
 * another account's DM, and a channel outside any guild, stay hidden even when about this person.
 */
export function visibleToSelf(
  scope: MemoryScope,
  account: AccountRef,
  person: PersonId | null,
): boolean {
  switch (scope.type) {
    case "global":
    case "guild":
      return true;
    case "channel":
      return !isPrivate(scope.context);
    case "dm":
      return sameAccount(scope.account, account);
    case "person":
      return person !== null && scope.person === person;
  }
}

/** `visibleScopes` for a prompt request (participants and speakers). */
export function requestScopes(request: PromptRequest): MemoryScope[] {
  const accounts = [...request.participants.map((p) => p.account), ...request.speakers];
  return visibleScopes(request.context, accounts, presentPeople(request));
}

/** People present in a prompt request. */
export function presentPeople(request: PromptRequest): PersonId[] {
  const out: PersonId[] = [];
  for (const p of request.participants) {
    if (p.person !== null && !out.includes(p.person)) out.push(p.person);
  }
  return out;
}

/** A DM, or a context outside any guild. */
export function isPrivate(context: ContextKey): boolean {
  return context.kind === "dm" || context.scope === null;
}

/**
 * Scope of a new memory learned in `context`.
 *
 * * DM (or guild-less context): `dm { partner }`, or `channel` when the partner is unknown or
 *   there are several. With `allow_global_from_dm`, global facts about a known person become
 *   `person`.
 * * Guild: self notes → `global`; global facts about a known person → `person`; everything
 *   else → `guild` (or `channel`, per `guild_scope`).
 */
export function scopeForNew(
  config: MemoryConfig,
  context: ContextKey,
  dmPartner: AccountRef | null,
  kind: MemoryKind,
  globalPerson: PersonId | null,
): MemoryScope {
  if (isPrivate(context)) {
    if (kind === "fact" && config.allow_global_from_dm && globalPerson !== null) {
      return { type: "person", person: globalPerson };
    }
    if (dmPartner !== null && context.kind === "dm") return { type: "dm", account: dmPartner };
    return { type: "channel", context };
  }
  if (kind === "self_note") return { type: "global" };
  if (kind === "fact" && globalPerson !== null) return { type: "person", person: globalPerson };
  if (config.guild_scope === "guild" && context.scope !== null) {
    return { type: "guild", platform: context.platform, guild: context.scope };
  }
  return { type: "channel", context };
}

/** Short label for exports and admin views. */
export function scopeLabel(scope: MemoryScope): string {
  switch (scope.type) {
    case "global":
      return "global";
    case "guild":
      return `guild:${scope.guild}`;
    case "channel":
      return `channel:${contextKeyString(scope.context)}`;
    case "dm":
      return "dm";
    case "person":
      return "person";
  }
}
