ALTER TABLE crossex_instruments ADD COLUMN support_cross INTEGER CHECK (support_cross IN (0, 1));
ALTER TABLE execution_orders ADD COLUMN remote_update_time TEXT;
