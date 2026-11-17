// `@miyoria/store/testing`: a migrated in-memory database for tests of plugin schemas and of the
// event log.
//
//     const t = openTestDb({ plugins: [economySchema] });
//     try { t.db.run("INSERT INTO economy_ledger ..."); } finally { t.close(); }

import { DatabaseSync } from "node:sqlite";
import { type Clock, systemClock } from "@miyoria/types";
import { configSchema } from "./config/migrations.js";
import { Db } from "./db.js";
import { EventStore } from "./events/log.js";
import { Identity } from "./identity/identity.js";
import { identitySchema } from "./identity/migrations.js";
import { legacySchema } from "./legacy-schema/index.js";
import { type AppliedMigration, migrate, type PluginSchema } from "./migrate.js";

export { fillV4, memoryV4, V4_PROFILE, v4File, v4Iso, v4Micros } from "./cutover/v4-fixture.js";

export interface OpenTestDbOptions {
  /** Schemas to apply after `core`, in dependency order. */
  plugins?: readonly PluginSchema[];
  /** Also apply the `identity` schema and return its operations. Default false. */
  identity?: boolean;
  /** Also apply the `config` schema (config revisions, place settings, plugin state). */
  config?: boolean;
  /** Also apply the store's V4 tables (the temporary `legacy` schema). Default false. */
  legacy?: boolean;
  /** "Now" for `_migrations.applied_at` and anything the test stamps through `db`. */
  clock?: Clock;
}

export interface TestDb {
  readonly db: Db;
  /** What the runner applied, in order. */
  readonly applied: readonly AppliedMigration[];
  /** Persons, accounts and places, when `identity` was asked for. */
  readonly identity: Identity | null;
  /** The event log (core), resolving places through `identity` when it is there. */
  readonly events: EventStore;
  close(): void;
}

/** A fresh `:memory:` database with `core` and the given schemas applied. */
export function openTestDb(options: OpenTestDbOptions = {}): TestDb {
  const raw = new DatabaseSync(":memory:", { enableForeignKeyConstraints: true });
  const db = new Db(raw, options.clock ?? systemClock);
  try {
    const schemas = [
      ...(options.identity ? [identitySchema] : []),
      ...(options.config ? [configSchema] : []),
      ...(options.legacy ? [legacySchema] : []),
      ...(options.plugins ?? []),
    ];
    const applied = migrate(db, schemas, { location: ":memory:" });
    const identity = options.identity ? new Identity(db) : null;
    const events = new EventStore(db, { identity });
    return { db, applied, identity, events, close: () => db.close() };
  } catch (error) {
    db.close();
    throw error;
  }
}
