CREATE TABLE margin_cost_reservations (
  account_key TEXT NOT NULL,
  batch_id TEXT PRIMARY KEY,
  amount TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  settled_at INTEGER
);
CREATE INDEX margin_cost_reservations_account ON margin_cost_reservations(account_key, settled_at);
