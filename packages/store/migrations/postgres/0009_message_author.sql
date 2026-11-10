-- What someone wrote over time, for the member page's chart (docs/design/v3-architecture.md §17.1).
CREATE INDEX message_log_author_idx
    ON message_log (profile_id, author_platform, author_id, ts);
