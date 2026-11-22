// The migration runner: bookkeeping, checksums, order, the naming lint, and the refusal to touch
// a V4 database.

import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openTestDb } from "@miyoria/store/testing";
import { systemClock } from "@miyoria/types";
import { describe, expect, it } from "vitest";
import {
  appliedMigrations,
  checksum,
  coreSchema,
  Db,
  Identity,
  identitySchema,
  legacySchema,
  lintSchemas,
  migrate,
  openStore,
  orderSchemas,
  type PluginSchema,
  SchemaError,
  SpacePlaces,
  SqliteStore,
} from "../src/index.js";

function withTempDir<T>(fn: (dir: string) => Promise<T> | T): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "miyoria-migrate-"));
  return Promise.resolve()
    .then(() => fn(dir))
    .finally(() => rmSync(dir, { recursive: true, force: true }));
}

function fileDb(path: string): Db {
  return new Db(new DatabaseSync(path, { enableForeignKeyConstraints: true }), systemClock);
}

function schema(plugin: string, sqls: string[], requires?: string[]): PluginSchema {
  return {
    plugin,
    ...(requires && { requires }),
    migrations: sqls.map((sql, i) => ({ version: i + 1, name: `step${i + 1}`, sql })),
  };
}

function thrown(fn: () => unknown): SchemaError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(SchemaError);
    return error as SchemaError;
  }
  throw new Error("expected a SchemaError");
}

/** sha256 of every file in a directory, by name. */
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of readdirSync(dir).sort()) {
    out[name] = createHash("sha256")
      .update(readFileSync(join(dir, name)))
      .digest("hex");
  }
  return out;
}

const SHOP = schema("shop", [
  "CREATE TABLE shop_items (id TEXT PRIMARY KEY, name TEXT NOT NULL) STRICT;",
  "CREATE INDEX shop_items_name_idx ON shop_items (name);",
]);

describe("bookkeeping", () => {
  it("records core and legacy with checksums, and builds the V4 tables as they were", () => {
    const t = openTestDb({ legacy: true });
    try {
      const rows = appliedMigrations(t.db);
      expect(rows.map((r) => `${r.plugin}:${r.version}`)).toEqual([
        "core:1",
        "core:2",
        "core:3",
        "core:4",
        "core:5",
        "core:6",
        "core:7",
        "legacy:1",
      ]);
      expect(rows[0]).toMatchObject({
        name: "bookkeeping",
        checksum: checksum(coreSchema.migrations[0]?.sql ?? ""),
      });
      for (const m of legacySchema.migrations) {
        const row = rows.find((r) => r.plugin === "legacy" && r.version === m.version);
        expect(row?.checksum).toBe(createHash("sha256").update(m.sql).digest("hex"));
      }
      expect(t.applied).toEqual(rows);
      const tables = t.db
        .all("SELECT name FROM sqlite_schema WHERE type = 'table'")
        .map((r) => r.name);
      expect(tables).toEqual(expect.arrayContaining(["relationships", "member_cards"]));
      expect(tables).not.toContain("schema_version");
      // Chat lines are events (core migration 3); so are decisions, turn outcomes and audit
      // entries (core migration 4). Settings are rows of `plugin_state`, and module on/off is a
      // flag in the current config revision (config migration 1).
      for (const gone of [
        "message_log",
        "decision_log",
        "turn_outcomes",
        "audit_log",
        "profile_settings",
        "module_state",
        // The auth plugin's tables (v5-data §8 step 9a).
        "roles",
        "role_assignments",
        "role_mappings",
        "node_overrides",
        "directives",
        // Runtime persona edits are config's `config_persona_overrides`.
        "persona_overrides",
        // The economy plugin's tables (v5-data §8 step 9a).
        "coin_ledger",
        "coin_wallets",
        "fortunes",
        "bounties",
        "economy_docs",
        // The memory plugin's tables (v5-data §8 step 9b).
        "memory_records",
        "memory_fts",
        "memory_vector_version",
      ]) {
        expect(tables).not.toContain(gone);
      }
      // Re-running is a no-op.
      expect(migrate(t.db, [legacySchema])).toEqual([]);
      expect(appliedMigrations(t.db)).toEqual(rows);
    } finally {
      t.close();
    }
  });

  it("the legacy schema is one migration with LF line ends (what it builds: legacy-schema.test.ts)", () => {
    expect(legacySchema.migrations.map((m) => [m.version, m.name])).toEqual([[1, "init"]]);
    for (const m of legacySchema.migrations) expect(m.sql).not.toContain("\r");
  });

  it("applies a plugin schema after core, and only its new migrations later", () => {
    const first = openTestDb({ plugins: [{ ...SHOP, migrations: SHOP.migrations.slice(0, 1) }] });
    try {
      expect(first.applied.map((m) => `${m.plugin}:${m.version}`)).toEqual([
        "core:1",
        "core:2",
        "core:3",
        "core:4",
        "core:5",
        "core:6",
        "core:7",
        "shop:1",
      ]);
      const later = migrate(first.db, [SHOP]);
      expect(later.map((m) => `${m.plugin}:${m.version}`)).toEqual(["shop:2"]);
    } finally {
      first.close();
    }
  });

  it("a new file gets incremental auto-vacuum before its first table", () =>
    withTempDir(async (dir) => {
      const path = join(dir, "new.db");
      await (await SqliteStore.open(path)).close();
      const raw = new DatabaseSync(path);
      expect(raw.prepare("PRAGMA auto_vacuum").get()).toEqual({ auto_vacuum: 2 });
      raw.close();
    }));

  it("a failing migration rolls back with its row and names itself", () => {
    const t = openTestDb();
    try {
      const bad = schema("shop", [
        "CREATE TABLE shop_items (id TEXT PRIMARY KEY) STRICT; INSERT INTO shop_nothing VALUES (1);",
      ]);
      const error = thrown(() => migrate(t.db, [bad]));
      expect(error.code).toBe("failed");
      expect(error.message).toMatch(/shop migration 1 \(step1\) failed/);
      expect(appliedMigrations(t.db).map((m) => m.plugin)).toEqual([
        "core",
        "core",
        "core",
        "core",
        "core",
        "core",
        "core",
      ]);
      expect(t.db.get("SELECT name FROM sqlite_schema WHERE name = 'shop_items'")).toBeUndefined();
    } finally {
      t.close();
    }
  });
});

describe("refusals before any write", () => {
  it("an edited migration: checksum mismatch, and nothing else applied", () =>
    withTempDir((dir) => {
      const path = join(dir, "x.db");
      const db = fileDb(path);
      migrate(db, [{ ...SHOP, migrations: SHOP.migrations.slice(0, 1) }], { location: path });
      const edited: PluginSchema = {
        ...SHOP,
        migrations: [
          {
            ...(SHOP.migrations[0] as PluginSchema["migrations"][number]),
            sql: "CREATE TABLE shop_items (id TEXT) STRICT;",
          },
          SHOP.migrations[1] as PluginSchema["migrations"][number],
        ],
      };
      const error = thrown(() => migrate(db, [edited], { location: path }));
      expect(error.code).toBe("checksum_mismatch");
      expect(error.message).toContain(path);
      expect(error.message).toMatch(/shop migration 1 \(step1\) changed after it was applied/);
      expect(appliedMigrations(db).map((m) => `${m.plugin}:${m.version}`)).toEqual([
        "core:1",
        "core:2",
        "core:3",
        "core:4",
        "core:5",
        "core:6",
        "core:7",
        "shop:1",
      ]);
      db.close();
    }));

  it("a recorded migration missing from the code; an uninstalled plugin is left alone", () => {
    const t = openTestDb({ plugins: [SHOP] });
    try {
      const error = thrown(() =>
        migrate(t.db, [{ ...SHOP, migrations: SHOP.migrations.slice(0, 1) }]),
      );
      expect(error.code).toBe("missing_migration");
      expect(error.message).toMatch(/shop migration 2 \(step2\) was applied but this build/);
      // Without `shop` installed at all, its rows and tables stay and nothing fails.
      expect(migrate(t.db, [])).toEqual([]);
      expect(t.db.get("SELECT name FROM sqlite_schema WHERE name = 'shop_items'")).toBeDefined();
    } finally {
      t.close();
    }
  });

  it("a new migration numbered below one already applied", () => {
    const three = schema("shop", ["CREATE TABLE shop_a (x INTEGER) STRICT;"]);
    const t = openTestDb({
      plugins: [
        {
          ...three,
          migrations: [{ version: 3, name: "c", sql: "CREATE TABLE shop_c (x INTEGER) STRICT;" }],
        },
      ],
    });
    try {
      const error = thrown(() =>
        migrate(t.db, [
          {
            plugin: "shop",
            migrations: [
              { version: 2, name: "b", sql: "CREATE TABLE shop_b (x INTEGER) STRICT;" },
              { version: 3, name: "c", sql: "CREATE TABLE shop_c (x INTEGER) STRICT;" },
            ],
          },
        ]),
      );
      expect(error.code).toBe("out_of_order");
      expect(t.db.get("SELECT name FROM sqlite_schema WHERE name = 'shop_b'")).toBeUndefined();
    } finally {
      t.close();
    }
  });

  it("a database with tables but no `_migrations`", () =>
    withTempDir(async (dir) => {
      const path = join(dir, "other.db");
      const raw = new DatabaseSync(path);
      raw.exec("CREATE TABLE notes (x TEXT)");
      raw.close();
      const before = snapshot(dir);
      await expect(SqliteStore.open(path)).rejects.toThrow(/has tables but no `_migrations`/);
      expect(snapshot(dir)).toEqual(before);
    }));
});

describe("a V4 database (`schema_version`)", () => {
  /** A file shaped like the live V4 database: `schema_version` plus a table with a row. */
  function v4(path: string, wal: boolean): DatabaseSync {
    const raw = new DatabaseSync(path);
    if (wal) raw.exec("PRAGMA journal_mode = WAL");
    raw.exec(
      "CREATE TABLE schema_version (version INTEGER PRIMARY KEY, name TEXT NOT NULL, " +
        "applied_at INTEGER NOT NULL); INSERT INTO schema_version VALUES (17, '0017_goal_fulfilled', 0); " +
        "CREATE TABLE message_log (id TEXT PRIMARY KEY, text TEXT); " +
        "INSERT INTO message_log VALUES ('m1', 'hello');",
    );
    return raw;
  }

  it("is refused by name, and the file is not changed", () =>
    withTempDir(async (dir) => {
      const path = join(dir, "miyoria.db");
      v4(path, false).close();
      const before = snapshot(dir);
      for (const open of [() => SqliteStore.open(path), () => openStore(`sqlite:${path}`)]) {
        const error = await open().then(
          () => null,
          (e: unknown) => e,
        );
        expect(error).toBeInstanceOf(SchemaError);
        expect((error as SchemaError).code).toBe("old_database");
        expect((error as SchemaError).message).toContain(path);
        expect((error as SchemaError).message).toMatch(/starts from a new database/);
      }
      expect(snapshot(dir)).toEqual(before);
    }));

  it("is refused while another process has it open in WAL mode, without a checkpoint", () =>
    withTempDir(async (dir) => {
      const path = join(dir, "miyoria.db");
      const live = v4(path, true);
      try {
        live.exec("INSERT INTO message_log VALUES ('m2', 'still in the WAL')");
        expect(existsSync(`${path}-wal`)).toBe(true);
        const db = readFileSync(path);
        const wal = readFileSync(`${path}-wal`);
        await expect(SqliteStore.open(path)).rejects.toThrow(/is a V4 database/);
        expect(readFileSync(path).equals(db)).toBe(true);
        expect(readFileSync(`${path}-wal`).equals(wal)).toBe(true);
        const names = live.prepare("SELECT name FROM sqlite_schema WHERE type = 'table'").all();
        expect(names.map((r) => r.name)).not.toContain("_migrations");
      } finally {
        live.close();
      }
    }));

  it("is refused by the runner itself too, before it writes", () => {
    const raw = new DatabaseSync(":memory:");
    raw.exec("CREATE TABLE schema_version (version INTEGER PRIMARY KEY)");
    const db = new Db(raw, systemClock);
    try {
      expect(thrown(() => migrate(db, [legacySchema], { location: "x.db" })).code).toBe(
        "old_database",
      );
      expect(raw.prepare("PRAGMA auto_vacuum").get()).toEqual({ auto_vacuum: 0 });
      expect(
        raw.prepare("SELECT name FROM sqlite_schema WHERE name = '_migrations'").get(),
      ).toBeUndefined();
    } finally {
      db.close();
    }
  });
});

describe("order", () => {
  it("core, identity, config, then requires with ties by id", () => {
    const ids = orderSchemas([
      schema("c", ["SELECT 1"]),
      schema("b", ["SELECT 1"], ["a"]),
      schema("config", ["SELECT 1"], ["identity"]),
      schema("a", ["SELECT 1"], ["d"]),
      schema("d", ["SELECT 1"]),
      schema("identity", ["SELECT 1"]),
      coreSchema,
    ]).map((s) => s.plugin);
    expect(ids).toEqual(["core", "identity", "config", "c", "d", "a", "b"]);
  });

  it("refuses duplicates, unknown or late requirements, cycles and bad versions", () => {
    const one = (id: string, requires?: string[]) => schema(id, ["SELECT 1"], requires);
    expect(() => orderSchemas([one("a"), one("a")])).toThrow(/declared twice/);
    expect(() => orderSchemas([one("a", ["zz"])])).toThrow(/requires `zz`, which is not installed/);
    expect(() => orderSchemas([one("identity", ["config"]), one("config")])).toThrow(/runs later/);
    expect(() => orderSchemas([one("a", ["b"]), one("b", ["a"]), one("c")])).toThrow(/cycle: a, b/);
    expect(() => orderSchemas([one("Bad-Id")])).toThrow(/schema id/);
    expect(() =>
      orderSchemas([
        {
          plugin: "a",
          migrations: [
            { version: 1, name: "x", sql: "SELECT 1" },
            { version: 1, name: "y", sql: "SELECT 1" },
          ],
        },
      ]),
    ).toThrow(/two migrations 1/);
  });
});

describe("naming lint", () => {
  const identity = schema("identity", ["CREATE TABLE persons (id TEXT PRIMARY KEY) STRICT;"]);

  it("passes prefixed names, shared foreign keys, and ignores comments and strings", () => {
    const ok = schema("shop", [
      "-- CREATE TABLE items (x) is only a comment\n" +
        "CREATE TABLE IF NOT EXISTS shop_items (id TEXT PRIMARY KEY, owner TEXT REFERENCES persons (id), " +
        "note TEXT DEFAULT 'CREATE TABLE nope (x)') STRICT;\n" +
        "CREATE UNIQUE INDEX shop_items_owner_idx ON shop_items (owner);\n" +
        "CREATE VIRTUAL TABLE shop_fts USING fts5 (name);\n" +
        "CREATE TRIGGER \"shop_items_ro\" BEFORE UPDATE ON shop_items BEGIN SELECT RAISE(ABORT, 'no'); END;\n" +
        "CREATE VIEW shop_v AS SELECT * FROM shop_items;",
    ]);
    expect(lintSchemas(orderSchemas([coreSchema, identity, ok]))).toEqual([]);
    expect(lintSchemas([legacySchema])).toEqual([]);
  });

  it("names every unprefixed name, foreign table and cross-plugin key", () => {
    const other = schema("other", ["CREATE TABLE other_things (id TEXT PRIMARY KEY) STRICT;"]);
    const bad = schema("shop", [
      "CREATE TABLE items (id TEXT PRIMARY KEY, thing TEXT REFERENCES other_things (id)) STRICT;",
      "CREATE INDEX shop_idx ON other_things (id); ALTER TABLE people ADD COLUMN x TEXT;",
      "ALTER TABLE shop_a RENAME TO a; DROP VIEW IF EXISTS message_log_v;",
    ]);
    const problems = lintSchemas(orderSchemas([coreSchema, identity, other, bad]));
    expect(problems).toEqual([
      "shop migration 1 (step1) creates `items`, which must start with `shop_`",
      "shop migration 1 (step1) has a foreign key to `other_things`; only its own, core and identity tables may be referenced",
      "shop migration 2 (step2) changes `people`, which it does not own",
      "shop migration 2 (step2) changes `other_things`, which it does not own",
      "shop migration 3 (step3) creates `a`, which must start with `shop_`",
      "shop migration 3 (step3) changes `message_log_v`, which it does not own",
    ]);
    const t = openTestDb();
    try {
      const error = thrown(() => migrate(t.db, [other, bad]));
      expect(error.code).toBe("lint");
      expect(appliedMigrations(t.db).map((m) => m.plugin)).toEqual([
        "core",
        "core",
        "core",
        "core",
        "core",
        "core",
        "core",
      ]);
    } finally {
      t.close();
    }
  });
});

describe("identity v2 (places) on a v1 database", () => {
  const IDENTITY_TABLES = [
    "persons",
    "accounts",
    "link_codes",
    "spaces",
    "rooms",
    "sessions",
    "space_members",
  ];
  const V1: PluginSchema = { ...identitySchema, migrations: identitySchema.migrations.slice(0, 1) };

  /** A database migrated to identity v1 only, with `spaces` guilds and `members[i]` members in each. */
  function v1Database(guilds: { left?: boolean; joined: number; members: number }[]): Db {
    const db = new Db(new DatabaseSync(":memory:", { enableForeignKeyConstraints: true }), {
      now: () => Date.UTC(2026, 10, 14),
    });
    migrate(db, [V1]);
    db.run(
      "INSERT INTO persons (id, name, handle, created_at) VALUES ('p1', 'Owen', 'Owen', 1), ('p2', 'Ann', 'Ann', 2), ('p3', 'Bo', 'Bo', 3)",
    );
    db.run(
      `INSERT INTO accounts (id, platform, external_id, person_id, display_name, first_seen, last_seen)
       VALUES ('a1', 'discord', '1', 'p1', 'Owen', 1, 1), ('a2', 'discord', '2', 'p2', 'Ann', 2, 2),
              ('a3', 'discord', '3', 'p3', 'Bo', 3, 3)`,
    );
    db.run("INSERT INTO link_codes VALUES ('h', 'a1', 9)");
    guilds.forEach((g, i) => {
      const id = `s${i + 1}`;
      db.run(
        "INSERT INTO spaces (id, platform, external_id, name, joined_at, left_at) VALUES ($id, 'discord', $ext, $name, $joined, $left)",
        {
          id,
          ext: `g${i + 1}`,
          name: `Guild ${i + 1}`,
          joined: g.joined,
          left: g.left ? 50 : null,
        },
      );
      db.run(
        "INSERT INTO rooms (id, platform, external_id, space_id, kind, created_at) VALUES ($id, 'discord', $ext, $space, 'text', 1)",
        { id: `r${i + 1}`, ext: `c${i + 1}`, space: id },
      );
      db.run(
        "INSERT INTO sessions (key, space_id, room_id, created_at, last_at) VALUES ($key, $space, $room, 1, 1)",
        { key: `discord:g${i + 1}:c${i + 1}`, space: id, room: `r${i + 1}` },
      );
      for (let m = 1; m <= g.members; m++) {
        db.run(
          "INSERT INTO space_members (space_id, account_id, last_seen) VALUES ($space, $account, 1)",
          { space: id, account: `a${m}` },
        );
      }
    });
    return db;
  }

  function counts(db: Db): Record<string, number> {
    return Object.fromEntries(
      IDENTITY_TABLES.map((t) => [t, Number(db.get(`SELECT COUNT(*) AS n FROM ${t}`)?.n)]),
    );
  }

  function primaries(db: Db): string[] {
    return db.all("SELECT id FROM spaces WHERE is_primary = 1").map((r) => String(r.id));
  }

  function upgrade(db: Db): void {
    const before = counts(db);
    const v1 = appliedMigrations(db).find((m) => m.plugin === "identity" && m.version === 1);
    const applied = migrate(db, [identitySchema]);
    // v3 and v4 run too: with no events v3 adds no member, v4 only marks the Spaces, so every
    // count stays.
    expect(applied.map((m) => [m.plugin, m.version])).toEqual([
      ["identity", 2],
      ["identity", 3],
      ["identity", 4],
    ]);
    expect(counts(db)).toEqual(before);
    // The applied migration is the one that ran: its checksum is unchanged.
    expect(appliedMigrations(db).find((m) => m.plugin === "identity" && m.version === 1)).toEqual(
      v1,
    );
  }

  it("the one server becomes primary, and no row is lost", () => {
    const db = v1Database([{ joined: 10, members: 2 }]);
    try {
      upgrade(db);
      expect(primaries(db)).toEqual(["s1"]);
      expect(db.get("SELECT is_primary FROM spaces WHERE id = 's1'")).toEqual({ is_primary: 1 });
    } finally {
      db.close();
    }
  });

  it("with no server, none is primary", () => {
    const db = v1Database([]);
    try {
      upgrade(db);
      expect(primaries(db)).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("with two servers, the one with the most members she is still in", () => {
    // s1 is older, s2 has more members, s3 has the most but she left it.
    const db = v1Database([
      { joined: 10, members: 1 },
      { joined: 20, members: 2 },
      { joined: 5, members: 3, left: true },
    ]);
    try {
      upgrade(db);
      expect(primaries(db)).toEqual(["s2"]);
      // At most one primary.
      expect(() => db.run("UPDATE spaces SET is_primary = 1 WHERE id = 's1'")).toThrow(/UNIQUE/);
    } finally {
      db.close();
    }
  });

  it("with two servers of as many members, the older one", () => {
    const db = v1Database([
      { joined: 20, members: 2 },
      { joined: 10, members: 2 },
    ]);
    try {
      upgrade(db);
      expect(primaries(db)).toEqual(["s2"]);
    } finally {
      db.close();
    }
  });
});

describe("identity v3 (members who acted) on a v2 database", () => {
  const V2: PluginSchema = { ...identitySchema, migrations: identitySchema.migrations.slice(0, 2) };
  const OTHER_TABLES = [
    "persons",
    "accounts",
    "link_codes",
    "spaces",
    "rooms",
    "sessions",
    "events",
  ];

  let seq = 0;
  function event(
    db: Db,
    fields: {
      type?: string;
      at: number;
      space?: string | null;
      account?: string | null;
      person?: string | null;
      data?: unknown;
      redacted?: boolean;
    },
  ): void {
    seq++;
    db.run(
      `INSERT INTO events (id, at, type, source, space_id, person_id, account_id, scope, tier, data, redacted_at)
       VALUES ($id, $at, $type, 'test', $space, $person, $account, 'space', 'keep', $data, $redacted)`,
      {
        id: `e${seq}`,
        at: fields.at,
        type: fields.type ?? "platform.message.created",
        space: fields.space ?? null,
        person: fields.person ?? null,
        account: fields.account ?? null,
        data: fields.redacted ? '{"redacted":true}' : JSON.stringify(fields.data ?? {}),
        redacted: fields.redacted ? fields.at : null,
      },
    );
  }

  /** Her voice presence line: who was in a voice channel of `space`, as the facts writer keeps it. */
  function voiceLine(
    db: Db,
    space: string,
    at: number,
    people: [string, boolean][],
    redacted = false,
  ) {
    event(db, {
      type: "facts.observation.ambient",
      at,
      space,
      redacted,
      data: {
        observation: { source: "voice.presence", summary: "語音頻道裡有:..." },
        buckets: [],
        speech: false,
        origin: {
          module: "voice",
          topic: "voice.participants",
          event: {
            type: "voice.participants",
            v: 1,
            data: {
              context: { platform: "discord", scope: "g1", channel: "v1", kind: "voice" },
              participants: people.map(([id, self]) => ({
                account: { platform: "discord", id },
                display_name: id,
                is_self: self,
                muted: false,
                deafened: false,
              })),
            },
          },
          turn: null,
        },
      },
    });
  }

  /**
   * Two servers (s1 primary, s2), and accounts: a1 a member of s1, a2 a member of s1 who left, a3
   * to a5 no member anywhere, a6 on another platform, a7 marked as hers, a8 her bot account.
   */
  function v2Database(): Db {
    const db = new Db(new DatabaseSync(":memory:", { enableForeignKeyConstraints: true }), {
      now: () => Date.UTC(2026, 10, 22),
    });
    migrate(db, [V2]);
    const people = ["p1", "p2", "p3", "p4", "p5", "p6", "p7"];
    for (const [i, p] of people.entries()) {
      db.run("INSERT INTO persons (id, name, handle, created_at) VALUES ($id, $id, $id, $at)", {
        id: p,
        at: i + 1,
      });
    }
    const accounts: [string, string, string, string | null, number][] = [
      ["a1", "discord", "1", "p1", 0],
      ["a2", "discord", "2", "p2", 0],
      ["a3", "discord", "3", "p3", 0],
      ["a4", "discord", "4", "p4", 0],
      ["a5", "discord", "5", "p5", 0],
      ["a6", "twitch", "6", "p6", 0],
      ["a7", "discord", "7", "p7", 1],
      ["a8", "discord", "100", null, 0],
    ];
    for (const [id, platform, ext, person, self] of accounts) {
      db.run(
        `INSERT INTO accounts (id, platform, external_id, person_id, display_name, is_self, first_seen, last_seen)
         VALUES ($id, $platform, $ext, $person, $ext, $self, 1, 1)`,
        { id, platform, ext, person, self },
      );
    }
    db.run(
      `INSERT INTO spaces (id, platform, external_id, name, joined_at, is_primary)
       VALUES ('s1', 'discord', 'g1', 'One', 1, 1), ('s2', 'discord', 'g2', 'Two', 2, 0)`,
    );
    db.run(
      `INSERT INTO rooms (id, platform, external_id, space_id, kind, created_at)
       VALUES ('r1', 'discord', 'c1', 's1', 'text', 1), ('r2', 'discord', 'v1', 's1', 'voice', 1)`,
    );
    db.run(
      "INSERT INTO sessions (key, space_id, room_id, created_at, last_at) VALUES ('discord:g1:c1', 's1', 'r1', 1, 1)",
    );
    db.run(
      `INSERT INTO space_members (space_id, account_id, last_seen, left_at)
       VALUES ('s1', 'a1', 10, NULL), ('s1', 'a2', 10, 50)`,
    );
    return db;
  }

  function counts(db: Db): Record<string, number> {
    return Object.fromEntries(
      OTHER_TABLES.map((t) => [t, Number(db.get(`SELECT COUNT(*) AS n FROM ${t}`)?.n)]),
    );
  }

  const members = (db: Db) =>
    db
      .all("SELECT space_id, account_id, last_seen, left_at FROM space_members ORDER BY 1, 2")
      .map((r) => [r.space_id, r.account_id, r.last_seen, r.left_at]);

  it("adds a member only where a row names the space, and touches no existing one", () => {
    const db = v2Database();
    try {
      // A member already, and one who left: both stay as they are.
      event(db, { at: 900, space: "s1", account: "a1" });
      event(db, { at: 900, space: "s1", account: "a2" });
      // a3 acted in s2 twice: a member of s2 seen at the later one, not of s1.
      event(db, { type: "voice.utterance", at: 500, space: "s2", account: "a3" });
      event(db, { type: "facts.observation.said", at: 700, space: "s2", account: "a3" });
      // A person without the account does not say which account: nothing.
      event(db, { type: "heart.changed", at: 800, space: "s1", person: "p3" });
      // No space, an unknown space, another platform, an account marked hers: nothing.
      event(db, { at: 800, account: "a5" });
      event(db, { at: 800, space: "nope", account: "a5" });
      event(db, { at: 800, space: "s1", account: "a6" });
      event(db, { at: 800, space: "s1", account: "a7" });
      // Her voice line in s1: a4 was there; her bot account (is_self) and an account identity
      // never made are not members.
      voiceLine(db, "s1", 600, [
        ["4", false],
        ["100", true],
        ["999", false],
      ]);
      voiceLine(db, "s1", 650, [["4", false]]);
      // A forgotten voice line names nobody any more.
      voiceLine(db, "s2", 600, [["5", false]], true);
      // Another topic's observation with a participants list is not a voice line.
      event(db, {
        type: "facts.observation",
        at: 600,
        space: "s2",
        data: { origin: { topic: "game.x", event: { data: { participants: [] } } } },
      });

      const before = counts(db);
      const applied = migrate(db, [identitySchema]);
      expect(applied.map((m) => [m.plugin, m.name])).toEqual([
        ["identity", "members_who_acted"],
        ["identity", "established"],
      ]);
      expect(counts(db)).toEqual(before);
      expect(members(db)).toEqual([
        ["s1", "a1", 10, null],
        ["s1", "a2", 10, 50],
        ["s1", "a4", 650, null],
        ["s2", "a3", 700, null],
      ]);
      // Once only: a second start applies nothing and changes nothing.
      expect(migrate(db, [identitySchema])).toEqual([]);
      const after = members(db);
      // Its SQL run again adds nothing either.
      db.exec(identitySchema.migrations.find((m) => m.version === 3)?.sql ?? "");
      expect(members(db)).toEqual(after);
    } finally {
      db.close();
    }
  });

  it("is a no-op on a database without events", () => {
    const db = v2Database();
    try {
      const before = members(db);
      migrate(db, [identitySchema]);
      expect(members(db)).toEqual(before);
    } finally {
      db.close();
    }
  });
});

describe("identity v4 (established) on a v3 database", () => {
  const V3: PluginSchema = { ...identitySchema, migrations: identitySchema.migrations.slice(0, 3) };
  const TABLES = [
    "persons",
    "accounts",
    "link_codes",
    "spaces",
    "rooms",
    "sessions",
    "space_members",
    "events",
  ];
  const ctx = (guild: string, channel: string) => ({
    platform: "discord",
    scope: guild,
    channel,
    kind: "channel" as const,
  });
  const author = (id: string) => ({ account: { platform: "discord", id }, display_name: id });

  it("makes every server she was already in established, the second one too, and no row moves", () => {
    let now = Date.UTC(2026, 10, 22);
    const db = new Db(new DatabaseSync(":memory:", { enableForeignKeyConstraints: true }), {
      now: () => now++,
    });
    try {
      migrate(db, [V3]);
      // The install of the rehearsal, as the build of before wrote it (its own SQL: this build's
      // tables have the v4 column already): a big server (primary), a small one, and a third she
      // left, with members.
      const [a, b, c] = ["s-a", "s-b", "s-c"];
      db.run(
        `INSERT INTO spaces (id, platform, external_id, name, joined_at, left_at, is_primary)
         VALUES ('s-a', 'discord', 'gA', 'A', 1, NULL, 1), ('s-b', 'discord', 'gB', 'B', 2, NULL, 0),
                ('s-c', 'discord', 'gC', 'C', 3, 9, 0)`,
      );
      db.run(
        `INSERT INTO rooms (id, platform, external_id, space_id, kind, created_at)
         VALUES ('r-c', 'discord', 'c1', 's-c', 'text', 1)`,
      );
      for (const [i, space] of [a, a, a, a, b, c].entries()) {
        db.run("INSERT INTO persons (id, name, handle, created_at) VALUES ($id, $id, $id, 1)", {
          id: `p${i}`,
        });
        db.run(
          `INSERT INTO accounts (id, platform, external_id, person_id, display_name, first_seen, last_seen)
           VALUES ($id, 'discord', $ext, $person, $ext, 1, 1)`,
          { id: `a${i}`, ext: String(i + 1), person: `p${i}` },
        );
        db.run(
          "INSERT INTO space_members (space_id, account_id, last_seen) VALUES ($space, $account, 1)",
          { space, account: `a${i}` },
        );
      }
      const counts = () =>
        TABLES.map((t) => [t, Number(db.get(`SELECT COUNT(*) AS n FROM ${t}`)?.n)] as const);
      const before = counts();

      const applied = migrate(db, [identitySchema]);
      expect(applied.map((m) => [m.plugin, m.name])).toEqual([["identity", "established"]]);
      expect(counts()).toEqual(before);
      expect(db.all("SELECT id, is_primary, established FROM spaces ORDER BY joined_at")).toEqual([
        { id: a, is_primary: 1, established: 1 },
        { id: b, is_primary: 0, established: 1 },
        { id: c, is_primary: 0, established: 1 },
      ]);

      const identity = new Identity(db);
      const places = new SpacePlaces(db, identity);
      expect(places.spaces().map((s) => [s.id, s.primary, s.established])).toEqual([
        [a, true, true],
        [b, false, true],
      ]);
      // A server first seen after the upgrade is not established; one she left before it and
      // comes back to still is (its row was there).
      const d = places.seen("discord", "gD", "D");
      expect(places.space(d)).toMatchObject({ primary: false, established: false });
      identity.resolve(ctx("gC", "c1"), author("6"));
      expect(places.space(c)).not.toBeNull();
      expect(places.space(c)).toMatchObject({ primary: false, established: true });
      expect(migrate(db, [identitySchema])).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("a fresh install: the first server is primary and established, a later one is neither", () => {
    const db = new Db(new DatabaseSync(":memory:", { enableForeignKeyConstraints: true }), {
      now: () => Date.UTC(2026, 10, 22),
    });
    try {
      migrate(db, [identitySchema]);
      const places = new SpacePlaces(db, new Identity(db));
      const first = places.seen("discord", "g1", "One");
      const second = places.seen("discord", "g2", "Two");
      expect(places.space(first)).toMatchObject({ primary: true, established: true });
      expect(places.space(second)).toMatchObject({ primary: false, established: false });
    } finally {
      db.close();
    }
  });
});
