CREATE TABLE IF NOT EXISTS ml_reliever_posts (
  id INTEGER PRIMARY KEY,
  created_by INTEGER NOT NULL REFERENCES ml_users(id),
  date TEXT NOT NULL,
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  location TEXT NOT NULL,
  rate_cents INTEGER NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  legacy_availability_id INTEGER UNIQUE,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
ALTER TABLE ml_bookings ADD COLUMN reliever_post_id INTEGER REFERENCES ml_reliever_posts(id);
CREATE UNIQUE INDEX IF NOT EXISTS ml_bookings_reliever_post ON ml_bookings(reliever_post_id) WHERE reliever_post_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ml_reliever_posts_date ON ml_reliever_posts(date,active);
INSERT INTO ml_reliever_posts(created_by,date,start_time,end_time,location,rate_cents,legacy_availability_id)
SELECT a.doctor_id,a.date,a.start_time,a.end_time,a.location,a.rate_cents,a.id
FROM ml_availability a
WHERE a.rate_cents>0 AND NOT EXISTS (
  SELECT 1 FROM ml_bookings b WHERE b.doctor_id=a.doctor_id AND b.date=a.date
    AND b.status IN ('pending','approved') AND b.start_time<a.end_time AND b.end_time>a.start_time
);
