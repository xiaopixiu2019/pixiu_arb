CREATE TABLE continuous_protection_authority (
  profile_id TEXT PRIMARY KEY,
  account_key TEXT NOT NULL,
  revision INTEGER NOT NULL,
  enabled INTEGER NOT NULL CHECK (enabled IN (0,1)),
  groups_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE continuous_protection_status (
  profile_id TEXT NOT NULL,
  strategy_id TEXT NOT NULL,
  state TEXT NOT NULL,
  reason TEXT,
  checked_at INTEGER NOT NULL,
  PRIMARY KEY (profile_id, strategy_id)
);
