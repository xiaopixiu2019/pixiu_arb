-- Reservations block trading writes during read/cancel/recheck preparation. The existing
-- controller is retained until the new controller and baseline are committed atomically.
CREATE TABLE managed_position_reservations (
  symbol TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  strategy_id TEXT NOT NULL,
  previous_owner TEXT
);
CREATE INDEX managed_reservation_strategy_idx ON managed_position_reservations(strategy_id);
