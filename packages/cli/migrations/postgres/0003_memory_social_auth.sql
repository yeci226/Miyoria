-- Long-term memory, relationships, identity linking, roles and the audit log.
-- Ids are ULIDs stored as text. Per-character data carries `profile_id`.

-- Memory records. The privacy scope is kept both as jsonb (readable) and as a
-- canonical JSON string `scope_key` (exact-match filtering and deletion).
CREATE TABLE memory_records (
    id            TEXT        PRIMARY KEY,
    profile_id    TEXT        NOT NULL,
    kind          TEXT        NOT NULL,
    scope         JSONB       NOT NULL,
    scope_key     TEXT        NOT NULL,
    subjects      TEXT[]      NOT NULL DEFAULT '{}',
    content       TEXT        NOT NULL,
    -- Space-separated, already segmented search tokens.
    tokens        TEXT        NOT NULL,
    tsv           TSVECTOR    GENERATED ALWAYS AS (to_tsvector('simple', tokens)) STORED,
    -- No fixed dimension: the embedding model may change. Searches only
    -- compare rows with the query's dimension (`vector_dims`).
    embedding     VECTOR,
    importance    REAL        NOT NULL,
    confidence    REAL        NOT NULL,
    created_at    TIMESTAMPTZ NOT NULL,
    updated_at    TIMESTAMPTZ NOT NULL,
    last_accessed TIMESTAMPTZ,
    access_count  BIGINT      NOT NULL DEFAULT 0,
    source_context TEXT,
    due           TIMESTAMPTZ,
    done          BOOLEAN     NOT NULL DEFAULT FALSE,
    superseded_by TEXT
);

CREATE INDEX memory_records_list_idx
    ON memory_records (profile_id, created_at DESC, id DESC);
CREATE INDEX memory_records_scope_idx
    ON memory_records (profile_id, scope_key);
CREATE INDEX memory_records_subjects_idx
    ON memory_records USING GIN (subjects);
CREATE INDEX memory_records_tsv_idx
    ON memory_records USING GIN (tsv);
-- Open followups only.
CREATE INDEX memory_records_due_idx
    ON memory_records (profile_id, due)
    WHERE kind = 'followup' AND NOT done AND due IS NOT NULL;
-- Deliberately no ANN index on `embedding` yet: a single index needs a fixed
-- dimension and nearest-neighbour search is an exact scan of the profile's
-- rows. Add an HNSW index per dimension (expression index on
-- `(embedding::vector(N))`) once volumes call for it.

-- One profile's feelings about one person, plus the change history.
CREATE TABLE relationships (
    profile_id       TEXT        NOT NULL,
    person_id        TEXT        NOT NULL,
    affinity         REAL        NOT NULL,
    trust            REAL        NOT NULL,
    familiarity      REAL        NOT NULL,
    tags             TEXT[]      NOT NULL DEFAULT '{}',
    notes            TEXT        NOT NULL,
    call_name        TEXT,
    interactions     BIGINT      NOT NULL DEFAULT 0,
    last_interaction TIMESTAMPTZ,
    updated_at       TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (profile_id, person_id)
);

CREATE TABLE relationship_deltas (
    seq         BIGSERIAL   PRIMARY KEY,
    profile_id  TEXT        NOT NULL,
    person_id   TEXT        NOT NULL,
    at          TIMESTAMPTZ NOT NULL,
    affinity    REAL        NOT NULL,
    trust       REAL        NOT NULL,
    familiarity REAL        NOT NULL,
    reason      TEXT        NOT NULL
);

CREATE INDEX relationship_deltas_idx
    ON relationship_deltas (profile_id, person_id, at, seq);

-- One-time codes for linking accounts.
CREATE TABLE link_codes (
    code       TEXT        PRIMARY KEY,
    platform   TEXT        NOT NULL,
    account_id TEXT        NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL
);

-- Roles. `scope` columns hold the canonical JSON of an `AuthScope`.
CREATE TABLE roles (
    name     TEXT    PRIMARY KEY,
    rank     INTEGER NOT NULL,
    grants   TEXT[]  NOT NULL DEFAULT '{}',
    denies   TEXT[]  NOT NULL DEFAULT '{}',
    builtin  BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE TABLE role_assignments (
    platform   TEXT        NOT NULL,
    account_id TEXT        NOT NULL,
    role       TEXT        NOT NULL,
    scope      TEXT        NOT NULL,
    granted_by TEXT        NOT NULL,
    at         TIMESTAMPTZ NOT NULL,
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
    allow BOOLEAN NOT NULL,
    PRIMARY KEY (scope, role, node)
);

-- Who did what, newest first.
CREATE TABLE audit_log (
    id     TEXT        PRIMARY KEY,
    at     TIMESTAMPTZ NOT NULL,
    actor  TEXT        NOT NULL,
    action TEXT        NOT NULL,
    target TEXT        NOT NULL,
    detail JSONB       NOT NULL,
    ok     BOOLEAN     NOT NULL
);

CREATE INDEX audit_log_recent_idx ON audit_log (at DESC, id DESC);
CREATE INDEX audit_log_actor_idx ON audit_log (actor, at DESC, id DESC);
