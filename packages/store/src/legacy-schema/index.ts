// The `legacy` schema: the V4 tables that are still read and written and have no plugin of their
// own yet, as one migration. Its tables keep their V4 names, so it is exempt from the prefix lint.
//
// - `relationships`, `relationship_deltas`: the social module's bond with each person and its
//   changes (`RelationshipStore`). Phase 4 replaces them with `heart_person` and `heart.changed`
//   events (docs/design/v5-data.md §3.2).
// - `member_cards`: the cards the member page issues (`MemberCardStore`). Phase 5's `cards`
//   plugin replaces them.
//
// Until step 14 of v5-data §8 these came from the 18 V4-era migrations (0001-0018), most of which
// had become comments as their tables moved to plugins; no V5 database existed outside tests, so
// they were squashed into this one. `test/legacy-schema.test.ts` holds a dump of what the old chain
// built and checks this migration builds the same.
//
// The tables keep `profile_id` (decision D6 drops it everywhere else): they are redesigned in the
// phases named above, and taking the column out now would change every query and signature over
// them for no lasting gain. No new table gets a `profile_id`.

import type { PluginSchema } from "../migrate.js";

const INIT = `-- One profile's feelings about one person, plus the change history.
CREATE TABLE relationships (
    profile_id       TEXT    NOT NULL,
    person_id        TEXT    NOT NULL,
    affinity         REAL    NOT NULL,
    trust            REAL    NOT NULL,
    familiarity      REAL    NOT NULL,
    tags             TEXT    NOT NULL DEFAULT '[]',
    notes            TEXT    NOT NULL,
    call_name        TEXT,
    interactions     INTEGER NOT NULL DEFAULT 0,
    last_interaction INTEGER,
    updated_at       INTEGER NOT NULL,
    PRIMARY KEY (profile_id, person_id)
);

CREATE TABLE relationship_deltas (
    seq         INTEGER PRIMARY KEY,
    profile_id  TEXT    NOT NULL,
    person_id   TEXT    NOT NULL,
    at          INTEGER NOT NULL,
    affinity    REAL    NOT NULL,
    trust       REAL    NOT NULL,
    familiarity REAL    NOT NULL,
    reason      TEXT    NOT NULL
);

CREATE INDEX relationship_deltas_idx
    ON relationship_deltas (profile_id, person_id, at, seq);

-- Cards she gave people on the member page: what she thought of them when they asked, kept so the
-- code on a card can be checked. They go when the person asks her to forget them.
CREATE TABLE member_cards (
    -- \`MYR-XXXX-XXXX-XXXX\`.
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
`;

/** The V4 tables still in use. Temporary: see the file comment. */
export const legacySchema: PluginSchema = {
  plugin: "legacy",
  migrations: [{ version: 1, name: "init", sql: INIT }],
};
