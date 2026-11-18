// Per-person opt-outs: "don't DM me", "don't come to me on your own", "don't watch my stream". Set with `/me privacy`,
// checked by the gate before anything else that concerns the person.

import { errorMessage, getLogger, type ServiceLookup } from "@miyoria/runtime/kernel";
import { SettingsStoreKey } from "@miyoria/store";
import {
  type AccountRef,
  isJsonObject,
  type JsonValue,
  mergePrivacy,
  type ProfileId,
} from "@miyoria/types";

const log = getLogger("actions.privacy");

/** Settings profile of the choices (they belong to the person, not to a character). */
export const PRIVACY_PROFILE: ProfileId = "_global";

/** `true` = allowed (the default). */
export interface PrivacyChoices {
  /** She may DM them. */
  dm: boolean;
  /** She may approach them on her own (DMs she starts, joining them, ...). */
  approach: boolean;
  /** She may watch their Go Live. */
  watch: boolean;
}

export const DEFAULT_PRIVACY: Readonly<PrivacyChoices> = { dm: true, approach: true, watch: true };

/** `privacy:<platform>:<id>`. */
export function privacyKey(account: AccountRef): string {
  return `privacy:${account.platform}:${account.id}`;
}

function parseChoices(value: JsonValue | null): PrivacyChoices {
  if (!isJsonObject(value)) return { ...DEFAULT_PRIVACY };
  return {
    dm: value.dm !== false,
    approach: value.approach !== false,
    watch: value.watch !== false,
  };
}

/** Reads and writes the choices in the `SettingsStore` (memory only without one). */
export class Privacy {
  readonly #services: ServiceLookup;
  readonly #local = new Map<string, PrivacyChoices>();

  constructor(services: ServiceLookup) {
    this.#services = services;
  }

  /** A store failure counts as opted out of everything (fail closed). */
  async get(account: AccountRef): Promise<PrivacyChoices> {
    const store = this.#services.get(SettingsStoreKey);
    const key = privacyKey(account);
    if (!store) return { ...(this.#local.get(key) ?? DEFAULT_PRIVACY) };
    try {
      return parseChoices(await store.get(PRIVACY_PROFILE, key));
    } catch (error) {
      log.warn({ err: errorMessage(error) }, "cannot read privacy choices; treating as opted out");
      return { dm: false, approach: false, watch: false };
    }
  }

  async set(account: AccountRef, patch: Partial<PrivacyChoices>): Promise<PrivacyChoices> {
    const next = { ...(await this.get(account)), ...patch };
    const store = this.#services.get(SettingsStoreKey);
    const key = privacyKey(account);
    if (store) {
      // The record is shared with other features (e.g. the presence opt-out): merge, never replace.
      const existing = await store.get(PRIVACY_PROFILE, key);
      await store.set(PRIVACY_PROFILE, key, mergePrivacy(existing, patch));
    } else {
      this.#local.set(key, next);
    }
    return next;
  }
}
