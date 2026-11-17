// Data categories (docs/design/v5-data.md §3.4): every kind of data she has, what makes it up, and
// how to count, export and delete it. One definition, shared by the panel's data page
// (`/api/data/*`), the Discord `/admin memory wipe` and the factory reset.
//
// Two halves:
// - The catalog (`CATEGORY_SPECS`): the categories themselves, in display order, with what deleting
//   one takes with it (`requires`), the modules caching it, and their flags (shared, kept, how a
//   delete is confirmed). The panel, the API and the commands name categories by id, so the list is
//   fixed here, one place; a schema adds parts to a category, never a category.
// - The parts: each schema declares the parts its tables hold (`CategoryData`): the store's own
//   (`categories.ts`) and every plugin's (`StorePlugin.data`). A `DataRegistry` collects the
//   declarations of what a store has installed. A plugin that is not installed declares nothing,
//   so its parts are not there to count, export or delete.
//
// Invariants kept by the shape of the declarations:
// - Consolidation watermarks (`memory_watermark:*`) exist only inside `messages`, so they are
//   never deleted without the log they point into (otherwise the log would be extracted into
//   memories again).
// - The audit log, LLM usage (the `llm.call` events) and panel sessions are `kept`: never deleted,
//   also not by a reset.
// - `roles` is reset, not emptied: the auth plugin writes the built-in roles again in the same
//   transaction (`CategoryData.refill`), and the config owners (not stored) keep `owner`.
// - The event log keeps its keep-tier events (audit-like records: money posted, identity changes,
//   redactions, artifacts) when it is wiped, unless the category they record is wiped too
//   (`TablePart.spare`, `CategoryData.keptEvents`): deleting the chat history no longer takes the
//   record of a coin posting with it, a factory reset still takes everything.

import type { JsonObject, JsonValue, ProfileId, Timestamp } from "@miyoria/types";
import { StoreError } from "./common.js";
import type { PersonPrefs } from "./identity/schema.js";
import { type ExportColumn, exportValue } from "./profile-data.js";
import type { RoleDefinition } from "./records.js";

/** Settings profile of node-wide settings (`arbiter:state`, `queue:state`, ...). */
export const GLOBAL_SETTINGS_PROFILE: ProfileId = "_global";

export type DataCategoryId =
  | "memories"
  | "relationships"
  | "call_names"
  | "inner"
  | "knowledge"
  | "learning"
  | "conversation"
  | "mood"
  | "messages"
  | "decisions"
  | "event_log"
  | "directives"
  | "initiative"
  | "artifacts"
  | "people"
  | "channels"
  | "voice_consent"
  | "privacy"
  | "queue"
  | "roles"
  | "persona"
  | "proposed_tools"
  | "extensions"
  | "module_state"
  | "other_settings"
  | "audit"
  | "llm_usage"
  | "panel_sessions";

/** A table, or the rows of a table that belong to the profile. */
export interface TablePart {
  kind: "table";
  id: string;
  table: string;
  /** `profile`: rows with `profile_id` = the profile; `node`: every row (shared). */
  rows: "profile" | "node";
  /** Column of the "last updated" time, if any. */
  updated: string | null;
  order: string;
  columns: Readonly<Record<string, ExportColumn>>;
  /** Only the rows matching this (a code constant, never input); `null`: every row. */
  where: string | null;
  /** Where the export reads `columns` from (a view over `table`); `null`: `table`. */
  exportFrom: string | null;
  /**
   * Rows a wipe leaves (a code constant), counted and exported all the same, unless a category
   * being wiped claims them (`CategoryData.keptEvents`); `null`: a wipe deletes every row.
   */
  spare: string | null;
}

/**
 * Settings keys (rows of plugin `settings` in `plugin_state`). `profile` says which profile their
 * owners write them under, the profile's (`active`) or `_global` (`global`); both are one key
 * space now.
 */
export interface SettingsPart {
  kind: "settings";
  id: string;
  profile: "active" | "global";
  keys: readonly string[];
  prefixes: readonly string[];
}

/**
 * A `call_name` column (cleared, the row stays): the heart's `heart_person` (node-wide) since
 * phase 4, the old `relationships` (per profile, read-only) before it.
 */
export interface CallNamesPart {
  kind: "call_names";
  id: string;
  table: string;
  rows: "profile" | "node";
}

/** The `WHERE` of a call-names part. */
function callNamesWhere(p: Params, part: CallNamesPart, profile: ProfileId): string {
  const scope = part.rows === "profile" ? `profile_id = ${p.add(profile)} AND ` : "";
  return `${scope}call_name IS NOT NULL`;
}

/** Settings keys that no other part covers. */
export interface OtherSettingsPart {
  kind: "other_settings";
  id: string;
}

/** One entry of `persons.prefs` (cleared, the person stays). */
export interface PrefsPart {
  kind: "prefs";
  id: string;
  key: keyof PersonPrefs;
}

/**
 * The modules' `enabled` flags in the current config revision (`config/revisions.ts`). Cleared by
 * writing the next revision without them (`ConfigModuleState.clear`), not by a statement; earlier
 * revisions keep theirs, as config history.
 */
export interface ModuleFlagsPart {
  kind: "module_flags";
  id: string;
}

export type DataPart =
  | TablePart
  | SettingsPart
  | CallNamesPart
  | OtherSettingsPart
  | PrefsPart
  | ModuleFlagsPart;

/** Parts that clear a column of rows another part may delete; they run first. */
function clears(part: DataPart): boolean {
  return part.kind === "call_names" || part.kind === "prefs";
}

export interface DataCategory {
  id: DataCategoryId;
  /** The parts the declarations of a store's schemas give it, in declaration order. */
  parts: readonly DataPart[];
  /** Deleting this category also deletes these (their data would point at nothing). */
  requires: readonly DataCategoryId[];
  /**
   * Modules caching this data: stopped around a delete (so a module saving its state on stop
   * cannot write the deleted state back) and started again afterwards.
   */
  modules: readonly string[];
  /** Shared by every profile on this node (people, roles, ...). */
  shared: boolean;
  /** Deleting needs the profile id typed (`typed`) or one confirmation (`simple`). */
  confirm: "typed" | "simple";
  /** Never deleted (read and export only). */
  kept: boolean;
  /** Never exported (secrets or hashes). */
  exportable: boolean;
}

/** A category of the catalog: everything but its parts. */
export type CategorySpec = Omit<DataCategory, "parts">;

/**
 * What a schema declares for one category: the parts its tables hold, and how they are read and
 * deleted beyond what a part says by itself.
 */
export interface CategoryData {
  category: DataCategoryId;
  parts: readonly DataPart[];
  /** Counts by a sub-kind for the inventory (memories by `kind`): rows `{ kind, n }`. */
  breakdown?: Stmt;
  /**
   * The keep-tier events that record this category's rows (a `WHERE` over `events`, a code
   * constant): a wipe of the event log deletes them only when this category is wiped too.
   */
  keptEvents?: string;
  /** Statements run after the wipe's deletes when this category is wiped, in its transaction. */
  refill?(d: SqlDialect, options: WipeOptions): Stmt[];
}

function spec(id: DataCategoryId, options: Partial<Omit<CategorySpec, "id">> = {}): CategorySpec {
  return {
    id,
    requires: options.requires ?? [],
    modules: options.modules ?? [],
    shared: options.shared ?? false,
    confirm: options.confirm ?? "typed",
    kept: options.kept ?? false,
    exportable: options.exportable ?? true,
  };
}

/**
 * Every category, in display order. Which schema holds what is in the declarations: the store's
 * own in `categories.ts` and the folders it names, the plugins' in their `tables.ts`.
 */
export const CATEGORY_SPECS: readonly CategorySpec[] = [
  // The memory plugin's records, and its maintenance time (a settings key).
  spec("memories", { modules: ["memory", "arbiter"] }),
  // Relationships with their changes and member cards (`legacy`), and the economy plugin's tables:
  // coins come from being with her; the wallet goes with the relationship, not with a forget.
  spec("relationships", { modules: ["heart", "agent"] }),
  spec("call_names", { modules: ["heart", "agent"], confirm: "simple" }),
  // Her inner state, feelings and thoughts (settings keys).
  spec("inner", { modules: ["self", "mind"] }),
  spec("knowledge", { modules: ["knowledge"] }),
  spec("learning", { modules: ["reflect"], confirm: "simple" }),
  spec("conversation", { modules: ["conversation"], confirm: "simple" }),
  spec("mood", { modules: ["mood"], confirm: "simple" }),
  // Her conversation notes are made from the log, and the event log repeats what people said:
  // they go with it.
  spec("messages", { requires: ["conversation", "event_log"], modules: ["memory", "agent"] }),
  spec("decisions", { confirm: "simple" }),
  // The owner's rules: deleting them lifts every rule at once, so the profile id has to be typed.
  spec("directives", { modules: ["directive"] }),
  spec("event_log", { modules: ["facts"], confirm: "simple" }),
  spec("initiative", { modules: ["arbiter"], confirm: "simple" }),
  spec("artifacts"),
  spec("people", {
    // Relationships, feelings, documents, lessons and feedback are keyed by person; artifacts
    // name the person they were made for and the place they were made in.
    requires: ["relationships", "call_names", "inner", "knowledge", "learning", "artifacts"],
    modules: ["heart", "agent", "world", "memory"],
    shared: true,
  }),
  spec("channels", { confirm: "simple" }),
  spec("voice_consent", { shared: true }),
  spec("privacy", { modules: ["world"], shared: true }),
  spec("queue", { modules: ["queue"], shared: true, confirm: "simple" }),
  spec("roles", { shared: true }),
  spec("persona"),
  spec("proposed_tools", { modules: ["sandbox"] }),
  spec("extensions"),
  spec("module_state", { shared: true, confirm: "simple" }),
  spec("other_settings"),
  spec("audit", { shared: true, kept: true }),
  spec("llm_usage", { shared: true, kept: true }),
  spec("panel_sessions", { shared: true, kept: true, exportable: false }),
];

const SPECS = new Map(CATEGORY_SPECS.map((c) => [c.id, c]));

export function isDataCategoryId(id: string): id is DataCategoryId {
  return SPECS.has(id as DataCategoryId);
}

function categorySpec(id: DataCategoryId): CategorySpec {
  const found = SPECS.get(id);
  if (!found) throw new StoreError(`unknown data category \`${id}\``);
  return found;
}

/** Every category a factory reset deletes (everything but the kept ones). */
export const RESET_CATEGORIES: readonly DataCategoryId[] = CATEGORY_SPECS.filter(
  (c) => !c.kept,
).map((c) => c.id);

/**
 * `ids` plus what they require (transitively), in catalog order. Kept categories are refused.
 */
export function resolveCategories(ids: Iterable<DataCategoryId>): DataCategoryId[] {
  const want = new Set<DataCategoryId>();
  const add = (id: DataCategoryId) => {
    if (want.has(id)) return;
    const c = categorySpec(id);
    if (c.kept) throw new StoreError(`data category \`${id}\` is kept and cannot be deleted`);
    want.add(id);
    for (const r of c.requires) add(r);
  };
  for (const id of ids) add(id);
  return CATEGORY_SPECS.filter((c) => want.has(c.id)).map((c) => c.id);
}

/** Modules to stop around deleting `ids`, in catalog order, without duplicates. */
export function categoryModules(ids: Iterable<DataCategoryId>): string[] {
  const set = new Set(ids);
  const out: string[] = [];
  for (const c of CATEGORY_SPECS) {
    if (!set.has(c.id)) continue;
    for (const m of c.modules) if (!out.includes(m)) out.push(m);
  }
  return out;
}

/** Exportable categories among `ids` (kept ones included, panel sessions not). */
export function exportCategories(ids: Iterable<DataCategoryId>): DataCategoryId[] {
  const set = new Set(ids);
  return CATEGORY_SPECS.filter((c) => set.has(c.id) && c.exportable).map((c) => c.id);
}

// ---- declaring parts -------------------------------------------------------------------------

/** A table part (`TablePart`); the options default to every row, exported from the table. */
export function tablePart(
  id: string,
  name: string,
  rows: TablePart["rows"],
  updated: string | null,
  order: string,
  columns: Record<string, ExportColumn>,
  options: { where?: string; exportFrom?: string; spare?: string } = {},
): TablePart {
  return {
    kind: "table",
    id,
    table: name,
    rows,
    updated,
    order,
    columns,
    where: options.where ?? null,
    exportFrom: options.exportFrom ?? null,
    spare: options.spare ?? null,
  };
}

export function settingsPart(
  id: string,
  profile: SettingsPart["profile"],
  keys: string[],
  prefixes: string[] = [],
): SettingsPart {
  return { kind: "settings", id, profile, keys, prefixes };
}

export function prefsPart(id: string, key: PrefsPart["key"]): PrefsPart {
  return { kind: "prefs", id, key };
}

// ---- results ------------------------------------------------------------------------------

export interface PartInventory {
  id: string;
  count: number;
  updated_at: Timestamp | null;
}

export interface CategoryInventory {
  id: DataCategoryId;
  count: number;
  updated_at: Timestamp | null;
  parts: PartInventory[];
  /** Counts by a sub-kind (memories by `kind`). */
  breakdown: Record<string, number> | null;
}

export interface DataInventory {
  profile: ProfileId;
  at: Timestamp;
  categories: CategoryInventory[];
}

/**
 * A backup: the rows of each part, as plain JSON. Settings rows are `{profile_id, key, value,
 * updated_at}`, `profile_id` the profile the backup was made for.
 */
export interface DataExport {
  format: typeof DATA_EXPORT_FORMAT;
  version: 1;
  profile: ProfileId;
  exported_at: Timestamp;
  categories: DataCategoryId[];
  /** Rows per part. */
  parts: Record<string, JsonObject[]>;
}

export const DATA_EXPORT_FORMAT = "miyoria.data";

/** Rows removed (or, for `call_names`, cleared) per part. */
export type WipeCounts = Record<string, number>;

export interface WipeOptions {
  /** Written after the `roles` tables are cleared, in the same transaction. */
  seedRoles?: readonly RoleDefinition[];
}

// ---- SQL ----------------------------------------------------------------------------------

/** SQL fragments the statement builders below use. SQL uses `$1`-style placeholders. */
export interface SqlDialect {
  /** `column` starts with the text parameter `param` (case-sensitive, `%` / `_` literal). */
  startsWith(column: string, param: string): string;
  /** A JSON column as JSON text. */
  jsonText(column: string): string;
  /** `ORDER BY` of settings keys (byte order). */
  keyOrder: string;
  /** A `grants` / `denies` value. */
  list(values: readonly string[]): unknown;
  bool(value: boolean): unknown;
}

export interface Stmt {
  sql: string;
  params: unknown[];
}

class Params {
  readonly values: unknown[] = [];
  add(value: unknown): string {
    this.values.push(value);
    return `$${this.values.length}`;
  }
}

/** Settings rows matching keys / prefixes. */
function selectorSql(
  d: SqlDialect,
  p: Params,
  keys: readonly string[],
  prefixes: readonly string[],
): string {
  const terms = [
    ...keys.map((k) => `key = ${p.add(k)}`),
    ...prefixes.map((x) => d.startsWith("key", p.add(x))),
  ];
  return terms.length === 0 ? "FALSE" : `(${terms.join(" OR ")})`;
}

/** The settings rows of `plugin_state` (`config/state.ts` `SETTINGS_PLUGIN`). */
const SETTINGS_ROWS = "plugin = 'settings'";

function settingsPartWhere(d: SqlDialect, p: Params, part: SettingsPart) {
  return `${SETTINGS_ROWS} AND ${selectorSql(d, p, part.keys, part.prefixes)}`;
}

/** What a statement builder needs besides the part. */
interface PartScope {
  d: SqlDialect;
  profile: ProfileId;
  /** Every settings part of the registry: `other_settings` is what none of them claims. */
  claimed: readonly SettingsPart[];
}

/** Settings rows no settings part claims. */
function otherSettingsWhere(s: PartScope, p: Params): string {
  const known = selectorSql(
    s.d,
    p,
    s.claimed.flatMap((x) => x.keys),
    s.claimed.flatMap((x) => x.prefixes),
  );
  return `${SETTINGS_ROWS} AND NOT ${known}`;
}

function tableWhere(p: Params, part: TablePart, profile: ProfileId, extra: string[] = []): string {
  const terms = [
    ...(part.rows === "profile" ? [`profile_id = ${p.add(profile)}`] : []),
    ...(part.where === null ? [] : [`(${part.where})`]),
    ...extra,
  ];
  return terms.length === 0 ? "" : `WHERE ${terms.join(" AND ")}`;
}

/**
 * The modules of the current config revision that carry an `enabled` flag: `FROM ... WHERE ...`
 * with `module_id`, `enabled` and the revision's `created_at`.
 */
const MODULE_FLAGS =
  "FROM (SELECT key AS module_id, json_extract(value, '$.enabled') AS enabled, created_at, " +
  "CASE WHEN type = 'object' THEN json_type(value, '$.enabled') END AS flag " +
  "FROM (SELECT doc, created_at FROM config_revisions ORDER BY version DESC LIMIT 1), " +
  "json_each(doc, '$.modules')) WHERE flag IN ('true', 'false')";

/** `persons` rows that hold entry `key` of `prefs` (a code constant, never input). */
function prefsWhere(part: PrefsPart): string {
  return `json_type(prefs, '$.${part.key}') IS NOT NULL`;
}

/** Count and last update of a part: one row `{ n, at }`. */
function countStmt(s: PartScope, part: DataPart): Stmt {
  const p = new Params();
  switch (part.kind) {
    case "table": {
      const at = part.updated === null ? "NULL" : `MAX(${part.updated})`;
      const sql = `SELECT COUNT(*) AS n, ${at} AS at FROM ${part.table} ${tableWhere(p, part, s.profile)}`;
      return { sql, params: p.values };
    }
    case "settings":
      return {
        sql: `SELECT COUNT(*) AS n, MAX(updated_at) AS at FROM plugin_state WHERE ${settingsPartWhere(s.d, p, part)}`,
        params: p.values,
      };
    case "call_names":
      return {
        sql: `SELECT COUNT(*) AS n, MAX(updated_at) AS at FROM ${part.table} WHERE ${callNamesWhere(p, part, s.profile)}`,
        params: p.values,
      };
    case "other_settings":
      return {
        sql: `SELECT COUNT(*) AS n, MAX(updated_at) AS at FROM plugin_state WHERE ${otherSettingsWhere(s, p)}`,
        params: p.values,
      };
    case "prefs":
      return {
        sql: `SELECT COUNT(*) AS n, NULL AS at FROM persons WHERE ${prefsWhere(part)}`,
        params: [],
      };
    case "module_flags":
      return { sql: `SELECT COUNT(*) AS n, MAX(created_at) AS at ${MODULE_FLAGS}`, params: [] };
  }
}

const SETTINGS_COLUMNS: Record<string, ExportColumn> = {
  profile_id: "text",
  key: "text",
  value: "json",
  updated_at: "ts",
};

/** Columns of a part's exported rows. */
export function exportSpec(part: DataPart): Readonly<Record<string, ExportColumn>> {
  switch (part.kind) {
    case "table":
      return part.columns;
    case "call_names":
      return { person_id: "text", call_name: "text" };
    case "prefs":
      return { person_id: "text", value: "json" };
    case "module_flags":
      return { module_id: "text", enabled: "bool", updated_at: "ts" };
    case "settings":
    case "other_settings":
      return SETTINGS_COLUMNS;
  }
}

/** The rows of a part, with `exportSpec(part)` columns. */
function exportStmt(s: PartScope, part: DataPart): Stmt {
  const { d, profile } = s;
  const p = new Params();
  // One database is one character: every settings row is exported as the profile's.
  const settingsSelect = () =>
    `SELECT ${p.add(profile)} AS profile_id, key, ${d.jsonText("value")} AS value, updated_at FROM plugin_state`;
  switch (part.kind) {
    case "table": {
      const cols = Object.keys(part.columns)
        .map((c) => (part.columns[c] === "json" ? `${d.jsonText(c)} AS ${c}` : c))
        .join(", ");
      const from = part.exportFrom ?? part.table;
      const sql = `SELECT ${cols} FROM ${from} ${tableWhere(p, part, profile)} ORDER BY ${part.order}`;
      return { sql, params: p.values };
    }
    case "settings":
      return {
        sql: `${settingsSelect()} WHERE ${settingsPartWhere(d, p, part)} ORDER BY ${d.keyOrder}`,
        params: p.values,
      };
    case "call_names":
      return {
        sql: `SELECT person_id, call_name FROM ${part.table} WHERE ${callNamesWhere(p, part, profile)} ORDER BY person_id`,
        params: p.values,
      };
    case "other_settings":
      return {
        sql: `${settingsSelect()} WHERE ${otherSettingsWhere(s, p)} ORDER BY ${d.keyOrder}`,
        params: p.values,
      };
    case "prefs":
      return {
        sql: `SELECT id AS person_id, prefs -> '$.${part.key}' AS value FROM persons WHERE ${prefsWhere(part)} ORDER BY id`,
        params: [],
      };
    case "module_flags":
      return {
        sql: `SELECT module_id, enabled, created_at AS updated_at ${MODULE_FLAGS} ORDER BY module_id`,
        params: [],
      };
  }
}

/**
 * What deletes (or clears) a part; its row count is the part's count. `null` for the module
 * flags, which the store clears in code (`ModuleFlagsPart`). `claimed` is what the categories
 * being wiped claim of the part's `spare` rows (`FALSE`: nothing).
 */
function deleteStmt(s: PartScope, part: DataPart, claimed: string): Stmt | null {
  const { d, profile } = s;
  const p = new Params();
  switch (part.kind) {
    case "module_flags":
      return null;
    case "table": {
      const spared = part.spare === null ? [] : [`NOT ((${part.spare}) AND NOT (${claimed}))`];
      return {
        sql: `DELETE FROM ${part.table} ${tableWhere(p, part, profile, spared)}`,
        params: p.values,
      };
    }
    case "settings":
      return {
        sql: `DELETE FROM plugin_state WHERE ${settingsPartWhere(d, p, part)}`,
        params: p.values,
      };
    case "call_names":
      return {
        sql: `UPDATE ${part.table} SET call_name = NULL WHERE ${callNamesWhere(p, part, profile)}`,
        params: p.values,
      };
    case "other_settings":
      return {
        sql: `DELETE FROM plugin_state WHERE ${otherSettingsWhere(s, p)}`,
        params: p.values,
      };
    case "prefs":
      return {
        sql: `UPDATE persons SET prefs = json_remove(prefs, '$.${part.key}') WHERE ${prefsWhere(part)}`,
        params: [],
      };
  }
}

/** One `{ n, at }` row as a part's inventory. */
export function partInventory(id: string, row: Record<string, unknown> | undefined): PartInventory {
  const at = row?.at;
  return {
    id,
    count: Number(row?.n ?? 0),
    updated_at: at === null || at === undefined ? null : (exportValue("ts", at) as Timestamp),
  };
}

/** Sums parts into a category's inventory. */
export function categoryInventory(
  category: Pick<DataCategory, "id">,
  parts: PartInventory[],
  breakdown: Record<string, number> | null = null,
): CategoryInventory {
  let updated: Timestamp | null = null;
  for (const part of parts) {
    if (part.updated_at !== null && (updated === null || part.updated_at > updated)) {
      updated = part.updated_at;
    }
  }
  return {
    id: category.id,
    count: parts.reduce((n, x) => n + x.count, 0),
    updated_at: updated,
    parts,
    breakdown,
  };
}

/** A row of a part as plain JSON. */
export function exportPartRow(part: DataPart, row: Record<string, unknown>): JsonObject {
  const out: JsonObject = {};
  for (const [column, kind] of Object.entries(exportSpec(part))) {
    out[column] = exportValue(kind, row[column]) as JsonValue;
  }
  return out;
}

/** Adds one statement's row count to its part. */
export function addCount(counts: WipeCounts, part: string | null, n: number): void {
  if (part === null) return;
  counts[part] = (counts[part] ?? 0) + n;
}

export type RunQuery = (stmt: Stmt) => Promise<Record<string, unknown>[]>;

/** A step of a wipe: its statement and the part it counts toward (`null`: not counted). */
export interface WipeStep {
  part: string | null;
  /** `null`: the module flags' part, which the store clears in code. */
  stmt: Stmt | null;
}

// ---- the registry ---------------------------------------------------------------------------

/**
 * The categories as the declarations of a store's schemas make them up: every category of the
 * catalog, with the parts the declarations give it (none, for a category whose schemas are not
 * installed).
 */
export class DataRegistry {
  /** Every category, in catalog order. */
  readonly categories: readonly DataCategory[];
  readonly #declarations: readonly CategoryData[];
  readonly #byId: ReadonlyMap<DataCategoryId, DataCategory>;
  readonly #settings: readonly SettingsPart[];

  /** `declarations` in order; a category's parts are in the order they are declared. */
  constructor(declarations: readonly CategoryData[]) {
    const parts = new Map<DataCategoryId, DataPart[]>();
    const ids = new Set<string>();
    for (const declared of declarations) {
      categorySpec(declared.category);
      for (const part of declared.parts) {
        if (ids.has(part.id)) throw new StoreError(`data part \`${part.id}\` is declared twice`);
        ids.add(part.id);
      }
      parts.set(declared.category, [...(parts.get(declared.category) ?? []), ...declared.parts]);
    }
    this.#declarations = [...declarations];
    this.categories = CATEGORY_SPECS.map((c) => ({ ...c, parts: parts.get(c.id) ?? [] }));
    this.#byId = new Map(this.categories.map((c) => [c.id, c]));
    this.#settings = this.categories
      .flatMap((c) => c.parts)
      .filter((x): x is SettingsPart => x.kind === "settings");
  }

  category(id: DataCategoryId): DataCategory {
    const found = this.#byId.get(id);
    if (!found) throw new StoreError(`unknown data category \`${id}\``);
    return found;
  }

  #scope(d: SqlDialect, profile: ProfileId): PartScope {
    return { d, profile, claimed: this.#settings };
  }

  async inventory(
    d: SqlDialect,
    query: RunQuery,
    profile: ProfileId,
    now: Timestamp,
  ): Promise<DataInventory> {
    const s = this.#scope(d, profile);
    const categories: CategoryInventory[] = [];
    for (const c of this.categories) {
      const parts: PartInventory[] = [];
      for (const part of c.parts) {
        parts.push(partInventory(part.id, (await query(countStmt(s, part)))[0]));
      }
      let breakdown: Record<string, number> | null = null;
      for (const declared of this.#declarations) {
        if (declared.category !== c.id || declared.breakdown === undefined) continue;
        breakdown ??= {};
        for (const row of await query(declared.breakdown)) {
          const kind = String(row.kind);
          breakdown[kind] = (breakdown[kind] ?? 0) + Number(row.n);
        }
      }
      categories.push(categoryInventory(c, parts, breakdown));
    }
    return { profile, at: now, categories };
  }

  async export(
    d: SqlDialect,
    query: RunQuery,
    profile: ProfileId,
    ids: readonly DataCategoryId[],
    now: Timestamp,
  ): Promise<DataExport> {
    for (const id of ids) this.category(id);
    const s = this.#scope(d, profile);
    const categories = exportCategories(ids);
    const parts: Record<string, JsonObject[]> = {};
    for (const id of categories) {
      for (const part of this.category(id).parts) {
        const rows = await query(exportStmt(s, part));
        parts[part.id] = rows.map((row) => exportPartRow(part, row));
      }
    }
    return {
      format: DATA_EXPORT_FORMAT,
      version: 1,
      profile,
      exported_at: now,
      categories,
      parts,
    };
  }

  /**
   * The statements of a wipe of `ids` and what they require, in order. Clearing categories come
   * first (`call_names`, a person's choices): they clear a column of rows another category may
   * delete next (`relationships`, `people`). `people` last: other categories' rows name its
   * accounts and spaces, and a plugin's go with them (role assignments), which would leave those
   * categories nothing to count. Then each wiped category's `refill`. A part's `spare` rows stay
   * unless a wiped category claims them.
   */
  wipeStatements(
    d: SqlDialect,
    profile: ProfileId,
    ids: readonly DataCategoryId[],
    options: WipeOptions = {},
  ): WipeStep[] {
    const s = this.#scope(d, profile);
    const resolved = resolveCategories(ids);
    const set = new Set(resolved);
    const wiped = this.#declarations.filter((x) => set.has(x.category));
    const kept = wiped.flatMap((x) => (x.keptEvents === undefined ? [] : [`(${x.keptEvents})`]));
    const claimed = kept.length === 0 ? "FALSE" : kept.join(" OR ");
    const rank = (id: DataCategoryId) =>
      this.category(id).parts.some(clears) ? 0 : id === "people" ? 2 : 1;
    const ordered = [...resolved].sort((a, b) => rank(a) - rank(b));
    const out: WipeStep[] = [];
    for (const id of ordered) {
      for (const part of this.category(id).parts) {
        out.push({ part: part.id, stmt: deleteStmt(s, part, claimed) });
      }
    }
    for (const declared of wiped) {
      for (const stmt of declared.refill?.(d, options) ?? []) out.push({ part: null, stmt });
    }
    return out;
  }
}
