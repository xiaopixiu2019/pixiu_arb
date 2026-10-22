-- Independent, account-scoped financial evidence. Never subject to portfolio_snapshots retention.
CREATE TABLE performance_samples (
  account_key TEXT NOT NULL, at INTEGER NOT NULL,
  equity TEXT, available TEXT, reason TEXT,
  rates_json TEXT NOT NULL, balances_json TEXT NOT NULL,
  PRIMARY KEY (account_key, at)
);
CREATE INDEX performance_samples_time ON performance_samples(account_key, at);
CREATE TABLE performance_flows (
  account_key TEXT NOT NULL, id TEXT NOT NULL, at INTEGER NOT NULL,
  amount TEXT, reason TEXT, evidence_json TEXT NOT NULL,
  PRIMARY KEY (account_key, id)
);
CREATE TABLE performance_coverage (
  account_key TEXT NOT NULL, from_at INTEGER NOT NULL, to_at INTEGER NOT NULL,
  reason TEXT,
  PRIMARY KEY (account_key, from_at, to_at)
);
