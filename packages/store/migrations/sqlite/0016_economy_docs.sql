-- Economy 2.0 documents (docs/design/v4-plan.md §10): collection items, predictions and their bets,
-- commissions and what the audience funded of her room. One table; `kind` says which. Coins are
-- never kept here: every balance change is a row of `coin_ledger`, a document only says what the
-- coins were for and where the thing stands.
CREATE TABLE economy_docs (
    profile_id     TEXT    NOT NULL,
    -- `item`, `prediction`, `bet`, `commission`, `room`.
    kind           TEXT    NOT NULL,
    -- ULID, or a deterministic id that makes a create idempotent.
    id             TEXT    NOT NULL,
    -- Who it belongs to; both NULL for what belongs to nobody in particular.
    owner_platform TEXT,
    owner_id       TEXT,
    -- Kind-specific state word (`open`, `held`, `unlocked`, ...).
    status         TEXT    NOT NULL,
    -- Starts at 1; an update only applies to the version the writer read.
    version        INTEGER NOT NULL,
    -- JSON text.
    data           TEXT    NOT NULL,
    created_at     INTEGER NOT NULL,
    updated_at     INTEGER NOT NULL,
    PRIMARY KEY (profile_id, kind, id)
);

CREATE INDEX economy_docs_recent_idx
    ON economy_docs (profile_id, kind, created_at DESC, id DESC);
CREATE INDEX economy_docs_owner_idx
    ON economy_docs (profile_id, kind, owner_platform, owner_id, created_at DESC);
