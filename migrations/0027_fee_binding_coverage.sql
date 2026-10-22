CREATE TABLE fee_binding_coverage (
  account_key TEXT NOT NULL, venue TEXT NOT NULL, order_id TEXT NOT NULL,
  symbol TEXT, quantity TEXT, order_at INTEGER,
  PRIMARY KEY(account_key, venue, order_id),
  FOREIGN KEY(account_key, venue, order_id) REFERENCES fee_order_bindings(account_key, venue, order_id) ON DELETE CASCADE
);
ALTER TABLE execution_fills ADD COLUMN fee_coin TEXT;
