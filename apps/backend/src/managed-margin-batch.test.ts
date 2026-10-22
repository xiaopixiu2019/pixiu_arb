import { afterEach, describe, expect, it } from 'vitest';
import { Decimal } from 'decimal.js';
import { resolve } from 'node:path';
import { openDatabase } from './database.js';
import { assertMarginHoldings, assertMarginSubmission, marginBatchFills } from './managed-margin-batch.js';
import type { ManagedMarginBatch } from './managed-position-store.js';
const dbs: ReturnType<typeof openDatabase>[] = [];
afterEach(() => { for (const db of dbs.splice(0)) db.close(); });
function fixture() {
  const db = openDatabase(':memory:', resolve('../../migrations')); dbs.push(db);
  const batch: ManagedMarginBatch = { version: 2, id: 'batch', before: '10', quantity: '1', firstLeg: 0, incidentId: 'incident' };
  let seq = 0;
  const order = (leg: string, quantity: string, filled: string, state = 'CANCELLED') => db.prepare(`INSERT INTO execution_orders
    (id,client_order_id,environment,symbol,venue,side,order_type,time_in_force,quantity,reduce_only,state,executed_quantity,
    strategy_id,strategy_leg,strategy_clip,created_at,updated_at) VALUES (?,?, 'live','GATE_FUTURE_BTC_USDT','GATE','SELL','MARKET','IOC',?,1,?,?, 'strategy',?,'margin:batch',?,?)`)
    .run(String(++seq), `fake-${seq}`, quantity, state, filled, leg, new Date().toISOString(), new Date().toISOString());
  return { db, batch, order };
}
describe('persistent margin batch budget', () => {
  it('rechecks actual dispatch excluding only its own durable pending row', () => {
    const h = fixture();
    expect(() => assertMarginSubmission(h.db, 'strategy', h.batch, 0, new Decimal('1'))).not.toThrow();
    h.order('left', '1', '0', 'PENDING_SUBMIT');
    expect(() => assertMarginSubmission(h.db, 'strategy', h.batch, 0, new Decimal('1'))).toThrow();
    expect(() => assertMarginSubmission(h.db, 'strategy', h.batch, 0, new Decimal('1'), '1')).not.toThrow();
    h.order('left', '1', '0', 'PENDING_SUBMIT');
    expect(() => assertMarginSubmission(h.db, 'strategy', h.batch, 0, new Decimal('1'), '1')).toThrow();
  });
  it('uses cumulative per-order fills without counting a repeated read twice', () => {
    const h = fixture(); h.order('left', '1', '0.6'); h.order('right', '0.6', '0.2');
    expect(marginBatchFills(h.db, 'strategy', h.batch).filled.map(x => x.toString())).toEqual(['0.6', '0.2']);
    expect(marginBatchFills(h.db, 'strategy', h.batch).filled.map(x => x.toString())).toEqual(['0.6', '0.2']);
    expect(() => assertMarginSubmission(h.db, 'strategy', h.batch, 1, new Decimal('0.4'))).not.toThrow();
    expect(() => assertMarginSubmission(h.db, 'strategy', h.batch, 1, new Decimal('0.5'))).toThrow('margin_pairing_budget_exceeded');
    expect(() => assertMarginSubmission(h.db, 'strategy', h.batch, 0, new Decimal('0.1'))).toThrow('margin_first_leg_already_submitted');
  });
  it('reserves unknown orders and rejects balanced but unexplained external changes', () => {
    const h = fixture(); h.order('left', '1', '0.6'); h.order('right', '0.6', '0.2', 'NEW');
    expect(() => assertMarginSubmission(h.db, 'strategy', h.batch, 1, new Decimal('0.4'))).toThrow('margin_pairing_budget_exceeded');
    expect(() => assertMarginHoldings(h.db, 'strategy', h.batch, ['9.4', '9.4'])).toThrow('margin_batch_holdings_unexplained');
    h.db.prepare("UPDATE execution_orders SET state='FILLED',executed_quantity='0.6' WHERE strategy_leg='right'").run();
    expect(() => assertMarginHoldings(h.db, 'strategy', h.batch, ['9.4', '9.4'])).not.toThrow();
    expect(() => assertMarginHoldings(h.db, 'strategy', h.batch, ['10', '10'])).toThrow('margin_positions_settlement_pending');
    expect(() => assertMarginHoldings(h.db, 'strategy', h.batch, ['9', '9'])).toThrow('margin_batch_holdings_unexplained');
  });
  it('rejects cumulative over-budget fills and old incomplete batch states', () => {
    const h = fixture(); h.order('left', '0.6', '0.6'); h.order('left', '0.6', '0.6');
    expect(() => marginBatchFills(h.db, 'strategy', h.batch)).toThrow('margin_batch_quantity_exceeded');
    expect(() => marginBatchFills(h.db, 'strategy', { before: '10', quantity: '1', incidentId: 'old' })).toThrow('margin_legacy_batch_requires_review');
  });
});
