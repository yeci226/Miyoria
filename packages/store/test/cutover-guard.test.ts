// Core's guard refuses a V4 file without leaving anything beside it: a stopped V4 left its file in
// WAL mode with no `-wal`, where a plain read-only connection would create `-wal` and `-shm`.

import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { archiveDatabase, checkDatabaseFile, SqliteStore } from "../src/index.js";
import { v4File } from "../src/testing.js";

let dir = "";
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("checkDatabaseFile", () => {
  it("refuses a stopped V4 file and leaves its folder as it was", async () => {
    dir = mkdtempSync(join(tmpdir(), "miyoria-guard-"));
    const path = join(dir, "miyoria.db");
    v4File(path).close();
    expect(readdirSync(dir)).toEqual(["miyoria.db"]);
    expect(() => checkDatabaseFile(path)).toThrow(
      expect.objectContaining({ code: "old_database" }),
    );
    await expect(SqliteStore.open(path)).rejects.toThrow(/miyoria db archive/);
    expect(readdirSync(dir)).toEqual(["miyoria.db"]);
  });

  it("is not archived when it is the new database", async () => {
    dir = mkdtempSync(join(tmpdir(), "miyoria-guard-"));
    const path = join(dir, "core.db");
    await (await SqliteStore.open(path)).close();
    await expect(archiveDatabase({ path })).rejects.toMatchObject({ code: "not_v4" });
  });
});
