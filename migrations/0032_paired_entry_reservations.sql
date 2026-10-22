-- Execution commitments are distinct from ownership and margin-reduction cost reservations.
CREATE TABLE paired_entry_reservations (
  strategy_id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  config_hash TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX paired_entry_account_idx ON paired_entry_reservations(account_id);
