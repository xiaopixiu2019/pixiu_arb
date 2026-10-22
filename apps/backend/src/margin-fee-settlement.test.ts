import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { openDatabase } from './database.js';
import { marginFeesSettled, marginFeeCollectionReady } from './margin-fee-settlement.js';
import { TransactionFeeStore } from './transaction-fee-store.js';
import type { GateCrossExTrade, GateAccountBookRecord } from './crossex-client.js';
import { marginCostProof } from './margin-cost-proof.js';

const databases: ReturnType<typeof openDatabase>[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
function fixture() {
  const db = openDatabase(':memory:', resolve('../../migrations')); databases.push(db);
  const at = Date.now(), profile = 'synthetic', user = 'uid', key = createHash('sha256').update(`${profile}:${user}`).digest('hex');
  const stamp = new Date(at).toISOString();
  db.prepare(`INSERT INTO execution_strategies (id,kind,environment,status,config_json,credential_profile_id,created_at,updated_at)
    VALUES ('task','position','live','RUNNING','{}',?,?,?)`).run(profile, stamp, stamp);
  db.prepare(`INSERT INTO execution_orders (id,remote_order_id,client_order_id,environment,symbol,venue,side,order_type,time_in_force,
    quantity,state,executed_quantity,strategy_id,strategy_clip,fee_phase,created_at,updated_at)
    VALUES ('local','remote','client','live','GATE_FUTURE_TEST_USDT','GATE','SELL','MARKET','IOC','1','FILLED','1','task','margin:batch','exit',?,?)`).run(stamp, stamp);
  const store = new TransactionFeeStore(db); store.begin(key, profile, at - 1000);
  const trade = { transaction_id: 'fill', order_id: 'remote', text: 'client', exchange_type: 'GATE', symbol: 'GATE_FUTURE_TEST_USDT',
    qty: '1', fee: '0.05', fee_coin: 'USDT', create_time: String(at), price: '100', side: 'SELL', business_type: 'FUTURE', fee_rate: '0.0005', match_role: 'TAKER', rpnl: '0', position_mode: 'SINGLE', position_side: 'NONE' } as GateCrossExTrade;
  const book = { id: 'book', business_id: 'remote', statement_type: 'TRADING_FEE', exchange_type: 'GATE', coin: 'USDT', symbol: trade.symbol,
    change: '-0.05', balance: '100', create_time: String(at) } as GateAccountBookRecord;
  const rules = { fees: [{ symbol: trade.symbol, pool: 'GATE:USDT' }] };
  return { db, store, at, key, profile, user, trade, book, rules };
}
describe('borrowing batch ledger settlement proof', () => {
  it('checks actual collected fees for budget overruns instead of trusting the forecast fee rate', () => {
    const h = fixture(); h.db.prepare("UPDATE execution_orders SET executed_average_price='100' WHERE id='local'").run();
    h.store.saveTrades(h.key, h.profile, [{ ...h.trade, fee: '5' }], h.at);
    const budget = { batchId: 'batch', amount: '0.05', originalAmount: '2', quantity: '1', legs: [{ symbol: h.trade.symbol, side: 'SELL' as const, mark: '100', feeRate: '0.0005' }] };
    expect(marginCostProof(h.db, budget, h.profile, h.user)).toEqual({ amount: '2', settled: false, exceeded: true });
  });
  it('releases unused execution pressure but retains fees until authoritative coverage arrives', () => {
    const h = fixture(); h.db.prepare("UPDATE execution_orders SET executed_average_price='99.9' WHERE id='local'").run();
    const budget = { batchId: 'batch', amount: '2', originalAmount: '2', quantity: '1', legs: [{ symbol: h.trade.symbol, side: 'SELL' as const, mark: '100', feeRate: '0.0005' }] };
    expect(marginCostProof(h.db, budget, h.profile, h.user)).toEqual({ amount: '0.050949', settled: false, exceeded: false });
    expect(marginCostProof(h.db, budget, 'other', h.user)).toBeNull();
    h.store.saveTrades(h.key, h.profile, [h.trade], h.at); h.store.saveBook(h.key, [h.book], h.at);
    expect(marginCostProof(h.db, budget, h.profile, h.user)?.settled).toBe(true);
    h.db.prepare("UPDATE execution_orders SET executed_average_price='90' WHERE id='local'").run();
    expect(marginCostProof(h.db, budget, h.profile, h.user)?.exceeded).toBe(true);
    h.db.prepare("UPDATE execution_orders SET state='UNKNOWN' WHERE id='local'").run();
    expect(marginCostProof(h.db, budget, h.profile, h.user)).toBeNull();
  });
  it('requires exact trade quantity and canonical fee charge', () => {
    const h = fixture();
    expect(marginFeesSettled(h.db, h.profile, h.user, 'batch', h.rules)).toBe(false);
    h.store.saveTrades(h.key, h.profile, [h.trade], h.at);
    expect(marginFeesSettled(h.db, h.profile, h.user, 'batch', h.rules)).toBe(false);
    h.store.saveBook(h.key, [h.book], h.at);
    expect(marginFeesSettled(h.db, h.profile, h.user, 'batch', h.rules)).toBe(true);
    expect(marginFeesSettled(h.db, h.profile, 'other', 'batch', h.rules)).toBe(false);
    expect(marginFeesSettled(h.db, h.profile, h.user, 'other', h.rules)).toBe(false);
  });
  it('rejects wrong debit currency or pool rather than masking a changed fee convention', () => {
    const h = fixture(); h.store.saveTrades(h.key, h.profile, [h.trade], h.at); h.store.saveBook(h.key, [h.book], h.at);
    expect(marginFeesSettled(h.db, h.profile, h.user, 'batch', { fees: [{ symbol: h.trade.symbol, pool: 'KRAKEN:USD' }] })).toBe(false);
  });
  it('rejects incomplete quantities and stale fee collection', () => {
    const h = fixture(); h.store.saveTrades(h.key, h.profile, [{ ...h.trade, qty: '0.5' }], h.at); h.store.saveBook(h.key, [h.book], h.at);
    expect(marginFeesSettled(h.db, h.profile, h.user, 'batch', h.rules)).toBe(false);
    expect(marginFeeCollectionReady(h.db, h.profile, h.user, h.at)).toBe(true);
    expect(marginFeeCollectionReady(h.db, h.profile, h.user, h.at + 60001)).toBe(false);
  });
});
