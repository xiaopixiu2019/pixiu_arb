// Synthetic acceptance data only. Never run against a production database.
import assert from 'node:assert/strict';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { existsSync } from 'node:fs';
const [rootArg, databaseArg, mode] = process.argv.slice(2);
const testRoot = process.env.PIXIU_DESKTOP_TEST_ROOT;
assert(testRoot && existsSync(join(testRoot, '.desktop-acceptance-root')), 'Isolated test marker required');
const root = resolve(rootArg), databasePath = resolve(databaseArg);
assert(databasePath.startsWith(resolve(testRoot) + '/') || databasePath.startsWith(resolve(testRoot) + '\\'));
const load = name => import(pathToFileURL(join(root, 'apps/backend/dist', name)).href);
const { openDatabase } = await load('database.js');
const account = 'gate-crossex-default', id = 'synthetic-platform-safety-fixture';
const now = '2026-10-21T00:00:00.000Z';
const config = {
  kind: 'position', asset: 'HYPE', leftVenue: 'KRAKEN', rightVenue: 'DERIBIT',
  leftSide: 'SELL', rightSide: 'BUY', leftLeverage: '25', rightLeverage: '25',
  entryBps: '10', totalAmount: '20', perOrderQuantity: '10',
  executionMethod: 'MAKER_TAKER', makerLeg: 'left', management: { perOrderQuantity: '10' },
};
const { managedLegs } = await load('managed-position-manager.js');
const symbols = managedLegs(config).map(leg => leg.symbol);
if (mode === 'seed') {
  const db = openDatabase(databasePath, join(root, 'migrations'));
  assert.equal(db.prepare('SELECT count(*) AS n FROM credential_metadata').get().n, 0);
  try {
    const { CreateStrategyInputSchema } = await load('trading-runtime.js');
    const { initialManagedState } = await load('managed-position-store.js');
    const validated = CreateStrategyInputSchema.parse(config);
    const state = { ...initialManagedState(), phase: 'STOPPED', stopIntent: 'KEEP', groupId: id,
      leftQuantity: '1', rightQuantity: '1', verified: true, maxLeft: '1', maxRight: '1' };
    db.transaction(() => {
      db.prepare(`INSERT INTO execution_strategies
        (id,kind,environment,status,config_json,created_at,updated_at,credential_profile_id)
        VALUES (?,?,?,?,?,?,?,?)`).run(id, 'position', 'live', 'STOPPED', JSON.stringify(validated), now, now, account);
      db.prepare('INSERT INTO managed_positions (strategy_id,account_id,state_json,updated_at) VALUES (?,?,?,?)')
        .run(id, account, JSON.stringify(state), now);
      for (const symbol of symbols) db.prepare('INSERT INTO managed_position_claims (account_id,symbol,strategy_id) VALUES (?,?,?)').run(account, symbol, id);
      db.prepare('INSERT INTO managed_risk_lock VALUES (1,?,?)').run('managed_review_changed', now);
      db.prepare(`INSERT INTO execution_orders
        (id,client_order_id,environment,symbol,venue,side,order_type,time_in_force,quantity,state,created_at,updated_at,strategy_id,failure_reason)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run('synthetic-unknown-order','synthetic-no-replay','live',symbols[0],'KRAKEN','SELL','MARKET','IOC','1','PENDING_SUBMIT',now,now,id,'ORDER_SUBMISSION_UNKNOWN');
      db.prepare(`INSERT INTO execution_orders
        (id,client_order_id,environment,symbol,venue,side,order_type,time_in_force,quantity,state,executed_quantity,executed_average_price,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run('synthetic-history-order','synthetic-history-client','live',symbols[1],'DERIBIT','BUY','MARKET','IOC','1','FILLED','1','30',now,now);
      db.prepare(`INSERT INTO execution_fills
        (id,order_id,symbol,venue,side,quantity,price,fee,created_at)
        VALUES (?,?,?,?,?,?,?,?,?)`).run('synthetic-history-fill','synthetic-history-order',symbols[1],'DERIBIT','BUY','1','30','0.03',now);
      db.prepare('INSERT INTO margin_cost_reservations VALUES (?,?,?,?,?,NULL)')
        .run(account,'synthetic-cost-pending','2.5',JSON.stringify({ batchId: 'synthetic-cost-pending',
          amount: '2.5', originalAmount: '2.5', quantity: '1', legs: symbols.map((symbol,index) => ({
            symbol, mark: '30', side: index === 0 ? 'BUY' : 'SELL', feeRate: '0.001' })) }),0);
      db.prepare('INSERT INTO user_preferences VALUES (?,?,?)').run('platform-acceptance',JSON.stringify({ synthetic: true, keep: 'unchanged' }),now);
    })();
    assert.equal(db.prepare('SELECT count(*) AS n FROM schema_migrations').get().n,32);
    db.pragma('wal_checkpoint(TRUNCATE)');
  } finally { db.close(); }
} else if (mode === 'reserve32') {
  const db = openDatabase(databasePath, join(root, 'migrations'));
  try {
    const { saveEntryBudget } = await load('paired-entry-ledger.js');
    const actual = JSON.parse(db.prepare('SELECT config_json FROM execution_strategies WHERE id=?').get(id).config_json);
    saveEntryBudget(db,id,account,actual,{ accountUser: 'synthetic-user', released: false,
      legs: symbols.map((symbol,index) => ({ symbol, side: index === 0 ? 'SELL' : 'BUY', target: '1',
        leverage: '25', maintenanceRate: '0.01', price: '30', initialBudget: '2', baseline: '0', covered: {} })) });
    db.pragma('wal_checkpoint(TRUNCATE)');
  } finally { db.close(); }
} else { throw new Error('Expected seed or reserve32'); }
process.stdout.write(JSON.stringify({ mode, synthetic: true, databasePath }) + '\n');
