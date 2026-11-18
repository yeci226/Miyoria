-- Attention decisions of the agent and small per-profile runtime settings.

-- One row per decision, for "why did she (not) reply" views.
CREATE TABLE decision_log (
    id           TEXT    PRIMARY KEY,
    profile_id   TEXT    NOT NULL,
    -- Canonical JSON of the trace's `ContextKey`, used for lookups.
    context_key  TEXT    NOT NULL,
    ts           INTEGER NOT NULL,
    -- JSON text of the `DecisionTrace`.
    trace        TEXT    NOT NULL
);

CREATE INDEX decision_log_recent_idx
    ON decision_log (profile_id, ts DESC, id DESC);

CREATE INDEX decision_log_context_idx
    ON decision_log (profile_id, context_key, ts DESC, id DESC);

-- Free-form JSON settings per profile, keyed `area:subkey` by convention.
CREATE TABLE profile_settings (
    profile_id  TEXT    NOT NULL,
    key         TEXT    NOT NULL,
    -- JSON text.
    value       TEXT    NOT NULL,
    updated_at  INTEGER NOT NULL,
    PRIMARY KEY (profile_id, key)
);
