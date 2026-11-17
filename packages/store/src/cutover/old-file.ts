// Reading a database file without changing it, for the cut-over tools (docs/design/v5-data.md §7,
// §8 step 12): `db import-links` reads the V4 file, `db doctor` looks at any file, `db archive`
// copies the archived one.
//
// A plain read-only SQLite connection can still leave traces: on a file in WAL mode it creates the
// `-wal` and `-shm` files when they are missing, and they stay after it closes. So the connection
// is chosen by what is on disk:
// - a rollback-journal file, or a WAL file whose `-wal` and `-shm` are both there (another
//   connection may hold it open): `mode=ro`. SQLite reads the WAL through the index and never
//   writes the file or its `-wal`;
// - a WAL file without a `-wal`: nothing is in a WAL, so `immutable=1` reads the file alone,
//   without locks or side files;
// - a `-wal` without its `-shm` (a crash left it; nothing has it open, an open WAL connection
//   always has the index): the file and its `-wal` are copied to a private temporary folder and
//   the copy is read; the folder is removed on close.

import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdtempSync,
  openSync,
  readSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { StoreError } from "../common.js";

/** Why a cut-over tool refused. */
export type CutoverErrorCode =
  | "missing"
  | "not_database"
  | "not_v4"
  | "not_v5"
  | "profile"
  | "conflict"
  | "held"
  | "archive_state"
  | "same_file";

/** A cut-over tool refused, before writing anything (or after undoing what it wrote). */
export class CutoverError extends StoreError {
  readonly code: CutoverErrorCode;

  constructor(code: CutoverErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.code = code;
  }
}

const MAGIC = "SQLite format 3\0";

/** What is on disk for one database file, read without opening it as a database. */
export interface FileFacts {
  path: string;
  exists: boolean;
  /** Bytes of the main file (0 when missing). */
  size: number;
  /** Bytes of the `-wal` and `-shm` files, `null` when absent. */
  wal: number | null;
  shm: number | null;
  /** The header names WAL mode; `null` when the file is not a SQLite database. */
  walMode: boolean | null;
}

function sizeOf(path: string): number | null {
  try {
    const st = statSync(path);
    return st.isFile() ? st.size : null;
  } catch {
    return null;
  }
}

/** The first 100 bytes (the SQLite header), or fewer when the file is shorter. */
function header(path: string): Buffer {
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(100);
    const n = readSync(fd, buf, 0, 100, 0);
    return buf.subarray(0, n);
  } finally {
    closeSync(fd);
  }
}

export function fileFacts(path: string): FileFacts {
  const size = sizeOf(path);
  const facts: FileFacts = {
    path,
    exists: size !== null,
    size: size ?? 0,
    wal: sizeOf(`${path}-wal`),
    shm: sizeOf(`${path}-shm`),
    walMode: null,
  };
  if (size !== null && size >= 100) {
    const head = header(path);
    if (head.length === 100 && head.subarray(0, 16).toString("latin1") === MAGIC) {
      // Bytes 18 and 19: file format write and read versions, 2 for WAL.
      facts.walMode = head[18] === 2 || head[19] === 2;
    }
  }
  return facts;
}

/** A read-only connection that leaves the file and its side files as they were. */
export interface ReadOnlyDatabase {
  readonly db: DatabaseSync;
  /** How it was opened (see the file comment). */
  readonly how: "direct" | "immutable" | "copy";
  close(): void;
}

function uri(path: string, query: string): URL {
  return new URL(`${pathToFileURL(resolve(path)).href}?${query}`);
}

/**
 * Opens `path` read-only without creating, writing, checkpointing or deleting anything next to it
 * (see the file comment). Throws a `CutoverError` for a missing file or one that is not a SQLite
 * database.
 */
export function openReadOnly(path: string): ReadOnlyDatabase {
  const facts = fileFacts(path);
  if (!facts.exists) throw new CutoverError("missing", `${path} does not exist`);
  if (facts.walMode === null) {
    throw new CutoverError("not_database", `${path} is not a SQLite database`);
  }
  try {
    if (!facts.walMode || (facts.wal !== null && facts.shm !== null)) {
      const db = new DatabaseSync(uri(path, "mode=ro"), { readOnly: true });
      return { db, how: "direct", close: () => db.close() };
    }
    if (facts.wal === null) {
      const db = new DatabaseSync(uri(path, "immutable=1"), { readOnly: true });
      return { db, how: "immutable", close: () => db.close() };
    }
    const dir = mkdtempSync(join(tmpdir(), "miyoria-read-"));
    try {
      const copy = join(dir, basename(path));
      copyFileSync(path, copy);
      copyFileSync(`${path}-wal`, `${copy}-wal`);
      const db = new DatabaseSync(uri(copy, "mode=ro"), { readOnly: true });
      return {
        db,
        how: "copy",
        close: () => {
          db.close();
          rmSync(dir, { recursive: true, force: true });
        },
      };
    } catch (error) {
      rmSync(dir, { recursive: true, force: true });
      throw error;
    }
  } catch (cause) {
    if (cause instanceof CutoverError) throw cause;
    throw new CutoverError("not_database", `cannot read ${path} as a SQLite database`, { cause });
  }
}

/** The names of the tables of a database (SQLite's own excluded). */
export function tablesOf(db: DatabaseSync): Set<string> {
  const rows = db
    .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all();
  return new Set(rows.map((r) => String(r.name)));
}

/** Whether `a` and `b` name the same file (both must exist to be the same). */
export function sameFile(a: string, b: string): boolean {
  if (resolve(a) === resolve(b)) return true;
  if (!existsSync(a) || !existsSync(b)) return false;
  const sa = statSync(a);
  const sb = statSync(b);
  return sa.ino !== 0 && sa.dev === sb.dev && sa.ino === sb.ino;
}
