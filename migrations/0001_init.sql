CREATE TABLE IF NOT EXISTS ml_users (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('admin','doctor','nurse','staff')),
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS ml_sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES ml_users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS ml_availability (
  id INTEGER PRIMARY KEY,
  doctor_id INTEGER NOT NULL REFERENCES ml_users(id),
  date TEXT NOT NULL,
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  location TEXT NOT NULL DEFAULT '',
  rate_cents INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS ml_bookings (
  id INTEGER PRIMARY KEY,
  doctor_id INTEGER NOT NULL REFERENCES ml_users(id),
  requester_id INTEGER NOT NULL REFERENCES ml_users(id),
  date TEXT NOT NULL,
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  rate_cents INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK(status IN ('pending','approved','declined','cancelled')),
  notification_state TEXT NOT NULL DEFAULT 'not_configured',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  decided_at TEXT
);
CREATE TABLE IF NOT EXISTS ml_attendance (
  booking_id INTEGER PRIMARY KEY REFERENCES ml_bookings(id) ON DELETE CASCADE,
  clock_in_at TEXT NOT NULL,
  clock_out_at TEXT,
  clock_in_photo TEXT NOT NULL,
  clock_in_mime TEXT NOT NULL,
  clock_out_photo TEXT,
  clock_out_mime TEXT,
  document_file TEXT,
  document_name TEXT,
  document_mime TEXT
);
CREATE TABLE IF NOT EXISTS ml_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS ml_login_attempts (
  attempt_key TEXT PRIMARY KEY,
  count INTEGER NOT NULL,
  until_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ml_availability_date ON ml_availability(doctor_id,date);
CREATE INDEX IF NOT EXISTS ml_bookings_date ON ml_bookings(doctor_id,date,status);
CREATE INDEX IF NOT EXISTS ml_bookings_requester ON ml_bookings(requester_id,date,status);
