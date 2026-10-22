CREATE TABLE task_performance_cache (
  account_key TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL,
  checked_at INTEGER NOT NULL,
  payload TEXT NOT NULL
);
