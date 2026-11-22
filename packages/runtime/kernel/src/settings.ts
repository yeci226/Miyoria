// What the panel may change of a module's config (docs/design/v5-settings.md §2): a field of a
// module's zod schema carries `.meta(setting({...}))`, a `"x-miyoria"` object zod copies into the
// JSON Schema as it is. `settingFields` reads that JSON Schema back into a flat list of fields, so a
// built-in module (zod, through `configJsonSchema`) and an extension (its own `config.schema.json`)
// are described the same way. A field without the marker stays in the file only.
//
// The marker says how to draw and apply a field; what is valid (type, range, options, default)
// still comes from the schema itself, and Core is the only one that checks a value.
//
// `ModuleSettingsService` (provided by Core under `ModuleSettingsKey`) is what the API calls: it
// owns the layer of panel edits over `miyoria.toml` and applies a save by restarting the module.

import {
  type JsonObject,
  type JsonValue,
  type ModuleId,
  type ModuleStateKind,
  serviceKey,
} from "@miyoria/types";
import { z } from "zod";

/** The key zod copies into the JSON Schema of a marked field (and of a schema's groups). */
export const SETTING_KEY = "x-miyoria";

/**
 * How a field is drawn. `role`, `person`, `multi`, `ratio` and `rows` are declared for the
 * design's later steps; the panel draws the others today.
 */
export const SETTING_KINDS = [
  "switch",
  "number",
  "text",
  "select",
  "multi",
  "channel",
  "role",
  "person",
  "time",
  "weekday",
  "duration",
  "coins",
  "ratio",
  "rows",
] as const;
export type SettingKind = (typeof SETTING_KINDS)[number];

/** `module`: saving restarts the module; `core`: it takes a restart of Core. */
export type SettingApply = "module" | "core";
/**
 * `cluster`: one value. `space`: may differ per server. `room`: may differ per room (channel,
 * thread, voice room), and a room without its own value takes its Space's. A place's value is a
 * `place_settings` row; `placeConfig` resolves it (docs/design/v5-places.md).
 */
export type SettingScope = "cluster" | "space" | "room";
/**
 * How a place's value meets the ones above it. `replace` (default): the nearest one wins.
 * `union`: a list field takes every layer's entries (cluster, Space, parent room, room), so a deny
 * list set for the cluster cannot be lifted by a room.
 */
export type SettingMerge = "replace" | "union";
/** The scopes, for checks. */
export const SETTING_SCOPES: readonly SettingScope[] = ["cluster", "space", "room"];
/** A `duration`'s unit: the unit the key's name says, never converted. */
export type SettingUnit = "ms" | "s" | "min" | "h" | "day";
/** The kind of room a `channel` field takes. */
export type SettingRoom = "text" | "voice" | "thread";
/** What a `channel` field stores: a bare channel id, or a context key `discord:<guild>:<channel>`. */
export type SettingRef = "id" | "context";

/** The marker on one field. */
export interface SettingMeta {
  kind: SettingKind;
  /** Short, in zh-TW: the field's name on the form. */
  label: string;
  /** One sentence under the field. */
  help?: string;
  /** A group id the schema root names (`settingGroups`). */
  group?: string;
  /** Position within the group; default: the order the schema declares the fields in. */
  order?: number;
  /** Default `module`. */
  apply?: SettingApply;
  /** Why changing it is dangerous; the panel asks before saving it. */
  danger?: string;
  /** Never sent to the panel and never written by it; only whether it is set. */
  secret?: boolean;
  /** Default `cluster`. */
  scope?: SettingScope;
  /** Default `replace`; `union` only means something for a list. */
  merge?: SettingMerge;
  unit?: SettingUnit;
  /** The step of a number. */
  step?: number;
  /** Draw a number as a slider (needs a min and a max). */
  slider?: boolean;
  /** A long text: a text area. */
  long?: boolean;
  /** zh-TW names of a `select` / `multi` field's options, by option. */
  labels?: Record<string, string>;
  room?: SettingRoom;
  /** A `channel` / `role` field that holds a list. */
  multiple?: boolean;
  /** Default `context` for a new field; the existing channel fields store bare ids. */
  ref?: SettingRef;
}

/** A group of fields on the form. */
export interface SettingGroup {
  id: string;
  label: string;
}

/** `{ "x-miyoria": meta }`, for a field's `.meta()`. */
export function setting(meta: SettingMeta): { [SETTING_KEY]: SettingMeta } {
  return { [SETTING_KEY]: meta };
}

/** `{ "x-miyoria": { groups } }`, for the schema root's `.meta()`. */
export function settingGroups(groups: readonly SettingGroup[]): {
  [SETTING_KEY]: { groups: SettingGroup[] };
} {
  return { [SETTING_KEY]: { groups: groups.map((g) => ({ ...g })) } };
}

/** One field the panel may draw, read back from the JSON Schema (`settingFields`). */
export interface SettingField {
  /** Dotted, relative to the module's section: `rewards.coins_per_point`. */
  path: string;
  keys: string[];
  kind: SettingKind;
  label: string;
  help: string | null;
  group: string | null;
  order: number;
  apply: SettingApply;
  danger: string | null;
  secret: boolean;
  scope: SettingScope;
  merge: SettingMerge;
  unit: SettingUnit | null;
  labels: Record<string, string> | null;
  room: SettingRoom | null;
  multiple: boolean;
  ref: SettingRef;
  /** From the schema: `minimum` (an exclusive bound of an integer moved by one). */
  min: number | null;
  max: number | null;
  step: number | null;
  int: boolean;
  max_length: number | null;
  pattern: string | null;
  /** A `select` / `multi` field's options, from the schema's `enum`. */
  options: string[] | null;
  slider: boolean;
  long: boolean;
  default: JsonValue | null;
}

/** What `settingFields` found. `skipped` names markers it could not read. */
export interface SettingDescriptor {
  groups: SettingGroup[];
  fields: SettingField[];
  skipped: { path: string; reason: string }[];
}

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

function oneOf<T extends string>(v: unknown, values: readonly T[]): T | null {
  return typeof v === "string" && (values as readonly string[]).includes(v) ? (v as T) : null;
}

/** `#/$defs/X` of `root`, else the node itself. */
function resolve(root: Obj, node: Obj): Obj {
  const ref = node.$ref;
  if (typeof ref !== "string" || !ref.startsWith("#/")) return node;
  let at: unknown = root;
  for (const part of ref.slice(2).split("/")) at = isObj(at) ? at[part] : undefined;
  return isObj(at) ? { ...at, ...node, $ref: undefined } : node;
}

function groupsOf(node: Obj): SettingGroup[] {
  const meta = node[SETTING_KEY];
  if (!isObj(meta) || !Array.isArray(meta.groups)) return [];
  return meta.groups.flatMap((g) => {
    if (!isObj(g)) return [];
    const id = str(g.id);
    const label = str(g.label);
    return id && label ? [{ id, label }] : [];
  });
}

function stringMap(v: unknown): Record<string, string> | null {
  if (!isObj(v)) return null;
  const out: Record<string, string> = {};
  for (const [k, value] of Object.entries(v)) if (typeof value === "string") out[k] = value;
  return Object.keys(out).length > 0 ? out : null;
}

function enumOf(node: Obj): string[] | null {
  const values = Array.isArray(node.enum) ? node.enum : null;
  if (values === null || !values.every((v) => typeof v === "string")) return null;
  return values as string[];
}

function fieldOf(root: Obj, raw: Obj, keys: string[], declared: number): SettingField | string {
  const node = resolve(root, raw);
  const meta = node[SETTING_KEY] as Obj;
  const kind = oneOf(meta.kind, SETTING_KINDS);
  if (kind === null) return `unknown kind \`${String(meta.kind)}\``;
  const label = str(meta.label);
  if (label === null) return "no label";
  const type = node.type;
  const int = type === "integer";
  const exMin = num(node.exclusiveMinimum);
  const exMax = num(node.exclusiveMaximum);
  const items = isObj(node.items) ? resolve(root, node.items) : null;
  // zod writes the safe-integer range as the bounds of every `int()`: those are no bound at all.
  const bound = (v: unknown) => {
    const n = num(v);
    return n === null || Math.abs(n) >= Number.MAX_SAFE_INTEGER ? null : n;
  };
  const min = bound(node.minimum) ?? (exMin === null ? null : int ? exMin + 1 : exMin);
  const max = bound(node.maximum) ?? (exMax === null ? null : int ? exMax - 1 : exMax);
  const def = node.default;
  return {
    path: keys.join("."),
    keys,
    kind,
    label,
    help: str(meta.help),
    group: str(meta.group),
    order: num(meta.order) ?? declared,
    apply: oneOf(meta.apply, ["module", "core"] as const) ?? "module",
    danger: str(meta.danger),
    secret: meta.secret === true,
    scope: oneOf(meta.scope, SETTING_SCOPES) ?? "cluster",
    merge: (type === "array" && oneOf(meta.merge, ["replace", "union"] as const)) || "replace",
    unit: oneOf(meta.unit, ["ms", "s", "min", "h", "day"] as const),
    labels: stringMap(meta.labels),
    room: oneOf(meta.room, ["text", "voice", "thread"] as const),
    multiple: meta.multiple === true || type === "array",
    ref: oneOf(meta.ref, ["id", "context"] as const) ?? "context",
    min,
    max,
    step: num(meta.step) ?? (int ? 1 : null),
    int,
    max_length: num(node.maxLength),
    pattern: typeof node.pattern === "string" ? node.pattern : null,
    options: enumOf(node) ?? (items ? enumOf(items) : null),
    slider: meta.slider === true,
    long: meta.long === true,
    default: def === undefined ? null : (def as JsonValue),
  };
}

/**
 * The marked fields of a config's JSON Schema (as `configJsonSchema` writes it, or an extension's
 * `config.schema.json`), sorted by group order and then `order`. Objects are walked into, so a
 * field of a nested table (`rewards.enabled`) is found too. A marker that cannot be read (an
 * unknown kind, no label) is skipped and named in `skipped`.
 */
export function settingFields(jsonSchema: JsonValue | null | undefined): SettingDescriptor {
  const out: SettingDescriptor = { groups: [], fields: [], skipped: [] };
  if (!isObj(jsonSchema)) return out;
  const root = jsonSchema;
  let declared = 0;
  const walk = (raw: Obj, keys: string[]) => {
    const node = resolve(root, raw);
    for (const g of groupsOf(node)) {
      if (!out.groups.some((x) => x.id === g.id)) out.groups.push(g);
    }
    const props = isObj(node.properties) ? node.properties : null;
    if (props === null) return;
    for (const [key, child] of Object.entries(props)) {
      if (!isObj(child)) continue;
      const path = [...keys, key];
      const resolved = resolve(root, child);
      const meta = resolved[SETTING_KEY];
      if (isObj(meta) && "kind" in meta) {
        declared += 10;
        const field = fieldOf(root, child, path, declared);
        if (typeof field === "string") out.skipped.push({ path: path.join("."), reason: field });
        else out.fields.push(field);
      } else if (isObj(resolved.properties)) {
        walk(resolved, path);
      }
    }
  };
  walk(root, []);
  const groupIndex = (id: string | null) => {
    const i = out.groups.findIndex((g) => g.id === id);
    return i === -1 ? out.groups.length : i;
  };
  out.fields.sort((a, b) => groupIndex(a.group) - groupIndex(b.group) || a.order - b.order);
  return out;
}

// ---- the service Core provides --------------------------------------------------------------

/**
 * Where a field's value comes from: the schema `default`, the `file`, the cluster layer in the
 * database (`panel`, only while it differs from the file), or a place's own value (`space`, `room`).
 */
export type SettingSource = "default" | "file" | "panel" | "space" | "room";

/**
 * A place a module's settings are read or written for (docs/design/v5-places.md): a Space by
 * identity's id, and optionally one of its rooms by the platform's channel id.
 */
export interface SettingsPlace {
  space: string;
  /** The platform's channel id (what the channel picker lists); `null`: the whole Space. */
  room?: string | null;
}

/** A field's value at a place, beside what it would be without the place's own value. */
export interface SettingPlaceValue {
  /** The place's own value (`place_settings`); `null` when it has none. */
  own: JsonValue | null;
  own_set: boolean;
  /** What the field is at this place without its own value: what clearing it returns to. */
  inherited: JsonValue | null;
  /** Where `inherited` comes from. */
  inherited_from: SettingSource;
}

/** A field's value as the panel shows it. */
export interface SettingValue {
  /** What the module runs with; `null` for a secret. */
  value: JsonValue | null;
  source: SettingSource;
  /** What `miyoria.toml` says; `null` when it does not set the key, or for a secret. */
  file: JsonValue | null;
  file_set: boolean;
  /** A secret: whether it has a value. */
  set: boolean;
  /** A secret: the environment variable the file names (`${NAME}`), if any. */
  env: string | null;
  /** The panel's value does not fit the schema any more: it is skipped, with why. */
  invalid: string | null;
  /** Read for a place and the field may differ there: the place's own value and what it inherits. */
  place?: SettingPlaceValue | null;
}

/** The place a view was read for. */
export interface SettingsPlaceView {
  space: { id: string; name: string };
  /** The room asked for: the platform's channel id and the name identity knows. */
  room: { id: string; name: string | null } | null;
}

/** One module's settings, for the form. */
export interface ModuleSettingsView {
  module: ModuleId;
  name: string;
  /** The config revision the values were read at: a save names it as `expected`. */
  revision: number;
  groups: SettingGroup[];
  fields: SettingField[];
  /** By field path. */
  values: Record<string, SettingValue>;
  /** The last revision that changed this module's panel settings. */
  updated: { version: number; at: string; by: string } | null;
  /** A save now would wait for this guarded state (`singing`, `live`) before the restart. */
  guard: string | null;
  /** A saved change waits for this guarded state before it is applied. */
  pending: string | null;
  /** The place the values were read for; `null`: the cluster (no place asked). */
  place?: SettingsPlaceView | null;
}

export interface SettingsSaveRequest {
  /**
   * The revision the form was loaded at; another write since is a conflict. Not checked for a
   * place's save (place settings have no versions).
   */
  expected: number;
  /** New values by field path. */
  set: Record<string, JsonValue>;
  /**
   * Field paths that go back to the file's value (the panel's value is removed); for a place, to
   * what the place inherits (its own value is removed).
   */
  reset: string[];
  note?: string | null;
  /** Write the place's own values (`place_settings`) instead of the cluster layer. */
  place?: SettingsPlace | null;
}

/**
 * `restarted`: the module was restarted with it. `deferred`: saved; the restart waits for a guarded
 * state to end. `stored`: saved; the module is off and reads it when it starts. `unchanged`: there
 * was nothing to write. `immediate`: a place's values, in effect at once without a restart.
 */
export type SettingsApplied = "restarted" | "deferred" | "stored" | "unchanged" | "immediate";

export interface SettingsSaveResult {
  revision: number;
  applied: SettingsApplied;
  state: ModuleStateKind;
  reason: string | null;
}

/** A value refused, by field path, with zod's message in zh-TW after the field's label. */
export interface SettingProblem {
  path: string;
  message: string;
}

/** One revision that changed a module's panel settings, with what changed. */
export interface SettingsChange {
  version: number;
  at: string;
  by: string;
  note: string | null;
  changes: { path: string; label: string; before: JsonValue | null; after: JsonValue | null }[];
  /** A place's change: the Space's own value, or a room's (its channel id and name). */
  place?: { scope: "space" | "room"; room: string | null; name: string | null } | null;
}

/** One key of the panel's layer, for `miyoria config overrides` and `bake`. */
export interface SettingOverride {
  /** `modules.market.auction_channel`. */
  key: string;
  module: ModuleId;
  path: string;
  value: JsonValue;
  /** What the file says, when it sets the key. */
  file: JsonValue | null;
  file_set: boolean;
}

export type SettingsErrorKind = "unknown" | "not_editable" | "invalid" | "conflict";

export class SettingsError extends Error {
  override readonly name = "SettingsError";

  constructor(
    readonly kind: SettingsErrorKind,
    message: string,
    readonly problems: readonly SettingProblem[] = [],
  ) {
    super(message);
  }
}

/** Core's settings layer, as the API sees it. */
export interface ModuleSettingsService {
  /** Whether the module has fields the panel may change. */
  editable(module: ModuleId): boolean;
  /**
   * The fields and their values; with `place`, the values at that place (a field that may differ
   * there carries `place`). `SettingsError("unknown")` for an unknown module, Space or room.
   */
  describe(module: ModuleId, place?: SettingsPlace | null): ModuleSettingsView;
  /**
   * Writes the next revision and applies it, or with `request.place` the place's own values
   * (`SettingsError` for an unknown field, a bad value, a conflict).
   */
  save(module: ModuleId, request: SettingsSaveRequest, by: string): Promise<SettingsSaveResult>;
  history(
    module: ModuleId,
    options?: { limit?: number; before?: number },
  ): { items: SettingsChange[]; next_before: number | null };
  /**
   * The changes of one place's own values for the module (the Space's and its rooms', or one
   * room's), newest first; `version` is the change's position in the event log.
   */
  placeHistory(
    module: ModuleId,
    place: SettingsPlace,
    options?: { limit?: number; before?: number },
  ): Promise<{ items: SettingsChange[]; next_before: number | null }>;
  /** Makes the module's panel settings what they were at revision `version` (0: none). */
  revert(
    module: ModuleId,
    version: number,
    expected: number,
    by: string,
  ): Promise<SettingsSaveResult>;
  /** A saved change waiting for a guard, if any. */
  pending(module: ModuleId): string | null;
  overrides(): SettingOverride[];
}

export const ModuleSettingsKey = serviceKey<ModuleSettingsService>("ModuleSettings");

/** One reason a module's section does not fit its schema: where, and zod's words. */
export interface SectionIssue {
  keys: (string | number)[];
  message: string;
}

let zhTW: z.core.$ZodErrorMap | undefined;

/**
 * Every issue of `value` against a module's `schema`, worded in zh-TW (zod's own locale, for this
 * parse only: the global setting is left alone). A message the schema wrote itself wins.
 */
export function sectionIssues(schema: z.ZodType, value: JsonValue | null): SectionIssue[] {
  zhTW ??= z.locales.zhTW().localeError;
  let result: ReturnType<z.ZodType["safeParse"]>;
  try {
    result = schema.safeParse(value ?? {}, { error: zhTW });
  } catch (error) {
    // A transform that throws instead of reporting an issue.
    return [{ keys: [], message: error instanceof Error ? error.message : String(error) }];
  }
  if (result.success) return [];
  return result.error.issues.map((issue) => ({
    keys: issue.path.map((k) => (typeof k === "number" ? k : String(k))),
    message: issue.message,
  }));
}

/** The value at `keys` of a JSON tree, `undefined` when the path does not lead anywhere. */
export function jsonAt(doc: JsonValue | undefined, keys: readonly string[]): JsonValue | undefined {
  let at: JsonValue | undefined = doc;
  for (const key of keys) {
    if (!isObj(at)) return undefined;
    at = (at as JsonObject)[key];
  }
  return at;
}
