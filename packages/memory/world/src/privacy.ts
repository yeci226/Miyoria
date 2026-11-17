// Presence opt-out: the `PresencePrivacy` service the platform modules ask before publishing
// someone's presence (set with `/me privacy presence`, which the `actions` module registers).
// The choice is stored in the shared
// per-person privacy record (`privacy:<platform>:<id>` under `_global`, see `@miyoria/types`).

import { errorMessage, getLogger } from "@miyoria/runtime/kernel";
import type { SettingsStore } from "@miyoria/store";
import {
  type AccountRef,
  accountRefString,
  mergePrivacy,
  PRIVACY_PREFIX,
  PRIVACY_PROFILE,
  parsePrivacy,
  privacyAccount,
  privacyKey,
} from "@miyoria/types";

const log = getLogger("world.privacy");

/**
 * Who opted out of presence, loaded once and kept in memory so lookups are synchronous. Until
 * the records are loaded every presence is refused (fail closed).
 */
export class PrivacyBook {
  readonly #denied = new Set<string>();
  #loaded: boolean;

  constructor(private readonly store: SettingsStore | null) {
    this.#loaded = store === null;
  }

  get loaded(): boolean {
    return this.#loaded;
  }

  /** Reads every privacy record. Returns whether it worked (otherwise presence stays refused). */
  async load(): Promise<boolean> {
    if (!this.store) return true;
    try {
      const records = await this.store.list(PRIVACY_PROFILE, PRIVACY_PREFIX);
      this.#denied.clear();
      for (const [key, value] of records) {
        const account = privacyAccount(key);
        if (account && !parsePrivacy(value).presence) this.#denied.add(accountRefString(account));
      }
      this.#loaded = true;
    } catch (error) {
      log.warn({ err: errorMessage(error) }, "cannot read privacy settings; ignoring presence");
    }
    return this.#loaded;
  }

  presenceAllowed(account: AccountRef): boolean {
    return this.#loaded && !this.#denied.has(accountRefString(account));
  }

  /** Records `account`'s choice, keeping the other fields of their record. */
  async setPresence(account: AccountRef, allowed: boolean): Promise<void> {
    if (this.store) {
      const key = privacyKey(account);
      const existing = await this.store.get(PRIVACY_PROFILE, key);
      await this.store.set(PRIVACY_PROFILE, key, mergePrivacy(existing, { presence: allowed }));
    }
    if (allowed) this.#denied.delete(accountRefString(account));
    else this.#denied.add(accountRefString(account));
  }
}
