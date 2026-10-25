import type Database from 'better-sqlite3';
import { CreateStrategyInputSchema } from '../trading-runtime.js';
import { initialManagedState } from '../managed-position-store.js';

export const PAIRED_PERFORMANCE_SCALE = { historicalTasks: 49, monitoringTasks: 2, historicalOrders: 25300, historicalFills: 700 };
const at = '2026-10-20T00:00:00.000Z';

/** Representative row counts, synthetic identities/prices only; no account or fee evidence is imported. */
export function seedPairedPerformanceHistory(db: Database.Database): void {
  const config = CreateStrategyInputSchema.parse({ kind: 'position', asset: 'BTC', leftVenue: 'BINANCE', rightVenue: 'OKX',
    leftSide: 'SELL', rightSide: 'BUY', totalAmount: '1', perOrderQuantity: '0.1', executionMethod: 'MAKER_TAKER', entryBps: '10', makerLeg: 'left',
    management: { perOrderQuantity: '0.1' } });
  const task = db.prepare(`INSERT INTO execution_strategies(id,kind,environment,status,config_json,credential_profile_id,created_at,updated_at)
    VALUES(?,'position','live',?,?, 'account-1',?,?)`);
  const order = db.prepare(`INSERT INTO execution_orders(id,client_order_id,remote_order_id,environment,symbol,venue,side,order_type,time_in_force,
    quantity,price,reduce_only,state,executed_quantity,executed_average_price,created_at,updated_at,strategy_id,strategy_leg)
    VALUES(?,?,?,'live',?,?,?,?,?,'0.01',?,?,? ,?,?,?, ?,?,?)`);
  const fill = db.prepare(`INSERT INTO execution_fills(id,order_id,symbol,venue,side,quantity,price,fee,realized_pnl,created_at,fee_coin)
    VALUES(?,?,?,?,?,'0.01',?,'0.00001',?,?,'USDT')`);
  // Large synthetic setup otherwise spills trigger statement journals to Windows temp files.
  // Restore the production setting before the measured hedge path; its 500 ms bound is unchanged.
  const tempStore = db.pragma('temp_store', { simple: true }) as number;
  db.pragma('temp_store=MEMORY');
  try { db.transaction(() => {
    for (let i = 0; i < PAIRED_PERFORMANCE_SCALE.historicalTasks; i++) task.run(`HISTORY-${i}`, 'COMPLETED', JSON.stringify(config), at, at);
    for (let i = 0; i < PAIRED_PERFORMANCE_SCALE.historicalOrders; i++) {
      const executed = i < PAIRED_PERFORMANCE_SCALE.historicalFills, phase = i % 4, left = phase % 2 === 0;
      const id = `HISTORY-ORDER-${i}`, owner = `HISTORY-${Math.floor(i / 4) % PAIRED_PERFORMANCE_SCALE.historicalTasks}`;
      const venue = left ? 'BINANCE' : 'OKX', symbol = `${venue}_FUTURE_BTC_USDT`, side = phase === 0 || phase === 3 ? 'SELL' : 'BUY';
      const price = phase === 2 ? '99.9' : phase === 3 ? '100.1' : '100';
      order.run(id, `${id}-client`, `${id}-remote`, symbol, venue, side, executed ? 'MARKET' : 'LIMIT', executed ? 'IOC' : 'POC',
        price, executed && phase >= 2 ? 1 : 0, executed ? 'FILLED' : 'CANCELLED', executed ? '0.01' : '0', executed ? price : '0', at, at, owner, left ? 'left' : 'right');
      if (executed) fill.run(`HISTORY-FILL-${i}`, id, symbol, venue, side, price, phase >= 2 ? '0.001' : '0', at);
    }
    for (const [index, asset] of ['ETH', 'SOL'].entries()) {
      const id = `MONITOR-${index}`, leftVenue = index === 0 ? 'HYPERLIQUID' : 'DERIBIT';
      const saved = { ...config, asset, leftVenue, rightVenue: 'KRAKEN', totalAmount: '10', perOrderQuantity: '1', management: { ...config.management!, perOrderQuantity: '1' } };
      task.run(id, 'RUNNING', JSON.stringify(saved), at, at);
      db.prepare('INSERT INTO managed_positions VALUES (?,?,?,?)').run(id, 'account-1', JSON.stringify({ ...initialManagedState(),
        phase: 'MONITORING', verified: true, groupId: id, adoptedAt: at, adoptedLeft: '10', adoptedRight: '10', leftQuantity: '10', rightQuantity: '10',
        maxLeft: '10', maxRight: '10', observedReductions: ['0', '0'], checkedAt: new Date().toISOString() }), at);
      for (const symbol of [`${leftVenue}_FUTURE_${asset}_USDC`, `KRAKEN_FUTURE_${asset}_USD`])
        db.prepare('INSERT INTO managed_position_claims VALUES(?,?,?)').run(symbol, 'account-1', id);
    }
  })(); } finally { db.pragma(`temp_store=${tempStore}`); }
}
