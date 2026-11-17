// `db archive` (docs/design/v5-data.md §7 steps 2-4): the three files move together, the copy and
// the manifest are made, an open database is refused, a missing side file is fine, and a run that
// stopped at any step finishes when run again.

import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { archiveDatabase, archiveDate, heldFiles } from "../src/index.js";
import { v4File } from "../src/testing.js";

const NOW = Date.UTC(2026, 10, 15, 12);
const clock = { now: () => NOW };
const DATE = archiveDate(NOW);
const BASE = `miyoria-v4-${DATE}`;

let root = "";
let data = "";
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "miyoria-archive-"));
  data = join(root, "data");
  mkdirSync(data);
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const sha = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
const db = () => join(data, "miyoria.db");
const archive = () => join(data, "archive");

/**
 * A V4 database as a stopped (or killed) Core left it: with `wal`, its last writes still in the
 * `-wal` next to an `-shm`, nothing holding them; without, the file alone.
 */
function stoppedV4(wal: boolean): void {
  if (!wal) {
    v4File(db()).close();
    return;
  }
  const scratch = join(root, "scratch");
  mkdirSync(scratch);
  const writer = v4File(join(scratch, "miyoria.db"));
  for (const suffix of ["", "-wal", "-shm"]) {
    copyFileSync(join(scratch, `miyoria.db${suffix}`), `${db()}${suffix}`);
  }
  writer.close();
}

const allArchived = [
  "MANIFEST.txt",
  `${BASE}.db`,
  `${BASE}.db-shm`,
  `${BASE}.db-wal`,
  `${BASE}.plan.json`,
  `${BASE}.single.db`,
];

function manifestLines(): string[] {
  return readFileSync(join(archive(), "MANIFEST.txt"), "utf8")
    .split("\n")
    .filter((l) => l !== "" && !l.startsWith("#"));
}

describe("archiveDatabase", () => {
  it("moves the three files together, copies them into one and hashes both", async () => {
    stoppedV4(true);
    const sums = { db: sha(db()), wal: sha(`${db()}-wal`) };
    const result = await archiveDatabase({ path: db(), clock });
    expect(result.state).toBe("archived");
    expect(readdirSync(data)).toEqual(["archive"]);
    expect(readdirSync(archive()).sort()).toEqual(allArchived);
    expect(sha(join(archive(), `${BASE}.db`))).toBe(sums.db);
    expect(sha(join(archive(), `${BASE}.db-wal`))).toBe(sums.wal);

    // The copy is one file with what was still in the WAL.
    const single = join(archive(), `${BASE}.single.db`);
    expect(manifestLines()).toEqual([
      `${sums.db}  ${BASE}.db`,
      `${sums.wal}  ${BASE}.db-wal`,
      `${sha(single)}  ${BASE}.single.db`,
    ]);
    const copy = new DatabaseSync(single, { readOnly: true });
    expect(copy.prepare("SELECT count(*) AS n FROM people").get()?.n).toBe(5);
    expect(copy.prepare("PRAGMA journal_mode").get()?.journal_mode).toBe("delete");
    copy.close();

    const manifest = readFileSync(join(archive(), "MANIFEST.txt"), "utf8");
    const again = await archiveDatabase({ path: db(), clock });
    expect(again.state).toBe("already");
    expect(readdirSync(archive()).sort()).toEqual(allArchived);
    expect(readFileSync(join(archive(), "MANIFEST.txt"), "utf8")).toBe(manifest);
  });

  it("refuses, moving nothing, while V4 holds the database", async () => {
    const writer = v4File(db());
    try {
      const files = [db(), `${db()}-wal`, `${db()}-shm`];
      expect(heldFiles(files)).toEqual(files);
      await expect(archiveDatabase({ path: db(), clock })).rejects.toMatchObject({ code: "held" });
      expect(readdirSync(data).sort()).toEqual(["miyoria.db", "miyoria.db-shm", "miyoria.db-wal"]);
    } finally {
      writer.close();
    }
    expect(heldFiles([db()])).toEqual([]);
  });

  it("archives a file without its side files, and a dry run changes nothing", async () => {
    stoppedV4(false);
    const dry = await archiveDatabase({ path: db(), clock, dryRun: true });
    expect(dry.state).toBe("planned");
    expect(dry.files.map((f) => f.to)).toEqual([join(archive(), `${BASE}.db`)]);
    expect(readdirSync(data)).toEqual(["miyoria.db"]);

    await archiveDatabase({ path: db(), clock });
    expect(readdirSync(archive()).sort()).toEqual([
      "MANIFEST.txt",
      `${BASE}.db`,
      `${BASE}.plan.json`,
      `${BASE}.single.db`,
    ]);
    expect(manifestLines()).toHaveLength(2);
  });

  it("finishes a run that stopped at any step when run again", async () => {
    for (const stop of ["rename-wal", "rename-shm", "rename-db", "copy", "manifest"]) {
      rmSync(data, { recursive: true, force: true });
      rmSync(join(root, "scratch"), { recursive: true, force: true });
      mkdirSync(data);
      stoppedV4(true);
      const sums = { db: sha(db()), wal: sha(`${db()}-wal`) };
      const crash = (step: string) => {
        if (step === stop) throw new Error(`killed before ${step}`);
      };
      await expect(archiveDatabase({ path: db(), clock, onStep: crash })).rejects.toThrow(/killed/);
      // An unfinished copy, as a kill during VACUUM INTO leaves it.
      if (stop === "copy") writeFileSync(join(archive(), `${BASE}.single.db.partial`), "half");

      const result = await archiveDatabase({ path: db(), clock });
      expect(result, stop).toMatchObject({ state: "archived", resumed: true });
      expect(readdirSync(data), stop).toEqual(["archive"]);
      expect(readdirSync(archive()).sort(), stop).toEqual(allArchived);
      expect(manifestLines()[0], stop).toBe(`${sums.db}  ${BASE}.db`);
      expect(manifestLines()[1], stop).toBe(`${sums.wal}  ${BASE}.db-wal`);
      expect(manifestLines(), stop).toHaveLength(3);
      expect(existsSync(join(archive(), `${BASE}.single.db.partial`)), stop).toBe(false);
    }
  });

  it("refuses when a new database appeared after part of an archive moved", async () => {
    stoppedV4(true);
    const crash = (step: string) => {
      if (step === "rename-db") throw new Error("killed");
    };
    await expect(archiveDatabase({ path: db(), clock, onStep: crash })).rejects.toThrow();
    // Core started again on the half-moved folder and made a new -wal.
    writeFileSync(`${db()}-wal`, "");
    await expect(archiveDatabase({ path: db(), clock })).rejects.toMatchObject({
      code: "archive_state",
    });
    expect(existsSync(db())).toBe(true);
  });
});
