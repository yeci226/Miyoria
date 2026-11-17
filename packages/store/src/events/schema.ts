// Core migration 2: the event log (docs/design/v5-data.md §2.2). Hand-written SQL, not Drizzle:
// the redaction trigger, the partial indexes and the JSON views of later steps are outside what
// Drizzle declares (research_notes/v5/drizzle-trial.md). Never edit it once a V5 database exists.
//
// Differences from the design's draft, on purpose:
// - `seq` is AUTOINCREMENT: compaction deletes rows, and a paging cursor must never be reused
//   (without it SQLite hands out the highest deleted `seq` again).
// - `events_source_idx`: the facts module reads its lifecycle lines by source at every start, and
//   the panel filters by source; without it both scan the whole table.
// - The trigger checks every envelope column, not only the draft's list (`v`, the place ids,
//   `account_id` and `key` could otherwise change on a redaction).

export const EVENTS_SQL = `-- One table is the raw record: what she perceived, thought, decided, said and did.
CREATE TABLE events (
    -- Commit order; the paging cursor. Never reused.
    seq          INTEGER PRIMARY KEY AUTOINCREMENT,
    -- ULID made when the event was created; appending the same id again stores it once.
    id           TEXT    NOT NULL UNIQUE,
    -- When it happened, microseconds since the epoch.
    at           INTEGER NOT NULL,
    -- Registered type.
    type         TEXT    NOT NULL,
    -- Schema version of \`data\` for this type.
    v            INTEGER NOT NULL DEFAULT 1,
    -- Stamped by Core: the plugin, provider or host it came from.
    source       TEXT    NOT NULL,
    -- The id of the causing event.
    parent       TEXT,
    turn         TEXT,
    -- Session key ('discord:<g>:<c>', 'discord:dm:<person>', 'home').
    session      TEXT,
    -- Copied from the session for scope checks. No foreign keys: the log takes rows for places
    -- and people that are not resolved yet, and a check on every insert costs time.
    space_id     TEXT,
    room_id      TEXT,
    -- The acting person (a person id, never a handle) and account.
    person_id    TEXT,
    account_id   TEXT,
    scope        TEXT    NOT NULL CHECK (scope IN ('public', 'space', 'room', 'dm', 'self', 'owner')),
    tier         TEXT    NOT NULL CHECK (tier IN ('keep', 'long', 'short', 'ambient')),
    -- Attention and dedupe key, e.g. 'msg:discord:<id>'.
    key          TEXT,
    -- JSON text.
    data         TEXT    NOT NULL,
    -- Set once by redact(), together with data = '{"redacted":true}'.
    redacted_at  INTEGER
) STRICT;

CREATE INDEX events_type_idx    ON events (type, seq);
CREATE INDEX events_source_idx  ON events (source, seq);
CREATE INDEX events_session_idx ON events (session, seq) WHERE session IS NOT NULL;
CREATE INDEX events_person_idx  ON events (person_id, type, at) WHERE person_id IS NOT NULL;
CREATE INDEX events_turn_idx    ON events (turn) WHERE turn IS NOT NULL;
CREATE INDEX events_parent_idx  ON events (parent) WHERE parent IS NOT NULL;
CREATE INDEX events_key_idx     ON events (key) WHERE key IS NOT NULL;
CREATE INDEX events_tier_idx    ON events (tier, at);
CREATE INDEX events_at_idx      ON events (at);

-- Rows never change, with one exception: redact() replaces \`data\` and sets \`redacted_at\`, once.
CREATE TRIGGER events_append_only BEFORE UPDATE ON events
WHEN NOT (OLD.redacted_at IS NULL AND NEW.redacted_at IS NOT NULL
          AND NEW.data = '{"redacted":true}'
          AND NEW.seq = OLD.seq AND NEW.id = OLD.id AND NEW.at = OLD.at
          AND NEW.type = OLD.type AND NEW.v = OLD.v AND NEW.source = OLD.source
          AND NEW.parent IS OLD.parent AND NEW.turn IS OLD.turn AND NEW.session IS OLD.session
          AND NEW.space_id IS OLD.space_id AND NEW.room_id IS OLD.room_id
          AND NEW.person_id IS OLD.person_id AND NEW.account_id IS OLD.account_id
          AND NEW.scope = OLD.scope AND NEW.tier = OLD.tier AND NEW.key IS OLD.key)
BEGIN
    SELECT RAISE(ABORT, 'events are append-only');
END;

-- What compaction removed, per UTC day (microseconds of its start), type and source.
CREATE TABLE event_rollups (
    day      INTEGER NOT NULL,
    type     TEXT    NOT NULL,
    source   TEXT    NOT NULL,
    count    INTEGER NOT NULL,
    first_at INTEGER NOT NULL,
    last_at  INTEGER NOT NULL,
    PRIMARY KEY (day, type, source)
) STRICT;
`;

/**
 * Core migration 7: a redaction may also keep part of a payload. "Forget me" takes the words out
 * of events that must stay readable (the heart's `heart.changed`, whose numbers are the day's caps
 * and a person's history): the payload stays a JSON object, the fields with their words are
 * emptied, and it carries `"redacted": true`. Everything else of the trigger is migration 2's: once
 * only, `redacted_at` set, every envelope column unchanged.
 */
export const PARTIAL_REDACTION_SQL = `-- A redaction replaces the payload with '{"redacted":true}', or keeps a JSON object marked
-- "redacted": true (the fields with someone's words emptied); either once.
DROP TRIGGER events_append_only;

CREATE TRIGGER events_append_only BEFORE UPDATE ON events
WHEN NOT (OLD.redacted_at IS NULL AND NEW.redacted_at IS NOT NULL
          AND (NEW.data = '{"redacted":true}'
               OR (json_valid(NEW.data) IS 1 AND json_type(NEW.data) IS 'object'
                   AND json_type(NEW.data, '$.redacted') IS 'true'))
          AND NEW.seq = OLD.seq AND NEW.id = OLD.id AND NEW.at = OLD.at
          AND NEW.type = OLD.type AND NEW.v = OLD.v AND NEW.source = OLD.source
          AND NEW.parent IS OLD.parent AND NEW.turn IS OLD.turn AND NEW.session IS OLD.session
          AND NEW.space_id IS OLD.space_id AND NEW.room_id IS OLD.room_id
          AND NEW.person_id IS OLD.person_id AND NEW.account_id IS OLD.account_id
          AND NEW.scope = OLD.scope AND NEW.tier = OLD.tier AND NEW.key IS OLD.key)
BEGIN
    SELECT RAISE(ABORT, 'events are append-only');
END;
`;

/**
 * Core migration 3: chat lines on the event log (§2.7, §8 step 5). The lines of a session and of
 * an account, by time, over partial indexes (the chat types are a few percent of the log), and
 * `v_messages`, the old `message_log` columns read from the payloads (the data export uses it).
 * The type list is the same text in `chat.ts`: SQLite uses a partial index only when the query
 * names its condition.
 */
export const CHAT_SQL = `-- A session's chat lines by time: MessageLog.recent.
CREATE INDEX events_chat_session_idx ON events (session, at, seq)
    WHERE type IN ('platform.message.created', 'voice.utterance', 'voice.playback');

-- An account's chat lines by time: MessageLog.authoredSince.
CREATE INDEX events_chat_account_idx ON events (account_id, at, seq)
    WHERE type IN ('platform.message.created', 'voice.utterance', 'voice.playback');

-- The chat lines as the message log's rows. A redacted line keeps its envelope; what its payload
-- held reads as NULL.
CREATE VIEW v_messages AS
SELECT
    seq,
    id,
    type,
    coalesce(json_extract(data, '$.id.context.platform'), json_extract(data, '$.context.platform'))
        AS platform,
    CASE WHEN json_type(data, '$.id.context') IS NOT NULL THEN json_extract(data, '$.id.context.scope')
         ELSE json_extract(data, '$.context.scope') END AS scope,
    coalesce(json_extract(data, '$.id.context.channel'), json_extract(data, '$.context.channel'))
        AS channel,
    coalesce(json_extract(data, '$.id.context.kind'), json_extract(data, '$.context.kind')) AS kind,
    coalesce(json_extract(data, '$.author.account.platform'),
             json_extract(data, '$.speaker.account.platform')) AS author_platform,
    coalesce(json_extract(data, '$.author.account.id'), json_extract(data, '$.speaker.account.id'))
        AS author_id,
    coalesce(json_extract(data, '$.author.display_name'), json_extract(data, '$.speaker.display_name'))
        AS author_name,
    json_extract(data, '$.text') AS text,
    CASE WHEN type = 'voice.playback' OR json_extract(data, '$.self') = 1 THEN 1 ELSE 0 END
        AS is_self,
    at AS ts,
    turn AS turn_id,
    session,
    person_id,
    redacted_at,
    data
FROM events
WHERE type IN ('platform.message.created', 'voice.utterance', 'voice.playback');
`;

/**
 * Core migration 4: turn records and audit entries on the event log (§2.7, §8 step 6). Partial
 * indexes for what `DecisionLog` and `AuditLog` read (newest first, for everyone or one place or
 * actor, and the latest outcome of a turn), and the views the data export reads them through in
 * the old tables' columns. The type conditions are the same text in `turns.ts` and `audit.ts`:
 * SQLite uses a partial index only when the query names its condition.
 */
export const TURNS_AUDIT_SQL = `-- Her decisions by time: DecisionLog.recent and decisionsSince.
CREATE INDEX events_decision_idx ON events (at, id) WHERE type = 'agent.decision';

-- A session's decisions by time (session NULL: decisions whose place did not resolve).
CREATE INDEX events_decision_session_idx ON events (session, at, id)
    WHERE type = 'agent.decision';

-- Turn outcomes by time: DecisionLog.recentOutcomes and outcomesSince.
CREATE INDEX events_outcome_idx ON events (at, turn) WHERE type = 'agent.turn.outcome';

-- A session's turn outcomes by time.
CREATE INDEX events_outcome_session_idx ON events (session, at, turn)
    WHERE type = 'agent.turn.outcome';

-- The outcomes of one turn in commit order: a turn written again reads as its latest.
CREATE INDEX events_outcome_turn_idx ON events (turn, seq) WHERE type = 'agent.turn.outcome';

-- Audit entries by time: AuditLog.recent.
CREATE INDEX events_audit_idx ON events (at, id) WHERE type GLOB 'audit.*';

-- One actor's audit entries by time.
CREATE INDEX events_audit_actor_idx ON events (json_extract(data, '$.actor'), at, id)
    WHERE type GLOB 'audit.*';

-- Her decisions as the decision log's rows.
CREATE VIEW v_decisions AS
SELECT seq, id, type, at AS ts, data AS trace, turn, session, person_id
FROM events
WHERE type = 'agent.decision';

-- How each turn ended, the latest outcome of each turn, as the turn outcome rows (id: the turn).
CREATE VIEW v_turns AS
SELECT
    e.seq,
    e.turn AS id,
    e.type,
    e.at AS ts,
    json_extract(e.data, '$.outcome.type') AS outcome,
    e.data AS record,
    e.id AS event_id,
    e.session,
    e.person_id
FROM events e
WHERE e.type = 'agent.turn.outcome'
  AND NOT EXISTS (SELECT 1 FROM events n
                  WHERE n.type = 'agent.turn.outcome' AND n.turn = e.turn AND n.seq > e.seq);

-- Audit entries as the audit log's rows.
CREATE VIEW v_audit AS
SELECT
    seq,
    id,
    type,
    at,
    json_extract(data, '$.actor') AS actor,
    json_extract(data, '$.action') AS action,
    json_extract(data, '$.target') AS target,
    data -> '$.detail' AS detail,
    json_extract(data, '$.ok') AS ok,
    person_id
FROM events
WHERE type GLOB 'audit.*';
`;

/**
 * Core migration 5: LLM calls on the event log (§2.6, §8 step 7). A partial index over the
 * `llm.call` events by time, for the cost totals of a day or a month, and `v_llm_calls`, the calls
 * in columns, which the data export reads. The type condition is the same text in `llm.ts`: SQLite
 * uses a partial index only when the query names its condition.
 */
export const LLM_CALLS_SQL = `-- LLM calls by time: the cost and usage totals since the start of a day or a month.
CREATE INDEX events_llm_call_idx ON events (at) WHERE type = 'llm.call';

-- One row per LLM call: what it was for, the model, tokens, cost and how it ended.
CREATE VIEW v_llm_calls AS
SELECT
    seq,
    id,
    type,
    at,
    json_extract(data, '$.call_id') AS call_id,
    json_extract(data, '$.log_day') AS log_day,
    json_extract(data, '$.purpose') AS purpose,
    json_extract(data, '$.module') AS module,
    json_extract(data, '$.model') AS model,
    json_extract(data, '$.provider') AS provider,
    json_extract(data, '$.status') AS status,
    json_extract(data, '$.error_kind') AS error_kind,
    json_extract(data, '$.usage.prompt_tokens') AS prompt_tokens,
    json_extract(data, '$.usage.completion_tokens') AS completion_tokens,
    json_extract(data, '$.usage.cached_prompt_tokens') AS cached_prompt_tokens,
    json_extract(data, '$.usage.reasoning_tokens') AS reasoning_tokens,
    json_extract(data, '$.cost_usd') AS cost_usd,
    json_extract(data, '$.duration_ms') AS duration_ms,
    turn,
    data
FROM events
WHERE type = 'llm.call';
`;
