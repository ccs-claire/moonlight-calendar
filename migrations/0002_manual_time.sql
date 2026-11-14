ALTER TABLE ml_attendance ADD COLUMN entry_source TEXT NOT NULL DEFAULT 'clock';
ALTER TABLE ml_attendance ADD COLUMN evidence_note TEXT NOT NULL DEFAULT '';
