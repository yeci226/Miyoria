// Every plugin whose tables are Drizzle definitions (`scripts/schema-sql.ts` `DRIZZLE_PLUGINS`):
// its checked-in migrations and its Drizzle tables cannot drift apart. What each schema's own
// constraints do is tested beside it (`identity-schema.test.ts`, `config.test.ts`). What a plugin
// writes by hand after its generated SQL (`handWritten`: full-text indexes, triggers) is checked
// to follow it unchanged; drizzle-kit does not see it, and the drift check leaves it alone.

import { describe, expect, it } from "vitest";
import {
  createSql,
  DRIZZLE_PLUGINS,
  firstMigrationSql,
  migrated,
  pendingSql,
} from "../scripts/schema-sql.js";
import { coreSchema, lintSchemas, migrate, orderSchemas } from "../src/index.js";

/** The table names a plugin's generated SQL creates. */
function tablesOf(statements: readonly string[]): string[] {
  return statements
    .map((s) => /^CREATE TABLE `([^`]+)`/.exec(s)?.[1])
    .filter((name): name is string => name !== undefined)
    .sort();
}

describe.each(Object.entries(DRIZZLE_PLUGINS))("the %s schema", (id, plugin) => {
  const { tables, schema } = plugin;
  // The first migration is the whole schema while it is the only one. Once a second one exists,
  // the check is `pendingSql` below (what drizzle-kit would still change) plus the index comparison.
  it.skipIf(schema.migrations.length > 1)(
    "is the SQL drizzle-kit generates from the Drizzle tables, STRICT added",
    async () => {
      expect(schema.migrations).toHaveLength(1);
      const generated = firstMigrationSql(await createSql(tables), plugin.handWritten);
      if (schema.migrations[0]?.sql !== generated) {
        // The message is the migration to check in.
        expect.fail(`${id} migration 1 differs from the Drizzle tables; generated:\n${generated}`);
      }
    },
  );

  it("migrates into a database drizzle-kit finds nothing to change in", async () => {
    const { raw, db } = migrated(schema);
    try {
      expect(await pendingSql(raw, tables)).toEqual([]);
      // What drizzle-kit does not compare: STRICT, and the text of every index (a partial
      // index's WHERE, an index on an expression).
      const generated = await createSql(tables);
      const names = tablesOf(generated);
      expect(names.length).toBeGreaterThan(0);
      const list = raw.prepare("PRAGMA table_list").all() as { name: string; strict: number }[];
      for (const name of names) {
        expect(list.find((t) => t.name === name)?.strict, name).toBe(1);
      }
      // The plugin's own indexes: core's event log is in every database.
      const indexes = (
        raw
          .prepare(
            "SELECT name, sql, tbl_name FROM sqlite_schema WHERE type = 'index' AND sql IS NOT NULL",
          )
          .all() as { name: string; sql: string; tbl_name: string }[]
      ).filter((i) => names.includes(i.tbl_name));
      const wanted = generated
        .filter((s) => /^CREATE (UNIQUE )?INDEX/.test(s))
        .map((s) => s.trim().replace(/;$/, ""));
      expect(indexes.map((i) => i.sql).sort()).toEqual([...wanted].sort());
    } finally {
      db.close();
    }
  });

  it("passes the naming lint, and re-running is a no-op", () => {
    const required = Object.values(DRIZZLE_PLUGINS)
      .map((entry) => entry.schema)
      .filter((s) => schema.requires?.includes(s.plugin));
    expect(lintSchemas(orderSchemas([coreSchema, ...required, schema]))).toEqual([]);
    const { db } = migrated(schema);
    try {
      expect(migrate(db, [...required, schema])).toEqual([]);
    } finally {
      db.close();
    }
  });
});

it("covers identity, config, the artifact store and the plugins that own their tables", () => {
  expect(Object.keys(DRIZZLE_PLUGINS).sort()).toEqual([
    "artifact",
    "auth",
    "cards",
    "cluster",
    "config",
    "directive",
    "economy",
    "exchange",
    "gifts",
    "heart",
    "identity",
    "initiative",
    "karaoke",
    "market",
    "memory",
    "notes",
    "report",
    "transcript",
  ]);
});
