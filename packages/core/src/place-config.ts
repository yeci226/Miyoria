// Core's `PlaceConfig` (docs/design/v5-places.md §3): a module's section resolved for one place, from
// the `place_settings` rows of its fields that may differ per Space or Room. Modules reach it
// through the kernel's `placeConfig(ctx, Schema)`, which reads the fields' meta and calls `open`.
//
// For each such field, nearest first: the room, the room's parent channel (a thread), the Space,
// then the cluster value (the module's section as it started: the file and the panel's layer),
// then the schema default. A `space` field reads only the Space. A `union` field takes every
// layer's entries. Then the channel rule: a channel value not in the Space resolved for is
// dropped. The result is parsed with the module's schema, so a module always gets its own type.
//
// Results are cached per place and the cache goes when a place setting of the module is written
// (`PlaceSettings.onChange`) or a Space or room appears or changes (`Places.onChange`): a place
// setting applies at the next read, without restarting the module.

import { getLogger, jsonAt, type Logger } from "@miyoria/runtime/kernel";
import type { PlaceSetting, PlaceSettings } from "@miyoria/store";
import {
  type ContextKey,
  isJsonObject,
  type JsonObject,
  type JsonValue,
  type PlaceConfig,
  type PlaceConfigChange,
  type PlaceConfigRequest,
  type PlaceConfigService,
  type PlaceDirectory,
  type PlaceField,
  type Places,
  type PlaceWhere,
  type SpaceRef,
} from "@miyoria/types";
import { deleteIn, setIn } from "./module-settings.js";

/** Places cached per opened config before the cache starts over. */
const CACHE_MAX = 1_000;

export interface PlaceConfigsOptions {
  places: Places;
  settings: PlaceSettings;
  /** The platform's live view, for a bare channel id identity has not seen (`PlaceDirectoryKey`). */
  directory?: () => PlaceDirectory | undefined;
  log?: Logger;
}

/** Where a value came from: the place's own layers, or the cluster above them. */
type Origin = "own" | "base";

interface Resolved {
  space: SpaceRef;
  room: string | null;
  parent: string | null;
}

const isContext = (where: object): where is ContextKey =>
  "channel" in where && "platform" in where && "kind" in where;

/** The Space `value` (a channel) is in, as far as anyone knows: `in`, `out`, or `unknown`. */
type ChannelPlace = "in" | "out" | "unknown";

/** Core's `PlaceConfigKey` service. */
export class PlaceConfigs implements PlaceConfigService {
  readonly #options: PlaceConfigsOptions;
  readonly #log: Logger;

  constructor(options: PlaceConfigsOptions) {
    this.#options = options;
    this.#log = options.log ?? getLogger("core.place-config");
  }

  open<T>(request: PlaceConfigRequest<T>): PlaceConfig<T> {
    return new ModulePlaceConfig(request, this.#options, this.#log);
  }
}

class ModulePlaceConfig<T> implements PlaceConfig<T> {
  readonly #request: PlaceConfigRequest<T>;
  readonly #places: Places;
  readonly #settings: PlaceSettings;
  readonly #directory: () => PlaceDirectory | undefined;
  readonly #log: Logger;
  readonly #base: T;
  readonly #section: JsonObject;
  readonly #cache = new Map<string, T>();
  readonly #listeners = new Set<(change: PlaceConfigChange) => void>();
  /** Keys already warned about, so a bad row is logged once per cache. */
  readonly #warned = new Set<string>();

  constructor(request: PlaceConfigRequest<T>, options: PlaceConfigsOptions, log: Logger) {
    this.#request = request;
    this.#places = options.places;
    this.#settings = options.settings;
    this.#directory = options.directory ?? (() => undefined);
    this.#log = log;
    this.#section = isJsonObject(request.section ?? null) ? (request.section as JsonObject) : {};
    this.#base = request.parse(request.section);
    const stops = [
      this.#settings.onChange((change) => {
        if (change.plugin !== request.module) return;
        this.#drop();
        this.#notify({
          space_id: change.space_id,
          room_id: change.scope === "room" ? change.scope_id : null,
        });
      }),
      this.#places.onChange((change) => {
        this.#drop();
        if (change.kind === "space") this.#notify({ space_id: change.space_id, room_id: null });
      }),
    ];
    const stop = () => {
      for (const s of stops) s();
      this.#listeners.clear();
    };
    if (request.signal?.aborted) stop();
    else request.signal?.addEventListener("abort", stop, { once: true });
  }

  #drop(): void {
    this.#cache.clear();
    this.#warned.clear();
  }

  #notify(change: PlaceConfigChange): void {
    for (const listener of [...this.#listeners]) {
      try {
        listener(change);
      } catch (error) {
        this.#log.warn(
          { module: this.#request.module, err: error },
          "a place config listener threw",
        );
      }
    }
  }

  base(): T {
    return this.#base;
  }

  onChange(listener: (change: PlaceConfigChange) => void): () => void {
    if (this.#request.signal?.aborted) return () => {};
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  for(where: PlaceWhere): T {
    const place = this.#resolve(where);
    if (place === null) return this.#base;
    const key = `${place.space.id}|${place.room ?? ""}|${place.parent ?? ""}`;
    const cached = this.#cache.get(key);
    if (cached !== undefined) return cached;
    const value = this.#compute(place);
    if (this.#cache.size >= CACHE_MAX) this.#cache.clear();
    this.#cache.set(key, value);
    return value;
  }

  /** The Space, room and parent room of `where`; `null` when it has no (active) Space. */
  #resolve(where: PlaceWhere): Resolved | null {
    if (where === null || where === undefined) return null;
    let spaceId: string | null = null;
    let room: string | null = null;
    let parent: string | null = null;
    if (isContext(where)) {
      const at = this.#places.at(where);
      if (at !== null) {
        spaceId = at.space_id;
        room = at.room_id;
        parent = at.parent_room_id;
      } else if (where.scope !== null) {
        // A room not seen yet: its Space still counts.
        spaceId = this.#places.ofGuild(where.platform, where.scope)?.id ?? null;
      }
    } else if (where.room_id != null) {
      const row = this.#places.room(where.room_id);
      if (row === null) spaceId = where.space_id ?? null;
      else {
        spaceId = row.space_id;
        room = row.id;
        parent = row.kind === "thread" ? row.parent_id : null;
      }
    } else {
      spaceId = where.space_id ?? null;
    }
    if (spaceId === null) return null;
    const space = this.#places.space(spaceId);
    return space === null ? null : { space, room, parent };
  }

  /** The module's rows for the place's layers, by field path. */
  #rows(scope: "space" | "room", id: string | null): Map<string, PlaceSetting> {
    if (id === null) return new Map();
    const rows = this.#settings.list({ plugin: this.#request.module, scope, scope_id: id });
    return new Map(rows.map((r) => [r.key, r]));
  }

  #compute(place: Resolved): T {
    const roomRows = this.#rows("room", place.room);
    const parentRows = this.#rows("room", place.parent);
    const spaceRows = this.#rows("space", place.space.id);
    const channels = new ChannelCheck(place.space, this.#places, this.#directory);
    const changes: { field: PlaceField; value: JsonValue | undefined }[] = [];
    for (const field of this.#request.fields) {
      const path = field.keys.join(".");
      const layers: JsonValue[] = [];
      if (field.scope === "room") {
        const r = roomRows.get(path);
        const p = parentRows.get(path);
        if (r !== undefined) layers.push(r.value);
        if (p !== undefined) layers.push(p.value);
      }
      const s = spaceRows.get(path);
      if (s !== undefined) layers.push(s.value);
      const base = this.#baseValue(field.keys);
      let entries: { value: JsonValue; origin: Origin }[] | null = null;
      let single: { value: JsonValue | undefined; origin: Origin };
      if (field.merge === "union" && (base === undefined || Array.isArray(base))) {
        entries = (Array.isArray(base) ? base : []).map((value) => ({ value, origin: "base" }));
        // Cluster first, then the Space, the parent, the room: the order a reader would list them.
        for (const layer of [...layers].reverse()) {
          if (!Array.isArray(layer)) {
            this.#warnOnce(path, "a union field's place value is not a list; skipped");
            continue;
          }
          for (const value of layer) entries.push({ value, origin: "own" });
        }
        const seen = new Set<string>();
        entries = entries.filter((e) => {
          const k = JSON.stringify(e.value);
          if (seen.has(k)) return false;
          seen.add(k);
          return true;
        });
        single = { value: entries.map((e) => e.value), origin: layers.length > 0 ? "own" : "base" };
      } else {
        single =
          layers.length > 0 ? { value: layers[0], origin: "own" } : { value: base, origin: "base" };
      }
      let changed = single.origin === "own";
      let value = single.value;
      if (field.channel !== null) {
        const keep = (v: JsonValue, origin: Origin) => {
          if (typeof v !== "string" || v === "") return true;
          const at = channels.place(v, field.channel?.ref ?? "id");
          // A cluster channel nobody can place goes to the primary only, not to every established
          // Space: the default Space, so a job posting there runs once, not in each server.
          return at === "in" || (at === "unknown" && (origin === "own" || place.space.primary));
        };
        if (entries !== null) {
          const kept = entries.filter((e) => keep(e.value, e.origin));
          if (kept.length !== entries.length) changed = true;
          value = kept.map((e) => e.value);
        } else if (Array.isArray(value)) {
          const kept = value.filter((v) => keep(v, single.origin));
          if (kept.length !== value.length) changed = true;
          value = kept;
        } else if (value !== undefined && !keep(value, single.origin)) {
          // A single channel elsewhere: the schema default (the key is left out).
          changed = true;
          value = undefined;
        }
      }
      if (changed) changes.push({ field, value });
    }
    if (changes.length === 0) return this.#base;
    const apply = (list: typeof changes) =>
      list.reduce(
        (section, c) =>
          c.value === undefined
            ? deleteIn(section, c.field.keys)
            : setIn(section, c.field.keys, c.value),
        this.#section,
      );
    try {
      return this.#request.parse(apply(changes));
    } catch {
      // One bad row must not take the others down: keep each change that parses on its own.
      const good = changes.filter((c) => {
        try {
          this.#request.parse(apply([c]));
          return true;
        } catch (error) {
          this.#warnOnce(
            c.field.keys.join("."),
            "a place value does not fit the schema; skipped",
            error,
          );
          return false;
        }
      });
      try {
        return this.#request.parse(apply(good));
      } catch {
        return this.#base;
      }
    }
  }

  /** The cluster's value at `keys`, defaults applied. */
  #baseValue(keys: readonly string[]): JsonValue | undefined {
    const parsed = jsonAt(this.#base as JsonValue, keys);
    return parsed !== undefined ? parsed : jsonAt(this.#section, keys);
  }

  #warnOnce(path: string, msg: string, error?: unknown): void {
    if (this.#warned.has(path)) return;
    this.#warned.add(path);
    this.#log.warn({ module: this.#request.module, field: path, err: error }, msg);
  }
}

/** Whether channels are in one Space, asked of identity's rooms, then of the platform's view. */
class ChannelCheck {
  readonly #space: SpaceRef;
  readonly #places: Places;
  readonly #directory: () => PlaceDirectory | undefined;
  #live: Map<string, string> | null = null;

  constructor(space: SpaceRef, places: Places, directory: () => PlaceDirectory | undefined) {
    this.#space = space;
    this.#places = places;
    this.#directory = directory;
  }

  place(value: string, ref: "id" | "context"): ChannelPlace {
    const space = this.#space;
    // A context key names its server: `discord:<guild>:<channel>`, `discord:dm:<channel>`.
    if (ref === "context" || value.includes(":")) {
      const [platform, scope] = value.split(":");
      if (platform === undefined || scope === undefined) return "unknown";
      return platform === space.platform && scope === space.external_id ? "in" : "out";
    }
    const known = this.#places.channelSpace(space.platform, value);
    if (known !== null) return known === space.id ? "in" : "out";
    const guild = this.#liveRooms().get(value);
    if (guild === undefined) return "unknown";
    return guild === space.external_id ? "in" : "out";
  }

  /** Channel id → guild id, from the platform's live view of the Space's platform. */
  #liveRooms(): Map<string, string> {
    if (this.#live !== null) return this.#live;
    this.#live = new Map();
    const directory = this.#directory();
    if (directory === undefined || directory.platform !== this.#space.platform) return this.#live;
    try {
      for (const room of directory.rooms()) this.#live.set(room.id, room.space.id);
    } catch {
      // No live view: unknown stays unknown.
    }
    return this.#live;
  }
}
