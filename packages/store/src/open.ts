// `openStore(url)`: opens the SQLite database a store URL names.

import type { Clock } from "@miyoria/types";
import { StoreError } from "./common.js";
import { SqliteStore, type SqliteStoreOptions } from "./sqlite.js";
import type { Store } from "./stores.js";

/** What the CLI uses when no store URL is configured. */
export const DEFAULT_STORE_URL = "sqlite:data/miyoria.db";

export interface OpenStoreOptions {
  clock?: Clock;
  sqlite?: Omit<SqliteStoreOptions, "clock">;
}

/** The SQLite database a store URL names: a file path, or `:memory:`. */
export interface StoreLocation {
  path: string;
}

/**
 * Parses a store URL:
 * - `sqlite:<path>` / `sqlite://<path>`: a SQLite file (relative paths resolve against the
 *   working directory; `sqlite:///abs/path` is absolute);
 * - `sqlite::memory:`, `memory://`, `memory:`: a fresh in-memory SQLite database.
 *
 * Anything else is refused. PostgreSQL was removed: Miyoria stores everything in SQLite.
 */
export function parseStoreUrl(url: string): StoreLocation {
  const trimmed = url.trim();
  if (trimmed.startsWith("memory:") || trimmed === "sqlite::memory:") {
    return { path: ":memory:" };
  }
  if (trimmed.startsWith("sqlite:")) {
    let path = trimmed.slice("sqlite:".length);
    if (path.startsWith("//")) path = path.slice(2);
    // `sqlite:///C:/x.db` names a Windows drive path.
    if (/^\/[A-Za-z]:[\\/]/.test(path)) path = path.slice(1);
    const query = path.indexOf("?");
    if (query >= 0) path = path.slice(0, query);
    if (path === "") throw new StoreError("store URL `sqlite:` has no path");
    return { path: path === ":memory:" ? ":memory:" : decodeURI(path) };
  }
  // Never echo the URL itself: it may carry a password.
  const scheme = /^[A-Za-z][A-Za-z0-9+.-]*:/.exec(trimmed)?.[0] ?? "(none)";
  if (/^postgres(ql)?:$/i.test(scheme)) {
    throw new StoreError(
      `PostgreSQL is no longer supported (store URL scheme \`${scheme}\`): ` +
        "set `core.database_url` to `sqlite:<path>` (default `sqlite:data/miyoria.db`)",
    );
  }
  throw new StoreError(
    `unsupported store URL scheme \`${scheme}\`: use \`sqlite:<path>\` or \`memory://\``,
  );
}

/** Opens the SQLite database a URL names and runs pending migrations. */
export async function openStore(url: string, options: OpenStoreOptions = {}): Promise<Store> {
  const { path } = parseStoreUrl(url);
  const clock = options.clock;
  return SqliteStore.open(path, { ...options.sqlite, ...(clock && { clock }) });
}
