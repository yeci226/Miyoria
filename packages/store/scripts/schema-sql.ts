// The SQL of a plugin's Drizzle tables, for its `PluginSchema` migrations (docs/design/v5-data.md
// §3.1). drizzle-kit writes the DDL; this adds `STRICT` to every table, which Drizzle cannot
// declare. Tests use the same functions to prove the checked-in migrations and the Drizzle tables
// agree.
//
//   pnpm --filter @miyoria/store schema:sql identity
//
// prints the first migration of a plugin that has none yet, or the next one (what the migrated
// database lacks) for a plugin that has some. Review the output before pasting it: drizzle-kit
// cannot see a partial index's WHERE or an index on an expression, and rebuilds a table to
// change a column, which needs `PRAGMA foreign_keys = OFF` outside the migration's transaction.

import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { systemClock } from "@miyoria/types";
import { generateDrizzleJson, generateMigration, pushSchema } from "drizzle-kit/payload/sqlite";
import { authSchema } from "../../auth/src/migrations.js";
import * as authTables from "../../auth/src/schema.js";
import { directiveSchema } from "../../brain/directive/src/migrations.js";
import * as directiveTables from "../../brain/directive/src/schema.js";
import { reportSchema } from "../../brain/report/src/migrations.js";
import * as reportTables from "../../brain/report/src/schema.js";
import { initiativeSchema } from "../../brain/selfhost/src/initiative-migrations.js";
import * as initiativeTables from "../../brain/selfhost/src/initiative-schema.js";
import { clusterSchema } from "../../cluster/src/migrations.js";
import * as clusterTables from "../../cluster/src/schema.js";
import { giftSchema } from "../../economy/src/gift-migrations.js";
import * as giftTables from "../../economy/src/gift-schema.js";
import { economySchema } from "../../economy/src/migrations.js";
import * as economyTables from "../../economy/src/schema.js";
import { heartSchema } from "../../heart/person/src/migrations.js";
import * as heartTables from "../../heart/person/src/schema.js";
import { MEMORY_SEARCH_SQL, memorySchema } from "../../memory/memory/src/migrations.js";
import * as memoryTables from "../../memory/memory/src/schema.js";
import { notesSchema } from "../../memory/notes/src/migrations.js";
import * as notesTables from "../../memory/notes/src/schema.js";
import { transcriptSchema } from "../../memory/transcript/src/migrations.js";
import * as transcriptTables from "../../memory/transcript/src/schema.js";
import { CARDS_CATALOGUE_SQL, cardsSchema } from "../../play/cards/src/migrations.js";
import * as cardsTables from "../../play/cards/src/schema.js";
import { exchangeSchema } from "../../play/exchange/src/migrations.js";
import * as exchangeTables from "../../play/exchange/src/schema.js";
import { karaokeSchema } from "../../play/karaoke/src/migrations.js";
import * as karaokeTables from "../../play/karaoke/src/schema.js";
import { marketSchema } from "../../play/market/src/migrations.js";
import * as marketTables from "../../play/market/src/schema.js";
import { artifactSchema } from "../src/artifacts/migrations.js";
import * as artifactTables from "../src/artifacts/schema.js";
import { configSchema } from "../src/config/migrations.js";
import * as configTables from "../src/config/schema.js";
import { Db } from "../src/db.js";
import { identitySchema } from "../src/identity/migrations.js";
import * as identityTables from "../src/identity/schema.js";
import { coreSchema, migrate, type PluginSchema, sqlNames } from "../src/migrate.js";

/** Core's tables and indexes (the event log): in every database, and no plugin's business. */
const CORE_NAMES = new Set(coreSchema.migrations.flatMap((m) => sqlNames(m.sql).created));

/**
 * The names `sql` creates by hand, with the shadow tables SQLite keeps for each virtual table
 * (an FTS5 table `x` stores itself in `x_data`, `x_idx`, `x_content`, `x_docsize`, `x_config`).
 */
function handWrittenNames(sql: string): (name: string) => boolean {
  const created = new Set(sqlNames(sql).created.map((n) => n.toLowerCase()));
  const virtual = [...sql.matchAll(/\bCREATE\s+VIRTUAL\s+TABLE\s+[`"]?(\w+)/gi)].map((m) =>
    String(m[1]).toLowerCase(),
  );
  return (name) => {
    const lower = name.toLowerCase();
    return created.has(lower) || virtual.some((v) => lower.startsWith(`${v}_`));
  };
}

/**
 * Whether drizzle-kit's statement drops a table or index that `tables` does not own: core's, one
 * of another Drizzle plugin's that the migrated database carries because `tables` requires it,
 * or one of the plugin's own that its migration writes by hand (`handWritten`: full-text indexes
 * and triggers drizzle-kit cannot declare, so it takes them for tables nobody declared).
 */
function dropsOthers(statement: string, tables: object): boolean {
  const name = /^DROP\s+(?:TABLE|INDEX|TRIGGER|VIEW)\s+(?:IF\s+EXISTS\s+)?[`"]?([^`"\s;]+)/i.exec(
    statement.trim(),
  )?.[1];
  if (name === undefined) return false;
  if (CORE_NAMES.has(name)) return true;
  return Object.values(DRIZZLE_PLUGINS).some((other) =>
    other.tables !== tables
      ? other.schema.migrations.some((m) => sqlNames(m.sql).created.includes(name))
      : other.handWritten !== undefined && handWrittenNames(other.handWritten)(name),
  );
}

/** A plugin whose tables are Drizzle definitions. */
export interface DrizzlePlugin {
  tables: object;
  schema: PluginSchema;
  /**
   * What migration 1 adds by hand after the generated SQL (and a blank line): full-text search,
   * triggers, seed rows. drizzle-kit neither generates nor compares it.
   */
  handWritten?: string;
}

/**
 * The Drizzle tables of each plugin that declares its tables with Drizzle: the store's own, and
 * those of the packages that own theirs (`<package>/src/schema.ts` and `migrations.ts`), by
 * relative path. This file and the drift test are tooling: nothing the store ships imports them.
 */
export const DRIZZLE_PLUGINS: Record<string, DrizzlePlugin> = {
  identity: { tables: identityTables, schema: identitySchema },
  config: { tables: configTables, schema: configSchema },
  artifact: { tables: artifactTables, schema: artifactSchema },
  auth: { tables: authTables, schema: authSchema },
  cards: { tables: cardsTables, schema: cardsSchema, handWritten: CARDS_CATALOGUE_SQL },
  cluster: { tables: clusterTables, schema: clusterSchema },
  directive: { tables: directiveTables, schema: directiveSchema },
  economy: { tables: economyTables, schema: economySchema },
  exchange: { tables: exchangeTables, schema: exchangeSchema },
  gifts: { tables: giftTables, schema: giftSchema },
  heart: { tables: heartTables, schema: heartSchema },
  initiative: { tables: initiativeTables, schema: initiativeSchema },
  karaoke: { tables: karaokeTables, schema: karaokeSchema },
  market: { tables: marketTables, schema: marketSchema },
  memory: { tables: memoryTables, schema: memorySchema, handWritten: MEMORY_SEARCH_SQL },
  notes: { tables: notesTables, schema: notesSchema },
  report: { tables: reportTables, schema: reportSchema },
  transcript: { tables: transcriptTables, schema: transcriptSchema },
};

/** Migration 1 of a plugin: the generated statements, then its hand-written SQL, if any. */
export function firstMigrationSql(generated: readonly string[], handWritten?: string): string {
  const tables = generated.join("\n");
  return handWritten === undefined ? tables : `${tables}\n${handWritten}`;
}

/** `CREATE TABLE ... );` as `CREATE TABLE ... ) STRICT;`. */
export function strict(statement: string): string {
  return statement.replace(/^(CREATE TABLE [\s\S]*\n\));(\s*)$/, "$1 STRICT;$2");
}

/**
 * A schema module's exports in name order. drizzle-kit emits indexes in the order it is given
 * them, and a module namespace is sorted by name under Node but in declaration order under
 * Vitest: without this, the same tables give two different migrations.
 */
function sorted(tables: object): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(tables).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
}

/** The statements that create `tables` in an empty database, `STRICT` added. */
export async function createSql(tables: object): Promise<string[]> {
  const empty = await generateDrizzleJson({});
  const current = await generateDrizzleJson(sorted(tables));
  return (await generateMigration(empty, current)).map((s) => `${strict(s.trim())}\n`);
}

/** A drizzle-kit client over one `node:sqlite` connection. */
function kitClient(raw: DatabaseSync) {
  return {
    query: async <T>(query: string, params: unknown[] = []) =>
      raw.prepare(query).all(...(params as never[])) as T[],
    run: async (query: string) => raw.exec(query),
    batch: async (queries: string[]) => {
      for (const q of queries) raw.exec(q);
    },
  };
}

/**
 * What drizzle-kit would change in `raw` to match `tables` (empty when they agree, as far as
 * drizzle-kit can see: not `STRICT`, not a partial index's WHERE, not an expression index).
 */
export async function pendingSql(raw: DatabaseSync, tables: object): Promise<string[]> {
  // `_migrations` is the runner's, the event log is core's, and a required plugin's tables are
  // its own; drizzle-kit would drop them as tables it does not know.
  const result = await pushSchema(sorted(tables), kitClient(raw), { table: "_migrations" });
  return result.sqlStatements.filter((s) => !dropsOthers(s, tables));
}

/**
 * A `:memory:` database with `core`, the Drizzle schemas `schema` requires, and `schema` applied
 * from the checked-in migrations.
 */
export function migrated(schema: PluginSchema): { raw: DatabaseSync; db: Db } {
  const raw = new DatabaseSync(":memory:", { enableForeignKeyConstraints: true });
  const db = new Db(raw, systemClock);
  const required = Object.values(DRIZZLE_PLUGINS)
    .map((entry) => entry.schema)
    .filter((s) => schema.requires?.includes(s.plugin));
  migrate(db, [...required, schema]);
  return { raw, db };
}

async function main(plugin: string | undefined): Promise<void> {
  const entry = plugin === undefined ? undefined : DRIZZLE_PLUGINS[plugin];
  if (entry === undefined) {
    const known = Object.keys(DRIZZLE_PLUGINS).join(", ");
    throw new Error(`usage: schema-sql <plugin>; plugins with Drizzle tables: ${known}`);
  }
  if (entry.schema.migrations.length === 0) {
    process.stdout.write((await createSql(entry.tables)).join("\n"));
    return;
  }
  const { raw, db } = migrated(entry.schema);
  try {
    const pending = await pendingSql(raw, entry.tables);
    process.stdout.write(pending.length === 0 ? "-- up to date\n" : `${pending.join("\n")}\n`);
  } finally {
    db.close();
  }
}

const entryFile = process.argv[1];
if (entryFile !== undefined && import.meta.url === pathToFileURL(entryFile).href) {
  await main(process.argv[2]);
}
