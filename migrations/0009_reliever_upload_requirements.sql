ALTER TABLE ml_reliever_posts ADD COLUMN required_uploads TEXT NOT NULL DEFAULT '[]';
ALTER TABLE ml_bookings ADD COLUMN reliever_uploads TEXT NOT NULL DEFAULT '[]';
