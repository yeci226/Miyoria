-- Deals (docs/design/economy.md §12): a bribe she accepted, someone's promise of a snack for a task.
-- Payment is read from the coin ledger, never from her memory; the row only says where the deal is.
CREATE TABLE deals (
    -- ULID.
    id              TEXT        PRIMARY KEY,
    -- Create order, for rows of the same microsecond.
    seq             BIGSERIAL   NOT NULL,
    profile_id      TEXT        NOT NULL,
    -- The speaker; their wallet pays.
    author_platform TEXT        NOT NULL,
    author_id       TEXT        NOT NULL,
    reward_item     TEXT        NOT NULL,
    reward_count    INTEGER     NOT NULL,
    -- What the reward costs in coins, fixed when the deal was made.
    reward_value    BIGINT      NOT NULL,
    task            TEXT        NOT NULL,
    prepaid         BOOLEAN     NOT NULL DEFAULT FALSE,
    -- The escrow's `coin_ledger` row, for a prepaid deal.
    escrow_entry    TEXT,
    status          TEXT        NOT NULL
                    CHECK (status IN ('open', 'owed', 'settled', 'broken', 'refunded', 'cancelled')),
    created_at      TIMESTAMPTZ NOT NULL,
    -- When she said she did the task.
    done_at         TIMESTAMPTZ,
    -- Unpaid: when payment is due; prepaid: when the escrow is refunded if she has not done it.
    due_at          TIMESTAMPTZ,
    closed_at       TIMESTAMPTZ
);

CREATE INDEX deals_author_idx ON deals (profile_id, author_platform, author_id, created_at);
CREATE INDEX deals_status_idx ON deals (profile_id, status, due_at);
