-- Directives (docs/design/v3-architecture.md §9): the owner's rules. They outlive restarts; a rule
-- ends when it expires or someone removes it, and the row stays so the panel can show what ended.
CREATE TABLE directives (
    id           TEXT    PRIMARY KEY,
    profile_id   TEXT    NOT NULL,
    -- JSON of the `AccountRef` that made it.
    issuer       TEXT    NOT NULL,
    authority    TEXT    NOT NULL CHECK (authority IN ('owner', 'moderator', 'system', 'viewer')),
    -- JSON of `DirectiveScope`.
    scope        TEXT    NOT NULL,
    effect       TEXT    NOT NULL
                 CHECK (effect IN ('deny', 'require_approval', 'prefer', 'avoid')),
    text         TEXT    NOT NULL,
    -- NULL: `until_revoked`.
    expires      INTEGER,
    source_event TEXT    NOT NULL,
    created_at   INTEGER NOT NULL,
    revoked_at   INTEGER,
    revoked_by   TEXT
);

CREATE INDEX directives_live_idx ON directives (profile_id, expires) WHERE revoked_at IS NULL;
CREATE INDEX directives_recent_idx ON directives (profile_id, created_at);
