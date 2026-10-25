import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, cpSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { openDatabase, readDatabaseStatus } from './database.js';
import { runDatabaseMaintenance } from './database-maintenance.js';
import {
  readCryptoMarketCapSnapshot,
  readHyperliquidPerpMetadata,
  writeCryptoMarketCapSnapshot,
  writeHyperliquidPerpMetadata,
} from './repositories.js';

const temporaryDirectories: string[] = [];

function temporaryDatabasePath(): { directory: string; path: string } {
  const directory = mkdtempSync(join(tmpdir(), 'gate-crossex-database-'));
  temporaryDirectories.push(directory);
  return { directory, path: join(directory, 'test.sqlite') };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('database migrations', () => {
  it.each(['{}', '{"released":false}', '{"released":1}', 'invalid-json'])(
    'retains expired orders and fills until paired responsibility is explicitly released (%s)', payload => {
      const db = openDatabase(':memory:', resolve(process.cwd(), '../../migrations'));
      try {
        db.exec(`INSERT INTO execution_strategies (id,kind,environment,status,config_json,progress,filled_quantity,created_at,updated_at)
          VALUES ('paired-old','position','live','STOPPED','{}',0,'1','2020-01-01','2020-01-01');
          INSERT INTO execution_orders (id,client_order_id,environment,symbol,venue,side,order_type,time_in_force,quantity,state,created_at,updated_at,strategy_id)
          VALUES ('paired-order','paired-client','live','GATE_FUTURE_HYPE_USDT','GATE','SELL','MARKET','IOC','1','FILLED','2020-01-01','2020-01-01','paired-old');
          INSERT INTO execution_fills (id,order_id,symbol,venue,side,quantity,price,fee,realized_pnl,created_at)
          VALUES ('paired-fill','paired-order','GATE_FUTURE_HYPE_USDT','GATE','SELL','1','100','0.01','0','2020-01-01');`);
        db.prepare('INSERT INTO paired_entry_reservations VALUES (?,?,?,?,?,?)')
          .run('paired-old', 'account', 'config', payload, '2020-01-01', '2020-01-01');
        expect(runDatabaseMaintenance(db)).toMatchObject({ ordersDeleted: 0, fillsDeleted: 0 });
        expect(db.prepare('SELECT id FROM execution_fills').all()).toEqual([{ id: 'paired-fill' }]);
        db.prepare('UPDATE paired_entry_reservations SET payload_json=?').run('{"released":true}');
        expect(runDatabaseMaintenance(db)).toMatchObject({ ordersDeleted: 1, fillsDeleted: 1 });
      } finally { db.close(); }
    },
  );
  it('retains expired execution evidence until its independent margin cost responsibility is settled', () => {
    const db = openDatabase(':memory:', resolve(process.cwd(), '../../migrations'));
    try {
      db.exec(`INSERT INTO execution_orders (id,client_order_id,environment,symbol,venue,side,order_type,time_in_force,quantity,state,created_at,updated_at,strategy_clip)
        VALUES ('cost-order','cost-client','live','GATE_FUTURE_BTC_USDT','GATE','SELL','MARKET','IOC','1','FILLED','2020-01-01','2020-01-01','margin:pending');
        INSERT INTO margin_cost_reservations VALUES ('account','pending','1','{}',0,NULL);
        INSERT INTO execution_fills (id,order_id,symbol,venue,side,quantity,price,fee,realized_pnl,created_at)
        VALUES ('cost-fill','cost-order','GATE_FUTURE_BTC_USDT','GATE','SELL','1','100','0.01','0','2020-01-01');`);
      expect(runDatabaseMaintenance(db).ordersDeleted).toBe(0);
      expect(db.prepare('SELECT id FROM execution_fills').all()).toEqual([{ id: 'cost-fill' }]);
      db.exec('UPDATE margin_cost_reservations SET settled_at=1');
      expect(runDatabaseMaintenance(db)).toMatchObject({ ordersDeleted: 1, fillsDeleted: 1 });
    } finally { db.close(); }
  });
  it('applies migrations once and reports the current version', () => {
    const location = temporaryDatabasePath();
    const migrationsDir = resolve(process.cwd(), '../../migrations');
    chmodSync(location.directory, 0o755);
    const first = openDatabase(location.path, migrationsDir);

    expect(readDatabaseStatus(first)).toEqual({
      state: 'ok',
      migrationCount: 34,
      currentMigration: '0034_task_performance_projection.sql',
    });
    const orderColumns = first.prepare('PRAGMA table_info(execution_orders)').all() as Array<{ name: string }>;
    expect(orderColumns.map((column) => column.name)).toContain('failure_reason');
    const positionColumns = first.prepare('PRAGMA table_info(live_positions)').all() as Array<{ name: string }>;
    expect(positionColumns.map((column) => column.name)).toContain('funding_fee');
    const strategyColumns = first.prepare('PRAGMA table_info(execution_strategies)').all() as Array<{ name: string }>;
    expect(strategyColumns.map((column) => column.name)).toEqual(expect.arrayContaining([
      'credential_profile_id', 'credential_profile_label',
    ]));
    const commitmentColumns = first.prepare('PRAGMA table_info(paired_entry_reservations)').all() as Array<{ name: string }>;
    expect(commitmentColumns.map((column) => column.name)).toEqual([
      'strategy_id', 'account_id', 'config_hash', 'payload_json', 'created_at', 'updated_at',
    ]);
    expect(first.prepare('SELECT count(*) AS count FROM continuous_protection_authority').get()).toEqual({ count: 0 });
    expect(first.prepare('SELECT count(*) AS count FROM continuous_protection_status').get()).toEqual({ count: 0 });
    if (process.platform !== 'win32') {
      expect(statSync(location.directory).mode & 0o777).toBe(0o700);
      expect(statSync(location.path).mode & 0o777).toBe(0o600);
    }
    first.close();

    const reopened = openDatabase(location.path, migrationsDir);
    expect(readDatabaseStatus(reopened).migrationCount).toBe(34);
    reopened.close();
  });

  it('attributes unowned pre-account strategies to the original default profile', () => {
    const location = temporaryDatabasePath();
    const migrationsDir = resolve(process.cwd(), '../../migrations');
    const database = openDatabase(location.path, migrationsDir);
    const now = '2026-01-01T00:00:00.000Z';
    database.prepare(`
      INSERT INTO credential_metadata (id, label, provider, created_at)
      VALUES ('gate-crossex-default', 'Main', 'os_keychain', ?)
    `).run(now);
    const insertStrategy = database.prepare(`
      INSERT INTO execution_strategies (
        id, kind, environment, status, config_json, progress, filled_quantity,
        credential_profile_id, credential_profile_label, created_at, updated_at, stopped_at
      ) VALUES (?, 'position', 'live', 'STOPPED', '{}', 0, '0', ?, ?, ?, ?, ?)
    `);
    insertStrategy.run('strategy-legacy', null, null, now, now, now);
    insertStrategy.run('strategy-owned', 'other-profile', 'Sub', now, now, now);
    database.prepare("DELETE FROM schema_migrations WHERE id = '0020_strategy_account_backfill.sql'").run();
    database.close();

    const reopened = openDatabase(location.path, migrationsDir);
    const rows = reopened.prepare(
      'SELECT id, credential_profile_id, credential_profile_label FROM execution_strategies ORDER BY id',
    ).all();
    expect(rows).toEqual([
      { id: 'strategy-legacy', credential_profile_id: 'gate-crossex-default', credential_profile_label: 'Main' },
      { id: 'strategy-owned', credential_profile_id: 'other-profile', credential_profile_label: 'Sub' },
    ]);
    reopened.close();
  });

  it('leaves unowned strategies untouched when the default profile no longer exists', () => {
    const location = temporaryDatabasePath();
    const migrationsDir = resolve(process.cwd(), '../../migrations');
    const database = openDatabase(location.path, migrationsDir);
    const now = '2026-01-01T00:00:00.000Z';
    database.prepare(`
      INSERT INTO execution_strategies (
        id, kind, environment, status, config_json, progress, filled_quantity, created_at, updated_at, stopped_at
      ) VALUES ('strategy-orphan', 'position', 'live', 'STOPPED', '{}', 0, '0', ?, ?, ?)
    `).run(now, now, now);
    database.prepare("DELETE FROM schema_migrations WHERE id = '0020_strategy_account_backfill.sql'").run();
    database.close();

    const reopened = openDatabase(location.path, migrationsDir);
    const row = reopened.prepare(
      "SELECT credential_profile_id FROM execution_strategies WHERE id = 'strategy-orphan'",
    ).get() as { credential_profile_id: string | null };
    expect(row.credential_profile_id).toBeNull();
    reopened.close();
  });

  it('installs indexes for execution-ledger hot paths', () => {
    const location = temporaryDatabasePath();
    const database = openDatabase(location.path, resolve(process.cwd(), '../../migrations'));
    const indexes = database.prepare(`
      SELECT name
      FROM sqlite_master
      WHERE type = 'index'
      ORDER BY name
    `).all() as Array<{ name: string }>;

    expect(indexes.map((index) => index.name)).toEqual(expect.arrayContaining([
      'execution_orders_remote_order_idx',
      'execution_orders_environment_created_idx',
      'execution_orders_environment_state_created_idx',
      'execution_orders_strategy_state_created_idx',
      'execution_fills_order_created_idx',
      'execution_fills_created_idx',
      'audit_events_created_idx',
      'execution_strategy_logs_created_idx',
      'paired_entry_account_idx',
    ]));
    database.close();
  });

  it('repairs the legacy audit table created by the original bootstrap code', () => {
    const location = temporaryDatabasePath();
    const legacy = new Database(location.path);
    legacy.exec(`
      CREATE TABLE audit_events (
        id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        type TEXT NOT NULL,
        payload_json TEXT NOT NULL
      )
    `);
    legacy.close();

    const database = openDatabase(location.path, resolve(process.cwd(), '../../migrations'));
    const columns = database.prepare('PRAGMA table_info(audit_events)').all() as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).toContain('correlation_id');
    expect(readDatabaseStatus(database).currentMigration).toBe('0034_task_performance_projection.sql');
    database.close();
  });

  it('persists the last-good Hyperliquid native market names', () => {
    const location = temporaryDatabasePath();
    const database = openDatabase(location.path, resolve(process.cwd(), '../../migrations'));
    expect(readHyperliquidPerpMetadata(database)).toBeNull();

    const snapshot = {
      nativeNames: ['BTC', 'xyz:SNDK'],
      fetchedAt: '2026-08-01T12:00:00.000Z',
    };
    writeHyperliquidPerpMetadata(database, snapshot);
    expect(readHyperliquidPerpMetadata(database)).toEqual(snapshot);
    database.close();
  });

  it('persists the last-good CoinGecko non-stablecoin market-cap ranking', () => {
    const location = temporaryDatabasePath();
    const database = openDatabase(location.path, resolve(process.cwd(), '../../migrations'));
    expect(readCryptoMarketCapSnapshot(database)).toBeNull();
    const assets = Array.from({ length: 20 }, (_, index) => ({
      id: `coin-${index + 1}`,
      symbol: `C${index + 1}`,
      name: `Coin ${index + 1}`,
      rank: index + 1,
    }));
    const snapshot = { assets, knownSymbols: assets.map((asset) => asset.symbol), fetchedAt: '2026-09-05T08:00:00.000Z' };

    writeCryptoMarketCapSnapshot(database, snapshot);

    expect(readCryptoMarketCapSnapshot(database)).toEqual(snapshot);
    database.close();
  });

  it('prunes expired terminal execution data without touching active strategies', () => {
    const location = temporaryDatabasePath();
    const database = openDatabase(location.path, resolve(process.cwd(), '../../migrations'));
    const old = '2020-01-01T00:00:00.000Z';
    database.prepare(`
      INSERT INTO audit_events (id, created_at, type, correlation_id, payload_json)
      VALUES ('audit-old', ?, 'test', NULL, '{}')
    `).run(old);
    const insertStrategy = database.prepare(`
      INSERT INTO execution_strategies (
        id, kind, environment, status, config_json, progress, filled_quantity, created_at, updated_at, stopped_at
      ) VALUES (?, 'position', 'live', ?, '{}', 0, '0', ?, ?, ?)
    `);
    insertStrategy.run('strategy-stopped', 'STOPPED', old, old, old);
    insertStrategy.run('strategy-running', 'RUNNING', old, old, null);
    database.prepare(`
      INSERT INTO execution_strategy_logs (id, strategy_id, level, event, condition_text, quantity, result_text, created_at)
      VALUES ('log-stopped', 'strategy-stopped', 'info', 'old', '—', '0', '—', ?),
             ('log-running', 'strategy-running', 'info', 'old', '—', '0', '—', ?)
    `).run(old, old);
    const insertOrder = database.prepare(`
      INSERT INTO execution_orders (
        id, strategy_id, client_order_id, environment, symbol, venue, side, order_type,
        time_in_force, quantity, reduce_only, state, executed_quantity, created_at, updated_at
      ) VALUES (?, ?, ?, 'live', 'GATE_FUTURE_BTC_USDT', 'GATE', 'BUY', 'MARKET',
        'IOC', '1', 0, ?, '0', ?, ?)
    `);
    insertOrder.run('order-failed', null, 'client-failed', 'FAIL', old, old);
    insertOrder.run('order-remote-missing', 'strategy-stopped', 'client-remote-missing', 'REMOTE_NOT_FOUND', old, old);
    insertOrder.run('order-active', 'strategy-running', 'client-active', 'FAIL', old, old);
    const insertFill = database.prepare(`
      INSERT INTO execution_fills (
        id, order_id, symbol, venue, side, quantity, price, fee, realized_pnl, created_at
      ) VALUES (?, ?, 'GATE_FUTURE_BTC_USDT', 'GATE', 'BUY', '1', '1', '0', '0', ?)
    `);
    insertFill.run('fill-failed', 'order-failed', old);
    insertFill.run('fill-remote-missing', 'order-remote-missing', old);
    insertFill.run('fill-active', 'order-active', old);

    const result = runDatabaseMaintenance(database, Date.parse('2026-07-29T00:00:00.000Z'));

    expect(result).toEqual({
      auditEventsDeleted: 1,
      strategyLogsDeleted: 1,
      fillsDeleted: 2,
      ordersDeleted: 2,
    });
    expect(database.prepare('SELECT id FROM execution_strategy_logs ORDER BY id').all())
      .toEqual([{ id: 'log-running' }]);
    expect(database.prepare('SELECT id FROM execution_orders ORDER BY id').all())
      .toEqual([{ id: 'order-active' }]);
    expect(database.prepare('SELECT id FROM execution_fills ORDER BY id').all())
      .toEqual([{ id: 'fill-active' }]);
    database.close();
  });

  it('removes simulated execution state when upgrading to the live-only runtime', () => {
    const location = temporaryDatabasePath();
    const sourceMigrations = resolve(process.cwd(), '../../migrations');
    const stagedMigrations = mkdtempSync(join(tmpdir(), 'gate-crossex-migrations-'));
    temporaryDirectories.push(stagedMigrations);
    for (const filename of readdirSync(sourceMigrations).filter((name) => name < '0008')) {
      cpSync(join(sourceMigrations, filename), join(stagedMigrations, filename));
    }

    const legacy = openDatabase(location.path, stagedMigrations);
    legacy.exec(`
      INSERT INTO execution_orders VALUES ('order-1', NULL, 'client-1', 'paper', 'BINANCE_FUTURE_BTC_USDT', 'BINANCE', 'BUY', 'MARKET', 'IOC', '0.01', NULL, 0, 'FILLED', '0.01', '1', '2026-01-01', '2026-01-01');
      INSERT INTO execution_fills VALUES ('fill-1', 'order-1', 'BINANCE_FUTURE_BTC_USDT', 'BINANCE', 'BUY', '0.01', '1', '0', '0', '2026-01-01');
      INSERT INTO paper_positions VALUES ('BINANCE_FUTURE_BTC_USDT', 'BINANCE', '0.01', '1', '1', '0', '2026-01-01');
      INSERT INTO execution_strategies VALUES ('strategy-1', 'auto', 'paper', 'RUNNING', '{}', 0, '0', '2026-01-01', '2026-01-01', NULL);
      INSERT INTO execution_strategy_logs VALUES ('log-1', 'strategy-1', 'info', 'started', 'none', '0', 'ok', '2026-01-01');
    `);
    legacy.close();

    cpSync(join(sourceMigrations, '0008_live_only_execution.sql'), join(stagedMigrations, '0008_live_only_execution.sql'));
    const upgraded = openDatabase(location.path, stagedMigrations);
    expect(upgraded.prepare('SELECT COUNT(*) AS count FROM execution_orders').get()).toEqual({ count: 0 });
    expect(upgraded.prepare('SELECT COUNT(*) AS count FROM execution_fills').get()).toEqual({ count: 0 });
    expect(upgraded.prepare('SELECT COUNT(*) AS count FROM execution_strategies').get()).toEqual({ count: 0 });
    expect(upgraded.prepare('SELECT COUNT(*) AS count FROM execution_strategy_logs').get()).toEqual({ count: 0 });
    expect(upgraded.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'paper_positions'").get()).toBeUndefined();
    upgraded.close();
  });
});
