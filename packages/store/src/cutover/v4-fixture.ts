// A small V4 database for the tests of the cut-over tools (here and in the CLI, through
// `@miyoria/store/testing`): the old layout's tables as V4's migrations made them
// (`main:packages/store/migrations/sqlite/0001`-`0011`, the ones the tools read or must leave
// behind), the V4 runner's `schema_version`, and a few people with the odd rows the old schema
// allowed.
//
// People (times are seconds after 2026-01-01 UTC):
// - `p-owen` "Owen" (1): accounts discord:100 and discord:101 (101 came from a person V4 merged
//   away, `p-gone`, whose handle row still names them); voice consent yes on 100 (20), no on 101
//   (30); bond 130 / familiarity 50 (知心); two cards, one only by its account.
// - `p-mika` "Mika" (2): discord:200, privacy `{presence: false}`; bond 20 (朋友).
// - `p-rin` "Rin" (3): discord:300, voice consent no; her handle row names no person; one card.
// - `p-lowen` "owen" (4): discord:400, handle row `owen`, newer than `Owen`.
// - `p-ghost` "Ghost" (6): no account left.
// Odd rows: account discord:900 of `p-gone` (no such person); a voice-only listener discord:500
// with consent yes and a handle row but no person; a passer-by's handle row (600); a handle row
// that is not JSON (700). Not identity: a link code, a coin, a chat line, an event.

import { DatabaseSync } from "node:sqlite";

export const T0 = Date.UTC(2026, 0, 1);
const us = (seconds: number) => (T0 + seconds * 1000) * 1000;
const iso = (seconds: number) => new Date(T0 + seconds * 1000).toISOString();

export const V4_PROFILE = "deepseek-chan";

const V4_SQL = `
CREATE TABLE schema_version (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL);

CREATE TABLE message_log (
    seq          INTEGER PRIMARY KEY,
    id           TEXT    NOT NULL UNIQUE,
    profile_id   TEXT    NOT NULL,
    context_key  TEXT    NOT NULL,
    platform     TEXT    NOT NULL,
    scope        TEXT,
    channel      TEXT    NOT NULL,
    kind         TEXT    NOT NULL,
    author_platform TEXT NOT NULL,
    author_id    TEXT    NOT NULL,
    author_name  TEXT    NOT NULL,
    text         TEXT    NOT NULL,
    is_self      INTEGER NOT NULL,
    ts           INTEGER NOT NULL,
    turn_id      TEXT
);

CREATE TABLE people (
    id           TEXT    PRIMARY KEY,
    display_name TEXT    NOT NULL,
    created_at   INTEGER NOT NULL
);

CREATE TABLE accounts (
    platform     TEXT    NOT NULL,
    account_id   TEXT    NOT NULL,
    person_id    TEXT    NOT NULL REFERENCES people (id) ON DELETE CASCADE,
    display_name TEXT    NOT NULL,
    first_seen   INTEGER NOT NULL,
    last_seen    INTEGER NOT NULL,
    PRIMARY KEY (platform, account_id)
);
CREATE INDEX accounts_person_idx ON accounts (person_id);

CREATE TABLE profile_settings (
    profile_id  TEXT    NOT NULL,
    key         TEXT    NOT NULL,
    value       TEXT    NOT NULL,
    updated_at  INTEGER NOT NULL,
    PRIMARY KEY (profile_id, key)
);

CREATE TABLE relationships (
    profile_id       TEXT    NOT NULL,
    person_id        TEXT    NOT NULL,
    affinity         REAL    NOT NULL,
    trust            REAL    NOT NULL,
    familiarity      REAL    NOT NULL,
    tags             TEXT    NOT NULL DEFAULT '[]',
    notes            TEXT    NOT NULL,
    call_name        TEXT,
    interactions     INTEGER NOT NULL DEFAULT 0,
    last_interaction INTEGER,
    updated_at       INTEGER NOT NULL,
    PRIMARY KEY (profile_id, person_id)
);

CREATE TABLE link_codes (
    code       TEXT    PRIMARY KEY,
    platform   TEXT    NOT NULL,
    account_id TEXT    NOT NULL,
    expires_at INTEGER NOT NULL
);

CREATE TABLE log_events (
    seq           INTEGER PRIMARY KEY AUTOINCREMENT,
    id            TEXT    NOT NULL UNIQUE,
    profile_id    TEXT    NOT NULL,
    at            INTEGER NOT NULL,
    kind          TEXT    NOT NULL,
    source        TEXT    NOT NULL,
    cause         TEXT,
    context_key   TEXT,
    context       TEXT,
    person        TEXT,
    attention_key TEXT,
    salience      TEXT,
    body          TEXT    NOT NULL
);

CREATE TABLE member_cards (
    serial          TEXT    PRIMARY KEY,
    profile_id      TEXT    NOT NULL,
    author_platform TEXT    NOT NULL,
    author_id       TEXT    NOT NULL,
    person_id       TEXT,
    issued_at       INTEGER NOT NULL,
    snapshot        TEXT    NOT NULL
);

CREATE TABLE coin_ledger (
    id              TEXT    PRIMARY KEY,
    profile_id      TEXT    NOT NULL,
    author_platform TEXT    NOT NULL,
    author_id       TEXT    NOT NULL,
    delta           INTEGER NOT NULL,
    reason          TEXT    NOT NULL,
    ref             TEXT,
    idem_key        TEXT,
    ts              INTEGER NOT NULL
);
`;

function handleRow(id: string, handle: string, person: string | null, at: number): string {
  return JSON.stringify({
    handle,
    person,
    account: { platform: "discord", id },
    display_name: handle,
    created_at: iso(at),
  });
}

/** Fills `db` (empty) with the V4 fixture described in the file comment. */
export function fillV4(db: DatabaseSync): void {
  db.exec("PRAGMA foreign_keys = OFF");
  db.exec(V4_SQL);
  const run = (sql: string, ...params: Array<string | number | null>) =>
    db.prepare(sql).run(...params);
  for (let v = 1; v <= 18; v++) {
    run("INSERT INTO schema_version VALUES (?, ?, ?)", v, `m${v}`, us(0));
  }
  const people: Array<[string, string, number]> = [
    ["p-owen", "Owen", 1],
    ["p-mika", "Mika", 2],
    ["p-rin", "Rin", 3],
    ["p-lowen", "owen", 4],
    ["p-ghost", "Ghost", 6],
  ];
  for (const [id, name, at] of people) run("INSERT INTO people VALUES (?, ?, ?)", id, name, us(at));
  const accounts: Array<[string, string, string, number]> = [
    ["100", "p-owen", "Owen", 1],
    ["101", "p-owen", "Owen Alt", 5],
    ["200", "p-mika", "Mika", 2],
    ["300", "p-rin", "Rin", 3],
    ["400", "p-lowen", "owen", 4],
    ["900", "p-gone", "Gone", 7],
  ];
  for (const [id, person, name, at] of accounts) {
    run("INSERT INTO accounts VALUES ('discord', ?, ?, ?, ?, ?)", id, person, name, us(at), us(50));
  }
  const setting = (key: string, value: string, at: number) =>
    run("INSERT INTO profile_settings VALUES ('_global', ?, ?, ?)", key, value, us(at));
  setting("handle:discord:100", handleRow("100", "Owen", "p-owen", 1), 1);
  setting("handle:discord:101", handleRow("101", "Owen Alt", "p-gone", 5), 5);
  setting("handle:discord:200", handleRow("200", "Mika", "p-mika", 2), 2);
  setting("handle:discord:300", handleRow("300", "Rin", null, 3), 3);
  setting("handle:discord:400", handleRow("400", "owen", "p-lowen", 4), 4);
  setting("handle:discord:500", handleRow("500", "Listener", null, 8), 8);
  setting("handle:discord:600", handleRow("600", "Passerby", null, 9), 9);
  setting("handle:discord:700", "{not json", 9);
  setting("privacy:discord:200", JSON.stringify({ presence: false }), 10);
  setting("voice_consent:discord:300", "false", 11);
  setting("voice_consent:discord:100", "true", 20);
  setting("voice_consent:discord:101", "false", 30);
  setting("voice_consent:discord:500", "true", 12);
  run("INSERT INTO profile_settings VALUES (?, 'mind:plan', '{}', ?)", V4_PROFILE, us(1));
  const bond = (person: string, affinity: number, familiarity: number) =>
    run(
      "INSERT INTO relationships (profile_id, person_id, affinity, trust, familiarity, notes, " +
        "updated_at) VALUES (?, ?, ?, 0, ?, '', ?)",
      V4_PROFILE,
      person,
      affinity,
      familiarity,
      us(40),
    );
  bond("p-owen", 130, 50);
  bond("p-mika", 20, 5);
  bond("p-gone", 90, 90);
  const card = (serial: string, account: string, person: string | null) =>
    run(
      "INSERT INTO member_cards VALUES (?, ?, 'discord', ?, ?, ?, '{}')",
      serial,
      V4_PROFILE,
      account,
      person,
      us(41),
    );
  card("MYR-0001", "100", "p-owen");
  card("MYR-0002", "101", null);
  card("MYR-0003", "300", "p-rin");
  run("INSERT INTO link_codes VALUES ('LINK-1', 'discord', '200', ?)", us(99));
  run(
    "INSERT INTO coin_ledger VALUES ('c1', ?, 'discord', '100', 50, 'checkin', NULL, 'd1', ?)",
    V4_PROFILE,
    us(42),
  );
  run(
    "INSERT INTO message_log (id, profile_id, context_key, platform, scope, channel, kind, " +
      "author_platform, author_id, author_name, text, is_self, ts) VALUES ('m1', ?, '{}', " +
      "'discord', 'g1', 'c1', 'channel', 'discord', '100', 'Owen', 'hello', 0, ?)",
    V4_PROFILE,
    us(43),
  );
  run(
    "INSERT INTO log_events (id, profile_id, at, kind, source, body) VALUES ('e1', ?, ?, " +
      "'observation', 'discord', '{}')",
    V4_PROFILE,
    us(44),
  );
  db.exec("PRAGMA foreign_keys = ON");
}

/** An in-memory V4 database. */
export function memoryV4(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  fillV4(db);
  return db;
}

/**
 * A V4 file at `path` in WAL mode, as V4 ran it. The returned connection still holds it, with
 * everything in the `-wal` (no checkpoint); close it to leave the file as a stopped V4 left it.
 */
export function v4File(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA wal_autocheckpoint = 0");
  fillV4(db);
  return db;
}

export { iso as v4Iso, us as v4Micros };
