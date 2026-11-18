// The panel's settings layer (docs/design/v5-settings.md §4, §5): what the panel changes of a
// module's config is written to the config revisions (`config_revisions`, the same documents that
// already remember module on/off) and laid over `miyoria.toml`, key by key. The file is never
// written. A module runs with: the file's section (env references expanded), then each key of the
// layer that still fits the module's schema; a key that no longer fits is skipped with a warning
// and the panel shows why.
//
// Merging: objects key by key, arrays and plain values whole. `enabled` is not part of a module's
// settings: the layer's flag and the file's are ANDed by boot as before.
//
// A save writes the next revision (author, time, the `config.revised` event, the `expected`
// version against concurrent writes) and restarts the module with its dependents
// (`Supervisor.reconfigure`). When the restart would stop a module she is using right now (sing,
// voice, voice.link, stage.link while she sings or is live), the save is kept and the restart
// waits until the guard is gone. Core is the only validator: the merged section is checked with
// the module's own schema and each problem comes back by field, in zod's zh-TW words.

import {
  type Config,
  configJsonSchema,
  getLogger,
  jsonAt,
  type Logger,
  type ModuleSettingsService,
  type ModuleSettingsView,
  type SettingField,
  type SettingGroup,
  type SettingOverride,
  type SettingProblem,
  type SettingsApplied,
  type SettingsChange,
  SettingsError,
  type SettingsSaveRequest,
  type SettingsSaveResult,
  type SettingValue,
  type Supervisor,
  sectionIssues,
  settingFields,
} from "@miyoria/runtime/kernel";
import { ConfigConflictError, type ConfigRevisions } from "@miyoria/store";
import { isJsonObject, type JsonObject, type JsonValue, type ModuleId } from "@miyoria/types";

/** Modules a restart would interrupt while she sings or is live. */
export const GUARDED_MODULES: readonly ModuleId[] = ["sing", "voice", "voice.link", "stage.link"];

/** How often a deferred save checks whether its guard is gone. */
export const DEFERRED_CHECK_MS = 5_000;

/** Revisions read for one page of a module's history. */
const HISTORY_SCAN_LIMIT = 2_000;

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

/** What a module runs with, and what of the layer was used and skipped. */
export interface Effective {
  config: JsonValue | null;
  /** Layer keys laid over the file. */
  used: string[][];
  /** Layer keys that do not fit the schema, with why. */
  skipped: { keys: string[]; reason: string }[];
}

/**
 * The file's section with the layer's keys laid over it, each kept only if it does not bring a
 * problem of its own (`schema`; without one every key is kept).
 */
export function effectiveSection(
  file: JsonValue | null,
  layer: JsonObject,
  schema: Parameters<typeof sectionIssues>[0] | undefined,
): Effective {
  const keys = leaves(layer);
  if (keys.length === 0) return { config: file, used: [], skipped: [] };
  let config: JsonObject = isJsonObject(file) ? file : {};
  const used: string[][] = [];
  const skipped: { keys: string[]; reason: string }[] = [];
  for (const [path, value] of keys) {
    const candidate = setIn(config, path, value);
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
}

interface Described {
  name: string;
  groups: SettingGroup[];
  fields: SettingField[];
  schema: Parameters<typeof sectionIssues>[0] | undefined;
}

/** Core's `ModuleSettingsKey`. */
export class ModuleSettings implements ModuleSettingsService {
  readonly #config: Config;
  readonly #revisions: ConfigRevisions;
  readonly #sup: Supervisor;
  readonly #guard: () => string | null;
  readonly #log: Logger;
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

  /**
   * What module `id` runs with at boot: the file's section and the layer over it. Logs each key the
   * layer overrides with a value other than the file's, and each one it skips, once.
   */
  boot(id: ModuleId, file: JsonValue | null, schema: Described["schema"]): JsonValue | null {
    const layer = this.#currentLayer(id);
    const found = effectiveSection(file, layer, schema);
    for (const keys of found.used) {
      const fileValue = jsonAt(file ?? undefined, keys);
      if (fileValue === undefined || same(fileValue, jsonAt(layer, keys))) continue;
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

  describe(id: ModuleId): ModuleSettingsView {
    const d = this.#describe(id);
    const current = this.#revisions.current();
    const layer = layerSection(current?.doc, id);
    const file = this.#file(id);
    const found = effectiveSection(file, layer, d.schema);
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
      values[f.path] = {
        value: effective ?? f.default,
        source: fromLayer ? "panel" : fileValue !== undefined ? "file" : "default",
        file: fileValue ?? null,
        file_set: fileValue !== undefined,
        set: true,
        env: null,
        invalid: skipped?.reason ?? null,
      };
    }
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
    };
  }

  async save(id: ModuleId, request: SettingsSaveRequest, by: string): Promise<SettingsSaveResult> {
    const d = this.#describe(id);
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

  /** The file with every key of `layer` over it, unchecked. */
  #mergeAll(file: JsonValue | null, layer: JsonObject): JsonObject {
    let out: JsonObject = isJsonObject(file) ? file : {};
    for (const [keys, value] of leaves(layer)) out = setIn(out, keys, value);
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
    const status = this.#sup.list().find((m) => m.id === id);
    return {
      revision: written,
      applied,
      state: status?.state ?? "stopped",
      reason: status?.reason ?? null,
    };
  }

  /** Gives the module its new config: restarts it now, or later when a guard holds. */
  async #apply(id: ModuleId): Promise<SettingsApplied> {
    const d = this.#describe(id);
    const config = effectiveSection(this.#file(id), this.#currentLayer(id), d.schema).config;
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

  history(
    id: ModuleId,
    options: { limit?: number; before?: number } = {},
  ): { items: SettingsChange[]; next_before: number | null } {
    const limit = Math.max(1, Math.min(options.limit ?? 10, 100));
    const labels = new Map<string, string>();
    try {
      for (const f of this.#describe(id).fields) labels.set(f.path, f.label);
    } catch {
      // An unknown module has no labels; its history is still the revisions'.
    }
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
    // Keys that do not fit any more are left out rather than refusing the whole revert.
    const kept = effectiveSection(this.#file(id), layer, d.schema);
    for (const s of kept.skipped) layer = deleteIn(layer, s.keys);
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
}
