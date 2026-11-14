ALTER TABLE ml_reliever_posts ADD COLUMN required_questions TEXT NOT NULL DEFAULT '[]';
ALTER TABLE ml_bookings ADD COLUMN reliever_answers TEXT NOT NULL DEFAULT '[]';
