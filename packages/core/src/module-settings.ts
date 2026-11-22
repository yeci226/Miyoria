// The panel's settings layer (docs/design/v5-settings.md §4, §5): what the panel changes of a
// module's config is written to the config revisions (`config_revisions`, the same documents that
// already remember module on/off) and laid over `miyoria.toml`, key by key. The file is never
// written. A module runs with: the file's section (env references expanded), then each key of the
// layer that still fits the module's schema; a key that no longer fits is skipped with a warning
// and the panel shows why.
//
// Merging: objects key by key, arrays and plain values whole. `enabled` is not part of a module's
// settings: the layer's flag and the file's are ANDed by boot as before. The layer's strings may
// hold `${NAME}` references (`miyoria config import` writes the file as it is, v5-settings §13):
// they are expanded from the environment like the file's, so a reference never reaches a module
// as text; one whose variable is not set is skipped like a value that does not fit.
//
// A save writes the next revision (author, time, the `config.revised` event, the `expected`
// version against concurrent writes) and restarts the module with its dependents
// (`Supervisor.reconfigure`). When the restart would stop a module she is using right now (sing,
// voice, voice.link, stage.link while she sings or is live), the save is kept and the restart
// waits until the guard is gone. Core is the only validator: the merged section is checked with
// the module's own schema and each problem comes back by field, in zod's zh-TW words.
//
// Places (docs/design/v5-places.md): a field marked `scope: "space"` or `"room"` may also have a
// value of its own for one Space or one room (`place_settings`). `describe` with a place shows the
// value there, the place's own value and what it inherits; a save with a place writes the place's
// own values, which apply at once (Core's `PlaceConfig` drops its cache on the write): no revision,
// no restart. Removing a place's own value returns the field to what it inherits.

import {
  type Config,
  ConfigError,
  configJsonSchema,
  type EnvLookup,
  getLogger,
  interpolateEnv,
  jsonAt,
  type Logger,
  type ModuleSettingsService,
  type ModuleSettingsView,
  parseSection,
  placeFields,
  processEnv,
  type SettingField,
  type SettingGroup,
  type SettingOverride,
  type SettingPlaceValue,
  type SettingProblem,
  type SettingSource,
  type SettingsApplied,
  type SettingsChange,
  SettingsError,
  type SettingsPlace,
  type SettingsSaveRequest,
  type SettingsSaveResult,
  type SettingValue,
  type Supervisor,
  sectionIssues,
  settingFields,
} from "@miyoria/runtime/kernel";
import {
  ConfigConflictError,
  type ConfigRevisions,
  type EventLogStore,
  type PlaceSettings,
} from "@miyoria/store";
import {
  isJsonObject,
  type JsonObject,
  type JsonValue,
  type ModuleId,
  type PlaceDirectory,
  type PlaceField,
  type Places,
  type RoomRef,
  type SpaceRef,
} from "@miyoria/types";
import { PlaceConfigs } from "./place-config.js";

/** Modules a restart would interrupt while she sings or is live. */
export const GUARDED_MODULES: readonly ModuleId[] = ["sing", "voice", "voice.link", "stage.link"];

/** How often a deferred save checks whether its guard is gone. */
export const DEFERRED_CHECK_MS = 5_000;

/** Revisions read for one page of a module's history. */
const HISTORY_SCAN_LIMIT = 2_000;

/** The event a place setting's write commits (`store/src/config/places.ts`). */
const PLACE_CHANGED = "settings.changed";

type Keys = readonly string[];

/** Every leaf of a JSON object (a value that is not an object), with its keys. */
export function leaves(
  value: JsonValue | undefined,
  prefix: string[] = [],
): [string[], JsonValue][] {
  if (!isJsonObject(value ?? null))
    return prefix.length === 0 ? [] : [[prefix, value as JsonValue]];
  const out: [string[], JsonValue][] = [];
  for (const [key, child] of Object.entries(value as JsonObject)) {
    if (child === undefined) continue;
    if (isJsonObject(child) && Object.keys(child).length > 0)
      out.push(...leaves(child, [...prefix, key]));
    else if (!isJsonObject(child)) out.push([[...prefix, key], child]);
  }
  return out;
}

/** `obj` with `value` at `keys` (a copy of every object on the way). */
export function setIn(obj: JsonObject, keys: Keys, value: JsonValue): JsonObject {
  const [head, ...rest] = keys;
  if (head === undefined) return obj;
  if (rest.length === 0) return { ...obj, [head]: value };
  const child = obj[head];
  return { ...obj, [head]: setIn(isJsonObject(child) ? child : {}, rest, value) };
}

/** `obj` without `keys` (objects left empty on the way are dropped). */
export function deleteIn(obj: JsonObject, keys: Keys): JsonObject {
  const [head, ...rest] = keys;
  if (head === undefined || !(head in obj)) return obj;
  const { [head]: child, ...others } = obj;
  if (rest.length === 0) return others;
  if (!isJsonObject(child ?? null)) return obj;
  const inner = deleteIn(child as JsonObject, rest);
  return Object.keys(inner).length === 0 ? others : { ...others, [head]: inner };
}

function same(a: JsonValue | undefined, b: JsonValue | undefined): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

const startsWith = (keys: readonly (string | number)[], prefix: Keys) =>
  prefix.every((k, i) => keys[i] === k);

/** A module's part of a revision's document, without `enabled`. */
export function layerSection(doc: JsonObject | undefined, id: ModuleId): JsonObject {
  const section = jsonAt(doc, ["modules", id]);
  if (!isJsonObject(section ?? null)) return {};
  const { enabled: _, ...rest } = section as JsonObject;
  return rest;
}

/**
 * A layer value with its `${NAME}` references expanded from `env`; a variable that is not set (and
 * has no default) is the zh-TW reason it cannot be used.
 */
export function expandLayerValue(
  value: JsonValue,
  env: EnvLookup,
): { value: JsonValue } | { reason: string } {
  if (!JSON.stringify(value).includes("${")) return { value };
  try {
    return { value: interpolateEnv(value, env) };
  } catch (error) {
    if (error instanceof ConfigError && error.code === "missing_env") {
      return { reason: `環境變數 ${error.path ?? ""} 沒有設定` };
    }
    throw error;
  }
}

/** What a module runs with, and what of the layer was used and skipped. */
export interface Effective {
  config: JsonValue | null;
  /** Layer keys laid over the file. */
  used: string[][];
  /** Layer keys that do not fit the schema (or name an unset variable: `env`), with why. */
  skipped: { keys: string[]; reason: string; env?: boolean }[];
}

/**
 * The file's section with the layer's keys laid over it, each expanded from `env` and kept only if
 * it does not bring a problem of its own (`schema`; without one every key is kept).
 */
export function effectiveSection(
  file: JsonValue | null,
  layer: JsonObject,
  schema: Parameters<typeof sectionIssues>[0] | undefined,
  env: EnvLookup = processEnv,
): Effective {
  const keys = leaves(layer);
  if (keys.length === 0) return { config: file, used: [], skipped: [] };
  let config: JsonObject = isJsonObject(file) ? file : {};
  const used: string[][] = [];
  const skipped: Effective["skipped"] = [];
  for (const [path, raw] of keys) {
    const expanded = expandLayerValue(raw, env);
    if ("reason" in expanded) {
      skipped.push({ keys: path, reason: expanded.reason, env: true });
      continue;
    }
    const candidate = setIn(config, path, expanded.value);
    const own = schema
      ? sectionIssues(schema, candidate).filter((i) => startsWith(i.keys, path))
      : [];
    const first = own[0];
    if (first !== undefined) {
      skipped.push({ keys: path, reason: first.message });
      continue;
    }
    config = candidate;
    used.push(path);
  }
  return { config, used, skipped };
}

/** What `ModuleSettings` reads and writes a module's place settings with. */
export interface ModuleSettingsPlaces {
  places: Places;
  settings: PlaceSettings;
  /** The event log, for a place's change history. */
  events?: Pick<EventLogStore, "query">;
  /** The platform's live view, for the channel rule of a bare channel id identity has not seen. */
  directory?: () => PlaceDirectory | undefined;
  /**
   * The room of a Space's channel, created on first use (identity's `ensureRoom`): a room gets a
   * setting before anyone spoke there. Without it only rooms identity has seen can have values.
   */
  ensureRoom?: (space: SpaceRef, channel: string) => string;
}

export interface ModuleSettingsOptions {
  /** `miyoria.toml` as loaded (env references expanded). */
  config: Config;
  revisions: ConfigRevisions;
  supervisor: Supervisor;
  /** The guarded state active now (`singing`, `live`), `null` when none. */
  guard: () => string | null;
  logger?: Logger;
  /** How often a deferred save checks its guard. Default `DEFERRED_CHECK_MS`. */
  checkMs?: number;
  /** Where the layer's `${NAME}` references are looked up. Default the process environment. */
  env?: EnvLookup;
  /** Spaces, rooms and their settings; without them only the cluster can be read and written. */
  places?: ModuleSettingsPlaces;
}

interface Described {
  name: string;
  groups: SettingGroup[];
  fields: SettingField[];
  schema: Parameters<typeof sectionIssues>[0] | undefined;
}

/** A place as a module's settings are read or written for. */
interface Place {
  space: SpaceRef;
  /** The room asked for: its channel id, and identity's row when there is one. */
  room: { channel: string; row: RoomRef | null } | null;
}

/** Core's `ModuleSettingsKey`. */
export class ModuleSettings implements ModuleSettingsService {
  readonly #config: Config;
  readonly #revisions: ConfigRevisions;
  readonly #sup: Supervisor;
  readonly #guard: () => string | null;
  readonly #log: Logger;
  readonly #env: EnvLookup;
  readonly #places: ModuleSettingsPlaces | null;
  /** Saves whose restart waits for a guard, by module: the guard named when it was saved. */
  readonly #pending = new Map<ModuleId, string>();
  #timer: ReturnType<typeof setInterval> | null = null;
  readonly #checkMs: number;

  constructor(options: ModuleSettingsOptions) {
    this.#config = options.config;
    this.#revisions = options.revisions;
    this.#sup = options.supervisor;
    this.#guard = options.guard;
    this.#log = options.logger ?? getLogger("core.settings");
    this.#checkMs = options.checkMs ?? DEFERRED_CHECK_MS;
    this.#env = options.env ?? processEnv;
    this.#places = options.places ?? null;
  }

  /** Stops waiting for guards (Core is stopping). */
  close(): void {
    if (this.#timer !== null) clearInterval(this.#timer);
    this.#timer = null;
  }

  #describe(id: ModuleId): Described {
    const module = this.#sup.module(id);
    if (module === undefined) throw new SettingsError("unknown", `unknown module \`${id}\``);
    const schema = module.manifest.configSchema;
    const found = schema ? settingFields(configJsonSchema(schema)) : { groups: [], fields: [] };
    return { name: module.manifest.name, groups: found.groups, fields: found.fields, schema };
  }

  /** The file's section of a module (without `enabled`). */
  #file(id: ModuleId): JsonValue | null {
    return this.#config.module(id).config;
  }

  #currentLayer(id: ModuleId): JsonObject {
    return layerSection(this.#revisions.current()?.doc, id);
  }

  #effective(id: ModuleId, layer: JsonObject, schema: Described["schema"]): Effective {
    return effectiveSection(this.#file(id), layer, schema, this.#env);
  }

  /**
   * What module `id` runs with at boot: the file's section and the layer over it. Logs each key the
   * layer overrides with a value other than the file's, and each one it skips, once.
   */
  boot(id: ModuleId, file: JsonValue | null, schema: Described["schema"]): JsonValue | null {
    const layer = this.#currentLayer(id);
    const found = effectiveSection(file, layer, schema, this.#env);
    for (const keys of found.used) {
      const fileValue = jsonAt(file ?? undefined, keys);
      const used = jsonAt(found.config ?? undefined, keys);
      if (fileValue === undefined || same(fileValue, used)) continue;
      this.#log.warn(
        { module: id, key: keys.join("."), file: fileValue, panel: jsonAt(layer, keys) },
        "the panel's value overrides miyoria.toml for this key (`miyoria config bake` writes it to the file)",
      );
    }
    for (const s of found.skipped) {
      this.#log.warn(
        { module: id, key: s.keys.join("."), reason: s.reason },
        "the panel's value no longer fits; the file's value or the default is used",
      );
    }
    return found.config;
  }

  editable(id: ModuleId): boolean {
    const module = this.#sup.module(id);
    if (module?.manifest.configSchema === undefined) return false;
    return this.#describe(id).fields.some((f) => !f.secret && f.apply === "module");
  }

  pending(id: ModuleId): string | null {
    return this.#pending.get(id) ?? null;
  }

  /** Whether a restart of `id` would stop a guarded module while a guard holds: which guard. */
  guardFor(id: ModuleId): string | null {
    const affected = [id, ...this.#sup.dependentsOf(id)];
    if (!affected.some((m) => GUARDED_MODULES.includes(m))) return null;
    return this.#guard();
  }

  describe(id: ModuleId, place?: SettingsPlace | null): ModuleSettingsView {
    const d = this.#describe(id);
    const at = place ? this.#place(place) : null;
    const current = this.#revisions.current();
    const layer = layerSection(current?.doc, id);
    const file = this.#file(id);
    const found = this.#effective(id, layer, d.schema);
    const values: Record<string, SettingValue> = {};
    for (const f of d.fields) {
      const fileValue = jsonAt(file ?? undefined, f.keys);
      const layerValue = jsonAt(layer, f.keys);
      const skipped = found.skipped.find((s) => same(s.keys, f.keys));
      const fromLayer = layerValue !== undefined && skipped === undefined;
      const effective = jsonAt(found.config ?? undefined, f.keys);
      if (f.secret) {
        const raw = typeof fileValue === "string" ? fileValue : "";
        values[f.path] = {
          value: null,
          source: fileValue === undefined ? "default" : "file",
          file: null,
          file_set: fileValue !== undefined,
          set: raw !== "",
          env: null,
          invalid: null,
        };
        continue;
      }
      // The layer counts as the source while it says something the file does not: after the
      // config import it holds the whole file, and a key equal to the file's is the file's.
      const panel = fromLayer && (fileValue === undefined || !same(fileValue, effective));
      values[f.path] = {
        value: effective ?? f.default,
        source: panel ? "panel" : fileValue !== undefined ? "file" : "default",
        file: fileValue ?? null,
        file_set: fileValue !== undefined,
        set: true,
        env: null,
        invalid: skipped?.reason ?? null,
      };
    }
    if (at !== null) this.#describePlace(id, d, at, found.config, values);
    const last = this.history(id, { limit: 1 }).items[0];
    return {
      module: id,
      name: d.name,
      revision: current?.version ?? 0,
      groups: d.groups,
      fields: d.fields,
      values,
      updated: last ? { version: last.version, at: last.at, by: last.by } : null,
      guard: this.guardFor(id),
      pending: this.pending(id),
      place:
        at === null
          ? null
          : {
              space: { id: at.space.id, name: at.space.name },
              room:
                at.room === null ? null : { id: at.room.channel, name: at.room.row?.name ?? null },
            },
    };
  }

  async save(id: ModuleId, request: SettingsSaveRequest, by: string): Promise<SettingsSaveResult> {
    const d = this.#describe(id);
    if (request.place) return this.#savePlace(id, d, request, by);
    const byPath = new Map(d.fields.map((f) => [f.path, f]));
    const refused: SettingProblem[] = [];
    let layer = this.#currentLayer(id);
    for (const [path, value] of Object.entries(request.set)) {
      const field = byPath.get(path);
      if (field === undefined || field.secret || field.apply !== "module") {
        refused.push({ path, message: `「${path}」不能在面板上改` });
        continue;
      }
      if (JSON.stringify(value).includes("${")) {
        refused.push({ path, message: `${field.label}:環境變數的參照只能寫在設定檔` });
        continue;
      }
      layer = setIn(layer, field.keys, value);
    }
    for (const path of request.reset) {
      const field = byPath.get(path);
      if (field === undefined) {
        refused.push({ path, message: `「${path}」不能在面板上改` });
        continue;
      }
      layer = deleteIn(layer, field.keys);
    }
    if (refused.length > 0) {
      throw new SettingsError("not_editable", "some fields cannot be changed here", refused);
    }
    this.#check(id, d, layer);
    return this.#write(id, layer, by, request.expected, request.note ?? null);
  }

  /** Throws `SettingsError("invalid")` with each problem of the merged section, by field. */
  #check(id: ModuleId, d: Described, layer: JsonObject): void {
    if (d.schema === undefined) return;
    const merged = this.#mergeAll(this.#file(id), layer);
    const problems: SettingProblem[] = sectionIssues(d.schema, merged).map((issue) => {
      const field = d.fields.find((f) => startsWith(issue.keys, f.keys));
      if (field) return { path: field.path, message: `${field.label}:${issue.message}` };
      const path = issue.keys.join(".");
      return { path, message: path === "" ? issue.message : `${path}:${issue.message}` };
    });
    if (problems.length > 0) {
      throw new SettingsError("invalid", problems.map((p) => p.message).join("\n"), problems);
    }
  }

  /** The file with every key of `layer` over it (references expanded where they can be), unchecked. */
  #mergeAll(file: JsonValue | null, layer: JsonObject): JsonObject {
    let out: JsonObject = isJsonObject(file) ? file : {};
    for (const [keys, raw] of leaves(layer)) {
      const expanded = expandLayerValue(raw, this.#env);
      out = setIn(out, keys, "value" in expanded ? expanded.value : raw);
    }
    return out;
  }

  async #write(
    id: ModuleId,
    layer: JsonObject,
    by: string,
    expected: number,
    note: string | null,
  ): Promise<SettingsSaveResult> {
    const current = this.#revisions.current();
    const doc: JsonObject = structuredClone(current?.doc ?? {});
    const modules = isJsonObject(doc.modules ?? null) ? (doc.modules as JsonObject) : {};
    const old = modules[id];
    const enabled = isJsonObject(old ?? null) ? (old as JsonObject).enabled : undefined;
    const section: JsonObject = { ...(enabled === undefined ? {} : { enabled }), ...layer };
    if (Object.keys(section).length === 0) delete modules[id];
    else modules[id] = section;
    doc.modules = modules;
    let written: number;
    try {
      const row = this.#revisions.write(doc, by, { expected, note });
      written = row.version;
    } catch (error) {
      if (error instanceof ConfigConflictError) {
        throw new SettingsError(
          "conflict",
          `config revision ${error.current} is current, not ${error.expected}`,
        );
      }
      if (error instanceof SettingsError) throw error;
      throw new SettingsError("invalid", error instanceof Error ? error.message : String(error));
    }
    const changed = written !== (current?.version ?? 0);
    const applied = changed ? await this.#apply(id) : "unchanged";
    return this.#result(id, written, applied);
  }

  #result(id: ModuleId, revision: number, applied: SettingsApplied): SettingsSaveResult {
    const status = this.#sup.list().find((m) => m.id === id);
    return {
      revision,
      applied,
      state: status?.state ?? "stopped",
      reason: status?.reason ?? null,
    };
  }

  /** Gives the module its new config: restarts it now, or later when a guard holds. */
  async #apply(id: ModuleId): Promise<SettingsApplied> {
    const d = this.#describe(id);
    const config = this.#effective(id, this.#currentLayer(id), d.schema).config;
    const enabled = this.#sup.list().find((m) => m.id === id)?.enabled ?? false;
    if (!enabled) {
      await this.#sup.reconfigure(id, config, { restart: false });
      return "stored";
    }
    const guard = this.guardFor(id);
    if (guard !== null) {
      // Any restart from here on (a failure, a manual one) takes the new config too.
      await this.#sup.reconfigure(id, config, { restart: false });
      this.#pending.set(id, guard);
      this.#log.info({ module: id, guard }, "settings saved; the restart waits for the guard");
      this.#watch();
      return "deferred";
    }
    this.#pending.delete(id);
    await this.#sup.reconfigure(id, config);
    return "restarted";
  }

  #watch(): void {
    if (this.#timer !== null) return;
    this.#timer = setInterval(() => void this.#retry(), this.#checkMs);
    this.#timer.unref?.();
  }

  /** Applies the deferred saves whose guard is gone. */
  async #retry(): Promise<void> {
    for (const id of [...this.#pending.keys()]) {
      if (this.guardFor(id) !== null) continue;
      this.#pending.delete(id);
      try {
        await this.#sup.reconfigure(id, this.#sup.configOf(id));
        this.#log.info({ module: id }, "deferred settings applied");
      } catch (error) {
        this.#log.warn({ module: id, err: String(error) }, "applying deferred settings failed");
      }
    }
    if (this.#pending.size === 0) this.close();
  }

  #labels(id: ModuleId): Map<string, string> {
    const labels = new Map<string, string>();
    try {
      for (const f of this.#describe(id).fields) labels.set(f.path, f.label);
    } catch {
      // An unknown module has no labels; its history is still the revisions'.
    }
    return labels;
  }

  history(
    id: ModuleId,
    options: { limit?: number; before?: number } = {},
  ): { items: SettingsChange[]; next_before: number | null } {
    const limit = Math.max(1, Math.min(options.limit ?? 10, 100));
    const labels = this.#labels(id);
    const all = this.#revisions.history(HISTORY_SCAN_LIMIT);
    const items: SettingsChange[] = [];
    let nextBefore: number | null = null;
    for (let i = 0; i < all.length; i++) {
      const row = all[i];
      if (row === undefined) continue;
      if (options.before !== undefined && row.version >= options.before) continue;
      const after = layerSection(row.doc, id);
      const before = layerSection(all[i + 1]?.doc, id);
      const paths = new Set([...leaves(before), ...leaves(after)].map(([keys]) => keys.join(".")));
      const changes: SettingsChange["changes"] = [];
      for (const path of [...paths].sort()) {
        const keys = path.split(".");
        const a = jsonAt(before, keys);
        const b = jsonAt(after, keys);
        if (same(a, b)) continue;
        changes.push({
          path,
          label: labels.get(path) ?? path,
          before: a ?? null,
          after: b ?? null,
        });
      }
      if (changes.length === 0) continue;
      if (items.length === limit) {
        nextBefore = items[items.length - 1]?.version ?? null;
        break;
      }
      items.push({
        version: row.version,
        at: row.created_at,
        by: row.created_by,
        note: row.note,
        changes,
      });
    }
    return { items, next_before: nextBefore };
  }

  async revert(
    id: ModuleId,
    version: number,
    expected: number,
    by: string,
  ): Promise<SettingsSaveResult> {
    const d = this.#describe(id);
    let layer: JsonObject = {};
    if (version > 0) {
      const row = this.#revisions.get(version);
      if (row === null)
        throw new SettingsError("unknown", `there is no config revision ${version}`);
      layer = layerSection(row.doc, id);
    }
    // Keys that do not fit any more are left out rather than refusing the whole revert; a reference
    // to a variable that is not set now stays as written.
    const kept = this.#effective(id, layer, d.schema);
    for (const s of kept.skipped) if (!s.env) layer = deleteIn(layer, s.keys);
    return this.#write(id, layer, by, expected, `revert ${id} to ${version}`);
  }

  overrides(): SettingOverride[] {
    const doc = this.#revisions.current()?.doc;
    const modules = jsonAt(doc, ["modules"]);
    if (!isJsonObject(modules ?? null)) return [];
    const out: SettingOverride[] = [];
    for (const id of Object.keys(modules as JsonObject).sort()) {
      const file = this.#file(id);
      for (const [keys, value] of leaves(layerSection(doc, id))) {
        const fileValue = jsonAt(file ?? undefined, keys);
        out.push({
          key: `modules.${/^[A-Za-z0-9_-]+$/.test(id) ? id : JSON.stringify(id)}.${keys.join(".")}`,
          module: id,
          path: keys.join("."),
          value,
          file: fileValue ?? null,
          file_set: fileValue !== undefined,
        });
      }
    }
    return out;
  }

  // ---- places ---------------------------------------------------------------------------------

  #placesOrThrow(): ModuleSettingsPlaces {
    if (this.#places === null) {
      throw new SettingsError("unknown", "這裡沒有伺服器的資料,只能改全部伺服器的設定");
    }
    return this.#places;
  }

  /** The Space (and room) of a request; `SettingsError` for an unknown Space or a room elsewhere. */
  #place(request: SettingsPlace): Place {
    const { places } = this.#placesOrThrow();
    const space = places.space(request.space);
    if (space === null) throw new SettingsError("unknown", "找不到這個伺服器");
    const channel = request.room?.trim() ?? "";
    if (channel === "") return { space, room: null };
    const known = places.channelSpace(space.platform, channel);
    if (known !== null && known !== space.id) {
      throw new SettingsError("unknown", "這個頻道不在這個伺服器");
    }
    const at = places.at({
      platform: space.platform,
      scope: space.external_id,
      channel,
      kind: "channel",
    });
    const row = at === null ? null : places.room(at.room_id);
    return { space, room: { channel, row } };
  }

  /** The fields of a module that may have a value of their own at `place`. */
  #placeFields(d: Described, place: Place): PlaceField[] {
    if (d.schema === undefined) return [];
    const all = placeFields(d.schema);
    return place.room === null ? all : all.filter((f) => f.scope === "room");
  }

  /**
   * The module's section at `place` from the cluster value `section` and the place rows, those of
   * `without` (one place's own) left out when given.
   */
  #resolveAt(
    id: ModuleId,
    d: Described,
    place: Place,
    section: JsonValue | null,
    without: { scope: "space" | "room"; id: string } | null,
  ): JsonValue | null {
    const ctx = this.#placesOrThrow();
    const schema = d.schema;
    if (schema === undefined) return section;
    const fields = placeFields(schema);
    if (fields.length === 0) return section;
    const settings =
      without === null
        ? ctx.settings
        : ({
            list: (filter: Parameters<PlaceSettings["list"]>[0]) =>
              ctx.settings
                .list(filter)
                .filter((r) => !(r.scope === without.scope && r.scope_id === without.id)),
            onChange: () => () => {},
          } as unknown as PlaceSettings);
    const stop = new AbortController();
    const configs = new PlaceConfigs({
      places: ctx.places,
      settings,
      ...(ctx.directory ? { directory: ctx.directory } : {}),
      log: this.#log,
    });
    try {
      const config = configs.open<JsonValue>({
        module: id,
        section,
        fields,
        parse: (s) => parseSection(schema, s ?? undefined, `modules.${id}`) as JsonValue,
        signal: stop.signal,
      });
      return config.for({ space_id: place.space.id, room_id: place.room?.row?.id ?? null });
    } catch {
      // A cluster section that does not parse: the place sees it as it is.
      return section;
    } finally {
      stop.abort();
    }
  }

  /** Adds each place field's value at `place`, its own value and what it inherits, to `values`. */
  #describePlace(
    id: ModuleId,
    d: Described,
    place: Place,
    cluster: JsonValue | null,
    values: Record<string, SettingValue>,
  ): void {
    const { settings } = this.#placesOrThrow();
    const own = this.#ownPlace(place);
    const resolved = this.#resolveAt(id, d, place, cluster, null);
    const inherited = own === null ? resolved : this.#resolveAt(id, d, place, cluster, { ...own });
    const parent =
      place.room?.row?.kind === "thread" && place.room.row.parent_id !== null
        ? place.room.row.parent_id
        : null;
    for (const f of this.#placeFields(d, place)) {
      const path = f.keys.join(".");
      const value = values[path];
      if (value === undefined) continue;
      const mine = own === null ? null : settings.get(own.scope, own.id, id, path);
      let from: SettingSource = value.source;
      if (place.room !== null) {
        if (parent !== null && settings.get("room", parent, id, path) !== null) from = "room";
        else if (settings.get("space", place.space.id, id, path) !== null) from = "space";
      }
      const placeValue: SettingPlaceValue = {
        own: mine?.value ?? null,
        own_set: mine !== null,
        inherited: jsonAt(inherited ?? undefined, f.keys) ?? null,
        inherited_from: from,
      };
      values[path] = {
        ...value,
        value: jsonAt(resolved ?? undefined, f.keys) ?? value.value,
        source: mine !== null ? (own?.scope ?? from) : from,
        place: placeValue,
      };
    }
  }

  /** The `place_settings` place of a request's own values; `null` for a room identity has not seen. */
  #ownPlace(place: Place): { scope: "space" | "room"; id: string } | null {
    if (place.room === null) return { scope: "space", id: place.space.id };
    return place.room.row === null ? null : { scope: "room", id: place.room.row.id };
  }

  /** Whether a channel value can be a setting of `space`: not when it is known to be elsewhere. */
  #channelElsewhere(space: SpaceRef, value: string, ref: "id" | "context"): boolean {
    if (value === "") return false;
    if (ref === "context" || value.includes(":")) {
      const [platform, scope] = value.split(":");
      return !(platform === space.platform && scope === space.external_id);
    }
    const ctx = this.#placesOrThrow();
    const known = ctx.places.channelSpace(space.platform, value);
    if (known !== null) return known !== space.id;
    const directory = ctx.directory?.();
    if (directory === undefined || directory.platform !== space.platform) return false;
    try {
      const room = directory.rooms().find((r) => r.id === value);
      return room !== undefined && room.space.id !== space.external_id;
    } catch {
      return false;
    }
  }

  async #savePlace(
    id: ModuleId,
    d: Described,
    request: SettingsSaveRequest,
    by: string,
  ): Promise<SettingsSaveResult> {
    const ctx = this.#placesOrThrow();
    const place = this.#place(request.place as SettingsPlace);
    const scope: "space" | "room" = place.room === null ? "space" : "room";
    const fields = new Map(this.#placeFields(d, place).map((f) => [f.keys.join("."), f]));
    const labels = new Map(d.fields.map((f) => [f.path, f]));
    const cluster = this.#effective(id, this.#currentLayer(id), d.schema).config;
    const refused: SettingProblem[] = [];
    const invalid: SettingProblem[] = [];
    const where = scope === "space" ? "伺服器" : "頻道";
    const cannot = (path: string) => {
      const label = labels.get(path)?.label ?? path;
      refused.push({ path, message: `${label}:不能每個${where}設不同的值` });
    };
    for (const [path, value] of Object.entries(request.set)) {
      const field = fields.get(path);
      const described = labels.get(path);
      if (field === undefined || described === undefined || described.apply !== "module") {
        cannot(path);
        continue;
      }
      const label = described.label;
      if (JSON.stringify(value).includes("${")) {
        refused.push({ path, message: `${label}:環境變數的參照只能寫在設定檔` });
        continue;
      }
      if (field.merge === "union" && !Array.isArray(value)) {
        invalid.push({ path, message: `${label}:要是一個清單` });
        continue;
      }
      if (field.channel !== null) {
        const ref = field.channel.ref;
        const list = Array.isArray(value) ? value : [value];
        if (
          list.some((v) => typeof v === "string" && this.#channelElsewhere(place.space, v, ref))
        ) {
          invalid.push({ path, message: `${label}:這個頻道不在${place.space.name}` });
          continue;
        }
      }
      if (d.schema !== undefined) {
        const candidate = setIn(isJsonObject(cluster) ? cluster : {}, field.keys, value);
        const issue = sectionIssues(d.schema, candidate).find((i) =>
          startsWith(i.keys, field.keys),
        );
        if (issue !== undefined) invalid.push({ path, message: `${label}:${issue.message}` });
      }
    }
    for (const path of request.reset) if (!fields.has(path)) cannot(path);
    if (refused.length > 0) {
      throw new SettingsError("not_editable", "some fields cannot differ here", refused);
    }
    if (invalid.length > 0) {
      throw new SettingsError("invalid", invalid.map((p) => p.message).join("\n"), invalid);
    }
    let own = this.#ownPlace(place);
    const writes = Object.keys(request.set).length > 0;
    if (own === null && writes) {
      if (ctx.ensureRoom === undefined || place.room === null) {
        throw new SettingsError("unknown", "她還沒看過這個頻道,先在那裡說一句話再設");
      }
      own = { scope: "room", id: ctx.ensureRoom(place.space, place.room.channel) };
    }
    let changed = false;
    if (own !== null) {
      const target = own;
      const write = (path: string, value: JsonValue | null) => {
        const before = ctx.settings.get(target.scope, target.id, id, path);
        if (value === null ? before === null : before !== null && same(before.value, value)) return;
        ctx.settings.set(target.scope, target.id, id, path, value, by);
        changed = true;
      };
      for (const [path, value] of Object.entries(request.set)) write(path, value);
      for (const path of request.reset) write(path, null);
    }
    return this.#result(
      id,
      this.#revisions.current()?.version ?? 0,
      changed ? "immediate" : "unchanged",
    );
  }

  async placeHistory(
    id: ModuleId,
    request: SettingsPlace,
    options: { limit?: number; before?: number } = {},
  ): Promise<{ items: SettingsChange[]; next_before: number | null }> {
    const ctx = this.#placesOrThrow();
    const place = this.#place(request);
    const limit = Math.max(1, Math.min(options.limit ?? 10, 100));
    if (ctx.events === undefined) return { items: [], next_before: null };
    const own = this.#ownPlace(place);
    if (place.room !== null && own === null) return { items: [], next_before: null };
    const labels = this.#labels(id);
    const events = await ctx.events.query({ types: [PLACE_CHANGED], limit: HISTORY_SCAN_LIMIT });
    interface Change {
      seq: number;
      at: string;
      scope: "space" | "room";
      scope_id: string;
      key: string;
      value: JsonValue | null;
      by: string;
      space: string | null;
    }
    const mine: Change[] = [];
    for (const e of events) {
      const data = e.envelope.data;
      if (!isJsonObject(data) || data.plugin !== id) continue;
      const { scope, scope_id: scopeId, key, value, by } = data;
      if ((scope !== "space" && scope !== "room") || typeof scopeId !== "string") continue;
      if (typeof key !== "string") continue;
      mine.push({
        seq: e.envelope.seq ?? 0,
        at: e.envelope.at,
        scope,
        scope_id: scopeId,
        key,
        value: value ?? null,
        by: typeof by === "string" ? by : "",
        space: e.envelope.space_id,
      });
    }
    // Newest first; a change's "before" is the next older change of the same place and key.
    mine.sort((a, b) => b.seq - a.seq);
    const items: SettingsChange[] = [];
    let nextBefore: number | null = null;
    for (let i = 0; i < mine.length; i++) {
      const c = mine[i] as Change;
      if (own !== null && place.room !== null) {
        if (c.scope !== "room" || c.scope_id !== own.id) continue;
      } else if (c.space !== place.space.id) continue;
      if (options.before !== undefined && c.seq >= options.before) continue;
      if (items.length === limit) {
        nextBefore = items[items.length - 1]?.version ?? null;
        break;
      }
      const older = mine
        .slice(i + 1)
        .find((o) => o.scope === c.scope && o.scope_id === c.scope_id && o.key === c.key);
      const room = c.scope === "room" ? ctx.places.room(c.scope_id) : null;
      items.push({
        version: c.seq,
        at: c.at,
        by: c.by,
        note: null,
        changes: [
          {
            path: c.key,
            label: labels.get(c.key) ?? c.key,
            before: older?.value ?? null,
            after: c.value,
          },
        ],
        place: {
          scope: c.scope,
          room: room?.external_id ?? null,
          name: c.scope === "room" ? (room?.name ?? null) : place.space.name,
        },
      });
    }
    return { items, next_before: nextBefore };
  }
}
