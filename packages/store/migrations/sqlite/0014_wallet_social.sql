-- People with each other (docs/design/economy.md §13): who is on the sponsor board, and the
-- fortune slips she writes. Transfers need no table; they are two ledger rows.

-- Opted in to the sponsor board. Off unless someone turns it on. A person's accounts are one
-- wallet: any of them on is on.
ALTER TABLE coin_wallets ADD COLUMN on_board INTEGER NOT NULL DEFAULT 0;

-- A fortune slip, at most one per person per local day. They go when the person asks her to
-- forget them.
CREATE TABLE fortunes (
    -- ULID.
    id              TEXT    PRIMARY KEY,
    profile_id      TEXT    NOT NULL,
    -- The session account it was written for.
    author_platform TEXT    NOT NULL,
    author_id       TEXT    NOT NULL,
    person_id       TEXT,
    -- The local day number (days since the epoch, at the API's UTC offset).
    day             INTEGER NOT NULL,
    issued_at       INTEGER NOT NULL,
    -- The `fortune` row of the coin ledger that paid for it.
    entry_id        TEXT,
    -- JSON of the slip: rank, title, poem, fields, line.
    slip            TEXT    NOT NULL
);

CREATE INDEX fortunes_author_idx
    ON fortunes (profile_id, author_platform, author_id, day);
