-- Coins (docs/design/economy.md §6): an append-only ledger, the balance is the sum of a wallet's
-- rows. A wallet is a person's accounts together. Rows are never updated; a refund is a row.
CREATE TABLE coin_ledger (
    -- ULID.
    id              TEXT    PRIMARY KEY,
    profile_id      TEXT    NOT NULL,
    author_platform TEXT    NOT NULL,
    author_id       TEXT    NOT NULL,
    -- Positive: earned or refunded; negative: spent.
    delta           INTEGER NOT NULL,
    -- `checkin`, `talked`, `voice`, `song`, `her_gift`, `feed`, `letter`, `expression`,
    -- `frame`, `refund`.
    reason          TEXT    NOT NULL,
    -- What it is about: the food and count, the frame, her reason, the refunded row.
    ref             TEXT,
    -- One key counts once per account (a retried click, the day of a check-in).
    idem_key        TEXT,
    ts              INTEGER NOT NULL
);

CREATE UNIQUE INDEX coin_ledger_idem_idx
    ON coin_ledger (profile_id, author_platform, author_id, idem_key);
CREATE INDEX coin_ledger_author_idx
    ON coin_ledger (profile_id, author_platform, author_id, ts);
-- Totals across everyone (what she gave today).
CREATE INDEX coin_ledger_reason_idx
    ON coin_ledger (profile_id, reason, ts);

-- The card frame someone chose; owning one is a `frame` row of the ledger.
CREATE TABLE coin_wallets (
    profile_id      TEXT    NOT NULL,
    author_platform TEXT    NOT NULL,
    author_id       TEXT    NOT NULL,
    frame           TEXT,
    updated_at      INTEGER NOT NULL,
    PRIMARY KEY (profile_id, author_platform, author_id)
);
