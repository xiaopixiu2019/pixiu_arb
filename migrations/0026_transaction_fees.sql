ALTER TABLE execution_orders ADD COLUMN fee_phase TEXT;
CREATE TABLE fee_epochs (
  account_key TEXT PRIMARY KEY, profile_id TEXT NOT NULL, started_at INTEGER NOT NULL,
  covered_to INTEGER NOT NULL, checked_at INTEGER, book_reason TEXT, trade_reason TEXT, trades_to INTEGER NOT NULL
);
CREATE TABLE fee_book (
  account_key TEXT NOT NULL, id TEXT NOT NULL, at INTEGER NOT NULL, venue TEXT NOT NULL,
  order_id TEXT NOT NULL, coin TEXT NOT NULL, cost TEXT NOT NULL, usd TEXT, rate TEXT,
  conflict INTEGER NOT NULL DEFAULT 0, payload TEXT NOT NULL,
  PRIMARY KEY(account_key, id)
);
CREATE INDEX fee_book_account_time ON fee_book(account_key, at);
CREATE TABLE fee_trades (
  account_key TEXT NOT NULL, venue TEXT NOT NULL, id TEXT NOT NULL, order_id TEXT NOT NULL,
  at INTEGER NOT NULL, conflict INTEGER NOT NULL DEFAULT 0, payload TEXT NOT NULL,
  PRIMARY KEY(account_key, venue, id)
);
CREATE INDEX fee_trades_account_order ON fee_trades(account_key, venue, order_id);
CREATE TABLE fee_order_bindings (
  account_key TEXT NOT NULL, venue TEXT NOT NULL, order_id TEXT NOT NULL,
  task_id TEXT NOT NULL, task_started_at INTEGER NOT NULL, phase TEXT NOT NULL,
  leg TEXT, client_order_id TEXT NOT NULL,
  PRIMARY KEY(account_key, venue, order_id)
);
CREATE TABLE fee_rates (
  account_key TEXT NOT NULL, at INTEGER NOT NULL, payload TEXT NOT NULL,
  PRIMARY KEY(account_key, at)
);
