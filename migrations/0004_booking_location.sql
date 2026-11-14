ALTER TABLE ml_bookings ADD COLUMN location TEXT NOT NULL DEFAULT '';
UPDATE ml_bookings SET location=COALESCE((SELECT a.location FROM ml_availability a WHERE a.doctor_id=ml_bookings.doctor_id AND a.date=ml_bookings.date AND a.start_time<=ml_bookings.start_time AND a.end_time>=ml_bookings.end_time ORDER BY a.id LIMIT 1),'');
