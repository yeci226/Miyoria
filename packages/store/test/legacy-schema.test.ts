// The `legacy` schema's tables, frozen. The expected values below are a dump of `sqlite_schema` and
// `PRAGMA table_xinfo` taken from a database built by the 18 V4-era migrations (0001-0018) before
// they were squashed into one (v5-data §8 step 14): the squashed migration must build exactly
// these objects, with the same SQL text, the same columns and no others.

import { describe, expect, it } from "vitest";
import { openTestDb } from "../src/testing.js";

const OBJECTS =
  "SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name";

/** `[type, name, tbl_name, sql]` of every object `legacy` creates, in `ORDER BY type, name`. */
const EXPECTED_OBJECTS: readonly (readonly [string, string, string, string])[] = [
  [
    "index",
    "member_cards_author_idx",
    "member_cards",
    "CREATE INDEX member_cards_author_idx\n    ON member_cards (profile_id, author_platform, author_id, issued_at)",
  ],
  [
    "index",
    "relationship_deltas_idx",
    "relationship_deltas",
    "CREATE INDEX relationship_deltas_idx\n    ON relationship_deltas (profile_id, person_id, at, seq)",
  ],
  [
    "table",
    "member_cards",
    "member_cards",
    "CREATE TABLE member_cards (\n    -- `MYR-XXXX-XXXX-XXXX`.\n    serial          TEXT    PRIMARY KEY,\n    profile_id      TEXT    NOT NULL,\n    -- The session account it was issued to.\n    author_platform TEXT    NOT NULL,\n    author_id       TEXT    NOT NULL,\n    person_id       TEXT,\n    issued_at       INTEGER NOT NULL,\n    -- JSON of what the card shows.\n    snapshot        TEXT    NOT NULL\n)",
  ],
  [
    "table",
    "relationship_deltas",
    "relationship_deltas",
    "CREATE TABLE relationship_deltas (\n    seq         INTEGER PRIMARY KEY,\n    profile_id  TEXT    NOT NULL,\n    person_id   TEXT    NOT NULL,\n    at          INTEGER NOT NULL,\n    affinity    REAL    NOT NULL,\n    trust       REAL    NOT NULL,\n    familiarity REAL    NOT NULL,\n    reason      TEXT    NOT NULL\n)",
  ],
  [
    "table",
    "relationships",
    "relationships",
    "CREATE TABLE relationships (\n    profile_id       TEXT    NOT NULL,\n    person_id        TEXT    NOT NULL,\n    affinity         REAL    NOT NULL,\n    trust            REAL    NOT NULL,\n    familiarity      REAL    NOT NULL,\n    tags             TEXT    NOT NULL DEFAULT '[]',\n    notes            TEXT    NOT NULL,\n    call_name        TEXT,\n    interactions     INTEGER NOT NULL DEFAULT 0,\n    last_interaction INTEGER,\n    updated_at       INTEGER NOT NULL,\n    PRIMARY KEY (profile_id, person_id)\n)",
  ],
];

type Column = readonly [
  name: string,
  type: string,
  notnull: number,
  dflt: string | null,
  pk: number,
  hidden: number,
];

/** `PRAGMA table_xinfo` of each table, as `[name, type, notnull, dflt_value, pk, hidden]`. */
const EXPECTED_COLUMNS: Readonly<Record<string, readonly Column[]>> = {
  member_cards: [
    ["serial", "TEXT", 0, null, 1, 0],
    ["profile_id", "TEXT", 1, null, 0, 0],
    ["author_platform", "TEXT", 1, null, 0, 0],
    ["author_id", "TEXT", 1, null, 0, 0],
    ["person_id", "TEXT", 0, null, 0, 0],
    ["issued_at", "INTEGER", 1, null, 0, 0],
    ["snapshot", "TEXT", 1, null, 0, 0],
  ],
  relationship_deltas: [
    ["seq", "INTEGER", 0, null, 1, 0],
    ["profile_id", "TEXT", 1, null, 0, 0],
    ["person_id", "TEXT", 1, null, 0, 0],
    ["at", "INTEGER", 1, null, 0, 0],
    ["affinity", "REAL", 1, null, 0, 0],
    ["trust", "REAL", 1, null, 0, 0],
    ["familiarity", "REAL", 1, null, 0, 0],
    ["reason", "TEXT", 1, null, 0, 0],
  ],
  relationships: [
    ["profile_id", "TEXT", 1, null, 1, 0],
    ["person_id", "TEXT", 1, null, 2, 0],
    ["affinity", "REAL", 1, null, 0, 0],
    ["trust", "REAL", 1, null, 0, 0],
    ["familiarity", "REAL", 1, null, 0, 0],
    ["tags", "TEXT", 1, "'[]'", 0, 0],
    ["notes", "TEXT", 1, null, 0, 0],
    ["call_name", "TEXT", 0, null, 0, 0],
    ["interactions", "INTEGER", 1, "0", 0, 0],
    ["last_interaction", "INTEGER", 0, null, 0, 0],
    ["updated_at", "INTEGER", 1, null, 0, 0],
  ],
};

describe("the legacy schema", () => {
  it("builds exactly the tables and indexes the V4-era chain left, as it left them", () => {
    const core = openTestDb();
    const t = openTestDb({ legacy: true });
    try {
      const base = new Set(core.db.all(OBJECTS).map((o) => `${o.type}:${o.name}`));
      const added = t.db
        .all(OBJECTS)
        .filter((o) => !base.has(`${o.type}:${o.name}`))
        .map((o) => [o.type, o.name, o.tbl_name, o.sql]);
      expect(added).toEqual(EXPECTED_OBJECTS);
      for (const [table, columns] of Object.entries(EXPECTED_COLUMNS)) {
        const info = t.db
          .all(`PRAGMA table_xinfo(${table})`)
          .map((c) => [c.name, c.type, c.notnull, c.dflt_value, c.pk, c.hidden]);
        expect(info, table).toEqual(columns);
      }
    } finally {
      core.close();
      t.close();
    }
  });
});
