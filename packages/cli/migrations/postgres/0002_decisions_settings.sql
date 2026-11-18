-- Attention decisions of the agent and small per-profile runtime settings.

-- One row per decision, for "why did she (not) reply" views.
CREATE TABLE decision_log (
    id           TEXT        PRIMARY KEY,
    profile_id   TEXT        NOT NULL,
    -- Canonical JSON of the trace's `ContextKey`, used for lookups.
    context_key  TEXT        NOT NULL,
    ts           TIMESTAMPTZ NOT NULL,
    trace        JSONB       NOT NULL
);

CREATE INDEX decision_log_recent_idx
    ON decision_log (profile_id, ts DESC);

CREATE INDEX decision_log_context_idx
    ON decision_log (profile_id, context_key, ts DESC);

-- Free-form JSON settings per profile, keyed `area:subkey` by convention.
CREATE TABLE profile_settings (
    profile_id  TEXT        NOT NULL,
    key         TEXT        NOT NULL,
    value       JSONB       NOT NULL,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (profile_id, key)
);
