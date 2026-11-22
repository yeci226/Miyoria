// `miyoria db doctor`: what a database file is, read-only, for the person doing the cut-over
// (docs/design/v5-data.md §7) before and after each step. It opens the file through
// `openReadOnly`, so it never changes it, whichever layout it has.
//
// It says which layout the file has (V4, V5, an empty or blank file, something else, not a
// database), whether Core's guard would refuse it (`databaseRefusal`, the check `migrate` runs),
// for V5 the applied migrations against this build's, the integrity and foreign-key checks, how
// many persons, accounts and events it holds and the newest event's time, and for V4 what
// `import-links` would bring over.

import { basename } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { type Clock, systemClock, type Timestamp } from "@miyoria/types";
import { artifactSchema } from "../artifacts/migrations.js";
import { fromMicros } from "../common.js";
import { configSchema } from "../config/migrations.js";
import { identitySchema } from "../identity/migrations.js";
import { legacySchema } from "../legacy-schema/index.js";
import { checksum, coreSchema, databaseRefusal, type PluginSchema } from "../migrate.js";
import { emptyLinkTarget, importLinks, type LinkImportCounts, linkImportCounts } from "./links.js";
import { type FileFacts, fileFacts, openReadOnly, tablesOf } from "./old-file.js";

/** What a file is. `blank`: a SQLite database with no tables. `foreign`: tables, but not ours. */
export type DatabaseLayout =
  | "missing"
  | "empty"
  | "not_database"
  | "blank"
  | "v4"
  | "v5"
  | "foreign";

/** One schema's migrations, as recorded against as this build has them. */
export interface MigrationReport {
  plugin: string;
  applied: number[];
  /** `null`: a plugin this build's store does not carry (Core checks it at start). */
  code: number[] | null;
  /** In the code, not applied: Core applies them at its next start. */
  pending: number[];
  /** Applied, but not in the code: a newer build migrated this file. */
  unknown: number[];
  /** Applied with another checksum: a migration was edited after it ran. */
  changed: number[];
}

export interface DatabaseCounts {
  persons: number;
  accounts: number;
  events: number;
  newest_event: Timestamp | null;
}

/** One Space (server) of a V5 file, for `db doctor` (docs/design/v5-places.md). */
export interface SpaceReport {
  platform: string;
  external_id: string;
  name: string;
  /** Members who have not left. */
  members: number;
  /** She left it. */
  left: boolean;
  /**
   * The install's original server: `spaces.is_primary` once identity v2 ran, before that the one
   * identity v2 will pick (the active Space with the most members, then the earliest, then by id).
   */
  primary: boolean;
}

export interface DoctorReport {
  path: string;
  layout: DatabaseLayout;
  facts: FileFacts;
  /** How it was opened (`openReadOnly`), `null` when it was not. */
  opened: "direct" | "immutable" | "copy" | null;
  /** Core's guard: `null` when it would open the file, else its message. */
  refusal: string | null;
  /** V5 only. */
  migrations: MigrationReport[] | null;
  /** V4 only: the highest `schema_version`. */
  v4_version: number | null;
  /** `["ok"]`, or what `integrity_check` found. */
  integrity: string[] | null;
  /** Rows whose foreign key points at nothing (`foreign_key_check`), the first few. */
  foreign_keys: { count: number; first: string[] } | null;
  /** V5: persons (not merged into another), accounts, events. V4: people, accounts, `log_events`. */
  counts: DatabaseCounts | null;
  /** V5: the Spaces, primary first; `primary_pending` while identity v2 has not run yet. */
  spaces: SpaceReport[] | null;
  primary_pending: boolean;
  /** V4 only: what `import-links` would bring into an empty database. */
  import: LinkImportCounts | null;
  /** Why the import preview could not be made. */
  import_error: string | null;
}

export interface DoctorOptions {
  /** Schemas to compare against, besides the store's own (core, identity, config, legacy, artifact). */
  schemas?: readonly PluginSchema[];
  /** The character for the import preview (`core.profile`). */
  profile?: string | null;
  clock?: Clock;
}

const STORE_SCHEMAS: readonly PluginSchema[] = [
  coreSchema,
  identitySchema,
  configSchema,
  legacySchema,
  artifactSchema,
];

function scalar(db: DatabaseSync, sql: string): number | null {
  const row = db.prepare(sql).get();
  const v = row === undefined ? null : Object.values(row)[0];
  if (v === null || v === undefined) return null;
  return Number(v);
}

function migrationReports(db: DatabaseSync, schemas: readonly PluginSchema[]): MigrationReport[] {
  const rows = db
    .prepare("SELECT plugin, version, checksum FROM _migrations ORDER BY plugin, version")
    .all();
  const byPlugin = new Map<string, Array<{ version: number; checksum: string }>>();
  for (const r of rows) {
    const plugin = String(r.plugin);
    byPlugin.set(plugin, [
      ...(byPlugin.get(plugin) ?? []),
      { version: Number(r.version), checksum: String(r.checksum) },
    ]);
  }
  const known = new Map(schemas.map((s) => [s.plugin, s] as const));
  const plugins = [...new Set([...known.keys(), ...byPlugin.keys()])];
  return plugins.map((plugin) => {
    const applied = byPlugin.get(plugin) ?? [];
    const schema = known.get(plugin);
    if (schema === undefined) {
      return {
        plugin,
        applied: applied.map((a) => a.version),
        code: null,
        pending: [],
        unknown: [],
        changed: [],
      };
    }
    const code = schema.migrations.map((m) => m.version).sort((a, b) => a - b);
    const done = new Set(applied.map((a) => a.version));
    return {
      plugin,
      applied: applied.map((a) => a.version),
      code,
      pending: code.filter((v) => !done.has(v)),
      unknown: applied.filter((a) => !code.includes(a.version)).map((a) => a.version),
      changed: applied
        .filter((a) => {
          const m = schema.migrations.find((x) => x.version === a.version);
          return m !== undefined && checksum(m.sql) !== a.checksum;
        })
        .map((a) => a.version),
    };
  });
}

function checks(db: DatabaseSync): Pick<DoctorReport, "integrity" | "foreign_keys"> {
  const integrity = db
    .prepare("PRAGMA integrity_check")
    .all()
    .map((r) => String(Object.values(r)[0]));
  const fk = db.prepare("PRAGMA foreign_key_check").all();
  return {
    integrity,
    foreign_keys: {
      count: fk.length,
      first: fk
        .slice(0, 5)
        .map((r) => `${String(r.table)} rowid ${String(r.rowid)} -> ${String(r.parent)}`),
    },
  };
}

/**
 * The Spaces of a V5 file with their members and the primary: the column once identity v2 ran,
 * else the one its migration will pick (the same order as `identity/migrations.ts` v2).
 */
function spaceReports(db: DatabaseSync): Pick<DoctorReport, "spaces" | "primary_pending"> {
  const columns = new Set(
    (db.prepare("PRAGMA table_info(spaces)").all() as { name: string }[]).map((c) => c.name),
  );
  const pending = !columns.has("is_primary");
  const rows = db
    .prepare(
      `SELECT s.id, s.platform, s.external_id, s.name, s.left_at IS NOT NULL AS left_,
         ${pending ? "0" : "s.is_primary"} AS is_primary,
         (SELECT count(*) FROM space_members m WHERE m.space_id = s.id AND m.left_at IS NULL) AS members,
         (SELECT count(*) FROM space_members m WHERE m.space_id = s.id) AS ever
       FROM spaces s ORDER BY s.joined_at, s.id`,
    )
    .all() as {
    id: string;
    platform: string;
    external_id: string;
    name: string;
    left_: number;
    is_primary: number;
    members: number;
    ever: number;
  }[];
  let primary = rows.find((r) => r.is_primary === 1)?.id ?? null;
  if (pending) {
    // identity v2: the active Space with the most member rows, then the earliest, then the smallest
    // id (the rows' own order; the sort is stable).
    const pick = rows
      .filter((r) => r.left_ === 0)
      .sort((a, b) => b.ever - a.ever)
      .at(0);
    primary = pick?.id ?? null;
  }
  const spaces = rows.map((r) => ({
    platform: r.platform,
    external_id: r.external_id,
    name: r.name,
    members: Number(r.members),
    left: r.left_ === 1,
    primary: r.id === primary,
  }));
  spaces.sort((a, b) => Number(b.primary) - Number(a.primary));
  return { spaces, primary_pending: pending };
}

/** Looks at the database file at `path` without changing it (see the file comment). */
export function inspectDatabase(path: string, options: DoctorOptions = {}): DoctorReport {
  const facts = fileFacts(path);
  const report: DoctorReport = {
    path,
    layout: "missing",
    facts,
    opened: null,
    refusal: null,
    migrations: null,
    v4_version: null,
    integrity: null,
    foreign_keys: null,
    counts: null,
    spaces: null,
    primary_pending: false,
    import: null,
    import_error: null,
  };
  if (!facts.exists) return report;
  if (facts.size === 0) return { ...report, layout: "empty" };
  if (facts.walMode === null) return { ...report, layout: "not_database" };
  let ro: ReturnType<typeof openReadOnly>;
  try {
    ro = openReadOnly(path);
  } catch {
    return { ...report, layout: "not_database" };
  }
  try {
    const db = ro.db;
    report.opened = ro.how;
    const tables = tablesOf(db);
    report.refusal = databaseRefusal(tables, path)?.message ?? null;
    if (tables.size === 0) return { ...report, layout: "blank" };
    Object.assign(report, checks(db));
    if (tables.has("schema_version")) {
      report.layout = "v4";
      report.v4_version = scalar(db, "SELECT max(version) FROM schema_version");
      const newest = tables.has("log_events") ? scalar(db, "SELECT max(at) FROM log_events") : null;
      report.counts = {
        persons: tables.has("people") ? (scalar(db, "SELECT count(*) FROM people") ?? 0) : 0,
        accounts: tables.has("accounts") ? (scalar(db, "SELECT count(*) FROM accounts") ?? 0) : 0,
        events: tables.has("log_events") ? (scalar(db, "SELECT count(*) FROM log_events") ?? 0) : 0,
        newest_event: newest === null ? null : fromMicros(newest),
      };
      const target = emptyLinkTarget(options.clock ?? systemClock);
      try {
        const preview = importLinks(target, db, basename(path), {
          dryRun: true,
          profile: options.profile ?? null,
        });
        report.import = linkImportCounts(preview);
      } catch (error) {
        report.import_error = error instanceof Error ? error.message : String(error);
      } finally {
        target.close();
      }
      return report;
    }
    if (!tables.has("_migrations")) return { ...report, layout: "foreign" };
    report.layout = "v5";
    report.migrations = migrationReports(db, [...STORE_SCHEMAS, ...(options.schemas ?? [])]);
    const has = (t: string) => tables.has(t);
    const newest = has("events") ? scalar(db, "SELECT max(at) FROM events") : null;
    report.counts = {
      persons: has("persons")
        ? (scalar(db, "SELECT count(*) FROM persons WHERE merged_into IS NULL") ?? 0)
        : 0,
      accounts: has("accounts") ? (scalar(db, "SELECT count(*) FROM accounts") ?? 0) : 0,
      events: has("events") ? (scalar(db, "SELECT count(*) FROM events") ?? 0) : 0,
      newest_event: newest === null ? null : fromMicros(newest),
    };
    if (has("spaces") && has("space_members")) Object.assign(report, spaceReports(db));
    return report;
  } finally {
    ro.close();
  }
}
