CREATE TABLE router_order_context (order_id TEXT PRIMARY KEY, scope TEXT NOT NULL);
CREATE TABLE router_order_evidence (
  order_id TEXT PRIMARY KEY,
  remote_id TEXT,
  fingerprint TEXT NOT NULL,
  kind TEXT NOT NULL,
  observed_at INTEGER NOT NULL,
  working_since INTEGER
);
CREATE TABLE router_retry_events (
  order_id TEXT NOT NULL,
  outcome TEXT NOT NULL,
  strategy_id TEXT NOT NULL,
  PRIMARY KEY(order_id, outcome)
);
CREATE TABLE router_entry_retry (
  strategy_id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  failures INTEGER NOT NULL,
  next_at INTEGER NOT NULL,
  review INTEGER NOT NULL,
  last_sequence INTEGER NOT NULL
);
