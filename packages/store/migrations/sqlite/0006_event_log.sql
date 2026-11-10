-- The V3 EventLog (docs/design/v3-architecture.md §5): every fact she perceived, thought, decided,
-- said and did, append-only. Rows are never changed; compaction only ever deletes rows nothing
-- points at, and keeps a count of them in `log_event_rollups`.
CREATE TABLE log_events (
    seq           INTEGER PRIMARY KEY AUTOINCREMENT,
    -- ULID: sorts in creation order, paging goes by it.
    id            TEXT    NOT NULL UNIQUE,
    profile_id    TEXT    NOT NULL,
    at            INTEGER NOT NULL,
    kind          TEXT    NOT NULL,
    source        TEXT    NOT NULL,
    -- The `id` of the event that caused this one.
    cause         TEXT,
    -- Canonical JSON of `context`, used for lookups.
    context_key   TEXT,
    context       TEXT,
    person        TEXT,
    -- Copied out of `body` for lookups (`observation`, `utterance`, `delivered`).
    attention_key TEXT,
    salience      TEXT,
    body          TEXT    NOT NULL
);

CREATE INDEX log_events_recent_idx ON log_events (profile_id, id);
CREATE INDEX log_events_kind_idx ON log_events (profile_id, kind, id);
CREATE INDEX log_events_source_idx ON log_events (profile_id, source, id);
CREATE INDEX log_events_at_idx ON log_events (profile_id, at);
CREATE INDEX log_events_cause_idx ON log_events (cause) WHERE cause IS NOT NULL;
CREATE INDEX log_events_context_idx ON log_events (profile_id, context_key, id)
    WHERE context_key IS NOT NULL;
CREATE INDEX log_events_person_idx ON log_events (profile_id, person, id)
    WHERE person IS NOT NULL;
CREATE INDEX log_events_attention_idx ON log_events (profile_id, attention_key, id)
    WHERE attention_key IS NOT NULL;

CREATE TRIGGER log_events_append_only BEFORE UPDATE ON log_events
BEGIN
    SELECT RAISE(ABORT, 'log_events is append-only');
END;

-- What compaction removed, per UTC day.
CREATE TABLE log_event_rollups (
    profile_id TEXT    NOT NULL,
    -- Start of the UTC day.
    day        INTEGER NOT NULL,
    kind       TEXT    NOT NULL,
    source     TEXT    NOT NULL,
    count      INTEGER NOT NULL,
    first_at   INTEGER NOT NULL,
    last_at    INTEGER NOT NULL,
    PRIMARY KEY (profile_id, day, kind, source)
);
