// `plugin_state` (docs/design/v5-data.md §6): each plugin's small persistent values, and the old
// `SettingsStore` kept working over it while its callers move (§8 step 8).
//
// - `PluginState` is the plugins' own interface: one JSON value per (plugin, key) with the version
//   of its shape (`v`), at most `PLUGIN_STATE_MAX_BYTES` each. No listing: a key family that needs
//   one is a table.
// - `SettingsState` is `SettingsStore` over the same table. Every key of the old settings table is
//   one row of the reserved plugin `settings`, under its old name, whatever profile the caller
//   names: one database belongs to one character (decision D6), so the active profile and `_global`
//   are one key space. It keeps what the old table did that `PluginState` refuses: listing and
//   deleting by prefix, and values of any size, because the families that still need them (her
//   thoughts, documents, lessons, conversation notes) wait for phase 3 to get tables.

import { type JsonValue, type Timestamp, toTimestamp } from "@miyoria/types";
import { and, asc, eq, sql } from "drizzle-orm";
import { StoreError } from "../common.js";
import type { Db } from "../db.js";
import type { SettingsStore } from "../stores.js";
import { pluginState } from "./schema.js";

/** The plugin id `SettingsState` keeps the old settings keys under. */
export const SETTINGS_PLUGIN = "settings";

/** The largest value `PluginState` stores, as JSON text in UTF-8 (§6: about 64 KB). */
export const PLUGIN_STATE_MAX_BYTES = 64 * 1024;

/** One stored value with the version of its shape. */
export interface PluginStateValue {
  value: JsonValue;
  v: number;
  updated_at: Timestamp;
}

const plugin = sql.placeholder("plugin");
const key = sql.placeholder("key");
const prefix = sql.placeholder("prefix");
const startsWith = sql`substr(${pluginState.key}, 1, length(${prefix})) = ${prefix}`;

/** The prepared reads and deletes both interfaces share. */
function statements(db: Db) {
  const orm = db.orm;
  const one = and(eq(pluginState.plugin, plugin), eq(pluginState.key, key));
  return {
    get: orm
      .select({ value: pluginState.value, v: pluginState.v, updated_at: pluginState.updated_at })
      .from(pluginState)
      .where(one)
      .prepare(),
    delete: orm.delete(pluginState).where(one).prepare(),
    // `substr` instead of `LIKE`, so `%` and `_` in the prefix are literal and case matters.
    list: orm
      .select({ key: pluginState.key, value: pluginState.value })
      .from(pluginState)
      .where(and(eq(pluginState.plugin, plugin), startsWith))
      .orderBy(asc(pluginState.key))
      .prepare(),
    deletePrefix: orm
      .delete(pluginState)
      .where(and(eq(pluginState.plugin, plugin), startsWith))
      .prepare(),
  };
}

function write(db: Db, row: { plugin: string; key: string; value: JsonValue; v: number }): void {
  const at = toTimestamp(db.clock.now());
  db.orm
    .insert(pluginState)
    .values({ ...row, updated_at: at })
    .onConflictDoUpdate({
      target: [pluginState.plugin, pluginState.key],
      set: { value: row.value, v: row.v, updated_at: at },
    })
    .run();
}

/** Plugins' small persistent values on one database. */
export class PluginState {
  readonly #db: Db;
  readonly #stmts;

  constructor(db: Db) {
    this.#db = db;
    this.#stmts = statements(db);
  }

  /** The value of `key`, or `null` when it was never set (or deleted). */
  get(pluginId: string, name: string): PluginStateValue | null {
    this.#db.ensureOpen();
    return this.#stmts.get.get({ plugin: pluginId, key: name }) ?? null;
  }

  /**
   * Stores `value` as version `v` of its shape. Throws a `StoreError` for a value larger than
   * `PLUGIN_STATE_MAX_BYTES`: a value that grows needs a table.
   */
  set(pluginId: string, name: string, value: JsonValue, v = 1): void {
    const bytes = Buffer.byteLength(JSON.stringify(value), "utf8");
    if (bytes > PLUGIN_STATE_MAX_BYTES) {
      throw new StoreError(
        `plugin state ${pluginId}/${name} is ${bytes} bytes; the limit is ${PLUGIN_STATE_MAX_BYTES}`,
      );
    }
    if (!Number.isSafeInteger(v) || v < 1) {
      throw new StoreError(`plugin state ${pluginId}/${name}: version ${v} is not 1 or more`);
    }
    write(this.#db, { plugin: pluginId, key: name, value, v });
  }

  /** Deletes `key`; `false` when it was not there. */
  delete(pluginId: string, name: string): boolean {
    this.#db.ensureOpen();
    return this.#stmts.delete.run({ plugin: pluginId, key: name }).changes > 0;
  }
}

/**
 * `SettingsStore` over `plugin_state`: the old settings keys as rows of plugin `settings`. The
 * `profile` argument is not part of the key any more (see the file comment).
 */
export class SettingsState implements SettingsStore {
  readonly #db: Db;
  readonly #stmts;

  constructor(db: Db) {
    this.#db = db;
    this.#stmts = statements(db);
  }

  async get(_profile: string, name: string): Promise<JsonValue | null> {
    this.#db.ensureOpen();
    return this.#stmts.get.get({ plugin: SETTINGS_PLUGIN, key: name })?.value ?? null;
  }

  async set(_profile: string, name: string, value: JsonValue | null): Promise<void> {
    this.#db.ensureOpen();
    if (value === null) {
      this.#stmts.delete.run({ plugin: SETTINGS_PLUGIN, key: name });
      return;
    }
    write(this.#db, { plugin: SETTINGS_PLUGIN, key: name, value, v: 1 });
  }

  async list(_profile: string, start: string): Promise<Map<string, JsonValue>> {
    this.#db.ensureOpen();
    const rows = this.#stmts.list.all({ plugin: SETTINGS_PLUGIN, prefix: start });
    return new Map(rows.map((r) => [r.key, r.value]));
  }

  async deletePrefix(_profile: string, start: string): Promise<number> {
    this.#db.ensureOpen();
    return Number(this.#stmts.deletePrefix.run({ plugin: SETTINGS_PLUGIN, prefix: start }).changes);
  }
}
