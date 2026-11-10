-- Memory provenance (docs/design/v3-architecture.md §11): every memory says whether she lived it
-- or was told it, and which EventLog events it came from.
--
-- Existing rows are not guessed at. A note someone asked her to write down (`source` is set)
-- really was told to her; everything else stays 'unknown' and keeps working as before.
ALTER TABLE memory_records ADD COLUMN origin TEXT NOT NULL DEFAULT 'unknown';
-- JSON array of EventLog ids (or `msg:<id>` of a chat line the log has no event for).
ALTER TABLE memory_records ADD COLUMN source_events TEXT NOT NULL DEFAULT '[]';

UPDATE memory_records SET origin = 'told' WHERE source IS NOT NULL;
