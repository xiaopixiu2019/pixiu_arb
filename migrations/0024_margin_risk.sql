CREATE TABLE margin_risk_accounts (
  account_key TEXT PRIMARY KEY,
  policy_json TEXT NOT NULL,
  incident_json TEXT,
  entry_latched INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE margin_risk_samples (
  account_key TEXT NOT NULL,
  sampled_at INTEGER NOT NULL,
  metrics_json TEXT,
  PRIMARY KEY (account_key, sampled_at)
);
CREATE TABLE margin_risk_minutes (
  account_key TEXT NOT NULL,
  minute_at INTEGER NOT NULL,
  point_json TEXT NOT NULL,
  PRIMARY KEY (account_key, minute_at)
);
CREATE TABLE margin_risk_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_key TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  kind TEXT NOT NULL,
  detail TEXT NOT NULL,
  revision INTEGER NOT NULL,
  evidence_json TEXT
);
CREATE INDEX margin_risk_events_account_time ON margin_risk_events(account_key, created_at DESC);
CREATE TABLE margin_telegram_deliveries (
  account_key TEXT PRIMARY KEY,
  state TEXT NOT NULL,
  sent_at INTEGER NOT NULL
);
