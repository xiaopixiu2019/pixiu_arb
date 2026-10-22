CREATE TABLE IF NOT EXISTS credential_session (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  active_profile_id TEXT REFERENCES credential_metadata(id) ON DELETE SET NULL,
  updated_at TEXT NOT NULL
);
