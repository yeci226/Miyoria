-- How each agent turn ended (sent / silence / cancelled / error), so "decided to reply but
-- nothing went out" can be queried next to the attention decision.
CREATE TABLE turn_outcomes (
    -- The turn id (one row per turn; a later write of the same turn replaces it).
    id           TEXT    PRIMARY KEY,
    profile_id   TEXT    NOT NULL,
    -- Canonical JSON of the record's `ContextKey`, used for lookups.
    context_key  TEXT    NOT NULL,
    ts           INTEGER NOT NULL,
    -- `sent`, `silence`, `cancelled` or `error`.
    outcome      TEXT    NOT NULL,
    -- JSON text of the `TurnOutcomeRecord`.
    record       TEXT    NOT NULL
);

CREATE INDEX turn_outcomes_recent_idx
    ON turn_outcomes (profile_id, ts DESC, id DESC);

CREATE INDEX turn_outcomes_context_idx
    ON turn_outcomes (profile_id, context_key, ts DESC, id DESC);
