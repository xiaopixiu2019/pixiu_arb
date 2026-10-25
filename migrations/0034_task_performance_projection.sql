-- Rebuildable financial display projections; canonical evidence and trading authority remain unchanged.
CREATE TABLE task_pnl_watch (account_key TEXT PRIMARY KEY,profile_id TEXT NOT NULL);
CREATE INDEX task_pnl_watch_profile ON task_pnl_watch(profile_id);
CREATE TABLE task_pnl_changes (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, account_key TEXT, profile_id TEXT,
  ref TEXT NOT NULL, payload TEXT NOT NULL
);
CREATE INDEX task_pnl_changes_account ON task_pnl_changes(account_key,sequence);
CREATE INDEX task_pnl_changes_profile ON task_pnl_changes(profile_id,sequence);
CREATE INDEX task_pnl_changes_unscoped ON task_pnl_changes(sequence) WHERE account_key IS NULL AND profile_id IS NULL;
CREATE UNIQUE INDEX task_pnl_changes_pending ON task_pnl_changes(kind,COALESCE(account_key,''),COALESCE(profile_id,''),ref,payload);
CREATE TABLE task_pnl_projection (
  account_key TEXT PRIMARY KEY, profile_id TEXT NOT NULL, processed_sequence INTEGER NOT NULL,
  version INTEGER NOT NULL, checked_at INTEGER NOT NULL, meta_json TEXT NOT NULL
);
CREATE TABLE task_pnl_group_cache (
  account_key TEXT NOT NULL, group_id TEXT NOT NULL, payload TEXT NOT NULL,
  PRIMARY KEY(account_key,group_id)
);
CREATE TABLE task_pnl_pool_cache (
  account_key TEXT NOT NULL, symbol TEXT NOT NULL, payload TEXT NOT NULL,
  PRIMARY KEY(account_key,symbol)
);
CREATE TABLE task_pnl_dependencies (
  account_key TEXT NOT NULL, target_kind TEXT NOT NULL, target_id TEXT NOT NULL,
  coin TEXT NOT NULL, at INTEGER NOT NULL, rate TEXT,
  PRIMARY KEY(account_key,target_kind,target_id,coin,at)
);
CREATE INDEX task_pnl_dependencies_fx ON task_pnl_dependencies(account_key,coin,at);
CREATE INDEX task_pnl_dependencies_time ON task_pnl_dependencies(account_key,at);
CREATE TABLE task_pnl_coverage_merged (
  account_key TEXT NOT NULL, from_at INTEGER NOT NULL, to_at INTEGER NOT NULL,
  PRIMARY KEY(account_key,from_at)
);
CREATE TABLE task_pnl_coverage_state (account_key TEXT PRIMARY KEY, ready INTEGER NOT NULL);
INSERT INTO task_pnl_coverage_state SELECT DISTINCT account_key,0 FROM task_pnl_coverage;
CREATE TABLE task_pnl_source_state (kind TEXT NOT NULL, ref TEXT NOT NULL, signature TEXT NOT NULL, PRIMARY KEY(kind,ref));
CREATE TABLE task_pnl_projection_work (
  account_key TEXT NOT NULL, source_sequence INTEGER NOT NULL, work_key TEXT NOT NULL, payload TEXT NOT NULL,
  PRIMARY KEY(account_key,source_sequence,work_key)
);
CREATE INDEX task_pnl_book_symbol ON task_pnl_book(account_key,json_extract(CASE WHEN json_valid(payload) THEN payload ELSE '{}' END,'$.symbol'));
CREATE INDEX fee_trades_symbol ON fee_trades(account_key,json_extract(CASE WHEN json_valid(payload) THEN payload ELSE '{}' END,'$.symbol'));
CREATE INDEX fee_book_symbol ON fee_book(account_key,json_extract(CASE WHEN json_valid(payload) THEN payload ELSE '{}' END,'$.symbol'));
CREATE INDEX fee_book_order ON fee_book(account_key,order_id);
CREATE INDEX fee_bindings_task ON fee_order_bindings(account_key,task_id);

CREATE TRIGGER task_pnl_coverage_insert AFTER INSERT ON task_pnl_coverage BEGIN
  INSERT OR IGNORE INTO task_pnl_coverage_state VALUES(NEW.account_key,1);
  INSERT INTO task_pnl_coverage_merged(account_key,from_at,to_at)
  SELECT NEW.account_key,MIN(NEW.from_at,COALESCE(MIN(from_at),NEW.from_at)),MAX(NEW.to_at,COALESCE(MAX(to_at),NEW.to_at))
  FROM task_pnl_coverage_merged WHERE account_key=NEW.account_key AND from_at<=NEW.to_at AND to_at>=NEW.from_at
  ON CONFLICT(account_key,from_at) DO UPDATE SET to_at=MAX(to_at,excluded.to_at);
  DELETE FROM task_pnl_coverage_merged WHERE account_key=NEW.account_key AND from_at<=NEW.to_at
    AND from_at>(SELECT MIN(from_at) FROM task_pnl_coverage_merged WHERE account_key=NEW.account_key AND from_at<=NEW.from_at AND to_at>=NEW.to_at);
  INSERT INTO task_pnl_changes(kind,account_key,ref,payload) VALUES('coverage',NEW.account_key,'','{}') ON CONFLICT DO UPDATE SET sequence=excluded.sequence;
END;
CREATE TRIGGER task_pnl_coverage_delete AFTER DELETE ON task_pnl_coverage BEGIN
  INSERT INTO task_pnl_coverage_state VALUES(OLD.account_key,0) ON CONFLICT(account_key) DO UPDATE SET ready=0;
  INSERT INTO task_pnl_changes(kind,account_key,ref,payload) VALUES('coverage',OLD.account_key,'','{}') ON CONFLICT DO UPDATE SET sequence=excluded.sequence;
END;
CREATE TRIGGER task_pnl_coverage_update AFTER UPDATE ON task_pnl_coverage BEGIN
  INSERT INTO task_pnl_coverage_state VALUES(OLD.account_key,0) ON CONFLICT(account_key) DO UPDATE SET ready=0;
  INSERT INTO task_pnl_coverage_state VALUES(NEW.account_key,0) ON CONFLICT(account_key) DO UPDATE SET ready=0;
  INSERT INTO task_pnl_changes(kind,account_key,ref,payload) VALUES('coverage',OLD.account_key,'','{}') ON CONFLICT DO UPDATE SET sequence=excluded.sequence;
  INSERT INTO task_pnl_changes(kind,account_key,ref,payload) VALUES('coverage',NEW.account_key,'','{}') ON CONFLICT DO UPDATE SET sequence=excluded.sequence;
END;

CREATE TRIGGER pnl_task_pnl_book_insert AFTER INSERT ON task_pnl_book WHEN EXISTS(SELECT 1 FROM task_pnl_watch WHERE account_key IN (NEW.account_key)) BEGIN
  INSERT INTO task_pnl_changes(kind,account_key,profile_id,ref,payload) VALUES('book',NEW.account_key,NULL,json_array(NEW.account_key,NEW.id),json_object('symbol',json_extract(CASE WHEN json_valid(NEW.payload) THEN NEW.payload ELSE '{}' END,'$.symbol'),'order',json_extract(CASE WHEN json_valid(NEW.payload) THEN NEW.payload ELSE '{}' END,'$.business_id'),'coin',json_extract(CASE WHEN json_valid(NEW.payload) THEN NEW.payload ELSE '{}' END,'$.coin'),'venue',json_extract(CASE WHEN json_valid(NEW.payload) THEN NEW.payload ELSE '{}' END,'$.exchange_type'),'type',json_extract(CASE WHEN json_valid(NEW.payload) THEN NEW.payload ELSE '{}' END,'$.statement_type'),'at',NEW.at)) ON CONFLICT DO UPDATE SET sequence=excluded.sequence;
END;

CREATE TRIGGER pnl_task_pnl_book_update AFTER UPDATE ON task_pnl_book WHEN (json_array(NEW.payload,NEW.conflict) IS NOT json_array(OLD.payload,OLD.conflict)) AND EXISTS(SELECT 1 FROM task_pnl_watch WHERE account_key IN (NEW.account_key,OLD.account_key)) BEGIN
  INSERT INTO task_pnl_changes(kind,account_key,profile_id,ref,payload) VALUES('book',OLD.account_key,NULL,json_array(OLD.account_key,OLD.id),json_object('symbol',json_extract(CASE WHEN json_valid(OLD.payload) THEN OLD.payload ELSE '{}' END,'$.symbol'),'order',json_extract(CASE WHEN json_valid(OLD.payload) THEN OLD.payload ELSE '{}' END,'$.business_id'),'coin',json_extract(CASE WHEN json_valid(OLD.payload) THEN OLD.payload ELSE '{}' END,'$.coin'),'venue',json_extract(CASE WHEN json_valid(OLD.payload) THEN OLD.payload ELSE '{}' END,'$.exchange_type'),'type',json_extract(CASE WHEN json_valid(OLD.payload) THEN OLD.payload ELSE '{}' END,'$.statement_type'),'at',OLD.at)) ON CONFLICT DO UPDATE SET sequence=excluded.sequence;
  INSERT INTO task_pnl_changes(kind,account_key,profile_id,ref,payload) VALUES('book',NEW.account_key,NULL,json_array(NEW.account_key,NEW.id),json_object('symbol',json_extract(CASE WHEN json_valid(NEW.payload) THEN NEW.payload ELSE '{}' END,'$.symbol'),'order',json_extract(CASE WHEN json_valid(NEW.payload) THEN NEW.payload ELSE '{}' END,'$.business_id'),'coin',json_extract(CASE WHEN json_valid(NEW.payload) THEN NEW.payload ELSE '{}' END,'$.coin'),'venue',json_extract(CASE WHEN json_valid(NEW.payload) THEN NEW.payload ELSE '{}' END,'$.exchange_type'),'type',json_extract(CASE WHEN json_valid(NEW.payload) THEN NEW.payload ELSE '{}' END,'$.statement_type'),'at',NEW.at)) ON CONFLICT DO UPDATE SET sequence=excluded.sequence;
END;

CREATE TRIGGER pnl_task_pnl_book_delete AFTER DELETE ON task_pnl_book WHEN EXISTS(SELECT 1 FROM task_pnl_watch WHERE account_key IN (OLD.account_key)) BEGIN
  INSERT INTO task_pnl_changes(kind,account_key,profile_id,ref,payload) VALUES('book',OLD.account_key,NULL,json_array(OLD.account_key,OLD.id),json_object('symbol',json_extract(CASE WHEN json_valid(OLD.payload) THEN OLD.payload ELSE '{}' END,'$.symbol'),'order',json_extract(CASE WHEN json_valid(OLD.payload) THEN OLD.payload ELSE '{}' END,'$.business_id'),'coin',json_extract(CASE WHEN json_valid(OLD.payload) THEN OLD.payload ELSE '{}' END,'$.coin'),'venue',json_extract(CASE WHEN json_valid(OLD.payload) THEN OLD.payload ELSE '{}' END,'$.exchange_type'),'type',json_extract(CASE WHEN json_valid(OLD.payload) THEN OLD.payload ELSE '{}' END,'$.statement_type'),'at',OLD.at)) ON CONFLICT DO UPDATE SET sequence=excluded.sequence;
END;

CREATE TRIGGER pnl_fee_book_insert AFTER INSERT ON fee_book WHEN EXISTS(SELECT 1 FROM task_pnl_watch WHERE account_key IN (NEW.account_key)) BEGIN
  INSERT INTO task_pnl_changes(kind,account_key,profile_id,ref,payload) VALUES('fee',NEW.account_key,NULL,json_array(NEW.account_key,NEW.id),json_object('symbol',json_extract(CASE WHEN json_valid(NEW.payload) THEN NEW.payload ELSE '{}' END,'$.symbol'),'order',NEW.order_id,'coin',NEW.coin,'venue',NEW.venue,'at',NEW.at)) ON CONFLICT DO UPDATE SET sequence=excluded.sequence;
END;

CREATE TRIGGER pnl_fee_book_update AFTER UPDATE ON fee_book WHEN (json_array(NEW.payload,NEW.conflict,NEW.usd,NEW.rate) IS NOT json_array(OLD.payload,OLD.conflict,OLD.usd,OLD.rate)) AND EXISTS(SELECT 1 FROM task_pnl_watch WHERE account_key IN (NEW.account_key,OLD.account_key)) BEGIN
  INSERT INTO task_pnl_changes(kind,account_key,profile_id,ref,payload) VALUES('fee',OLD.account_key,NULL,json_array(OLD.account_key,OLD.id),json_object('symbol',json_extract(CASE WHEN json_valid(OLD.payload) THEN OLD.payload ELSE '{}' END,'$.symbol'),'order',OLD.order_id,'coin',OLD.coin,'venue',OLD.venue,'at',OLD.at)) ON CONFLICT DO UPDATE SET sequence=excluded.sequence;
  INSERT INTO task_pnl_changes(kind,account_key,profile_id,ref,payload) VALUES('fee',NEW.account_key,NULL,json_array(NEW.account_key,NEW.id),json_object('symbol',json_extract(CASE WHEN json_valid(NEW.payload) THEN NEW.payload ELSE '{}' END,'$.symbol'),'order',NEW.order_id,'coin',NEW.coin,'venue',NEW.venue,'at',NEW.at)) ON CONFLICT DO UPDATE SET sequence=excluded.sequence;
END;

CREATE TRIGGER pnl_fee_book_delete AFTER DELETE ON fee_book WHEN EXISTS(SELECT 1 FROM task_pnl_watch WHERE account_key IN (OLD.account_key)) BEGIN
  INSERT INTO task_pnl_changes(kind,account_key,profile_id,ref,payload) VALUES('fee',OLD.account_key,NULL,json_array(OLD.account_key,OLD.id),json_object('symbol',json_extract(CASE WHEN json_valid(OLD.payload) THEN OLD.payload ELSE '{}' END,'$.symbol'),'order',OLD.order_id,'coin',OLD.coin,'venue',OLD.venue,'at',OLD.at)) ON CONFLICT DO UPDATE SET sequence=excluded.sequence;
END;

CREATE TRIGGER pnl_fee_trades_insert AFTER INSERT ON fee_trades WHEN EXISTS(SELECT 1 FROM task_pnl_watch WHERE account_key IN (NEW.account_key)) BEGIN
  INSERT INTO task_pnl_changes(kind,account_key,profile_id,ref,payload) VALUES('trade',NEW.account_key,NULL,json_array(NEW.account_key,NEW.venue,NEW.id),json_object('symbol',json_extract(CASE WHEN json_valid(NEW.payload) THEN NEW.payload ELSE '{}' END,'$.symbol'),'order',NEW.order_id,'at',NEW.at)) ON CONFLICT DO UPDATE SET sequence=excluded.sequence;
END;

CREATE TRIGGER pnl_fee_trades_update AFTER UPDATE ON fee_trades WHEN (json_array(NEW.payload,NEW.conflict) IS NOT json_array(OLD.payload,OLD.conflict)) AND EXISTS(SELECT 1 FROM task_pnl_watch WHERE account_key IN (NEW.account_key,OLD.account_key)) BEGIN
  INSERT INTO task_pnl_changes(kind,account_key,profile_id,ref,payload) VALUES('trade',OLD.account_key,NULL,json_array(OLD.account_key,OLD.venue,OLD.id),json_object('symbol',json_extract(CASE WHEN json_valid(OLD.payload) THEN OLD.payload ELSE '{}' END,'$.symbol'),'order',OLD.order_id,'at',OLD.at)) ON CONFLICT DO UPDATE SET sequence=excluded.sequence;
  INSERT INTO task_pnl_changes(kind,account_key,profile_id,ref,payload) VALUES('trade',NEW.account_key,NULL,json_array(NEW.account_key,NEW.venue,NEW.id),json_object('symbol',json_extract(CASE WHEN json_valid(NEW.payload) THEN NEW.payload ELSE '{}' END,'$.symbol'),'order',NEW.order_id,'at',NEW.at)) ON CONFLICT DO UPDATE SET sequence=excluded.sequence;
END;

CREATE TRIGGER pnl_fee_trades_delete AFTER DELETE ON fee_trades WHEN EXISTS(SELECT 1 FROM task_pnl_watch WHERE account_key IN (OLD.account_key)) BEGIN
  INSERT INTO task_pnl_changes(kind,account_key,profile_id,ref,payload) VALUES('trade',OLD.account_key,NULL,json_array(OLD.account_key,OLD.venue,OLD.id),json_object('symbol',json_extract(CASE WHEN json_valid(OLD.payload) THEN OLD.payload ELSE '{}' END,'$.symbol'),'order',OLD.order_id,'at',OLD.at)) ON CONFLICT DO UPDATE SET sequence=excluded.sequence;
END;

CREATE TRIGGER pnl_fee_order_bindings_insert AFTER INSERT ON fee_order_bindings WHEN EXISTS(SELECT 1 FROM task_pnl_watch WHERE account_key IN (NEW.account_key)) BEGIN
  INSERT INTO task_pnl_changes(kind,account_key,profile_id,ref,payload) VALUES('binding',NEW.account_key,NULL,json_array(NEW.account_key,NEW.venue,NEW.order_id),json_object('task',NEW.task_id,'order',NEW.order_id)) ON CONFLICT DO UPDATE SET sequence=excluded.sequence;
END;

CREATE TRIGGER pnl_fee_order_bindings_update AFTER UPDATE ON fee_order_bindings WHEN (json_array(NEW.task_id,NEW.task_started_at,NEW.phase,NEW.leg,NEW.client_order_id) IS NOT json_array(OLD.task_id,OLD.task_started_at,OLD.phase,OLD.leg,OLD.client_order_id)) AND EXISTS(SELECT 1 FROM task_pnl_watch WHERE account_key IN (NEW.account_key,OLD.account_key)) BEGIN
  INSERT INTO task_pnl_changes(kind,account_key,profile_id,ref,payload) VALUES('binding',OLD.account_key,NULL,json_array(OLD.account_key,OLD.venue,OLD.order_id),json_object('task',OLD.task_id,'order',OLD.order_id)) ON CONFLICT DO UPDATE SET sequence=excluded.sequence;
  INSERT INTO task_pnl_changes(kind,account_key,profile_id,ref,payload) VALUES('binding',NEW.account_key,NULL,json_array(NEW.account_key,NEW.venue,NEW.order_id),json_object('task',NEW.task_id,'order',NEW.order_id)) ON CONFLICT DO UPDATE SET sequence=excluded.sequence;
END;

CREATE TRIGGER pnl_fee_order_bindings_delete AFTER DELETE ON fee_order_bindings WHEN EXISTS(SELECT 1 FROM task_pnl_watch WHERE account_key IN (OLD.account_key)) BEGIN
  INSERT INTO task_pnl_changes(kind,account_key,profile_id,ref,payload) VALUES('binding',OLD.account_key,NULL,json_array(OLD.account_key,OLD.venue,OLD.order_id),json_object('task',OLD.task_id,'order',OLD.order_id)) ON CONFLICT DO UPDATE SET sequence=excluded.sequence;
END;

CREATE TRIGGER pnl_fee_binding_coverage_insert AFTER INSERT ON fee_binding_coverage WHEN EXISTS(SELECT 1 FROM task_pnl_watch WHERE account_key IN (NEW.account_key)) BEGIN
  INSERT INTO task_pnl_changes(kind,account_key,profile_id,ref,payload) VALUES('binding',NEW.account_key,NULL,json_array(NEW.account_key,NEW.venue,NEW.order_id),json_object('symbol',NEW.symbol,'order',NEW.order_id)) ON CONFLICT DO UPDATE SET sequence=excluded.sequence;
END;

CREATE TRIGGER pnl_fee_binding_coverage_update AFTER UPDATE ON fee_binding_coverage WHEN (json_array(NEW.symbol,NEW.quantity,NEW.order_at) IS NOT json_array(OLD.symbol,OLD.quantity,OLD.order_at)) AND EXISTS(SELECT 1 FROM task_pnl_watch WHERE account_key IN (NEW.account_key,OLD.account_key)) BEGIN
  INSERT INTO task_pnl_changes(kind,account_key,profile_id,ref,payload) VALUES('binding',OLD.account_key,NULL,json_array(OLD.account_key,OLD.venue,OLD.order_id),json_object('symbol',OLD.symbol,'order',OLD.order_id)) ON CONFLICT DO UPDATE SET sequence=excluded.sequence;
  INSERT INTO task_pnl_changes(kind,account_key,profile_id,ref,payload) VALUES('binding',NEW.account_key,NULL,json_array(NEW.account_key,NEW.venue,NEW.order_id),json_object('symbol',NEW.symbol,'order',NEW.order_id)) ON CONFLICT DO UPDATE SET sequence=excluded.sequence;
END;

CREATE TRIGGER pnl_fee_binding_coverage_delete AFTER DELETE ON fee_binding_coverage WHEN EXISTS(SELECT 1 FROM task_pnl_watch WHERE account_key IN (OLD.account_key)) BEGIN
  INSERT INTO task_pnl_changes(kind,account_key,profile_id,ref,payload) VALUES('binding',OLD.account_key,NULL,json_array(OLD.account_key,OLD.venue,OLD.order_id),json_object('symbol',OLD.symbol,'order',OLD.order_id)) ON CONFLICT DO UPDATE SET sequence=excluded.sequence;
END;

CREATE TRIGGER pnl_fee_rates_insert AFTER INSERT ON fee_rates WHEN EXISTS(SELECT 1 FROM task_pnl_watch WHERE account_key IN (NEW.account_key)) BEGIN
  INSERT INTO task_pnl_changes(kind,account_key,profile_id,ref,payload) VALUES('fx',NEW.account_key,NULL,json_array(NEW.account_key,NEW.at),json_object('at',NEW.at,'rates',json(CASE WHEN json_valid(NEW.payload) THEN NEW.payload ELSE '{}' END))) ON CONFLICT DO UPDATE SET sequence=excluded.sequence;
END;

CREATE TRIGGER pnl_fee_rates_update AFTER UPDATE ON fee_rates WHEN (json_array(NEW.payload) IS NOT json_array(OLD.payload)) AND EXISTS(SELECT 1 FROM task_pnl_watch WHERE account_key IN (NEW.account_key,OLD.account_key)) BEGIN
  INSERT INTO task_pnl_changes(kind,account_key,profile_id,ref,payload) VALUES('fx',OLD.account_key,NULL,json_array(OLD.account_key,OLD.at),json_object('at',OLD.at,'rates',json(CASE WHEN json_valid(OLD.payload) THEN OLD.payload ELSE '{}' END))) ON CONFLICT DO UPDATE SET sequence=excluded.sequence;
  INSERT INTO task_pnl_changes(kind,account_key,profile_id,ref,payload) VALUES('fx',NEW.account_key,NULL,json_array(NEW.account_key,NEW.at),json_object('at',NEW.at,'rates',json(CASE WHEN json_valid(NEW.payload) THEN NEW.payload ELSE '{}' END))) ON CONFLICT DO UPDATE SET sequence=excluded.sequence;
END;

CREATE TRIGGER pnl_fee_rates_delete AFTER DELETE ON fee_rates WHEN EXISTS(SELECT 1 FROM task_pnl_watch WHERE account_key IN (OLD.account_key)) BEGIN
  INSERT INTO task_pnl_changes(kind,account_key,profile_id,ref,payload) VALUES('fx',OLD.account_key,NULL,json_array(OLD.account_key,OLD.at),json_object('at',OLD.at,'rates',json(CASE WHEN json_valid(OLD.payload) THEN OLD.payload ELSE '{}' END))) ON CONFLICT DO UPDATE SET sequence=excluded.sequence;
END;

CREATE TRIGGER pnl_performance_samples_insert AFTER INSERT ON performance_samples WHEN EXISTS(SELECT 1 FROM task_pnl_watch WHERE account_key IN (NEW.account_key)) BEGIN
  INSERT INTO task_pnl_changes(kind,account_key,profile_id,ref,payload) VALUES('fx',NEW.account_key,NULL,json_array(NEW.account_key,NEW.at),json_object('at',NEW.at,'rates',json(CASE WHEN json_valid(NEW.rates_json) THEN NEW.rates_json ELSE '{}' END))) ON CONFLICT DO UPDATE SET sequence=excluded.sequence;
END;

CREATE TRIGGER pnl_performance_samples_update AFTER UPDATE ON performance_samples WHEN (json_array(NEW.rates_json) IS NOT json_array(OLD.rates_json)) AND EXISTS(SELECT 1 FROM task_pnl_watch WHERE account_key IN (NEW.account_key,OLD.account_key)) BEGIN
  INSERT INTO task_pnl_changes(kind,account_key,profile_id,ref,payload) VALUES('fx',OLD.account_key,NULL,json_array(OLD.account_key,OLD.at),json_object('at',OLD.at,'rates',json(CASE WHEN json_valid(OLD.rates_json) THEN OLD.rates_json ELSE '{}' END))) ON CONFLICT DO UPDATE SET sequence=excluded.sequence;
  INSERT INTO task_pnl_changes(kind,account_key,profile_id,ref,payload) VALUES('fx',NEW.account_key,NULL,json_array(NEW.account_key,NEW.at),json_object('at',NEW.at,'rates',json(CASE WHEN json_valid(NEW.rates_json) THEN NEW.rates_json ELSE '{}' END))) ON CONFLICT DO UPDATE SET sequence=excluded.sequence;
END;

CREATE TRIGGER pnl_performance_samples_delete AFTER DELETE ON performance_samples WHEN EXISTS(SELECT 1 FROM task_pnl_watch WHERE account_key IN (OLD.account_key)) BEGIN
  INSERT INTO task_pnl_changes(kind,account_key,profile_id,ref,payload) VALUES('fx',OLD.account_key,NULL,json_array(OLD.account_key,OLD.at),json_object('at',OLD.at,'rates',json(CASE WHEN json_valid(OLD.rates_json) THEN OLD.rates_json ELSE '{}' END))) ON CONFLICT DO UPDATE SET sequence=excluded.sequence;
END;

CREATE TRIGGER pnl_fee_epochs_insert AFTER INSERT ON fee_epochs WHEN EXISTS(SELECT 1 FROM task_pnl_watch WHERE account_key IN (NEW.account_key)) BEGIN
  INSERT INTO task_pnl_changes(kind,account_key,profile_id,ref,payload) VALUES('epoch',NEW.account_key,NULL,json_array(NEW.account_key),json_object('startedAt',NEW.started_at)) ON CONFLICT DO UPDATE SET sequence=excluded.sequence;
END;

CREATE TRIGGER pnl_fee_epochs_update AFTER UPDATE ON fee_epochs WHEN (json_array(NEW.profile_id,NEW.started_at,NEW.covered_to,NEW.checked_at,NEW.book_reason,NEW.trade_reason,NEW.trades_to) IS NOT json_array(OLD.profile_id,OLD.started_at,OLD.covered_to,OLD.checked_at,OLD.book_reason,OLD.trade_reason,OLD.trades_to)) AND EXISTS(SELECT 1 FROM task_pnl_watch WHERE account_key IN (NEW.account_key,OLD.account_key)) BEGIN
  INSERT INTO task_pnl_changes(kind,account_key,profile_id,ref,payload) VALUES('epoch',OLD.account_key,NULL,json_array(OLD.account_key),json_object('startedAt',OLD.started_at)) ON CONFLICT DO UPDATE SET sequence=excluded.sequence;
  INSERT INTO task_pnl_changes(kind,account_key,profile_id,ref,payload) VALUES('epoch',NEW.account_key,NULL,json_array(NEW.account_key),json_object('startedAt',NEW.started_at)) ON CONFLICT DO UPDATE SET sequence=excluded.sequence;
END;

CREATE TRIGGER pnl_fee_epochs_delete AFTER DELETE ON fee_epochs WHEN EXISTS(SELECT 1 FROM task_pnl_watch WHERE account_key IN (OLD.account_key)) BEGIN
  INSERT INTO task_pnl_changes(kind,account_key,profile_id,ref,payload) VALUES('epoch',OLD.account_key,NULL,json_array(OLD.account_key),json_object('startedAt',OLD.started_at)) ON CONFLICT DO UPDATE SET sequence=excluded.sequence;
END;

CREATE TRIGGER pnl_execution_strategies_insert AFTER INSERT ON execution_strategies WHEN ((SELECT signature FROM task_pnl_source_state WHERE kind='execution_strategies' AND ref=json_array(NEW.id)) IS NOT json_array(NEW.credential_profile_id,NEW.status,NEW.created_at,NEW.stopped_at,NEW.config_json,NEW.filled_left,NEW.filled_right,NEW.open_position)) AND EXISTS(SELECT 1 FROM task_pnl_watch WHERE profile_id IN (NEW.credential_profile_id)) BEGIN
  INSERT INTO task_pnl_changes(kind,account_key,profile_id,ref,payload)
    SELECT 'task',NULL,json_extract(signature,'$[0]'),ref,json_object('task',NEW.id)
    FROM task_pnl_source_state WHERE kind='execution_strategies' AND ref=json_array(NEW.id) ON CONFLICT DO UPDATE SET sequence=excluded.sequence;
  INSERT INTO task_pnl_changes(kind,account_key,profile_id,ref,payload) VALUES('task',NULL,NEW.credential_profile_id,json_array(NEW.id),json_object('task',NEW.id)) ON CONFLICT DO UPDATE SET sequence=excluded.sequence;
  INSERT INTO task_pnl_source_state VALUES('execution_strategies',json_array(NEW.id),json_array(NEW.credential_profile_id,NEW.status,NEW.created_at,NEW.stopped_at,NEW.config_json,NEW.filled_left,NEW.filled_right,NEW.open_position)) ON CONFLICT(kind,ref) DO UPDATE SET signature=excluded.signature;
END;

CREATE TRIGGER pnl_execution_strategies_update AFTER UPDATE ON execution_strategies WHEN ((SELECT signature FROM task_pnl_source_state WHERE kind='execution_strategies' AND ref=json_array(NEW.id)) IS NOT json_array(NEW.credential_profile_id,NEW.status,NEW.created_at,NEW.stopped_at,NEW.config_json,NEW.filled_left,NEW.filled_right,NEW.open_position)) AND EXISTS(SELECT 1 FROM task_pnl_watch WHERE profile_id IN (NEW.credential_profile_id,OLD.credential_profile_id)) BEGIN
  INSERT INTO task_pnl_changes(kind,account_key,profile_id,ref,payload) VALUES('task',NULL,OLD.credential_profile_id,json_array(OLD.id),json_object('task',OLD.id)) ON CONFLICT DO UPDATE SET sequence=excluded.sequence;
  INSERT INTO task_pnl_changes(kind,account_key,profile_id,ref,payload) VALUES('task',NULL,NEW.credential_profile_id,json_array(NEW.id),json_object('task',NEW.id)) ON CONFLICT DO UPDATE SET sequence=excluded.sequence;
  INSERT INTO task_pnl_source_state VALUES('execution_strategies',json_array(NEW.id),json_array(NEW.credential_profile_id,NEW.status,NEW.created_at,NEW.stopped_at,NEW.config_json,NEW.filled_left,NEW.filled_right,NEW.open_position)) ON CONFLICT(kind,ref) DO UPDATE SET signature=excluded.signature;
END;

CREATE TRIGGER pnl_execution_strategies_delete AFTER DELETE ON execution_strategies WHEN EXISTS(SELECT 1 FROM task_pnl_watch WHERE profile_id IN (OLD.credential_profile_id)) BEGIN
  INSERT INTO task_pnl_changes(kind,account_key,profile_id,ref,payload) VALUES('task',NULL,OLD.credential_profile_id,json_array(OLD.id),json_object('task',OLD.id)) ON CONFLICT DO UPDATE SET sequence=excluded.sequence;
  DELETE FROM task_pnl_source_state WHERE kind='execution_strategies' AND ref=json_array(OLD.id);
END;
INSERT INTO task_pnl_source_state SELECT 'execution_strategies',json_array(R.id),json_array(R.credential_profile_id,R.status,R.created_at,R.stopped_at,R.config_json,R.filled_left,R.filled_right,R.open_position) FROM execution_strategies R;

CREATE TRIGGER pnl_managed_positions_insert AFTER INSERT ON managed_positions WHEN ((SELECT signature FROM task_pnl_source_state WHERE kind='managed_positions' AND ref=json_array(NEW.strategy_id)) IS NOT json_array(NEW.account_id,json_valid(NEW.state_json),json_extract(CASE WHEN json_valid(NEW.state_json) THEN NEW.state_json ELSE '{}' END,'$.groupId','$.transferredTo','$.phase','$.adoptedLeft','$.adoptedRight','$.leftQuantity','$.rightQuantity','$.adoptedAt','$.verified','$.adoptionBaseline'))) AND EXISTS(SELECT 1 FROM task_pnl_watch WHERE profile_id IN (NEW.account_id)) BEGIN
  INSERT INTO task_pnl_changes(kind,account_key,profile_id,ref,payload)
    SELECT 'task',NULL,json_extract(signature,'$[0]'),ref,json_object('task',NEW.strategy_id)
    FROM task_pnl_source_state WHERE kind='managed_positions' AND ref=json_array(NEW.strategy_id) ON CONFLICT DO UPDATE SET sequence=excluded.sequence;
  INSERT INTO task_pnl_changes(kind,account_key,profile_id,ref,payload) VALUES('task',NULL,NEW.account_id,json_array(NEW.strategy_id),json_object('task',NEW.strategy_id)) ON CONFLICT DO UPDATE SET sequence=excluded.sequence;
  INSERT INTO task_pnl_source_state VALUES('managed_positions',json_array(NEW.strategy_id),json_array(NEW.account_id,json_valid(NEW.state_json),json_extract(CASE WHEN json_valid(NEW.state_json) THEN NEW.state_json ELSE '{}' END,'$.groupId','$.transferredTo','$.phase','$.adoptedLeft','$.adoptedRight','$.leftQuantity','$.rightQuantity','$.adoptedAt','$.verified','$.adoptionBaseline'))) ON CONFLICT(kind,ref) DO UPDATE SET signature=excluded.signature;
END;

CREATE TRIGGER pnl_managed_positions_update AFTER UPDATE ON managed_positions WHEN ((SELECT signature FROM task_pnl_source_state WHERE kind='managed_positions' AND ref=json_array(NEW.strategy_id)) IS NOT json_array(NEW.account_id,json_valid(NEW.state_json),json_extract(CASE WHEN json_valid(NEW.state_json) THEN NEW.state_json ELSE '{}' END,'$.groupId','$.transferredTo','$.phase','$.adoptedLeft','$.adoptedRight','$.leftQuantity','$.rightQuantity','$.adoptedAt','$.verified','$.adoptionBaseline'))) AND EXISTS(SELECT 1 FROM task_pnl_watch WHERE profile_id IN (NEW.account_id,OLD.account_id)) BEGIN
  INSERT INTO task_pnl_changes(kind,account_key,profile_id,ref,payload) VALUES('task',NULL,OLD.account_id,json_array(OLD.strategy_id),json_object('task',OLD.strategy_id)) ON CONFLICT DO UPDATE SET sequence=excluded.sequence;
  INSERT INTO task_pnl_changes(kind,account_key,profile_id,ref,payload) VALUES('task',NULL,NEW.account_id,json_array(NEW.strategy_id),json_object('task',NEW.strategy_id)) ON CONFLICT DO UPDATE SET sequence=excluded.sequence;
  INSERT INTO task_pnl_source_state VALUES('managed_positions',json_array(NEW.strategy_id),json_array(NEW.account_id,json_valid(NEW.state_json),json_extract(CASE WHEN json_valid(NEW.state_json) THEN NEW.state_json ELSE '{}' END,'$.groupId','$.transferredTo','$.phase','$.adoptedLeft','$.adoptedRight','$.leftQuantity','$.rightQuantity','$.adoptedAt','$.verified','$.adoptionBaseline'))) ON CONFLICT(kind,ref) DO UPDATE SET signature=excluded.signature;
END;

CREATE TRIGGER pnl_managed_positions_delete AFTER DELETE ON managed_positions WHEN EXISTS(SELECT 1 FROM task_pnl_watch WHERE profile_id IN (OLD.account_id)) BEGIN
  INSERT INTO task_pnl_changes(kind,account_key,profile_id,ref,payload) VALUES('task',NULL,OLD.account_id,json_array(OLD.strategy_id),json_object('task',OLD.strategy_id)) ON CONFLICT DO UPDATE SET sequence=excluded.sequence;
  DELETE FROM task_pnl_source_state WHERE kind='managed_positions' AND ref=json_array(OLD.strategy_id);
END;
INSERT INTO task_pnl_source_state SELECT 'managed_positions',json_array(R.strategy_id),json_array(R.account_id,json_valid(R.state_json),json_extract(CASE WHEN json_valid(R.state_json) THEN R.state_json ELSE '{}' END,'$.groupId','$.transferredTo','$.phase','$.adoptedLeft','$.adoptedRight','$.leftQuantity','$.rightQuantity','$.adoptedAt','$.verified','$.adoptionBaseline')) FROM managed_positions R;

-- Execution writes already update their canonical row. Coalesce work by task, not every historical quote.
CREATE TRIGGER pnl_execution_orders_insert AFTER INSERT ON execution_orders WHEN (NEW.strategy_id IS NOT NULL) AND EXISTS(SELECT 1 FROM task_pnl_watch) BEGIN
  INSERT INTO task_pnl_changes(kind,account_key,profile_id,ref,payload)
    VALUES('order',NULL,(SELECT credential_profile_id FROM execution_strategies WHERE id=NEW.strategy_id),json_array(NEW.strategy_id),json_object('task',NEW.strategy_id)) ON CONFLICT DO UPDATE SET sequence=excluded.sequence;
END;
CREATE TRIGGER pnl_execution_orders_update AFTER UPDATE ON execution_orders WHEN (json_array(NEW.strategy_id,NEW.remote_order_id,NEW.venue,NEW.symbol,NEW.state,NEW.executed_quantity,NEW.client_order_id,NEW.fee_phase,NEW.strategy_leg,NEW.created_at)
  IS NOT json_array(OLD.strategy_id,OLD.remote_order_id,OLD.venue,OLD.symbol,OLD.state,OLD.executed_quantity,OLD.client_order_id,OLD.fee_phase,OLD.strategy_leg,OLD.created_at)) AND EXISTS(SELECT 1 FROM task_pnl_watch) BEGIN
  INSERT INTO task_pnl_changes(kind,account_key,profile_id,ref,payload)
    SELECT 'order',NULL,(SELECT credential_profile_id FROM execution_strategies WHERE id=OLD.strategy_id),json_array(OLD.strategy_id),json_object('task',OLD.strategy_id) WHERE OLD.strategy_id IS NOT NULL ON CONFLICT DO UPDATE SET sequence=excluded.sequence;
  INSERT INTO task_pnl_changes(kind,account_key,profile_id,ref,payload)
    SELECT 'order',NULL,(SELECT credential_profile_id FROM execution_strategies WHERE id=NEW.strategy_id),json_array(NEW.strategy_id),json_object('task',NEW.strategy_id) WHERE NEW.strategy_id IS NOT NULL ON CONFLICT DO UPDATE SET sequence=excluded.sequence;
END;
CREATE TRIGGER pnl_execution_orders_delete AFTER DELETE ON execution_orders WHEN (OLD.strategy_id IS NOT NULL) AND EXISTS(SELECT 1 FROM task_pnl_watch) BEGIN
  INSERT INTO task_pnl_changes(kind,account_key,profile_id,ref,payload)
    VALUES('order',NULL,(SELECT credential_profile_id FROM execution_strategies WHERE id=OLD.strategy_id),json_array(OLD.strategy_id),json_object('task',OLD.strategy_id)) ON CONFLICT DO UPDATE SET sequence=excluded.sequence;
END;
