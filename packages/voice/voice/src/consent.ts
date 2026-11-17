// Per-user consent to being listened to.

import { errorMessage, getLogger } from "@miyoria/runtime/kernel";
import type { SettingsStore } from "@miyoria/store";
import { type AccountRef, type Clock, type ProfileId, systemClock } from "@miyoria/types";

const log = getLogger("voice.consent");

/** Settings profile consent flags are stored under (they are not tied to a character). */
export const CONSENT_PROFILE: ProfileId = "_global";

/** Whether users are listened to unless they opt out, or only after opting in. */
export type ConsentPolicy = "opt-out" | "opt-in";

export function defaultAllowed(policy: ConsentPolicy): boolean {
  return policy === "opt-out";
}

/** Settings key of one user's flag: `voice_consent:<platform>:<user_id>`. */
export function consentKey(account: AccountRef): string {
  return `voice_consent:${account.platform}:${account.id}`;
}

const CACHE_TTL_MS = 60_000;

/**
 * Consent lookups, backed by a `SettingsStore` (or memory only when no store is available) with
 * a short cache.
 */
export class Consent {
  readonly policy: ConsentPolicy;
  readonly #store: SettingsStore | null;
  readonly #clock: Clock;
  readonly #cache = new Map<string, { value: boolean; at: number }>();
  /** Flags set while no store is available. */
  readonly #local = new Map<string, boolean>();

  constructor(policy: ConsentPolicy, store: SettingsStore | null, clock: Clock = systemClock) {
    this.policy = policy;
    this.#store = store;
    this.#clock = clock;
  }

  /** Whether `account` may be listened to. Store errors count as "no" (fail closed). */
  async allowed(account: AccountRef): Promise<boolean> {
    const key = consentKey(account);
    const now = this.#clock.now();
    const cached = this.#cache.get(key);
    if (cached && now - cached.at < CACHE_TTL_MS) return cached.value;
    let value: boolean;
    if (this.#store) {
      try {
        const v = await this.#store.get(CONSENT_PROFILE, key);
        value = typeof v === "boolean" ? v : defaultAllowed(this.policy);
      } catch (error) {
        log.warn({ err: errorMessage(error) }, "cannot read voice consent; not listening");
        return false;
      }
    } else {
      value = this.#local.get(key) ?? defaultAllowed(this.policy);
    }
    this.#cache.set(key, { value, at: this.#clock.now() });
    return value;
  }

  /** Records `account`'s choice. */
  async set(account: AccountRef, allowed: boolean): Promise<void> {
    const key = consentKey(account);
    if (this.#store) await this.#store.set(CONSENT_PROFILE, key, allowed);
    else this.#local.set(key, allowed);
    this.#cache.set(key, { value: allowed, at: this.#clock.now() });
  }
}
