-- Her own money (docs/design/economy.md §13): crowdfunding goals people pledge to, and bounties
-- she pays from her purse. The coins themselves are rows of `coin_ledger`; these say where each
-- goal or bounty stands.
CREATE TABLE goals (
    -- ULID.
    id              TEXT        PRIMARY KEY,
    -- Create order, for rows of the same microsecond.
    seq             BIGSERIAL   NOT NULL,
    profile_id      TEXT        NOT NULL,
    title           TEXT        NOT NULL,
    -- What she will do when the target is reached.
    promise         TEXT        NOT NULL,
    target          BIGINT      NOT NULL,
    status          TEXT        NOT NULL
                    CHECK (status IN ('open', 'reached', 'expired', 'cancelled')),
    created_at      TIMESTAMPTZ NOT NULL,
    deadline        TIMESTAMPTZ NOT NULL,
    closed_at       TIMESTAMPTZ
);

CREATE INDEX goals_status_idx ON goals (profile_id, status, created_at);

-- Coins held for a goal; `id` is the escrow's `coin_ledger` row.
CREATE TABLE goal_pledges (
    id              TEXT        PRIMARY KEY,
    seq             BIGSERIAL   NOT NULL,
    goal_id         TEXT        NOT NULL,
    profile_id      TEXT        NOT NULL,
    author_platform TEXT        NOT NULL,
    author_id       TEXT        NOT NULL,
    amount          BIGINT      NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL
);

CREATE INDEX goal_pledges_goal_idx ON goal_pledges (goal_id, created_at);

CREATE TABLE bounties (
    -- ULID.
    id              TEXT        PRIMARY KEY,
    seq             BIGSERIAL   NOT NULL,
    profile_id      TEXT        NOT NULL,
    task            TEXT        NOT NULL,
    reward          BIGINT      NOT NULL,
    -- The purse's `bounty_hold` row in `coin_ledger`.
    hold_entry      TEXT        NOT NULL,
    status          TEXT        NOT NULL
                    CHECK (status IN ('open', 'awarded', 'cancelled', 'expired')),
    created_at      TIMESTAMPTZ NOT NULL,
    expires_at      TIMESTAMPTZ NOT NULL,
    closed_at       TIMESTAMPTZ,
    -- Who the reward was paid to.
    winner_platform TEXT,
    winner_id       TEXT
);

CREATE INDEX bounties_status_idx ON bounties (profile_id, status, created_at);
