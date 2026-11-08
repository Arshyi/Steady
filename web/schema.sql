-- Steady schema. The Worker also applies this idempotently on first request.
CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY,
  name TEXT,
  firmware TEXT,
  last_seen INTEGER,
  meta TEXT
);

CREATE TABLE IF NOT EXISTS samples (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  device TEXT NOT NULL,
  ts INTEGER NOT NULL,
  ax REAL, ay REAL, az REAL,
  gx REAL, gy REAL, gz REAL,
  roll REAL, pitch REAL, tilt REAL, svm REAL,
  state INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_samples_device_ts ON samples(device, ts);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  uid TEXT NOT NULL UNIQUE,
  device TEXT NOT NULL,
  ts INTEGER NOT NULL,
  device_ts INTEGER,
  duration_ms INTEGER,
  peak_g REAL,
  min_g REAL,
  tilt_before REAL,
  tilt_after REAL,
  tilt_delta REAL,
  confidence INTEGER,
  flags INTEGER,
  rate_hz INTEGER,
  waveform TEXT,
  analysis TEXT,
  verdict TEXT,
  severity TEXT,
  server_score INTEGER,
  agreement TEXT,
  reviewed_label TEXT,
  reviewed_note TEXT,
  reviewed_at INTEGER,
  created_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_events_device_ts ON events(device, ts DESC);

-- Survey mode: one row per triple-press capture, then its access points.
CREATE TABLE IF NOT EXISTS surveys (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  uid TEXT NOT NULL UNIQUE,
  device TEXT NOT NULL,
  taken_at INTEGER NOT NULL,
  scan_count INTEGER NOT NULL,
  access_points INTEGER NOT NULL,
  room TEXT,
  floor TEXT,
  labelled_at INTEGER,
  created_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_surveys_device ON surveys(device, taken_at DESC);

CREATE TABLE IF NOT EXISTS fingerprints (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  survey_id INTEGER NOT NULL,
  device TEXT NOT NULL,
  room TEXT,
  floor TEXT,
  bssid TEXT NOT NULL,
  rssi INTEGER NOT NULL,
  ssid TEXT,
  channel INTEGER
);
CREATE INDEX IF NOT EXISTS idx_fingerprints_survey ON fingerprints(survey_id);
CREATE INDEX IF NOT EXISTS idx_fingerprints_room ON fingerprints(room, bssid);

-- "I'm OK" presses.
CREATE TABLE IF NOT EXISTS acks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  uid TEXT NOT NULL UNIQUE,
  device TEXT NOT NULL,
  kind TEXT NOT NULL,
  ts INTEGER NOT NULL,
  created_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_acks_ts ON acks(ts DESC);

-- Result of matching the latest scan against the fingerprints.
CREATE TABLE IF NOT EXISTS locations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  device TEXT NOT NULL,
  room TEXT,
  floor TEXT,
  confidence INTEGER,
  distance REAL,
  matched INTEGER,
  ts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_locations_device ON locations(device, ts DESC);
