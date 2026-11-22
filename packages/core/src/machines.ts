// The machines Core works with, whichever profile runs (docs/design/v5-profiles.md §7).
//
// The hosts that joined, their keys' hashes, invites, estimates and the owner's routing controls
// are the `cluster_*` tables of the install's database. A profile on the install's config runs on
// that database, so the store's tables are the machines' and nothing else is opened: the install
// that existed before profiles is exactly as it was. A profile with a database of its own opens
// the install's database beside its store for those tables alone (`openMachineDatabase`); a new
// install whose own character never ran gets a file there with `_migrations` and `cluster_*` only.
// There is one copy of the pairing, never two.

import { resolve } from "node:path";
import { type ClusterTables, clusterTables, openMachineDatabase } from "@miyoria/cluster";
import { getLogger } from "@miyoria/runtime/kernel";
import type { Store } from "@miyoria/store";
import type { Clock } from "@miyoria/types";
import type { MachineSource } from "./profiles.js";
import { sqlitePath } from "./settings.js";

const log = getLogger("core.machines");

/** The machines' tables Core runs with, and how to let go of them when it stops. */
export interface Machines {
  readonly tables: ClusterTables;
  /** The machine database's file when it is not the store's; `null` for the store's own. */
  readonly path: string | null;
  close(): void;
}

function samePath(a: string, b: string): boolean {
  const norm = (p: string) =>
    process.platform === "win32" ? resolve(p).toLowerCase() : resolve(p);
  return norm(a) === norm(b);
}

/**
 * The machines' tables for a store (`storeUrl`: the URL it was opened at, when Core opened it).
 * Without a `source` (the profile runs on the install's config), or when the source names the
 * store's own file or no file at all, they are the store's.
 */
export function openMachines(
  store: Store,
  source: MachineSource | null | undefined,
  options: { storeUrl?: string | null; clock?: Clock } = {},
): Machines {
  const own: Machines = { tables: store.plugin(clusterTables), path: null, close: () => {} };
  if (source === undefined || source === null) return own;
  const path = source.databaseUrl === null ? null : sqlitePath(source.databaseUrl);
  if (path === null) {
    log.warn("the install's database is not a file: this profile keeps its machines in its own");
    return own;
  }
  const storePath = options.storeUrl == null ? null : sqlitePath(options.storeUrl);
  if (storePath !== null && samePath(storePath, path)) return own;
  const opened = openMachineDatabase(
    path,
    options.clock === undefined ? {} : { clock: options.clock },
  );
  log.info({ path }, "the machines are in the install's database");
  return { tables: opened.tables, path, close: () => opened.close() };
}
