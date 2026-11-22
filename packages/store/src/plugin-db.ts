// A database opened for a few plugins' tables only (docs/design/v5-profiles.md §7): the
// install's machine database, which a profile with a database of its own opens beside its store.
//
// The same driver, pragmas and migration runner as the store (`SqliteStore.open`), with core's
// bookkeeping only (`MigrateOptions.core = "bookkeeping"`): a file this makes holds `_migrations`
// and the plugins' tables, nothing else. On a full store's file it migrates the given plugins and
// leaves every other table as it is.

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { type Clock, systemClock } from "@miyoria/types";
import { StoreError } from "./common.js";
import { Db } from "./db.js";
import { checkDatabaseFile, migrate, type PluginSchema } from "./migrate.js";

export interface PluginDatabaseOptions {
  clock?: Clock;
  /** How long a write waits for another process's lock. Default 5000 ms. */
  busyTimeoutMs?: number;
}

/**
 * Opens (creating it and its directory if needed) the SQLite file at `path`, or `":memory:"`,
 * and migrates `schemas` on it. A file the store would refuse (a V4 database, a foreign one) is
 * refused the same way, before anything is written.
 */
export function openPluginDatabase(
  path: string,
  schemas: readonly PluginSchema[],
  options: PluginDatabaseOptions = {},
): Db {
  const memory = path === ":memory:";
  if (!memory) {
    mkdirSync(dirname(path), { recursive: true });
    checkDatabaseFile(path);
  }
  let raw: DatabaseSync;
  try {
    raw = new DatabaseSync(path, { enableForeignKeyConstraints: true });
  } catch (cause) {
    throw new StoreError("cannot open the SQLite database", { cause });
  }
  const db = new Db(raw, options.clock ?? systemClock);
  try {
    db.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.floor(options.busyTimeoutMs ?? 5000))}`);
    if (!memory) {
      db.exec("PRAGMA journal_mode = WAL");
      db.exec("PRAGMA synchronous = NORMAL");
    }
    db.exec("PRAGMA foreign_keys = ON");
    migrate(db, schemas, { location: path, core: "bookkeeping" });
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}
