-- Who told her a memory (`remember`): JSON `{"account": {...}, "name": "..."}`; NULL for
-- memories she extracted herself.
ALTER TABLE memory_records ADD COLUMN source TEXT;
