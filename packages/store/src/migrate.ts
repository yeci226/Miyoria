// The migration runner (docs/design/v5-data.md §3.1).
//
// Every owner of tables declares a `PluginSchema`: its id (also its table prefix), the schemas
// it needs first, and forward-only migrations embedded as TypeScript strings, so a bundle or an
// installed plugin carries its own SQL. The runner applies `core` first, then `identity` and
// `config`, then the rest in dependency order (ties by id), each migration in its own
// transaction together with its `_migrations` row. That row keeps a sha256 of the SQL text.
//
// It refuses to start, before writing anything, when:
// - the file carries the V4 bookkeeping (`schema_version`): V5 starts from a new database and
//   never changes an old one (§7); the check opens such a file read-only;
// - the file has tables but no `_migrations`: it is not a database this runner made;
// - a recorded migration is missing from the code, or its checksum differs (someone edited a
//   migration that already ran);
// - a new migration sorts before one that was already applied;
// - a schema fails the naming lint: a plugin's tables, indexes, triggers and views start with
//   `<plugin>_`, and it declares foreign keys only to its own, core and identity tables. Core and
//   the two core plugins that always run (`identity`, `config`) name their tables without a
//   prefix, as the design does (`persons`, `place_settings`, `plugin_state`); so does `legacy`.

import { createHash } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { getLogger } from "@miyoria/runtime/kernel";
import { StoreError } from "./common.js";
import { openReadOnly } from "./cutover/old-file.js";
import type { Db, Row } from "./db.js";
import { EVENT_CURSORS_SQL } from "./events/cursors.js";
import {
  CHAT_SQL,
  EVENTS_SQL,
  LLM_CALLS_SQL,
  PARTIAL_REDACTION_SQL,
  TURNS_AUDIT_SQL,
} from "./events/schema.js";

const log = getLogger("store.migrate");

/** One forward-only step of a schema. `sql` may hold several statements. */
export interface Migration {
  /** 1, 2, 3, ...: the order within the schema. Never reused, never renumbered. */
  version: number;
  name: string;
  /** Never edited once released: its sha256 is recorded and checked at every start. */
  sql: string;
}

/** The tables one plugin owns. */
export interface PluginSchema {
  /** The plugin id, also the table prefix: `economy` owns `economy_*`. */
  plugin: string;
  /** Schemas that must migrate first. `core`, `identity` and `config` always come first. */
  requires?: readonly string[];
  migrations: readonly Migration[];
}

/** A row of `_migrations`. `applied_at` is microseconds since the epoch. */
export interface AppliedMigration {
  plugin: string;
  version: number;
  name: string;
  checksum: string;
  applied_at: number;
}

export type SchemaErrorCode =
  | "old_database"
  | "foreign_database"
  | "missing_migration"
  | "checksum_mismatch"
  | "out_of_order"
  | "invalid_schema"
  | "lint"
  | "failed";

/** Why the runner refused a database or a schema, or why a migration failed. */
export class SchemaError extends Error {
  override readonly name = "SchemaError";
  readonly code: SchemaErrorCode;

  constructor(code: SchemaErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.code = code;
  }
}

// ---- core schema ---------------------------------------------------------------------------

/** The bookkeeping table. `PRAGMA auto_vacuum = INCREMENTAL` is issued before it. */
const BOOKKEEPING = `CREATE TABLE _migrations (
    plugin     TEXT    NOT NULL,
    version    INTEGER NOT NULL,
    name       TEXT    NOT NULL,
    checksum   TEXT    NOT NULL,
    applied_at INTEGER NOT NULL,
    PRIMARY KEY (plugin, version)
) STRICT;
`;

/**
 * Core's own tables: the bookkeeping, the event log, then its chat indexes and view, then the
 * indexes and views of turn records and audit entries, then those of LLM calls, then the
 * positions of the log's readers, then the redaction that keeps part of a payload. No prefix.
 * Always applied first.
 */
export const coreSchema: PluginSchema = {
  plugin: "core",
  migrations: [
    { version: 1, name: "bookkeeping", sql: BOOKKEEPING },
    { version: 2, name: "events", sql: EVENTS_SQL },
    { version: 3, name: "chat", sql: CHAT_SQL },
    { version: 4, name: "turns_audit", sql: TURNS_AUDIT_SQL },
    { version: 5, name: "llm_calls", sql: LLM_CALLS_SQL },
    { version: 6, name: "event_cursors", sql: EVENT_CURSORS_SQL },
    { version: 7, name: "partial_redaction", sql: PARTIAL_REDACTION_SQL },
  ],
};

/** Core plugins that always run, in this order, right after `core`. */
const PINNED = ["identity", "config"] as const;

/**
 * Schemas whose table names carry no prefix: core, its two always-on plugins (`identity`,
 * `config`), and `legacy`.
 */
const UNPREFIXED = new Set(["core", "identity", "config", "legacy"]);

/** Schemas every plugin may point a foreign key at. */
const SHARED = new Set(["core", "identity"]);

const PLUGIN_ID = /^[a-z][a-z0-9_]*$/;

// ---- checksums -----------------------------------------------------------------------------

/** sha256 (hex) of a migration's SQL text. */
export function checksum(sql: string): string {
  return createHash("sha256").update(sql, "utf8").digest("hex");
}

// ---- order ---------------------------------------------------------------------------------

function checkSchema(schema: PluginSchema): void {
  const id = schema.plugin;
  if (!PLUGIN_ID.test(id)) {
    throw new SchemaError("invalid_schema", `schema id \`${id}\` must match ${PLUGIN_ID}`);
  }
  const seen = new Set<number>();
  for (const m of schema.migrations) {
    if (!Number.isSafeInteger(m.version) || m.version < 1) {
      throw new SchemaError("invalid_schema", `${id} migration version ${m.version} is invalid`);
    }
    if (seen.has(m.version)) {
      throw new SchemaError("invalid_schema", `${id} has two migrations ${m.version}`);
    }
    seen.add(m.version);
    if (m.name.trim() === "" || m.sql.trim() === "") {
      throw new SchemaError("invalid_schema", `${id} migration ${m.version} has no name or SQL`);
    }
  }
}

/**
 * The order schemas migrate in: `core`, then `identity` and `config` (when installed), then the
 * rest in topological order of `requires`, ties broken by plugin id. Throws on a duplicate id, an
 * unknown or late requirement, or a cycle.
 */
export function orderSchemas(schemas: readonly PluginSchema[]): PluginSchema[] {
  const byId = new Map<string, PluginSchema>();
  for (const schema of schemas) {
    checkSchema(schema);
    if (byId.has(schema.plugin)) {
      throw new SchemaError("invalid_schema", `schema \`${schema.plugin}\` is declared twice`);
    }
    byId.set(schema.plugin, schema);
  }
  const head = ["core", ...PINNED].filter((id) => byId.has(id));
  const placed = new Set<string>();
  const ordered: PluginSchema[] = [];
  for (const id of head) {
    const schema = byId.get(id) as PluginSchema;
    for (const need of schema.requires ?? []) {
      if (!placed.has(need)) {
        throw new SchemaError("invalid_schema", `\`${id}\` requires \`${need}\`, which runs later`);
      }
    }
    placed.add(id);
    ordered.push(schema);
  }

  const rest = [...byId.values()].filter((s) => !placed.has(s.plugin));
  for (const schema of rest) {
    for (const need of schema.requires ?? []) {
      if (!byId.has(need)) {
        throw new SchemaError(
          "invalid_schema",
          `\`${schema.plugin}\` requires \`${need}\`, which is not installed`,
        );
      }
    }
  }
  const waiting = new Map(rest.map((s) => [s.plugin, s]));
  while (waiting.size > 0) {
    const ready = [...waiting.values()]
      .filter((s) => (s.requires ?? []).every((need) => placed.has(need)))
      .sort((a, b) => (a.plugin < b.plugin ? -1 : a.plugin > b.plugin ? 1 : 0));
    const next = ready[0];
    if (next === undefined) {
      const ids = [...waiting.keys()].sort().join(", ");
      throw new SchemaError("invalid_schema", `schemas require each other in a cycle: ${ids}`);
    }
    waiting.delete(next.plugin);
    placed.add(next.plugin);
    ordered.push(next);
  }
  return ordered;
}

// ---- naming lint ---------------------------------------------------------------------------

const IDENT = String.raw`("[^"]+"|\x60[^\x60]+\x60|\[[^\]]+\]|[A-Za-z_][A-Za-z0-9_$]*)`;
const IF_NOT_EXISTS = String.raw`(?:IF\s+NOT\s+EXISTS\s+)?`;
const IF_EXISTS = String.raw`(?:IF\s+EXISTS\s+)?`;

/** SQL with comments and string literals blanked out, so names are only found in code. */
function codeOnly(sql: string): string {
  return sql.replace(/--[^\n]*|\/\*[\s\S]*?\*\/|'(?:[^']|'')*'/g, (m) =>
    m.startsWith("'") ? "''" : " ",
  );
}

function unquote(name: string): string {
  const first = name[0];
  return first === '"' || first === "`" || first === "[" ? name.slice(1, -1) : name;
}

function matches(sql: string, pattern: string): string[] {
  return [...sql.matchAll(new RegExp(pattern, "gi"))].map((m) => unquote(m[1] as string));
}

/** What one migration's SQL creates and touches, by name. */
export interface SqlNames {
  /** Tables, indexes, triggers and views it creates or renames to. */
  created: string[];
  /** Tables it alters, drops from, or hangs an index or trigger on. */
  touched: string[];
  /** Tables its foreign keys point at. */
  referenced: string[];
}

export function sqlNames(sql: string): SqlNames {
  const code = codeOnly(sql);
  const kind = String.raw`(?:TEMP(?:ORARY)?\s+)?(?:UNIQUE\s+)?(?:VIRTUAL\s+)?(?:TABLE|INDEX|TRIGGER|VIEW)`;
  return {
    created: [
      ...matches(code, String.raw`\bCREATE\s+${kind}\s+${IF_NOT_EXISTS}${IDENT}`),
      ...matches(code, String.raw`\bRENAME\s+TO\s+${IDENT}`),
    ],
    touched: [
      ...matches(code, String.raw`\bALTER\s+TABLE\s+${IDENT}`),
      ...matches(code, String.raw`\bDROP\s+(?:TABLE|INDEX|TRIGGER|VIEW)\s+${IF_EXISTS}${IDENT}`),
      ...matches(
        code,
        String.raw`\bCREATE\s+(?:UNIQUE\s+)?INDEX\s+${IF_NOT_EXISTS}${IDENT.replace("(", "(?:")}\s+ON\s+${IDENT}`,
      ),
      ...matches(
        code,
        String.raw`\bCREATE\s+(?:TEMP(?:ORARY)?\s+)?TRIGGER\s+${IF_NOT_EXISTS}${IDENT.replace("(", "(?:")}[^;]*?\bON\s+${IDENT}`,
      ),
    ],
    referenced: matches(code, String.raw`\bREFERENCES\s+${IDENT}`),
  };
}

/**
 * Problems with the names in `schemas` (already ordered), as messages; empty when they pass.
 * Core, identity, config and `legacy` are exempt from the prefix; every other schema's names
 * start with `<plugin>_`, and its foreign keys point only at its own, core or identity tables.
 */
export function lintSchemas(schemas: readonly PluginSchema[]): string[] {
  const shared = new Set<string>();
  for (const schema of schemas) {
    if (!SHARED.has(schema.plugin)) continue;
    for (const m of schema.migrations) {
      for (const name of sqlNames(m.sql).created) shared.add(name.toLowerCase());
    }
  }
  const problems: string[] = [];
  for (const schema of schemas) {
    if (UNPREFIXED.has(schema.plugin)) continue;
    const prefix = `${schema.plugin}_`;
    const own = (name: string) => name.toLowerCase().startsWith(prefix);
    for (const m of schema.migrations) {
      const where = `${schema.plugin} migration ${m.version} (${m.name})`;
      const names = sqlNames(m.sql);
      for (const name of names.created) {
        if (!own(name))
          problems.push(`${where} creates \`${name}\`, which must start with \`${prefix}\``);
      }
      for (const name of names.touched) {
        if (!own(name)) problems.push(`${where} changes \`${name}\`, which it does not own`);
      }
      for (const name of names.referenced) {
        if (!own(name) && !shared.has(name.toLowerCase())) {
          problems.push(
            `${where} has a foreign key to \`${name}\`; only its own, core and identity tables may be referenced`,
          );
        }
      }
    }
  }
  return problems;
}

// ---- the database --------------------------------------------------------------------------

function tableNames(rows: readonly Row[]): Set<string> {
  return new Set(rows.map((r) => String(r.name)));
}

const TABLES = "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'";

/**
 * Why a database with these tables must not be migrated, or `null` when it may be. Pure, so
 * `miyoria db doctor` can say what the guard would do without opening the file for writing.
 */
export function databaseRefusal(tables: ReadonlySet<string>, location: string): SchemaError | null {
  if (tables.has("schema_version")) {
    return new SchemaError(
      "old_database",
      `${location} is a V4 database (it records migrations in \`schema_version\`). This build ` +
        "starts from a new database and never changes an old one. To move over, with V4 " +
        "stopped: `miyoria db archive` (moves this file, its -wal and -shm to data/archive/ and " +
        "makes a single-file copy), point `core.database_url` at a new file (for example " +
        "`sqlite:data/core.db`), then `miyoria db import-links --from data/archive/" +
        "<name>.single.db`. `miyoria db doctor <file>` tells what a file is",
    );
  }
  if (tables.size > 0 && !tables.has("_migrations")) {
    return new SchemaError(
      "foreign_database",
      `${location} has tables but no \`_migrations\`: it is not a Miyoria database this ` +
        "build can migrate. Point `core.database_url` at a new file " +
        "(`miyoria db doctor <file>` tells what this one is)",
    );
  }
  return null;
}

/** Throws when a database with these tables must not be migrated. */
function refuseForeign(tables: ReadonlySet<string>, location: string): void {
  const refusal = databaseRefusal(tables, location);
  if (refusal !== null) throw refusal;
}

/**
 * Looks at an existing database file through a read-only connection and throws when it must
 * not be migrated (see the file comment). Changes nothing: the V4 database is checked this way
 * before any read-write connection, pragma or checkpoint can touch it, and through `openReadOnly`,
 * which (unlike a plain read-only connection) leaves no `-wal` or `-shm` beside a file in WAL mode
 * that had none. A missing or empty file passes.
 */
export function checkDatabaseFile(path: string): void {
  if (path === ":memory:" || !existsSync(path) || statSync(path).size === 0) return;
  let tables: Set<string>;
  try {
    const ro = openReadOnly(path);
    try {
      tables = tableNames(ro.db.prepare(TABLES).all());
    } finally {
      ro.close();
    }
  } catch (cause) {
    throw new StoreError(`cannot read the SQLite database ${path}`, { cause });
  }
  refuseForeign(tables, path);
}

/** Every row of `_migrations`, in the order they were applied. */
export function appliedMigrations(db: Db): AppliedMigration[] {
  const exists = db.get(
    "SELECT 1 AS x FROM sqlite_schema WHERE type = 'table' AND name = '_migrations'",
  );
  if (exists === undefined) return [];
  return db
    .all("SELECT plugin, version, name, checksum, applied_at FROM _migrations ORDER BY rowid")
    .map((r) => ({
      plugin: String(r.plugin),
      version: Number(r.version),
      name: String(r.name),
      checksum: String(r.checksum),
      applied_at: Number(r.applied_at),
    }));
}

/** Versions of one schema recorded in `_migrations`, ascending. */
export function schemaVersions(db: Db, plugin: string): number[] {
  return appliedMigrations(db)
    .filter((m) => m.plugin === plugin)
    .map((m) => m.version)
    .sort((a, b) => a - b);
}

/** `core` with only its bookkeeping (`_migrations`): for a database of a few plugins' tables. */
const BOOKKEEPING_ONLY: PluginSchema = {
  plugin: "core",
  migrations: coreSchema.migrations.filter((m) => m.version === 1),
};

export interface MigrateOptions {
  /** Names the database in errors and logs: its file path, or `:memory:`. */
  location?: string;
  /**
   * `all` (default): core's own tables, the event log among them. `bookkeeping`: only
   * `_migrations`, for a database that holds just `schemas` (the install's machine database,
   * `openPluginDatabase`). Core's later migrations recorded in the file (a full store's) are left
   * alone, and a full store opened on the file later applies them.
   */
  core?: "all" | "bookkeeping";
}

/**
 * Applies `core` and `schemas` to `db`, after every check in the file comment, and returns the
 * migrations it applied (empty when the database was up to date). Nothing is written when a
 * check fails. A recorded schema that is not installed any more is left alone.
 */
export function migrate(
  db: Db,
  schemas: readonly PluginSchema[],
  options: MigrateOptions = {},
): AppliedMigration[] {
  const location = options.location ?? "the database";
  const bookkeeping = options.core === "bookkeeping";
  const ordered = orderSchemas([bookkeeping ? BOOKKEEPING_ONLY : coreSchema, ...schemas]);
  const problems = lintSchemas(ordered);
  if (problems.length > 0) {
    throw new SchemaError("lint", `schema names fail the lint: ${problems.join("; ")}`);
  }

  const tables = tableNames(db.all(TABLES));
  refuseForeign(tables, location);
  const applied = appliedMigrations(db);

  // Check everything before writing anything.
  const byPlugin = new Map(ordered.map((s) => [s.plugin, s]));
  const done = new Map<string, Set<number>>();
  for (const row of applied) {
    const versions = done.get(row.plugin) ?? new Set<number>();
    versions.add(row.version);
    done.set(row.plugin, versions);
    // Core's tables past its bookkeeping belong to a full store, which checks them itself.
    if (bookkeeping && row.plugin === "core" && row.version !== 1) continue;
    const schema = byPlugin.get(row.plugin);
    if (schema === undefined) continue;
    const what = `${row.plugin} migration ${row.version} (${row.name})`;
    const code = schema.migrations.find((m) => m.version === row.version);
    if (code === undefined) {
      throw new SchemaError(
        "missing_migration",
        `${location}: ${what} was applied but this build does not have it; a newer build ` +
          "migrated this database",
      );
    }
    const sum = checksum(code.sql);
    if (sum !== row.checksum) {
      throw new SchemaError(
        "checksum_mismatch",
        `${location}: ${what} changed after it was applied (checksum ${row.checksum.slice(0, 12)} ` +
          `in the database, ${sum.slice(0, 12)} in this build). A migration that ran is never ` +
          "edited; add a new one",
      );
    }
  }
  const pending: Array<{ schema: PluginSchema; migration: Migration }> = [];
  for (const schema of ordered) {
    const versions = done.get(schema.plugin) ?? new Set<number>();
    const highest = Math.max(0, ...versions);
    const todo = schema.migrations
      .filter((m) => !versions.has(m.version))
      .sort((a, b) => a.version - b.version);
    for (const migration of todo) {
      if (migration.version < highest) {
        throw new SchemaError(
          "out_of_order",
          `${location}: ${schema.plugin} migration ${migration.version} (${migration.name}) is ` +
            `new but ${highest} was already applied; new migrations take the next number`,
        );
      }
      pending.push({ schema, migration });
    }
  }
  if (pending.length === 0) {
    log.debug({ location }, "database migrations are up to date");
    return [];
  }

  // A new database: incremental vacuum is chosen before the first table exists. Once the file
  // has a header (WAL mode writes one), only a VACUUM applies it; on an empty file that is cheap.
  if (tables.size === 0) {
    db.exec("PRAGMA auto_vacuum = INCREMENTAL");
    if (Number(db.get("PRAGMA auto_vacuum")?.auto_vacuum) !== 2) db.exec("VACUUM");
  }
  const result: AppliedMigration[] = [];
  for (const { schema, migration } of pending) {
    const row: AppliedMigration = {
      plugin: schema.plugin,
      version: migration.version,
      name: migration.name,
      checksum: checksum(migration.sql),
      applied_at: db.nowMicros(),
    };
    try {
      db.tx(() => {
        db.exec(migration.sql);
        db.run(
          "INSERT INTO _migrations (plugin, version, name, checksum, applied_at) " +
            "VALUES ($plugin, $version, $name, $checksum, $at)",
          {
            plugin: row.plugin,
            version: row.version,
            name: row.name,
            checksum: row.checksum,
            at: row.applied_at,
          },
        );
      });
    } catch (cause) {
      throw new SchemaError(
        "failed",
        `${location}: ${schema.plugin} migration ${migration.version} (${migration.name}) failed`,
        { cause },
      );
    }
    log.info(
      { plugin: row.plugin, version: row.version, name: row.name },
      "applied database migration",
    );
    result.push(row);
  }
  return result;
}
