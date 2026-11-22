// `db doctor`: each kind of file is told apart, read without changing it, with what the guard
// would say, the checks, the counts and, for V4, what an import would bring.

import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { inspectDatabase, SqliteStore } from "../src/index.js";
import { V4_PROFILE, v4File, v4Iso } from "../src/testing.js";

let dir = "";
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "miyoria-doctor-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const sha = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");

describe("inspectDatabase", () => {
  it("tells a missing, empty, non-database, blank and foreign file apart", () => {
    const at = (name: string) => join(dir, name);
    writeFileSync(at("empty.db"), "");
    writeFileSync(
      at("notes.txt"),
      "not a database at all, just text that is long enough ".repeat(4),
    );
    const blank = new DatabaseSync(at("blank.db"));
    blank.exec("PRAGMA user_version = 1");
    blank.close();
    const foreign = new DatabaseSync(at("foreign.db"));
    foreign.exec("CREATE TABLE notes (x)");
    foreign.close();

    expect(inspectDatabase(at("none.db")).layout).toBe("missing");
    expect(inspectDatabase(at("empty.db"))).toMatchObject({ layout: "empty", refusal: null });
    expect(inspectDatabase(at("notes.txt")).layout).toBe("not_database");
    expect(inspectDatabase(at("blank.db"))).toMatchObject({ layout: "blank", refusal: null });
    const other = inspectDatabase(at("foreign.db"));
    expect(other.layout).toBe("foreign");
    expect(other.refusal).toMatch(/no `_migrations`/);
  });

  it("reads a V4 file without changing it, names the commands, and previews the import", () => {
    const path = join(dir, "miyoria.db");
    v4File(path).close();
    const files = readdirSync(dir);
    const sum = sha(path);
    const report = inspectDatabase(path, { profile: V4_PROFILE });
    expect(readdirSync(dir)).toEqual(files);
    expect(sha(path)).toBe(sum);

    expect(report).toMatchObject({
      layout: "v4",
      v4_version: 18,
      integrity: ["ok"],
      counts: { persons: 5, accounts: 6, events: 1, newest_event: v4Iso(44) },
      import: { persons: 4, accounts: 6, privacy: 1, voice_consent: 3 },
      import_error: null,
    });
    // The orphaned account is the odd row the old schema let through.
    expect(report.foreign_keys?.count).toBe(1);
    for (const command of ["miyoria db archive", "miyoria db import-links", "miyoria db doctor"]) {
      expect(report.refusal).toContain(command);
    }
  });

  it("compares a V5 file's migrations with the code's and counts what it holds", async () => {
    const path = join(dir, "core.db");
    const store = await SqliteStore.open(path);
    store.persons.see({ platform: "discord", id: "1" }, "Owen");
    await store.close();

    const extra = {
      plugin: "economy",
      migrations: [{ version: 1, name: "init", sql: "SELECT 1" }],
    };
    const report = inspectDatabase(path, { schemas: [extra] });
    expect(report).toMatchObject({
      layout: "v5",
      refusal: null,
      integrity: ["ok"],
      foreign_keys: { count: 0 },
      counts: { persons: 1, accounts: 1, events: 0, newest_event: null },
    });
    const byPlugin = new Map(report.migrations?.map((m) => [m.plugin, m]));
    for (const plugin of ["core", "identity", "config", "legacy", "artifact"]) {
      expect(byPlugin.get(plugin), plugin).toMatchObject({ pending: [], unknown: [], changed: [] });
    }
    expect(byPlugin.get("economy")).toMatchObject({ applied: [], pending: [1] });
  });

  it("lists a V5 file's Spaces with their members and which is primary, or would be", async () => {
    const path = join(dir, "core.db");
    const store = await SqliteStore.open(path);
    store.places.seen("discord", "111", "一號");
    store.places.seen("discord", "222", "二號");
    store.places.seen("discord", "333", "走了");
    store.places.left("discord", "333");
    for (const id of ["1", "2", "3"]) store.persons.see({ platform: "discord", id }, `p${id}`);
    await store.close();
    // Two members in 二號, one in 一號.
    const raw = new DatabaseSync(path);
    const space = (guild: string) =>
      (raw.prepare("SELECT id FROM spaces WHERE external_id = ?").get(guild) as { id: string }).id;
    const accounts = (
      raw.prepare("SELECT id FROM accounts ORDER BY id").all() as { id: string }[]
    ).map((a) => a.id);
    const member = raw.prepare(
      "INSERT INTO space_members (space_id, account_id, roles, last_seen) VALUES (?, ?, '[]', 1)",
    );
    member.run(space("222"), accounts[0] as string);
    member.run(space("222"), accounts[1] as string);
    member.run(space("111"), accounts[2] as string);
    raw.close();

    // The first Space an install sees is primary, whatever the counts say.
    const report = inspectDatabase(path);
    expect(report.primary_pending).toBe(false);
    expect(report.spaces).toEqual([
      {
        platform: "discord",
        external_id: "111",
        name: "一號",
        members: 1,
        left: false,
        primary: true,
      },
      {
        platform: "discord",
        external_id: "222",
        name: "二號",
        members: 2,
        left: false,
        primary: false,
      },
      {
        platform: "discord",
        external_id: "333",
        name: "走了",
        members: 0,
        left: true,
        primary: false,
      },
    ]);

    // A file from before identity v2: the one v2 would pick, the most members.
    const old = new DatabaseSync(path);
    old.exec(
      "DROP INDEX spaces_primary_idx; ALTER TABLE spaces DROP COLUMN is_primary; " +
        "DELETE FROM _migrations WHERE plugin = 'identity' AND version = 2",
    );
    old.close();
    const before = inspectDatabase(path);
    expect(before.primary_pending).toBe(true);
    expect(before.spaces?.map((s) => [s.name, s.primary])).toEqual([
      ["二號", true],
      ["一號", false],
      ["走了", false],
    ]);
  });
});
