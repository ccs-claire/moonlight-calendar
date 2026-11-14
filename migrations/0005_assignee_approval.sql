ALTER TABLE ml_bookings ADD COLUMN approval_owner TEXT NOT NULL DEFAULT 'admin' CHECK(approval_owner IN ('admin','assignee'));
