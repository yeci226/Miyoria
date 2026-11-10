-- The V3 EventLog (docs/design/v3-architecture.md §5). Only the SQLite backend writes it for now
-- (`Store.events`); the tables exist here so the data categories work on both backends.
CREATE TABLE log_events (
    seq           BIGSERIAL   PRIMARY KEY,
    id            TEXT        NOT NULL UNIQUE,
    profile_id    TEXT        NOT NULL,
    at            TIMESTAMPTZ NOT NULL,
    kind          TEXT        NOT NULL,
    source        TEXT        NOT NULL,
    cause         TEXT,
    context_key   TEXT,
    context       JSONB,
    person        TEXT,
    attention_key TEXT,
    salience      TEXT,
    body          JSONB       NOT NULL
);

CREATE INDEX log_events_recent_idx ON log_events (profile_id, id);

CREATE TABLE log_event_rollups (
    profile_id TEXT        NOT NULL,
    day        TIMESTAMPTZ NOT NULL,
    kind       TEXT        NOT NULL,
    source     TEXT        NOT NULL,
    count      BIGINT      NOT NULL,
    first_at   TIMESTAMPTZ NOT NULL,
    last_at    TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (profile_id, day, kind, source)
);
