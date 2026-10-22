CREATE TABLE task_pnl_book (
  account_key TEXT NOT NULL, id TEXT NOT NULL, at INTEGER NOT NULL,
  payload TEXT NOT NULL, conflict INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(account_key, id)
);
CREATE INDEX task_pnl_book_time ON task_pnl_book(account_key, at);
CREATE TABLE task_pnl_coverage (
  account_key TEXT NOT NULL, from_at INTEGER NOT NULL, to_at INTEGER NOT NULL,
  PRIMARY KEY(account_key, from_at, to_at)
);
