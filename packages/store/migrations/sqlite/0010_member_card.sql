-- Cards she gave people on the member page (docs/design/v3-architecture.md §17.1): what she
-- thought of them when they asked, kept so the code on a card can be checked. They go when the
-- person asks her to forget them.
CREATE TABLE member_cards (
    -- `MYR-XXXX-XXXX-XXXX`.
    serial          TEXT    PRIMARY KEY,
    profile_id      TEXT    NOT NULL,
    -- The session account it was issued to.
    author_platform TEXT    NOT NULL,
    author_id       TEXT    NOT NULL,
    person_id       TEXT,
    issued_at       INTEGER NOT NULL,
    -- JSON of what the card shows.
    snapshot        TEXT    NOT NULL
);

CREATE INDEX member_cards_author_idx
    ON member_cards (profile_id, author_platform, author_id, issued_at);
