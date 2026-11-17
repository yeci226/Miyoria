// `db import-links` (docs/design/v5-data.md §4.3): what it copies from a V4 database and what it
// leaves, that a second run changes nothing, that a dry run writes nothing, that a failure or a
// clash leaves the new database as it was, and that the old file is never changed.

import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { IdentityImported } from "@miyoria/contracts/events";
import { afterEach, describe, expect, it } from "vitest";
import {
  CutoverError,
  importLinks,
  importLinksFromFile,
  LINK_IMPORT_SOURCE,
  linkImportCounts,
} from "../src/index.js";
import { memoryV4, openTestDb, type TestDb, V4_PROFILE, v4File, v4Iso } from "../src/testing.js";

const NOW = Date.UTC(2026, 10, 15, 12);
const clock = { now: () => NOW };

let open: TestDb[] = [];
afterEach(() => {
  for (const t of open) t.close();
  open = [];
});

function newDb(): TestDb {
  const t = openTestDb({ identity: true, legacy: true, clock });
  open.push(t);
  return t;
}

const target = (t: TestDb) => ({
  db: t.db,
  identity: t.identity as NonNullable<TestDb["identity"]>,
  events: t.events,
});

/** Every row of every table, as text: what "changes nothing" compares. */
function dump(t: TestDb): string {
  const tables = t.db
    .all(
      "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .map((r) => String(r.name))
    .filter((name) => !name.startsWith("memory_fts"));
  return tables
    .map((name) => `${name}:${JSON.stringify(t.db.all(`SELECT * FROM "${name}"`))}`)
    .join("\n");
}

const count = (t: TestDb, table: string) =>
  Number(t.db.get(`SELECT count(*) AS n FROM ${table}`)?.n);

describe("importLinks", () => {
  it("copies people, accounts, handles, choices and the keepsake, and nothing else", () => {
    const t = newDb();
    const before = dump(t);
    const result = importLinks(target(t), memoryV4(), "miyoria-v4.single.db", {
      profile: V4_PROFILE,
    });
    const identity = target(t).identity;

    const owen = identity.person("p-owen");
    expect(owen).toMatchObject({
      name: "Owen",
      handle: "Owen",
      created_at: v4Iso(1),
      prefs: { voice_consent: false },
      legacy: { first_seen: v4Iso(1), old_tier: "知心", cards: 2 },
    });
    expect(identity.accountsOf("p-owen").map((a) => [a.external_id, a.linked_by])).toEqual([
      ["100", "import"],
      ["101", "import"],
    ]);
    expect(identity.person("p-mika")).toMatchObject({
      prefs: { privacy: { presence: false } },
      legacy: { old_tier: "朋友", cards: 0 },
    });
    expect(identity.person("p-rin")).toMatchObject({
      handle: "Rin",
      prefs: { voice_consent: false },
      legacy: { old_tier: null, cards: 1 },
    });
    // `owen` is `Owen` ignoring case: the younger row takes the next suffix.
    expect(identity.person("p-lowen")?.handle).toBe("owen#2");
    // The listener's choice is kept on a person made for it, named by its handle row.
    const listener = identity.personOf({ platform: "discord", id: "500" });
    expect(listener).toMatchObject({
      handle: "Listener",
      prefs: { voice_consent: true },
      legacy: null,
    });
    expect(identity.personRow("p-ghost")).toBeNull();
    expect(identity.personRow("p-gone")).toBeNull();
    expect(identity.account({ platform: "discord", id: "900" })).toBeNull();
    expect(identity.account({ platform: "discord", id: "600" })).toBeNull();

    expect(linkImportCounts(result)).toEqual({
      persons: 4,
      choice_persons: 1,
      accounts: 6,
      handles_kept: 4,
      handles_renamed: 1,
      handles_made: 0,
      privacy: 1,
      voice_consent: 3,
      with_tier: 2,
      cards: 3,
      events: 5,
      skipped_existing: 0,
      skipped_no_accounts: 1,
      orphan_accounts: 1,
      handles_left: 1,
      conflicts: 0,
    });
    expect(result.skipped.unreadable).toEqual(["handle:discord:700"]);

    // One event per person, for the owner, kept; the rest of the database is as it was.
    const events = t.events.query({ order: "asc" });
    expect(events.map((e) => [e.envelope.type, e.envelope.person_id])).toEqual(
      result.persons.map((p) => [IdentityImported.type, p.id]),
    );
    expect(events[0]?.envelope).toMatchObject({
      scope: "owner",
      tier: "keep",
      source: LINK_IMPORT_SOURCE,
    });
    expect(events[0]?.envelope.data).toMatchObject({
      handle: "Owen",
      from: "miyoria-v4.single.db",
    });
    const changed = new Set(["persons", "accounts", "events"]);
    const unchanged = (text: string) =>
      text
        .split("\n")
        .filter((line) => !changed.has(line.slice(0, line.indexOf(":"))))
        .join("\n");
    expect(unchanged(dump(t))).toBe(unchanged(before));
    // Coins and memories are not imported either: they are the economy and memory plugins'
    // tables, not opened here.
    for (const table of ["member_cards", "relationships"]) {
      expect(count(t, table)).toBe(0);
    }
    expect(count(t, "link_codes")).toBe(0);
  });

  it("changes nothing the second time, and counts who it skipped", () => {
    const t = newDb();
    importLinks(target(t), memoryV4(), "old.db", { profile: V4_PROFILE });
    const after = dump(t);
    const again = importLinks(target(t), memoryV4(), "old.db", { profile: V4_PROFILE });
    expect(dump(t)).toBe(after);
    expect(again.persons).toEqual([]);
    expect(again.skipped.existing).toEqual(["p-owen", "p-mika", "p-rin", "p-lowen"]);
    expect(again.skipped.prefs).toBe(1);
    expect(linkImportCounts(again).events).toBe(0);
  });

  it("in a dry run says what it would do and writes nothing", () => {
    const t = newDb();
    const before = dump(t);
    const result = importLinks(target(t), memoryV4(), "old.db", {
      profile: V4_PROFILE,
      dryRun: true,
    });
    expect(dump(t)).toBe(before);
    expect(result.dry_run).toBe(true);
    expect(result.persons.map((p) => p.handle)).toEqual([
      "Owen",
      "Mika",
      "Rin",
      "owen#2",
      "Listener",
    ]);
    expect(result.events).toBe(0);
  });

  it("refuses, writing nothing, when V5 already gave an account to someone", () => {
    const t = newDb();
    target(t).identity.see({ platform: "discord", id: "200" }, "Mika");
    const before = dump(t);
    const dry = importLinks(target(t), memoryV4(), "old.db", { profile: V4_PROFILE, dryRun: true });
    expect(dry.conflicts).toEqual([
      expect.objectContaining({ person: "p-mika", platform: "discord", external_id: "200" }),
    ]);
    expect(() => importLinks(target(t), memoryV4(), "old.db", { profile: V4_PROFILE })).toThrow(
      expect.objectContaining({ code: "conflict" }),
    );
    expect(dump(t)).toBe(before);
  });

  it("leaves the new database as it was when a write fails half way", () => {
    const t = newDb();
    const before = dump(t);
    t.db.exec(
      "CREATE TEMP TRIGGER fail_400 BEFORE INSERT ON accounts WHEN NEW.external_id = '400' " +
        "BEGIN SELECT RAISE(ABORT, 'disk full'); END",
    );
    expect(() => importLinks(target(t), memoryV4(), "old.db", { profile: V4_PROFILE })).toThrow();
    t.db.exec("DROP TRIGGER fail_400");
    expect(dump(t)).toBe(before);
  });

  it("refuses a file that is not V4, and a character the file has no bonds of", () => {
    const t = newDb();
    const v5 = new DatabaseSync(":memory:");
    v5.exec("CREATE TABLE _migrations (plugin TEXT)");
    expect(() => importLinks(target(t), v5, "core.db")).toThrow(
      expect.objectContaining({ code: "not_v4" }),
    );
    expect(() => importLinks(target(t), memoryV4(), "old.db", { profile: "someone" })).toThrow(
      CutoverError,
    );
  });
});

describe("importLinksFromFile", () => {
  let dir = "";
  afterEach(() => {
    if (dir !== "") rmSync(dir, { recursive: true, force: true });
    dir = "";
  });

  const sha = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");

  it("never changes the old file, also while V4 still holds it in WAL mode", () => {
    dir = mkdtempSync(join(tmpdir(), "miyoria-links-"));
    const old = join(dir, "old", "miyoria.db");
    const fresh = join(dir, "new", "core.db");
    mkdirSync(join(dir, "old"));

    // Held: everything is still in the -wal, which the import must read through.
    const writer = v4File(old);
    const files = readdirSync(join(dir, "old")).sort();
    const sums = [sha(old), sha(`${old}-wal`)];
    const result = importLinksFromFile(old, fresh, { profile: V4_PROFILE, clock });
    expect(linkImportCounts(result).persons).toBe(4);
    expect(result.created).toBe(true);
    expect(readdirSync(join(dir, "old")).sort()).toEqual(files);
    expect([sha(old), sha(`${old}-wal`)]).toEqual(sums);
    writer.close();

    // Stopped: V4 checkpointed and removed its -wal; reading it makes no side files.
    const stopped = readdirSync(join(dir, "old"));
    expect(stopped).toEqual(["miyoria.db"]);
    const sum = sha(old);
    const again = importLinksFromFile(old, fresh, { profile: V4_PROFILE, clock, dryRun: true });
    expect(again.skipped.existing).toHaveLength(4);
    expect(readdirSync(join(dir, "old"))).toEqual(stopped);
    expect(sha(old)).toBe(sum);
  });

  it("does not make the new database in a dry run, and refuses the old file as the target", () => {
    dir = mkdtempSync(join(tmpdir(), "miyoria-links-"));
    const old = join(dir, "miyoria.db");
    v4File(old).close();
    const fresh = join(dir, "core.db");
    const dry = importLinksFromFile(old, fresh, { profile: V4_PROFILE, dryRun: true });
    expect(linkImportCounts(dry).persons).toBe(4);
    expect(readdirSync(dir)).toEqual(["miyoria.db"]);
    expect(() => importLinksFromFile(old, old, { profile: V4_PROFILE })).toThrow(
      expect.objectContaining({ code: "same_file" }),
    );
    const copy = join(dir, "copy.db");
    v4File(copy).close();
    expect(() => importLinksFromFile(old, copy, { profile: V4_PROFILE })).toThrow(
      expect.objectContaining({ code: "not_v5" }),
    );
  });
});
