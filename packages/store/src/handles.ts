// The stable handle table (docs/design/v2-architecture.md §3.1): the one name she uses for a
// person in prompts and in everything she writes down. A handle is the display name the
// account had when it was first seen, kept here so it never changes between calls; only a
// second person with the same name gets a suffix (`Owen`, `Owen#2`).
//
// The table lives in `SettingsStore` under the node-wide settings profile (one row per
// account, key `handle:<platform>:<id>`), is read into memory at start and answers
// synchronously; new rows are written in the background. It is shared by every profile, like
// the people it names.

import { errorMessage, getLogger, SerialQueue } from "@miyoria/kernel";
import {
  type AccountRef,
  accountRefString,
  assignHandle,
  type Clock,
  type Handle,
  type HandleDirectory,
  type HandleEntry,
  isJsonObject,
  isValidHandle,
  type JsonValue,
  type PersonId,
  systemClock,
  toTimestamp,
} from "@miyoria/types";
import { GLOBAL_SETTINGS_PROFILE } from "./data.js";
import type { Person } from "./records.js";
import type { SettingsStore } from "./stores.js";

const log = getLogger("store.handles");

/** Settings key prefix of handle rows (under `GLOBAL_SETTINGS_PROFILE`). */
export const HANDLE_PREFIX = "handle:";

export function handleKey(account: AccountRef): string {
  return `${HANDLE_PREFIX}${accountRefString(account)}`;
}

function parseEntry(value: JsonValue): HandleEntry | null {
  if (!isJsonObject(value)) return null;
  const { handle, person, account, display_name, created_at } = value;
  if (typeof handle !== "string" || !isValidHandle(handle)) return null;
  if (typeof display_name !== "string" || typeof created_at !== "string") return null;
  let ref: AccountRef | null = null;
  if (isJsonObject(account) && typeof account.platform === "string") {
    if (typeof account.id === "string") ref = { platform: account.platform, id: account.id };
  }
  return {
    handle,
    person: typeof person === "string" ? person : null,
    account: ref,
    display_name,
    created_at,
  };
}

const lower = (handle: Handle) => handle.toLowerCase();

/**
 * `HandleDirectory` backed by `SettingsStore` (or by nothing: `settings` null keeps the table
 * in memory only, for tests and as the fallback of modules that find no shared directory).
 */
export class StoredHandleDirectory implements HandleDirectory {
  readonly #settings: SettingsStore | null;
  readonly #clock: Clock;
  readonly #entries: HandleEntry[] = [];
  readonly #byAccount = new Map<string, HandleEntry>();
  /** Lower-cased handle → entry: two handles never differ only by case. */
  readonly #byHandle = new Map<string, HandleEntry>();
  readonly #writes = new SerialQueue();

  constructor(settings: SettingsStore | null = null, clock: Clock = systemClock) {
    this.#settings = settings;
    this.#clock = clock;
  }

  /** A directory with its persisted rows loaded. */
  static async open(
    settings: SettingsStore | null,
    clock: Clock = systemClock,
  ): Promise<StoredHandleDirectory> {
    const dir = new StoredHandleDirectory(settings, clock);
    await dir.load();
    return dir;
  }

  /** Reads the persisted rows (oldest first wins when two rows claim the same handle). */
  async load(): Promise<void> {
    if (!this.#settings) return;
    const rows = await this.#settings.list(GLOBAL_SETTINGS_PROFILE, HANDLE_PREFIX);
    const entries: HandleEntry[] = [];
    for (const value of rows.values()) {
      const entry = parseEntry(value);
      if (entry) entries.push(entry);
    }
    entries.sort((a, b) =>
      a.created_at === b.created_at
        ? a.handle < b.handle
          ? -1
          : 1
        : a.created_at < b.created_at
          ? -1
          : 1,
    );
    for (const entry of entries) {
      if (this.#byHandle.has(lower(entry.handle))) continue;
      this.#add(entry);
    }
  }

  /** Resolves once every queued write reached the store. */
  flush(): Promise<void> {
    return this.#writes.run(async () => {});
  }

  #add(entry: HandleEntry): void {
    this.#entries.push(entry);
    this.#byHandle.set(lower(entry.handle), entry);
    if (entry.account) this.#byAccount.set(accountRefString(entry.account), entry);
  }

  #save(entry: HandleEntry): void {
    const settings = this.#settings;
    if (!settings || !entry.account) return;
    const key = handleKey(entry.account);
    const value = JSON.parse(JSON.stringify(entry)) as JsonValue;
    void this.#writes
      .run(async () => {
        try {
          await settings.set(GLOBAL_SETTINGS_PROFILE, key, value);
        } catch (error) {
          log.warn({ err: errorMessage(error) }, "cannot persist a handle");
        }
      })
      .catch(() => undefined);
  }

  /**
   * The account's handle, assigned from `displayName` on first sight. `person`, when the
   * caller knows it, is recorded on the row (so `ofPerson` works).
   */
  ofAccount(account: AccountRef, displayName: string, person: PersonId | null = null): Handle {
    const existing = this.#byAccount.get(accountRefString(account));
    if (existing) {
      if (person !== null && existing.person !== person) {
        existing.person = person;
        this.#save(existing);
      }
      return existing.handle;
    }
    const handle = assignHandle(displayName, (h) => this.#byHandle.has(lower(h)));
    const entry: HandleEntry = {
      handle,
      person,
      account: { platform: account.platform, id: account.id },
      display_name: displayName,
      created_at: toTimestamp(this.#clock.now()),
    };
    this.#add(entry);
    this.#save(entry);
    return handle;
  }

  ofPerson(person: PersonId): Handle | null {
    return this.#entries.find((e) => e.person === person)?.handle ?? null;
  }

  resolve(handle: Handle): HandleEntry | null {
    const entry = this.#byHandle.get(lower(handle.trim()));
    // Exact match only: `owen` does not resolve `Owen` (the model must copy the handle).
    return entry && entry.handle === handle.trim() ? { ...entry } : null;
  }

  list(): HandleEntry[] {
    return this.#entries.map((e) => ({ ...e }));
  }

  /**
   * The handle of a known person: the one of their first account (assigning it when none of
   * their accounts has one yet). Used where only a `PersonId` is at hand.
   */
  ensurePerson(person: Person): Handle {
    const known = this.ofPerson(person.id);
    if (known !== null) return known;
    let handle: Handle | null = null;
    for (const account of person.accounts) {
      const h = this.ofAccount(account.account, account.display_name, person.id);
      handle ??= h;
    }
    if (handle !== null) return handle;
    // A person without accounts has no row to hang a handle on: a handle of the name alone.
    return assignHandle(person.display_name, (h) => this.#byHandle.has(lower(h)));
  }

  /**
   * Gives every known person a handle and links rows to people (after accounts were linked or
   * merged). Run once after `load`; cheap and idempotent.
   */
  syncPeople(people: readonly Person[]): void {
    for (const person of people) {
      for (const account of person.accounts) {
        this.ofAccount(account.account, account.display_name, person.id);
      }
    }
  }
}
