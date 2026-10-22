CREATE TABLE managed_positions (
  strategy_id TEXT PRIMARY KEY REFERENCES execution_strategies(id),
  account_id TEXT NOT NULL,
  state_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE managed_position_claims (
  account_id TEXT NOT NULL,
  symbol TEXT NOT NULL,
  strategy_id TEXT NOT NULL,
  PRIMARY KEY(account_id, symbol)
);
CREATE TABLE managed_risk_lock (
  singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL
);
