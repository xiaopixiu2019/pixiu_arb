CREATE TABLE IF NOT EXISTS crypto_market_cap_snapshot (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  assets_json TEXT NOT NULL,
  known_symbols_json TEXT NOT NULL,
  fetched_at TEXT NOT NULL
);
