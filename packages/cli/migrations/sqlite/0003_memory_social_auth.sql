-- Long-term memory, relationships, identity linking, roles and the audit log.
-- Ids are ULIDs stored as text. Per-character data carries `profile_id`.
-- Arrays (`subjects`, `tags`, `grants`, `denies`) are JSON text arrays.

-- Memory records. The privacy scope is kept both as JSON (readable) and as a
-- canonical JSON string `scope_key` (exact-match filtering and deletion).
CREATE TABLE memory_records (
    -- Stable integer key for the full-text index (upserts keep it).
    seq           INTEGER PRIMARY KEY,
    id            TEXT    NOT NULL UNIQUE,
    profile_id    TEXT    NOT NULL,
    kind          TEXT    NOT NULL,
    scope         TEXT    NOT NULL,
    scope_key     TEXT    NOT NULL,
    subjects      TEXT    NOT NULL DEFAULT '[]',
    content       TEXT    NOT NULL,
    -- Space-separated, already segmented search tokens.
    tokens        TEXT    NOT NULL,
    -- Little-endian float32 components. No fixed dimension: the embedding
    -- model may change. Searches only compare rows with the query's
    -- dimension (`length(embedding) = 4 * dims`).
    embedding     BLOB,
    importance    REAL    NOT NULL,
    confidence    REAL    NOT NULL,
    created_at    INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL,
    last_accessed INTEGER,
    access_count  INTEGER NOT NULL DEFAULT 0,
    source_context TEXT,
    due           INTEGER,
    done          INTEGER NOT NULL DEFAULT 0,
    superseded_by TEXT
);

CREATE INDEX memory_records_list_idx
    ON memory_records (profile_id, created_at DESC, id DESC);
CREATE INDEX memory_records_scope_idx
    ON memory_records (profile_id, scope_key);
-- Open followups only.
CREATE INDEX memory_records_due_idx
    ON memory_records (profile_id, due)
    WHERE kind = 'followup' AND NOT done AND due IS NOT NULL;

-- Full-text index over `tokens` (the counterpart of PostgreSQL's
-- `to_tsvector('simple', tokens)`): unicode61 folds case and keeps CJK words
-- whole; diacritics are kept, like the `simple` configuration.
CREATE VIRTUAL TABLE memory_fts USING fts5(
    tokens,
    content = 'memory_records',
    content_rowid = 'seq',
    tokenize = 'unicode61 remove_diacritics 0'
);

CREATE TRIGGER memory_records_fts_insert AFTER INSERT ON memory_records BEGIN
    INSERT INTO memory_fts (rowid, tokens) VALUES (new.seq, new.tokens);
END;

CREATE TRIGGER memory_records_fts_delete AFTER DELETE ON memory_records BEGIN
    INSERT INTO memory_fts (memory_fts, rowid, tokens) VALUES ('delete', old.seq, old.tokens);
END;

CREATE TRIGGER memory_records_fts_update AFTER UPDATE OF tokens ON memory_records BEGIN
    INSERT INTO memory_fts (memory_fts, rowid, tokens) VALUES ('delete', old.seq, old.tokens);
    INSERT INTO memory_fts (rowid, tokens) VALUES (new.seq, new.tokens);
END;

-- One profile's feelings about one person, plus the change history.
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

CREATE TABLE relationship_deltas (
    seq         INTEGER PRIMARY KEY,
    profile_id  TEXT    NOT NULL,
    person_id   TEXT    NOT NULL,
    at          INTEGER NOT NULL,
    affinity    REAL    NOT NULL,
    trust       REAL    NOT NULL,
    familiarity REAL    NOT NULL,
    reason      TEXT    NOT NULL
);

CREATE INDEX relationship_deltas_idx
    ON relationship_deltas (profile_id, person_id, at, seq);

-- One-time codes for linking accounts.
CREATE TABLE link_codes (
    code       TEXT    PRIMARY KEY,
    platform   TEXT    NOT NULL,
    account_id TEXT    NOT NULL,
    expires_at INTEGER NOT NULL
);

-- Roles. `scope` columns hold the canonical JSON of an `AuthScope`.
CREATE TABLE roles (
    name     TEXT    PRIMARY KEY,
    rank     INTEGER NOT NULL,
    grants   TEXT    NOT NULL DEFAULT '[]',
    denies   TEXT    NOT NULL DEFAULT '[]',
    builtin  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE role_assignments (
    platform   TEXT    NOT NULL,
    account_id TEXT    NOT NULL,
    role       TEXT    NOT NULL,
    scope      TEXT    NOT NULL,
    granted_by TEXT    NOT NULL,
    at         INTEGER NOT NULL,
    PRIMARY KEY (platform, account_id, role, scope)
);

CREATE TABLE role_mappings (
    platform      TEXT NOT NULL,
    guild         TEXT NOT NULL,
    platform_role TEXT NOT NULL,
    role          TEXT NOT NULL,
    PRIMARY KEY (platform, guild, platform_role)
);

CREATE TABLE node_overrides (
    scope TEXT    NOT NULL,
    role  TEXT    NOT NULL,
    node  TEXT    NOT NULL,
    allow INTEGER NOT NULL,
    PRIMARY KEY (scope, role, node)
);

-- Who did what, newest first.
CREATE TABLE audit_log (
    id     TEXT    PRIMARY KEY,
    at     INTEGER NOT NULL,
    actor  TEXT    NOT NULL,
    action TEXT    NOT NULL,
    target TEXT    NOT NULL,
    -- JSON text.
    detail TEXT    NOT NULL,
    ok     INTEGER NOT NULL
);

CREATE INDEX audit_log_recent_idx ON audit_log (at DESC, id DESC);
CREATE INDEX audit_log_actor_idx ON audit_log (actor, at DESC, id DESC);
