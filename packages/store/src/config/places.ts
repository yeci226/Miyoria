// Per-place settings (docs/design/v5-data.md §6): one plugin's setting overridden for one Space or
// one Room, resolved room, then space, then the cluster config, then the schema default (the last
// two are the plugin's to apply). Each write or removal commits a `settings.changed` event (owner,
// kept) in the same transaction. A place must exist (`spaces` / `rooms` of identity) before it
// gets a setting.
//
// Core's `PlaceConfig` (`core/src/place-config.ts`, docs/design/v5-places.md) reads them for every
// module, and drops its cache when `onChange` reports a write: a place setting applies at once.
// The per-channel modes still come from `[modules.agent]` and the `channel_mode:` settings keys
// until the agent moves here (phase 6, P3).

import { JsonValueSchema } from "@miyoria/contracts/wire";
import { type JsonValue, newId, toTimestamp } from "@miyoria/types";
import { and, asc, eq, type SQL, sql } from "drizzle-orm";
import { StoreError } from "../common.js";
import type { Db } from "../db.js";
import type { EventStore } from "../events/log.js";
import { SettingsChanged } from "../events/types.js";
import { rooms, spaces } from "../identity/schema.js";
import { CONFIG_SOURCE } from "./revisions.js";
import { type PlaceScope, type PlaceSettingRow, placeSettings } from "./schema.js";

export type PlaceSetting = PlaceSettingRow;

/** Which rows `PlaceSettings.list` returns; every field given narrows them. */
export interface PlaceSettingFilter {
  plugin?: string;
  scope?: PlaceScope;
  scope_id?: string;
}

/** A setting `resolve` found, and where. */
export interface ResolvedPlaceSetting {
  value: JsonValue;
  scope: PlaceScope;
  scope_id: string;
}

/** One write or removal `onChange` reports, once written (inside the write's transaction). */
export interface PlaceSettingChange {
  scope: PlaceScope;
  scope_id: string;
  plugin: string;
  key: string;
  /** The Space of the place (a room's Space); `null` for a room outside one (a DM). */
  space_id: string | null;
  /** The new value; `null` when it was removed. */
  value: JsonValue | null;
}

// Listeners by database, so a write through any `PlaceSettings` on one connection reaches them all.
const listeners = new WeakMap<Db, Set<(change: PlaceSettingChange) => void>>();

export interface PlaceSettingsOptions {
  /** Checks (and may normalise) a value before it is written: the plugin's schema. */
  validate?: (plugin: string, key: string, value: JsonValue) => JsonValue;
}

/** Per-Space and per-Room settings on one database. */
export class PlaceSettings {
  readonly #db: Db;
  readonly #events: EventStore;
  readonly #validate: ((plugin: string, key: string, value: JsonValue) => JsonValue) | null;
  readonly #get;

  constructor(db: Db, events: EventStore, options: PlaceSettingsOptions = {}) {
    this.#db = db;
    this.#events = events;
    this.#validate = options.validate ?? null;
    this.#get = db.orm
      .select()
      .from(placeSettings)
      .where(
        and(
          eq(placeSettings.scope, sql.placeholder("scope")),
          eq(placeSettings.scope_id, sql.placeholder("scope_id")),
          eq(placeSettings.plugin, sql.placeholder("plugin")),
          eq(placeSettings.key, sql.placeholder("key")),
        ),
      )
      .prepare();
  }

  get(scope: PlaceScope, scopeId: string, plugin: string, key: string): PlaceSetting | null {
    this.#db.ensureOpen();
    return this.#get.get({ scope, scope_id: scopeId, plugin, key }) ?? null;
  }

  /** Rows by place (spaces first), then plugin and key. */
  list(filter: PlaceSettingFilter = {}): PlaceSetting[] {
    const terms: SQL[] = [];
    if (filter.plugin !== undefined) terms.push(eq(placeSettings.plugin, filter.plugin));
    if (filter.scope !== undefined) terms.push(eq(placeSettings.scope, filter.scope));
    if (filter.scope_id !== undefined) terms.push(eq(placeSettings.scope_id, filter.scope_id));
    return this.#db.orm
      .select()
      .from(placeSettings)
      .where(and(...terms))
      .orderBy(
        sql`${placeSettings.scope} = 'room'`,
        asc(placeSettings.scope_id),
        asc(placeSettings.plugin),
        asc(placeSettings.key),
      )
      .all();
  }

  /**
   * Every setting of one Space: the Space's own and those of its rooms (spaces first, then rooms),
   * of one plugin when `plugin` is given.
   */
  listBySpace(space: string, plugin?: string): PlaceSetting[] {
    this.#db.ensureOpen();
    const place = sql`((${placeSettings.scope} = 'space' AND ${placeSettings.scope_id} = ${space})
      OR (${placeSettings.scope} = 'room' AND ${placeSettings.scope_id} IN
        (SELECT ${rooms.id} FROM ${rooms} WHERE ${rooms.space_id} = ${space})))`;
    return this.#db.orm
      .select()
      .from(placeSettings)
      .where(plugin === undefined ? place : and(place, eq(placeSettings.plugin, plugin)))
      .orderBy(
        sql`${placeSettings.scope} = 'room'`,
        asc(placeSettings.scope_id),
        asc(placeSettings.plugin),
        asc(placeSettings.key),
      )
      .all();
  }

  /**
   * Calls `listener` after every write or removal on this database (by any `PlaceSettings` on it);
   * returns the unsubscribe. A listener that throws is ignored.
   */
  onChange(listener: (change: PlaceSettingChange) => void): () => void {
    let set = listeners.get(this.#db);
    if (set === undefined) {
      set = new Set();
      listeners.set(this.#db, set);
    }
    set.add(listener);
    return () => set.delete(listener);
  }

  /**
   * The setting for a place: the room's, else its space's; `null` when neither has one (the
   * cluster config and the schema default apply, which are the plugin's to read).
   */
  resolve(
    plugin: string,
    key: string,
    place: { room_id: string | null; space_id: string | null },
  ): ResolvedPlaceSetting | null {
    const candidates: [PlaceScope, string | null][] = [
      ["room", place.room_id],
      ["space", place.space_id],
    ];
    for (const [scope, id] of candidates) {
      if (id === null) continue;
      const row = this.get(scope, id, plugin, key);
      if (row !== null) return { value: row.value, scope, scope_id: id };
    }
    return null;
  }

  /** The space a place belongs to (a space's own id); throws for an unknown place. */
  #spaceOf(scope: PlaceScope, id: string): string | null {
    if (scope === "space") {
      const found = this.#db.orm
        .select({ id: spaces.id })
        .from(spaces)
        .where(eq(spaces.id, id))
        .get();
      if (!found) throw new StoreError(`unknown space \`${id}\``);
      return found.id;
    }
    const room = this.#db.orm
      .select({ space_id: rooms.space_id })
      .from(rooms)
      .where(eq(rooms.id, id))
      .get();
    if (!room) throw new StoreError(`unknown room \`${id}\``);
    return room.space_id;
  }

  /**
   * Writes (or, with `null`, removes) a setting of one place, by `by` (`import`, `panel:<person>`,
   * a module id). Writing the value it has, or removing one that is not there, does nothing.
   */
  set(
    scope: PlaceScope,
    scopeId: string,
    plugin: string,
    key: string,
    value: JsonValue | null,
    by: string,
  ): void {
    if (plugin.trim() === "" || key.trim() === "") {
      throw new StoreError("a place setting needs a plugin and a key");
    }
    let checked: JsonValue | null = null;
    if (value !== null) {
      const parsed = JsonValueSchema.safeParse(value);
      if (!parsed.success) throw new StoreError(`place setting ${plugin}/${key} is not JSON`);
      checked = this.#validate === null ? parsed.data : this.#validate(plugin, key, parsed.data);
    }
    this.#db.tx(() => {
      const spaceId = this.#spaceOf(scope, scopeId);
      const before = this.get(scope, scopeId, plugin, key);
      const where = and(
        eq(placeSettings.scope, scope),
        eq(placeSettings.scope_id, scopeId),
        eq(placeSettings.plugin, plugin),
        eq(placeSettings.key, key),
      );
      const at = toTimestamp(this.#db.clock.now());
      if (checked === null) {
        if (before === null) return;
        this.#db.orm.delete(placeSettings).where(where).run();
      } else {
        if (before !== null && JSON.stringify(before.value) === JSON.stringify(checked)) return;
        this.#db.orm
          .insert(placeSettings)
          .values({
            scope,
            scope_id: scopeId,
            plugin,
            key,
            value: checked,
            updated_at: at,
            updated_by: by,
          })
          .onConflictDoUpdate({
            target: [
              placeSettings.scope,
              placeSettings.scope_id,
              placeSettings.plugin,
              placeSettings.key,
            ],
            set: { value: checked, updated_at: at, updated_by: by },
          })
          .run();
      }
      this.#events.appendNow({
        draft: {
          id: newId(),
          at,
          type: SettingsChanged.type,
          v: SettingsChanged.v,
          space_id: spaceId,
          room_id: scope === "room" ? scopeId : null,
          data: { scope, scope_id: scopeId, plugin, key, value: checked, by },
        },
        source: CONFIG_SOURCE,
      });
      const change = { scope, scope_id: scopeId, plugin, key, space_id: spaceId, value: checked };
      for (const listener of listeners.get(this.#db) ?? []) {
        try {
          listener(change);
        } catch {
          // A reader's cache must not break a write.
        }
      }
    });
  }
}
