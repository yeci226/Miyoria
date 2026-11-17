// The store's older interfaces over the `identity` tables, so every caller keeps working while
// it moves (docs/design/v5-data.md §8 step 4): `PeopleStore`, `IdentityStore`, the
// `HandleDirectory`, and the settings keys of a person's choices (`privacy:*`, `voice_consent:*`,
// which callers write under `_global`), which now live in `persons.prefs`.

import {
  type AccountRef,
  assignHandle,
  type Handle,
  type HandleEntry,
  type JsonValue,
  type PersonId,
  type ProfileId,
  type Timestamp,
} from "@miyoria/types";
import type { PersonHandleDirectory } from "../handles.js";
import type { PersonRequestResult } from "../person-data.js";
import type { Account, Person } from "../records.js";
import type { IdentityStore, PeopleStore, SettingsStore } from "../stores.js";
import type { Identity } from "./identity.js";
import type { AccountRow, PersonPrefs, PersonRow } from "./schema.js";

function accountOf(row: AccountRow): Account {
  return {
    account: { platform: row.platform, id: row.external_id },
    display_name: row.display_name,
    first_seen: row.first_seen,
    last_seen: row.last_seen,
  };
}

function personOf(row: PersonRow, accounts: readonly AccountRow[]): Person {
  return {
    id: row.id,
    display_name: row.name,
    created_at: row.created_at,
    accounts: accounts.map(accountOf),
  };
}

/** `PeopleStore` over `persons` and `accounts`. */
export class IdentityPeople implements PeopleStore {
  constructor(private readonly identity: Identity) {}

  async upsertAccount(account: AccountRef, displayName: string): Promise<PersonId> {
    return this.identity.see(account, displayName).id;
  }

  async personByAccount(account: AccountRef): Promise<Person | null> {
    const row = this.identity.personOf(account);
    return row === null ? null : personOf(row, this.identity.accountsOf(row.id));
  }

  async all(): Promise<Person[]> {
    const byPerson = new Map<PersonId, AccountRow[]>();
    for (const account of this.identity.personAccounts()) {
      const id = account.person_id as PersonId;
      byPerson.set(id, [...(byPerson.get(id) ?? []), account]);
    }
    return this.identity.persons().map((p) => personOf(p, byPerson.get(p.id) ?? []));
  }
}

/**
 * `IdentityStore` over `accounts`, `persons` and `link_codes`. A merge goes through `merge`: the
 * store's coordinator (`person-data.ts`), which runs every schema's `mergePerson` hook with
 * identity's own in one transaction.
 */
export class IdentityLinks implements IdentityStore {
  constructor(
    private readonly identity: Identity,
    private readonly merge: (keep: PersonId, absorb: PersonId) => PersonRequestResult | null = (
      keep,
      absorb,
    ) => {
      identity.merge(keep, absorb);
      return null;
    },
  ) {}

  async linkAccount(account: AccountRef, person: PersonId): Promise<void> {
    this.identity.link(account, person, "code");
  }

  async mergePeople(keep: PersonId, absorb: PersonId): Promise<PersonRequestResult | null> {
    // A person merged into itself is no merge: checked, and nothing to run or record.
    if (keep !== absorb) return this.merge(keep, absorb);
    this.identity.merge(keep, absorb);
    return null;
  }

  async accountsOf(person: PersonId): Promise<Account[]> {
    return this.identity.accountsOf(person).map(accountOf);
  }

  async setPersonName(person: PersonId, displayName: string): Promise<void> {
    this.identity.rename(person, displayName);
  }

  async createLinkCode(code: string, account: AccountRef, expiresAt: Timestamp): Promise<void> {
    this.identity.createLinkCode(code, account, expiresAt);
  }

  async consumeLinkCode(code: string, now: Timestamp): Promise<AccountRef | null> {
    return this.identity.consumeLinkCode(code, now);
  }
}

/**
 * `HandleDirectory` over `persons.handle`: one handle per person, made on first sight from the
 * first account's name. It answers synchronously from the database (no copy in memory), so every
 * module sees the same table.
 */
export class IdentityHandles implements PersonHandleDirectory {
  constructor(private readonly identity: Identity) {}

  #entry(row: PersonRow): HandleEntry {
    const first = this.identity.accountsOf(row.id)[0];
    return {
      handle: row.handle,
      person: row.id,
      account: first === undefined ? null : { platform: first.platform, id: first.external_id },
      display_name: row.name,
      created_at: row.created_at,
    };
  }

  ofAccount(account: AccountRef, displayName: string, person: PersonId | null = null): Handle {
    const known = this.identity.personOf(account);
    if (known !== null) return known.handle;
    // First sight. A caller that already knows the person links the account to them.
    if (person !== null && this.identity.person(person) !== null) {
      this.identity.link(account, person, "first_sight");
    }
    return this.identity.see(account, displayName).handle;
  }

  ofPerson(person: PersonId): Handle | null {
    return this.identity.person(person)?.handle ?? null;
  }

  resolve(handle: Handle): HandleEntry | null {
    const wanted = handle.trim();
    const row = this.identity.personByHandle(wanted);
    // Exact match only: `owen` does not resolve `Owen` (the model must copy the handle).
    if (row === null || row.handle !== wanted) return null;
    const live = this.identity.person(row.id);
    return live === null ? null : this.#entry(live);
  }

  list(): HandleEntry[] {
    return this.identity.persons().map((p) => this.#entry(p));
  }

  ensurePerson(person: Person): Handle {
    const known = this.ofPerson(person.id);
    if (known !== null) return known;
    // Not a person of this database: a handle of the name alone, never stored.
    return assignHandle(person.display_name, (h) => this.identity.personByHandle(h) !== null);
  }

  syncPeople(_people: readonly Person[]): void {
    // Every person has a handle from the moment it exists.
  }
}

/** The settings key families that are a person's choices, by `PersonPrefs` entry. */
const PREF_KEYS = { privacy: "privacy:", voice_consent: "voice_consent:" } as const;
type PrefKey = keyof typeof PREF_KEYS;

function prefKey(key: string): { pref: PrefKey; account: AccountRef } | null {
  for (const [pref, prefix] of Object.entries(PREF_KEYS) as [PrefKey, string][]) {
    if (!key.startsWith(prefix)) continue;
    const rest = key.slice(prefix.length);
    const colon = rest.indexOf(":");
    if (colon <= 0 || colon === rest.length - 1) return null;
    return { pref, account: { platform: rest.slice(0, colon), id: rest.slice(colon + 1) } };
  }
  return null;
}

/**
 * A `SettingsStore` that keeps `privacy:<platform>:<id>` and `voice_consent:<platform>:<id>` in
 * `persons.prefs` and everything else in `inner`. The choice belongs to the person, so every
 * account of a person reads the same value. One database is one character, so the profile a
 * caller names does not matter (callers name `_global`).
 */
export class PrefsSettings implements SettingsStore {
  constructor(
    private readonly inner: SettingsStore,
    private readonly identity: Identity,
  ) {}

  async get(profile: ProfileId, key: string): Promise<JsonValue | null> {
    const routed = prefKey(key);
    if (routed === null) return this.inner.get(profile, key);
    return this.identity.pref(routed.account, routed.pref) ?? null;
  }

  async set(profile: ProfileId, key: string, value: JsonValue | null): Promise<void> {
    const routed = prefKey(key);
    if (routed === null) return this.inner.set(profile, key, value);
    this.identity.setPref(routed.account, routed.pref, value);
  }

  /** The routed keys of `_global` starting with `prefix`, with their values. */
  #prefs(prefix: string): Map<string, JsonValue> {
    const out = new Map<string, JsonValue>();
    for (const [pref, keyPrefix] of Object.entries(PREF_KEYS) as [keyof PersonPrefs, string][]) {
      if (!keyPrefix.startsWith(prefix) && !prefix.startsWith(keyPrefix)) continue;
      for (const { account, value } of this.identity.prefsByAccount(pref)) {
        const key = `${keyPrefix}${account.platform}:${account.external_id}`;
        if (key.startsWith(prefix)) out.set(key, value);
      }
    }
    return out;
  }

  async list(profile: ProfileId, prefix: string): Promise<Map<string, JsonValue>> {
    const stored = await this.inner.list(profile, prefix);
    const prefs = this.#prefs(prefix);
    if (prefs.size === 0) return stored;
    const keys = [...new Set([...stored.keys(), ...prefs.keys()])].sort((a, b) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    return new Map(keys.map((k) => [k, (prefs.get(k) ?? stored.get(k)) as JsonValue]));
  }

  async deletePrefix(profile: ProfileId, prefix: string): Promise<number> {
    let n = await this.inner.deletePrefix(profile, prefix);
    for (const key of this.#prefs(prefix).keys()) {
      const routed = prefKey(key);
      if (routed === null) continue;
      // Two accounts of one person share the value: the first clears it for both.
      if (this.identity.pref(routed.account, routed.pref) === null) continue;
      this.identity.setPref(routed.account, routed.pref, null);
      n++;
    }
    return n;
  }
}
