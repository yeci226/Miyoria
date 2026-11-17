import type { AccountRef, ContextKey } from "./platform.js";
import { serviceKey } from "./service-key.js";

/** Who is asking, with as much context as the caller has. */
export interface Subject {
  account: AccountRef;
  /** Where the action happens (guild / channel overrides apply). */
  context: ContextKey | null;
  /** Platform role ids (e.g. Discord role ids) of the account in that guild. */
  platform_roles: string[];
  /** Platform-level administrator (e.g. Discord ADMINISTRATOR / MANAGE_GUILD). */
  is_guild_admin: boolean;
}

/** A subject with nothing but the account. */
export function accountSubject(account: AccountRef): Subject {
  return { account, context: null, platform_roles: [], is_guild_admin: false };
}

/**
 * Answers "may this subject use this permission node?". Provided as the `AuthorizerKey` service
 * by the module that owns permissions (`auth`, or `commands` as a fallback). Used for commands,
 * tools and API calls. Must answer from memory (no I/O).
 */
export interface Authorizer {
  allows(account: AccountRef, node: string): boolean;
  allowsSubject(subject: Subject, node: string): boolean;
}

/** Implements `allows` in terms of `allowsSubject`. */
export abstract class BaseAuthorizer implements Authorizer {
  allows(account: AccountRef, node: string): boolean {
    return this.allowsSubject(accountSubject(account), node);
  }

  abstract allowsSubject(subject: Subject, node: string): boolean;
}

export const AuthorizerKey = serviceKey<Authorizer>("Authorizer");
