ALTER TABLE ml_bookings ADD COLUMN end_date TEXT NOT NULL DEFAULT '';
UPDATE ml_bookings SET end_date=date WHERE end_date='';
CREATE INDEX IF NOT EXISTS ml_bookings_end_date ON ml_bookings(end_date,status);
