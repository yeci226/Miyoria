// A database opened for a few plugins' tables only (`openPluginDatabase`): what a new file holds,
// and how it shares a file with a full store in both orders.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  appliedMigrations,
  coreSchema,
  type Db,
  openPluginDatabase,
  type PluginSchema,
  SchemaError,
  SqliteStore,
} from "../src/index.js";

const SHOP: PluginSchema = {
  plugin: "shop",
  migrations: [
    { version: 1, name: "init", sql: "CREATE TABLE shop_items (id TEXT PRIMARY KEY) STRICT;" },
  ],
};

const SHOP_V2: PluginSchema = {
  plugin: "shop",
  migrations: [
    ...SHOP.migrations,
    { version: 2, name: "price", sql: "ALTER TABLE shop_items ADD COLUMN price INTEGER;" },
  ],
};

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "miyoria-plugin-db-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function tables(db: Db): string[] {
  return db
    .all(
      "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .map((r) => String(r.name));
}

describe("openPluginDatabase", () => {
  it("a new file holds the bookkeeping and the plugins' tables, nothing of a store", () => {
    const db = openPluginDatabase(join(dir, "data", "machines.db"), [SHOP]);
    try {
      expect(tables(db)).toEqual(["_migrations", "shop_items"]);
      expect(appliedMigrations(db).map((m) => `${m.plugin}:${m.version}`)).toEqual([
        "core:1",
        "shop:1",
      ]);
    } finally {
      db.close();
    }
  });

  it("on a full store's file adds only its plugins' tables and leaves the rest alone", async () => {
    const path = join(dir, "miyoria.db");
    const store = await SqliteStore.open(path);
    await store.close();
    const before = (() => {
      const db = openPluginDatabase(path, []);
      try {
        return { tables: tables(db), applied: appliedMigrations(db) };
      } finally {
        db.close();
      }
    })();
    const db = openPluginDatabase(path, [SHOP]);
    try {
      expect(tables(db)).toEqual([...before.tables, "shop_items"].sort());
      // Nothing of core was applied again: its later migrations are a store's to check.
      const applied = appliedMigrations(db);
      expect(applied.slice(0, before.applied.length)).toEqual(before.applied);
      expect(applied.slice(before.applied.length).map((m) => `${m.plugin}:${m.version}`)).toEqual([
        "shop:1",
      ]);
    } finally {
      db.close();
    }
  });

  it("a store opened later on its file applies the rest of core", async () => {
    const path = join(dir, "miyoria.db");
    openPluginDatabase(path, [SHOP]).close();
    const store = await SqliteStore.open(path, { schemas: [SHOP] });
    try {
      const db = openPluginDatabase(path, [SHOP]);
      try {
        const core = appliedMigrations(db).filter((m) => m.plugin === "core");
        expect(core.map((m) => m.version)).toEqual(coreSchema.migrations.map((m) => m.version));
      } finally {
        db.close();
      }
    } finally {
      await store.close();
    }
  });

  it("migrates its plugins forward and still checks their checksums", () => {
    const path = join(dir, "machines.db");
    openPluginDatabase(path, [SHOP]).close();
    const db = openPluginDatabase(path, [SHOP_V2]);
    db.close();
    const edited: PluginSchema = {
      plugin: "shop",
      migrations: [{ version: 1, name: "init", sql: "CREATE TABLE shop_items (x TEXT) STRICT;" }],
    };
    let error: unknown;
    try {
      openPluginDatabase(path, [edited]).close();
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(SchemaError);
    expect((error as SchemaError).code).toBe("checksum_mismatch");
  });
});
