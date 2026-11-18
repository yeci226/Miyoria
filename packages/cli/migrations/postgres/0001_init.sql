-- Phase-1 schema. Ids are ULIDs stored as text. Data that belongs to one
-- character carries `profile_id`.

-- pgvector, used later by the memory system.
CREATE EXTENSION IF NOT EXISTS vector;

-- Conversation log (working memory source), per profile and context.
CREATE TABLE message_log (
    seq          BIGSERIAL   PRIMARY KEY,
    id           TEXT        NOT NULL UNIQUE,
    profile_id   TEXT        NOT NULL,
    -- Canonical JSON of the `ContextKey`, used for lookups.
    context_key  TEXT        NOT NULL,
    platform     TEXT        NOT NULL,
    scope        TEXT,
    channel      TEXT        NOT NULL,
    kind         TEXT        NOT NULL,
    author_platform TEXT     NOT NULL,
    author_id    TEXT        NOT NULL,
    author_name  TEXT        NOT NULL,
    text         TEXT        NOT NULL,
    is_self      BOOLEAN     NOT NULL,
    ts           TIMESTAMPTZ NOT NULL,
    turn_id      TEXT
);

CREATE INDEX message_log_recent_idx
    ON message_log (profile_id, context_key, ts DESC, seq DESC);

-- Runtime enabled / disabled flag per module (node-wide, not per profile).
CREATE TABLE module_state (
    module_id   TEXT        PRIMARY KEY,
    enabled     BOOLEAN     NOT NULL,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Versioned runtime edits of persona sections.
CREATE TABLE persona_overrides (
    profile_id  TEXT        NOT NULL,
    section_key TEXT        NOT NULL,
    version     INTEGER     NOT NULL,
    body        TEXT        NOT NULL,
    edited_by   TEXT        NOT NULL,
    edited_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (profile_id, section_key, version)
);

-- Cross-platform people and their platform accounts (shared by all profiles).
CREATE TABLE people (
    id           TEXT        PRIMARY KEY,
    display_name TEXT        NOT NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE accounts (
    platform     TEXT        NOT NULL,
    account_id   TEXT        NOT NULL,
    person_id    TEXT        NOT NULL REFERENCES people (id) ON DELETE CASCADE,
    display_name TEXT        NOT NULL,
    first_seen   TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen    TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (platform, account_id)
);

CREATE INDEX accounts_person_idx ON accounts (person_id);
