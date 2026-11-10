// Data categories: every kind of data the store holds for a profile, which tables / settings
// keys make it up, and the SQL to count, export and delete it. One definition, shared by the
// panel's data page (`/api/data/*`), the Discord `/admin memory wipe` and the factory reset.
//
// Settings keys belong to other packages; they are repeated here as strings (the store cannot
// depend on the modules), and `@miyoria/api`'s tests check them against the owners' constants.
//
// Invariants kept by the shape of the registry:
// - Consolidation watermarks (`memory_watermark:*`) exist only inside `messages`, so they are
//   never deleted without the log they point into (otherwise the log would be extracted into
//   memories again).
// - The audit log, LLM usage and panel sessions are `kept`: never deleted, also not by a reset.
// - `roles` is reset, not emptied: the built-in roles are written again in the same
//   transaction, and the config owners (not stored) keep `owner`.

import type { JsonObject, JsonValue, ProfileId, Timestamp } from "@miyoria/types";
import { StoreError } from "./common.js";
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
}

/** Settings keys of the profile (`active`) or of `_global` (`global`). */
export interface SettingsPart {
  kind: "settings";
  id: string;
  profile: "active" | "global";
  keys: readonly string[];
  prefixes: readonly string[];
}

/** `relationships.call_name` (cleared, the relationship stays). */
export interface CallNamesPart {
  kind: "call_names";
  id: string;
}

/** Settings of the profile and of `_global` that no other part covers. */
export interface OtherSettingsPart {
  kind: "other_settings";
  id: string;
}

export type DataPart = TablePart | SettingsPart | CallNamesPart | OtherSettingsPart;

export interface DataCategory {
  id: DataCategoryId;
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

const MEMORY_COLUMNS = {
  id: "text",
  kind: "text",
  scope: "json",
  subjects: "json",
  content: "text",
  importance: "num",
  confidence: "num",
  created_at: "ts",
  updated_at: "ts",
  last_accessed: "ts",
  access_count: "num",
  source_context: "json",
  source: "json",
  origin: "text",
  source_events: "json",
  due: "ts",
  done: "bool",
  superseded_by: "text",
} as const satisfies Record<string, ExportColumn>;

const RELATIONSHIP_COLUMNS = {
  person_id: "text",
  affinity: "num",
  trust: "num",
  familiarity: "num",
  tags: "json",
  notes: "text",
  call_name: "text",
  interactions: "num",
  last_interaction: "ts",
  updated_at: "ts",
} as const satisfies Record<string, ExportColumn>;

function table(
  id: string,
  name: string,
  rows: TablePart["rows"],
  updated: string | null,
  order: string,
  columns: Record<string, ExportColumn>,
): TablePart {
  return { kind: "table", id, table: name, rows, updated, order, columns };
}

function settings(
  id: string,
  profile: SettingsPart["profile"],
  keys: string[],
  prefixes: string[] = [],
): SettingsPart {
  return { kind: "settings", id, profile, keys, prefixes };
}

function category(
  id: DataCategoryId,
  parts: DataPart[],
  options: Partial<Omit<DataCategory, "id" | "parts">> = {},
): DataCategory {
  return {
    id,
    parts,
    requires: options.requires ?? [],
    modules: options.modules ?? [],
    shared: options.shared ?? false,
    confirm: options.confirm ?? "typed",
    kept: options.kept ?? false,
    exportable: options.exportable ?? true,
  };
}

/** Every category, in display order. */
export const DATA_CATEGORIES: readonly DataCategory[] = [
  category(
    "memories",
    [
      table("memory_records", "memory_records", "profile", "updated_at", "created_at, id", {
        ...MEMORY_COLUMNS,
      }),
      // @miyoria/memory `MAINTENANCE_KEY`
      settings("memory_maintenance", "active", ["memory_maintenance_last"]),
    ],
    { modules: ["memory", "arbiter"] },
  ),
  category(
    "relationships",
    [
      table("relationships", "relationships", "profile", "updated_at", "person_id", {
        ...RELATIONSHIP_COLUMNS,
      }),
      table("relationship_deltas", "relationship_deltas", "profile", "at", "seq", {
        person_id: "text",
        at: "ts",
        affinity: "num",
        trust: "num",
        familiarity: "num",
        reason: "text",
      }),
      // The member page's cards are snapshots of the relationship; they go with it.
      table("member_cards", "member_cards", "profile", "issued_at", "issued_at, serial", {
        serial: "text",
        author_platform: "text",
        author_id: "text",
        person_id: "text",
        issued_at: "ts",
        snapshot: "json",
      }),
      // Coins come from being with her; the wallet goes with the relationship, not with a forget.
      table("coin_ledger", "coin_ledger", "profile", "ts", "ts, id", {
        id: "text",
        author_platform: "text",
        author_id: "text",
        delta: "num",
        reason: "text",
        ref: "text",
        idem_key: "text",
        ts: "ts",
      }),
      table("coin_wallets", "coin_wallets", "profile", "updated_at", "author_platform, author_id", {
        author_platform: "text",
        author_id: "text",
        frame: "text",
        on_board: "bool",
        off_board: "bool",
        updated_at: "ts",
      }),
      // The fortune slips she wrote for them, kept like their cards.
      table("fortunes", "fortunes", "profile", "issued_at", "issued_at, id", {
        id: "text",
        author_platform: "text",
        author_id: "text",
        person_id: "text",
        day: "num",
        issued_at: "ts",
        entry_id: "text",
        slip: "json",
      }),
      // Deals are promises between her and a member, kept like the wallet.
      table("deals", "deals", "profile", "created_at", "created_at, id", {
        id: "text",
        author_platform: "text",
        author_id: "text",
        reward_item: "text",
        reward_count: "num",
        reward_value: "num",
        task: "text",
        prepaid: "bool",
        escrow_entry: "text",
        status: "text",
        created_at: "ts",
        done_at: "ts",
        due_at: "ts",
        closed_at: "ts",
      }),
      // Her crowdfunding goals, the pledges to them and the bounties from her purse.
      table("goals", "goals", "profile", "created_at", "created_at, id", {
        id: "text",
        title: "text",
        promise: "text",
        target: "num",
        status: "text",
        created_at: "ts",
        deadline: "ts",
        closed_at: "ts",
      }),
      table("goal_pledges", "goal_pledges", "profile", "created_at", "created_at, id", {
        id: "text",
        goal_id: "text",
        author_platform: "text",
        author_id: "text",
        amount: "num",
        created_at: "ts",
      }),
      table("bounties", "bounties", "profile", "created_at", "created_at, id", {
        id: "text",
        task: "text",
        reward: "num",
        hold_entry: "text",
        status: "text",
        created_at: "ts",
        expires_at: "ts",
        closed_at: "ts",
        winner_platform: "text",
        winner_id: "text",
      }),
    ],
    { modules: ["social", "agent"] },
  ),
  category("call_names", [{ kind: "call_names", id: "call_names" }], {
    modules: ["social", "agent"],
    confirm: "simple",
  }),
  category(
    "inner",
    // @miyoria/self `STATE_KEY`, `FEELING_PREFIX`; @miyoria/mind's thought journal and its
    // digests (`THOUGHT_PREFIX`, `DIGEST_PREFIX`), her goals and plan state (`GOAL_PREFIX`,
    // `GOAL_MIGRATION_KEY` and `PLAN_STATE_KEY` under `mind:plan:`)
    [
      settings("self_state", "active", ["self:state"]),
      settings("self_feelings", "active", [], ["self:feeling:"]),
      settings("self_cards_migration", "active", ["self:cards:migration"]),
      settings("mind_thoughts", "active", [], ["mind:thought:"]),
      settings("mind_digests", "active", [], ["mind:digest:"]),
      settings("mind_goals", "active", [], ["mind:goal:", "mind:plan:"]),
    ],
    { modules: ["self", "mind"] },
  ),
  // @miyoria/learning `DOC_PREFIX`: her self-organized documents, whatever their shape.
  category("knowledge", [settings("knowledge_docs", "active", [], ["knowledge:doc:"])], {
    modules: ["knowledge"],
  }),
  // @miyoria/learning `LESSON_PREFIX`, `RUN_PREFIX`, `REFLECT_STATE_KEY`, `FEEDBACK_PREFIX`
  category(
    "learning",
    [
      settings("lessons", "active", [], ["reflect:lesson:"]),
      settings("reflections", "active", ["reflect:state"], ["reflect:run:"]),
      settings("feedback", "active", [], ["feedback:day:"]),
    ],
    { modules: ["reflect"], confirm: "simple" },
  ),
  // @miyoria/learning `STATE_PREFIX`: her running notes on each conversation (from the log).
  category(
    "conversation",
    [settings("conversation_states", "active", [], ["conversation:state:"])],
    {
      modules: ["conversation"],
      confirm: "simple",
    },
  ),
  // @miyoria/social `mood.ts` `SETTINGS_KEY`
  category("mood", [settings("mood", "active", ["mood:last"])], {
    modules: ["mood"],
    confirm: "simple",
  }),
  category(
    "messages",
    [
      table("message_log", "message_log", "profile", "ts", "seq", {
        id: "text",
        platform: "text",
        scope: "text",
        channel: "text",
        kind: "text",
        author_platform: "text",
        author_id: "text",
        author_name: "text",
        text: "text",
        is_self: "bool",
        ts: "ts",
        turn_id: "text",
      }),
      // @miyoria/memory `WATERMARK_PREFIX`: only ever together with the log.
      settings("memory_watermarks", "active", [], ["memory_watermark:"]),
    ],
    // Her conversation notes are made from the log, and the EventLog repeats what people said:
    // they go with it.
    { requires: ["conversation", "event_log"], modules: ["memory", "agent"] },
  ),
  category(
    "decisions",
    [
      table("decision_log", "decision_log", "profile", "ts", "ts, id", {
        id: "text",
        ts: "ts",
        trace: "json",
      }),
      table("turn_outcomes", "turn_outcomes", "profile", "ts", "ts, id", {
        id: "text",
        ts: "ts",
        outcome: "text",
        record: "json",
      }),
    ],
    { confirm: "simple" },
  ),
  // The owner's rules. Deleting them lifts every rule at once, so the profile id has to be typed.
  category(
    "directives",
    [
      table("directives", "directives", "profile", "created_at", "created_at, id", {
        id: "text",
        issuer: "json",
        authority: "text",
        scope: "json",
        effect: "text",
        text: "text",
        expires: "ts",
        source_event: "text",
        created_at: "ts",
        revoked_at: "ts",
        revoked_by: "text",
      }),
    ],
    { modules: ["directive"] },
  ),
  // The V3 EventLog: what she perceived, decided and said, and the counts of what was compacted.
  category(
    "event_log",
    [
      table("log_events", "log_events", "profile", "at", "seq", {
        id: "text",
        at: "ts",
        kind: "text",
        source: "text",
        cause: "text",
        context: "json",
        person: "text",
        attention_key: "text",
        salience: "text",
        body: "json",
      }),
      table("log_event_rollups", "log_event_rollups", "profile", "last_at", "day, kind, source", {
        day: "ts",
        kind: "text",
        source: "text",
        count: "num",
        first_at: "ts",
        last_at: "ts",
      }),
    ],
    { modules: ["facts"], confirm: "simple" },
  ),
  // @miyoria/arbiter `STATE_KEY` under `STATE_PROFILE` (her ledger: counters, backoff, topics,
  // greetings), and the old @miyoria/initiative state it replaced
  category(
    "initiative",
    [settings("initiative", "global", ["arbiter:state", "initiative:state"])],
    {
      modules: ["arbiter"],
      confirm: "simple",
    },
  ),
  category(
    "people",
    [
      table("accounts", "accounts", "node", "last_seen", "person_id, platform, account_id", {
        platform: "text",
        account_id: "text",
        person_id: "text",
        display_name: "text",
        first_seen: "ts",
        last_seen: "ts",
      }),
      table("people", "people", "node", "created_at", "created_at, id", {
        id: "text",
        display_name: "text",
        created_at: "ts",
      }),
      table("link_codes", "link_codes", "node", null, "code", {
        code: "text",
        platform: "text",
        account_id: "text",
        expires_at: "ts",
      }),
      // @miyoria/store `HANDLE_PREFIX` under `GLOBAL_SETTINGS_PROFILE`: the stable names of people.
      settings("handles", "global", [], ["handle:"]),
    ],
    {
      // Relationships, feelings, documents, lessons and feedback are keyed by person.
      requires: ["relationships", "call_names", "inner", "knowledge", "learning"],
      modules: ["social", "agent", "world", "memory"],
      shared: true,
    },
  ),
  category(
    "channels",
    // @miyoria/agent `MODE_PREFIX`, `ACTIVENESS_PREFIX`
    [
      settings("channel_modes", "active", [], ["channel_mode:"]),
      settings("channel_activeness", "active", [], ["activeness:"]),
    ],
    { confirm: "simple" },
  ),
  // @miyoria/voice `consentKey` under `CONSENT_PROFILE`
  category("voice_consent", [settings("voice_consent", "global", [], ["voice_consent:"])], {
    shared: true,
  }),
  // @miyoria/types `PRIVACY_PREFIX` under `PRIVACY_PROFILE`
  category("privacy", [settings("privacy", "global", [], ["privacy:"])], {
    modules: ["world"],
    shared: true,
  }),
  // @miyoria/queue `STATE_KEY` under `STATE_PROFILE`
  category("queue", [settings("queue", "global", ["queue:state"])], {
    modules: ["queue"],
    shared: true,
    confirm: "simple",
  }),
  category(
    "roles",
    [
      table("roles", "roles", "node", null, "rank DESC, name", {
        name: "text",
        rank: "num",
        grants: "json",
        denies: "json",
        builtin: "bool",
      }),
      table(
        "role_assignments",
        "role_assignments",
        "node",
        "at",
        "at, platform, account_id, role, scope",
        {
          platform: "text",
          account_id: "text",
          role: "text",
          scope: "json",
          granted_by: "text",
          at: "ts",
        },
      ),
      table("role_mappings", "role_mappings", "node", null, "platform, guild, platform_role", {
        platform: "text",
        guild: "text",
        platform_role: "text",
        role: "text",
      }),
      table("node_overrides", "node_overrides", "node", null, "scope, role, node", {
        scope: "json",
        role: "text",
        node: "text",
        allow: "bool",
      }),
    ],
    { shared: true },
  ),
  category("persona", [
    table(
      "persona_overrides",
      "persona_overrides",
      "profile",
      "edited_at",
      "section_key, version",
      {
        section_key: "text",
        version: "num",
        body: "text",
        edited_by: "text",
        edited_at: "ts",
      },
    ),
  ]),
  // @miyoria/sandbox `TOOL_KEY_PREFIX`
  category("proposed_tools", [settings("proposed_tools", "active", [], ["sandbox:tool:"])], {
    modules: ["sandbox"],
  }),
  // @miyoria/ext-host `storageKey`
  category("extensions", [settings("extension_storage", "active", [], ["ext:"])]),
  category(
    "module_state",
    [
      table("module_state", "module_state", "node", "updated_at", "module_id", {
        module_id: "text",
        enabled: "bool",
        updated_at: "ts",
      }),
    ],
    { shared: true, confirm: "simple" },
  ),
  category("other_settings", [{ kind: "other_settings", id: "other_settings" }]),
  category(
    "audit",
    [
      table("audit_log", "audit_log", "node", "at", "at, id", {
        id: "text",
        at: "ts",
        actor: "text",
        action: "text",
        target: "text",
        detail: "json",
        ok: "bool",
      }),
    ],
    { shared: true, kept: true },
  ),
  // @miyoria/llm `USAGE_KEY_PREFIX` under `USAGE_PROFILE`: spending, checked against the budget.
  category("llm_usage", [settings("llm_usage", "global", [], ["llm_usage:"])], {
    shared: true,
    kept: true,
  }),
  // @miyoria/api `STORE_PREFIX` under `STORE_PROFILE`: hashes of login tokens.
  category("panel_sessions", [settings("panel_sessions", "global", [], ["panel_session:"])], {
    shared: true,
    kept: true,
    exportable: false,
  }),
];

const BY_ID = new Map(DATA_CATEGORIES.map((c) => [c.id, c]));

export function isDataCategoryId(id: string): id is DataCategoryId {
  return BY_ID.has(id as DataCategoryId);
}

export function dataCategory(id: DataCategoryId): DataCategory {
  const found = BY_ID.get(id);
  if (!found) throw new StoreError(`unknown data category \`${id}\``);
  return found;
}

/** Every category a factory reset deletes (everything but the kept ones). */
export const RESET_CATEGORIES: readonly DataCategoryId[] = DATA_CATEGORIES.filter(
  (c) => !c.kept,
).map((c) => c.id);

/**
 * `ids` plus what they require (transitively), in registry order. Kept categories are refused.
 */
export function resolveCategories(ids: Iterable<DataCategoryId>): DataCategoryId[] {
  const want = new Set<DataCategoryId>();
  const add = (id: DataCategoryId) => {
    if (want.has(id)) return;
    const c = dataCategory(id);
    if (c.kept) throw new StoreError(`data category \`${id}\` is kept and cannot be deleted`);
    want.add(id);
    for (const r of c.requires) add(r);
  };
  for (const id of ids) add(id);
  return DATA_CATEGORIES.filter((c) => want.has(c.id)).map((c) => c.id);
}

/** Modules to stop around deleting `ids`, in registry order, without duplicates. */
export function categoryModules(ids: Iterable<DataCategoryId>): string[] {
  const set = new Set(ids);
  const out: string[] = [];
  for (const c of DATA_CATEGORIES) {
    if (!set.has(c.id)) continue;
    for (const m of c.modules) if (!out.includes(m)) out.push(m);
  }
  return out;
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

/** A backup: the rows of each part, as plain JSON. Settings rows are `{profile_id, key, value}`. */
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

/** What differs between the backends. SQL uses `$1`-style placeholders. */
export interface SqlDialect {
  /** `column` starts with the text parameter `param` (case-sensitive, `%` / `_` literal). */
  startsWith(column: string, param: string): string;
  /** A JSON / JSONB column as JSON text. */
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

/** `profile_settings` rows of one settings profile matching keys / prefixes. */
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

function settingsPartWhere(d: SqlDialect, p: Params, part: SettingsPart, profile: ProfileId) {
  const who = part.profile === "active" ? profile : GLOBAL_SETTINGS_PROFILE;
  return `profile_id = ${p.add(who)} AND ${selectorSql(d, p, part.keys, part.prefixes)}`;
}

/** Settings rows no settings part claims (in the profile and in `_global`). */
function otherSettingsWhere(d: SqlDialect, p: Params, profile: ProfileId): string {
  const known = (which: SettingsPart["profile"]) => {
    const parts = DATA_CATEGORIES.flatMap((c) => c.parts).filter(
      (x): x is SettingsPart => x.kind === "settings" && x.profile === which,
    );
    return selectorSql(
      d,
      p,
      parts.flatMap((x) => x.keys),
      parts.flatMap((x) => x.prefixes),
    );
  };
  const active = p.add(profile);
  const global = p.add(GLOBAL_SETTINGS_PROFILE);
  return (
    `((profile_id = ${active} AND NOT ${known("active")}) OR ` +
    `(profile_id = ${global} AND NOT ${known("global")}))`
  );
}

function tableWhere(p: Params, part: TablePart, profile: ProfileId): string {
  return part.rows === "profile" ? `WHERE profile_id = ${p.add(profile)}` : "";
}

/** Count and last update of a part: one row `{ n, at }`. */
export function countStmt(d: SqlDialect, part: DataPart, profile: ProfileId): Stmt {
  const p = new Params();
  switch (part.kind) {
    case "table": {
      const at = part.updated === null ? "NULL" : `MAX(${part.updated})`;
      const sql = `SELECT COUNT(*) AS n, ${at} AS at FROM ${part.table} ${tableWhere(p, part, profile)}`;
      return { sql, params: p.values };
    }
    case "settings":
      return {
        sql: `SELECT COUNT(*) AS n, MAX(updated_at) AS at FROM profile_settings WHERE ${settingsPartWhere(d, p, part, profile)}`,
        params: p.values,
      };
    case "call_names":
      return {
        sql: `SELECT COUNT(*) AS n, MAX(updated_at) AS at FROM relationships WHERE profile_id = ${p.add(profile)} AND call_name IS NOT NULL`,
        params: p.values,
      };
    case "other_settings":
      return {
        sql: `SELECT COUNT(*) AS n, MAX(updated_at) AS at FROM profile_settings WHERE ${otherSettingsWhere(d, p, profile)}`,
        params: p.values,
      };
  }
}

/** Memories by kind: rows `{ kind, n }`. */
export function memoryKindsStmt(profile: ProfileId): Stmt {
  return {
    sql: "SELECT kind, COUNT(*) AS n FROM memory_records WHERE profile_id = $1 GROUP BY kind",
    params: [profile],
  };
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
    case "settings":
    case "other_settings":
      return SETTINGS_COLUMNS;
  }
}

/** The rows of a part, with `exportSpec(part)` columns. */
export function exportStmt(d: SqlDialect, part: DataPart, profile: ProfileId): Stmt {
  const p = new Params();
  const settingsSelect = `SELECT profile_id, key, ${d.jsonText("value")} AS value, updated_at FROM profile_settings`;
  switch (part.kind) {
    case "table": {
      const cols = Object.keys(part.columns)
        .map((c) => (part.columns[c] === "json" ? `${d.jsonText(c)} AS ${c}` : c))
        .join(", ");
      const sql = `SELECT ${cols} FROM ${part.table} ${tableWhere(p, part, profile)} ORDER BY ${part.order}`;
      return { sql, params: p.values };
    }
    case "settings":
      return {
        sql: `${settingsSelect} WHERE ${settingsPartWhere(d, p, part, profile)} ORDER BY ${d.keyOrder}`,
        params: p.values,
      };
    case "call_names":
      return {
        sql: `SELECT person_id, call_name FROM relationships WHERE profile_id = ${p.add(profile)} AND call_name IS NOT NULL ORDER BY person_id`,
        params: p.values,
      };
    case "other_settings":
      return {
        sql: `${settingsSelect} WHERE ${otherSettingsWhere(d, p, profile)} ORDER BY profile_id, ${d.keyOrder}`,
        params: p.values,
      };
  }
}

/** What deletes (or clears) a part; its row count is the part's count. */
export function deleteStmt(d: SqlDialect, part: DataPart, profile: ProfileId): Stmt {
  const p = new Params();
  switch (part.kind) {
    case "table":
      return { sql: `DELETE FROM ${part.table} ${tableWhere(p, part, profile)}`, params: p.values };
    case "settings":
      return {
        sql: `DELETE FROM profile_settings WHERE ${settingsPartWhere(d, p, part, profile)}`,
        params: p.values,
      };
    case "call_names":
      return {
        sql: `UPDATE relationships SET call_name = NULL WHERE profile_id = ${p.add(profile)} AND call_name IS NOT NULL`,
        params: p.values,
      };
    case "other_settings":
      return {
        sql: `DELETE FROM profile_settings WHERE ${otherSettingsWhere(d, p, profile)}`,
        params: p.values,
      };
  }
}

export function seedRoleStmt(d: SqlDialect, role: RoleDefinition): Stmt {
  return {
    sql: "INSERT INTO roles (name, rank, grants, denies, builtin) VALUES ($1, $2, $3, $4, $5)",
    params: [role.name, role.rank, d.list(role.grants), d.list(role.denies), d.bool(role.builtin)],
  };
}

/**
 * The statements of a wipe, in order, each with the part it counts toward (`null`: not
 * counted). Parts are deleted in reverse registry order, so dependents go first.
 */
export function wipeStatements(
  d: SqlDialect,
  profile: ProfileId,
  ids: readonly DataCategoryId[],
  options: WipeOptions = {},
): { part: string | null; stmt: Stmt }[] {
  const out: { part: string | null; stmt: Stmt }[] = [];
  const resolved = resolveCategories(ids);
  const set = new Set(resolved);
  // `call_names` first: clearing a column of rows `relationships` may delete next.
  const ordered = [...resolved].sort((a, b) =>
    a === "call_names" ? -1 : b === "call_names" ? 1 : 0,
  );
  for (const id of ordered) {
    for (const part of dataCategory(id).parts) {
      out.push({ part: part.id, stmt: deleteStmt(d, part, profile) });
    }
  }
  if (set.has("roles")) {
    for (const role of options.seedRoles ?? [])
      out.push({ part: null, stmt: seedRoleStmt(d, role) });
  }
  return out;
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
  category: DataCategory,
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

/** Exportable categories among `ids` (kept ones included, panel sessions not). */
export function exportCategories(ids: Iterable<DataCategoryId>): DataCategoryId[] {
  const set = new Set(ids);
  return DATA_CATEGORIES.filter((c) => set.has(c.id) && c.exportable).map((c) => c.id);
}

// ---- backend-independent reads --------------------------------------------------------------

export type RunQuery = (stmt: Stmt) => Promise<Record<string, unknown>[]>;

export async function readInventory(
  d: SqlDialect,
  query: RunQuery,
  profile: ProfileId,
  now: Timestamp,
): Promise<DataInventory> {
  const categories: CategoryInventory[] = [];
  for (const c of DATA_CATEGORIES) {
    const parts: PartInventory[] = [];
    for (const part of c.parts) {
      const rows = await query(countStmt(d, part, profile));
      parts.push(partInventory(part.id, rows[0]));
    }
    let breakdown: Record<string, number> | null = null;
    if (c.id === "memories") {
      breakdown = {};
      for (const row of await query(memoryKindsStmt(profile))) {
        breakdown[String(row.kind)] = Number(row.n);
      }
    }
    categories.push(categoryInventory(c, parts, breakdown));
  }
  return { profile, at: now, categories };
}

export async function readExport(
  d: SqlDialect,
  query: RunQuery,
  profile: ProfileId,
  ids: readonly DataCategoryId[],
  now: Timestamp,
): Promise<DataExport> {
  for (const id of ids) dataCategory(id);
  const categories = exportCategories(ids);
  const parts: Record<string, JsonObject[]> = {};
  for (const id of categories) {
    for (const part of dataCategory(id).parts) {
      const rows = await query(exportStmt(d, part, profile));
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

/** Adds one statement's row count to its part. */
export function addCount(counts: WipeCounts, part: string | null, n: number): void {
  if (part === null) return;
  counts[part] = (counts[part] ?? 0) + n;
}
