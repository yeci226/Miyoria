// Tables a package outside the store owns (docs/design/v5-data.md §3): the plugin declares its
// `PluginSchema` and the code that reads and writes those tables, and the store attaches both to
// its one connection.
//
//     export const authTables: StorePlugin<AuthStore> = {
//       schema: authSchema,
//       open: ({ db, identity }) => new AuthTables(db, identity),
//     };
//     const store = await SqliteStore.open(path, { plugins: [authTables] });
//     const auth = store.plugin(authTables);
//
// Core opens the store with every installed plugin, so their migrations run at start. A plugin a
// store was not opened with is migrated the first time it is asked for (tests, tools); its data
// categories (`data`) count from then on.
//
// `RoutedSettings` keeps old `SettingsStore` key families working while their owners keep them in
// a table of their own (`StorePlugin.settings`); step 14 of §8 removes it with the key families.

import type { JsonValue, ProfileId } from "@miyoria/types";
import { StoreError } from "./common.js";
import type { CategoryData } from "./data.js";
import type { Db } from "./db.js";
import type { EventStore } from "./events/log.js";
import type { Identity } from "./identity/identity.js";
import type { PluginSchema } from "./migrate.js";
import type { PersonForget, PersonHookResult, PersonMerge } from "./person-data.js";
import type { SettingsStore } from "./stores.js";

/** What a plugin's code gets from the store it is attached to. */
export interface PluginContext {
  /** The store's connection: Drizzle on `db.orm`, transactions with `db.tx` (never Drizzle's). */
  readonly db: Db;
  /** The event log: a change worth recording is an event appended in the same transaction. */
  readonly events: EventStore;
  /** Persons, accounts and places, for keys by `person_id`, `account_id` and `space_id`. */
  readonly identity: Identity;
}

/** A plugin's tables and the code over them. */
export interface StorePlugin<T> {
  /** Its tables; the id is also the table prefix. */
  readonly schema: PluginSchema;
  /** Builds the plugin's code over the store's connection, once per store. */
  open(ctx: PluginContext): T;
  /**
   * Settings key families the plugin keeps in its own tables, while callers still reach them
   * through `SettingsStore`. Temporary (§8 step 14).
   */
  settings?(opened: T): readonly SettingsFamily[];
  /**
   * The parts of the data categories its tables hold, with how to count, export and delete them
   * (`data.ts`): the panel's data page, `/admin memory wipe` and the factory reset see them on a
   * store the plugin is attached to.
   */
  readonly data?: readonly CategoryData[];
  /**
   * What to do with a person's rows when they ask to be forgotten (`person-data.ts`): run with
   * every other schema's in one transaction (synchronous, like `Db.tx`). Money and audit records
   * are kept: a hook may decline (`declined`), saying why.
   */
  forgetPerson?(opened: T, request: PersonForget): PersonHookResult;
  /** What to do with `absorb`'s rows when it is merged into `keep`, as `forgetPerson`. */
  mergePerson?(opened: T, request: PersonMerge): PersonHookResult;
}

/**
 * One settings key family kept outside `plugin_state`. One database is one character, so the
 * profile a caller names is not part of the key.
 */
export interface SettingsFamily {
  /** Every key of the family starts with it. */
  readonly prefix: string;
  get(key: string): JsonValue | null;
  /** `null` deletes. Throws a `StoreError` for a value the family cannot hold. */
  set(key: string, value: JsonValue | null): void;
  /** Every key of the family with its value. */
  entries(): Map<string, JsonValue>;
}

function byKey(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** A `SettingsStore` that sends the keys of routed families to them, and the rest to `inner`. */
export class RoutedSettings implements SettingsStore {
  readonly #families: SettingsFamily[] = [];

  constructor(private readonly inner: SettingsStore) {}

  /** Sends the keys starting with `family.prefix` to `family` from now on. */
  route(family: SettingsFamily): void {
    const clash = this.#families.find(
      (f) => f.prefix.startsWith(family.prefix) || family.prefix.startsWith(f.prefix),
    );
    if (clash !== undefined) {
      throw new StoreError(
        `settings key family \`${family.prefix}\` overlaps \`${clash.prefix}\`, routed already`,
      );
    }
    this.#families.push(family);
  }

  #family(key: string): SettingsFamily | undefined {
    return this.#families.find((f) => key.startsWith(f.prefix));
  }

  /** The routed keys starting with `start`, with their values. */
  #routed(start: string): Map<string, JsonValue> {
    const out = new Map<string, JsonValue>();
    for (const family of this.#families) {
      if (!family.prefix.startsWith(start) && !start.startsWith(family.prefix)) continue;
      for (const [key, value] of family.entries()) {
        if (key.startsWith(start)) out.set(key, value);
      }
    }
    return out;
  }

  async get(profile: ProfileId, key: string): Promise<JsonValue | null> {
    const family = this.#family(key);
    return family === undefined ? this.inner.get(profile, key) : family.get(key);
  }

  async set(profile: ProfileId, key: string, value: JsonValue | null): Promise<void> {
    const family = this.#family(key);
    if (family === undefined) return this.inner.set(profile, key, value);
    family.set(key, value);
  }

  async list(profile: ProfileId, start: string): Promise<Map<string, JsonValue>> {
    const stored = await this.inner.list(profile, start);
    const routed = this.#routed(start);
    if (routed.size === 0) return stored;
    const keys = [...new Set([...stored.keys(), ...routed.keys()])].sort(byKey);
    return new Map(keys.map((k) => [k, (routed.get(k) ?? stored.get(k)) as JsonValue]));
  }

  async deletePrefix(profile: ProfileId, start: string): Promise<number> {
    let n = await this.inner.deletePrefix(profile, start);
    for (const key of this.#routed(start).keys()) {
      this.#family(key)?.set(key, null);
      n++;
    }
    return n;
  }
}
