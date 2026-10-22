import { afterEach, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import type Database from 'better-sqlite3';
import { openDatabase } from './database.js';
import { TransactionFeeStore } from './transaction-fee-store.js';
import { feeSummary, feeDetail } from './transaction-fee-report.js';
import type { GateAccountBookRecord, GateCrossExTrade } from './crossex-client.js';

const dbs: Database.Database[] = [];
afterEach(() => { for (const db of dbs.splice(0)) db.close(); });
function fixture() {
  const db = openDatabase(':memory:', fileURLToPath(new URL('../../../migrations/', import.meta.url))); dbs.push(db);
  const store = new TransactionFeeStore(db); store.begin('a', 'profile-a', 100000); store.rates('a', 150000, { USDT: '1', USDC: '0.998' });
  db.prepare(`INSERT INTO execution_strategies (id, kind, environment, status, config_json, created_at, updated_at, credential_profile_id)
    VALUES ('PAIR-FEE', 'position', 'live', 'RUNNING', '{}', ?, ?, 'profile-a')`).run(new Date(100000).toISOString(), new Date(100000).toISOString());
  const order = (id: string, venue: string, phase = 'entry') => db.prepare(`INSERT INTO execution_orders (id, remote_order_id, client_order_id, environment, symbol, venue, side, order_type, time_in_force, quantity, state, executed_quantity, strategy_id, fee_phase, created_at, updated_at)
    VALUES (?, ?, ?, 'live', ?, ?, 'BUY', 'LIMIT', 'POC', '1', 'FILLED', '1', 'PAIR-FEE', ?, ?, ?)`).run(id, id, `client-${id}`, `${venue}_FUTURE_HYPE_USDT`, venue, phase, new Date(100000).toISOString(), new Date(150000).toISOString());
  return { db, store, order };
}
function bill(id: string, order = id, coin = 'USDT', change = '-12.2', venue = 'BYBIT'): GateAccountBookRecord {
  return { id, business_id: order, statement_type: 'TRADING_FEE', exchange_type: venue, coin, change, balance: '100', create_time: '150000' };
}
function fill(id: string, venue = 'BYBIT'): GateCrossExTrade {
  return { transaction_id: `fill-${id}`, order_id: id, text: `client-${id}`, symbol: `${venue}_FUTURE_HYPE_USDT`, exchange_type: venue, business_type: 'FUTURE', side: 'BUY', qty: '1', price: '100', fee: '12.2', fee_coin: 'USDT', fee_rate: '0.001', match_role: 'MAKER', rpnl: '0', position_mode: 'SINGLE', position_side: 'LONG', create_time: '150000' };
}
describe('fee attribution and retained evidence', () => {
  it('preserves the old binding table write contract for rollback images', () => {
    const f = fixture();
    expect(() => f.db.prepare('INSERT INTO fee_order_bindings VALUES (?,?,?,?,?,?,?,?)')
      .run('a','GATE','legacy','PAIR-FEE',100000,'entry','right','legacy-client')).not.toThrow();
    expect(f.store.bindings('a')[0].quantity).toBeNull();
  });
  it('resolves a shared USDT ledger pool through exact retained fill and order identity', () => {
    const f = fixture(); f.order('gate', 'GATE'); f.order('kraken', 'KRAKEN');
    f.store.saveBook('a', [{ ...bill('gate', 'gate', 'USDT', '-0.4', 'CROSSEX'), symbol: 'GATE_FUTURE_HYPE_USDT' }, bill('kraken', 'kraken', 'USDT', '-0.16', 'KRAKEN')], 200000);
    f.store.saveTrades('a', 'profile-a', [{ ...fill('gate', 'GATE'), fee: '0.4' }, { ...fill('kraken', 'KRAKEN'), fee: '0.16' }], 200000);
    const result = feeSummary(f.store, 'a', 200000);
    expect(result.tasks[0].metric).toMatchObject({ amount: '0.56', status: 'ready', pending: 0 });
    expect(result.assigned.amount).toBe('0.56'); expect(result.unassigned.amount).toBe('0');
    expect(feeDetail(f.store, 'a', 200000, 'PAIR-FEE', 1)?.venues.map((v) => v.venue)).toEqual(['GATE', 'KRAKEN']);
    expect(f.store.book('a')[0].venue).toBe('CROSSEX');
    f.db.prepare('DELETE FROM execution_orders').run(); f.db.prepare('DELETE FROM execution_strategies').run();
    expect(feeSummary(f.store, 'a', 200000).tasks[0].metric.amount).toBe('0.56');
  });
  it('does not guess shared-pool identity with a missing symbol, wrong coin or conflicting client', () => {
    const f = fixture(); f.order('one', 'GATE');
    f.store.saveBook('a', [bill('one', 'one', 'USDT', '-1', 'CROSSEX')], 200000);
    f.store.saveTrades('a', 'profile-a', [fill('one', 'GATE')], 200000);
    expect(feeSummary(f.store, 'a', 200000).assigned.amount).toBeNull();
    f.store.saveBook('a', [{ ...bill('usd', 'one', 'USD', '-1', 'CROSSEX'), symbol: 'GATE_FUTURE_HYPE_USDT' }], 200000);
    expect(feeSummary(f.store, 'a', 200000).assigned.amount).toBeNull();
    f.store.saveTrades('a', 'profile-a', [{ ...fill('one', 'GATE'), text: 'foreign-client' }], 200000);
    expect(feeSummary(f.store, 'a', 200000).assigned.amount).toBeNull();
  });
  it('keeps a missing executed leg visible and propagates incomplete fees to account totals', () => {
    const f = fixture(); f.order('one', 'KRAKEN'); f.order('two', 'GATE');
    f.store.saveBook('a', [bill('one', 'one', 'USDT', '-12.2', 'KRAKEN')], 200000);
    f.store.saveTrades('a', 'profile-a', [fill('one', 'KRAKEN'), fill('two', 'GATE')], 200000);
    expect(feeSummary(f.store, 'a', 200000).total).toMatchObject({ amount: '12.2', status: 'partial', pending: 1 });
    expect(feeDetail(f.store, 'a', 200000, 'PAIR-FEE', 1)?.venues).toContainEqual({ venue: 'GATE', coin: 'USDT', native: null, converted: null, count: 0, pending: 1 });
  });
  it('rejects explicit ledger contract contradictions and incomplete charge amounts', () => {
    const f = fixture(); f.order('one', 'GATE');
    f.store.saveBook('a', [{ ...bill('one', 'one', 'USDT', '-12.2', 'GATE'), symbol: 'GATE_FUTURE_OTHER_USDT' }], 200000);
    f.store.saveTrades('a', 'profile-a', [fill('one', 'GATE')], 200000);
    expect(feeSummary(f.store, 'a', 200000).tasks[0].metric.status).not.toBe('ready');
    const g = fixture(); g.order('partial', 'GATE');
    g.store.saveBook('a', [bill('partial', 'partial', 'USDT', '-6.1', 'GATE')], 200000);
    g.store.saveTrades('a', 'profile-a', [fill('partial', 'GATE')], 200000);
    expect(feeSummary(g.store, 'a', 200000).tasks[0].metric).toMatchObject({ amount: '6.1', status: 'partial' });
    g.db.prepare('DELETE FROM execution_orders').run(); g.db.prepare('DELETE FROM execution_strategies').run();
    expect(feeSummary(g.store, 'a', 200000).tasks[0].metric).toMatchObject({ amount: '6.1', status: 'partial' });
  });
  it('keeps missing rebates and unknown legacy coverage unavailable', () => {
    const f = fixture(); f.order('rebate', 'GATE');
    f.store.saveBook('a', [], 200000); f.store.saveTrades('a', 'profile-a', [{ ...fill('rebate', 'GATE'), fee: '-0.1' }], 200000);
    expect(feeSummary(f.store, 'a', 200000).tasks[0].metric).toMatchObject({ amount: null, status: 'unavailable', pending: 1 });
    f.store.saveBook('a', [bill('rebate', 'rebate', 'USDT', '0.1', 'GATE')], 200000);
    expect(feeSummary(f.store, 'a', 200000).tasks[0].metric.amount).toBe('-0.1');
    f.db.prepare('UPDATE fee_binding_coverage SET quantity=NULL,symbol=NULL').run();
    f.db.prepare('DELETE FROM execution_orders').run(); f.db.prepare('DELETE FROM execution_strategies').run();
    expect(feeSummary(f.store, 'a', 200000).tasks[0].metric.status).toBe('partial');
  });
  it('uses fill dates for cross-day pending fees rather than order creation', () => {
    const f = fixture(); f.order('late', 'GATE');
    const now = Date.parse('2026-10-03T01:00:00Z');
    f.store.saveBook('a', [], now);
    f.store.saveTrades('a', 'profile-a', [{ ...fill('late', 'GATE'), create_time: String(now - 1000) }], now);
    expect(feeSummary(f.store, 'a', now).today.status).toBe('unavailable');
    const g = fixture(); g.order('spanning', 'GATE'); g.store.saveBook('a', [], now);
    g.store.saveTrades('a', 'profile-a', [{ ...fill('spanning', 'GATE'), transaction_id: 'yesterday', qty: '0.5', create_time: String(now - 86400000) },
      { ...fill('spanning', 'GATE'), transaction_id: 'today', qty: '0.5', create_time: String(now - 1000) }], now);
    expect(feeSummary(g.store, 'a', now).today.status).toBe('unavailable');
    expect(feeSummary(g.store, 'a', now).yesterday.status).toBe('unavailable');
    const h = fixture(); h.order('partial-day', 'GATE');
    h.db.prepare('UPDATE execution_orders SET executed_quantity=?,updated_at=?').run('2', new Date(now).toISOString());
    h.store.saveBook('a', [], now); h.store.saveTrades('a', 'profile-a', [{ ...fill('partial-day', 'GATE'), create_time: String(now - 86400000) }], now);
    expect(feeSummary(h.store, 'a', now).today.status).toBe('unavailable');
    expect(feeSummary(h.store, 'a', now).yesterday.status).toBe('unavailable');
  });
  it('revalues old unpriced bills only with stored evidence near the fee timestamp', () => {
    const f = fixture(); f.store.saveBook('a', [bill('usd', 'usd', 'USD', '-1', 'KRAKEN')], 200000);
    f.store.rates('a', 170000, { USD: '1.001' }); f.store.saveBook('a', [], 350000);
    expect(f.store.book('a')[0].usd).toBe('1.001');
  });
  it('never lets a historical reread erase latest coverage failures', () => {
    const f = fixture(); f.store.fail('a', 'trade', 'fee_trades_unavailable'); f.store.fail('a', 'book', 'fee_book_unavailable');
    f.store.saveTrades('a', 'profile-a', [], 150000, false); f.store.saveBook('a', [], 150000, false);
    expect(f.store.epoch('a')).toMatchObject({ trades_to: 100000, covered_to: 100000, trade_reason: 'fee_trades_unavailable', book_reason: 'fee_book_unavailable' });
  });
  it('rechecks a missing fill over its bounded creation-to-confirmation interval', () => {
    const f = fixture(); f.order('missing', 'GATE');
    expect(f.store.recheckWindow('a', 'profile-a', 0)).toEqual({ from: 100000, to: 151000 });
    f.db.prepare('UPDATE execution_orders SET executed_quantity=?,updated_at=?').run('2', new Date(200000).toISOString());
    f.store.saveTrades('a', 'profile-a', [fill('missing', 'GATE')], 210000);
    expect(f.store.recheckWindow('a', 'profile-a', 1)).toEqual({ from: 160000, to: 201000 });
  });
  it('does not contaminate account-window totals with pre-baseline orders', () => {
    const f = fixture(); f.order('before', 'GATE');
    f.db.prepare('UPDATE execution_orders SET updated_at=?').run(new Date(90000).toISOString());
    f.store.saveBook('a', [], 200000);
    expect(feeSummary(f.store, 'a', 200000).total).toMatchObject({ amount: '0', status: 'ready' });
    expect(f.store.recheckWindow('a', 'profile-a', 0)).toBeNull();
  });
  it('withdraws attribution when fill identity conflicts and does not rebind it', () => {
    const f = fixture(); f.order('one', 'BYBIT'); f.store.saveBook('a', [bill('one')], 200000);
    f.store.saveTrades('a', 'profile-a', [fill('one')], 200000);
    f.store.saveTrades('a', 'profile-a', [{ ...fill('one'), text: 'conflicting-client' }], 200000);
    f.store.saveTrades('a', 'profile-a', [fill('one')], 200000);
    const report = feeSummary(f.store, 'a', 200000);
    expect(report.assigned.amount).toBeNull(); expect(report.assigned.status).toBe('unavailable'); expect(report.unassigned.amount).toBe('12.2');
    expect(report.tasks[0].metric.amount).toBeNull();
  });
  it('binds delayed local order evidence without requiring the fill to be fetched again', () => {
    const f = fixture(); f.store.saveBook('a', [bill('one')], 200000);
    f.store.saveTrades('a', 'profile-a', [fill('one')], 200000); f.order('one', 'BYBIT');
    f.store.saveTrades('a', 'profile-a', [], 210000);
    expect(feeSummary(f.store, 'a', 210000).tasks[0].metric.amount).toBe('12.2');
  });
  it('counts canonical ledger money once and attributes by both remote and client order ids', () => {
    const f = fixture(); f.order('one', 'BYBIT');
    const records = [bill('one'), bill('manual', 'manual', 'USDT', '-2')];
    f.store.saveBook('a', records, 200000); f.store.saveBook('a', records, 200000);
    f.store.saveTrades('a', 'profile-a', [fill('one')], 200000);
    const result = feeSummary(f.store, 'a', 200000);
    expect(result.total.amount).toBe('14.2'); expect(result.assigned.amount).toBe('12.2'); expect(result.unassigned.amount).toBe('2');
    expect(result.tasks[0].metric).toMatchObject({ amount: '12.2', status: 'ready' });
    expect(feeDetail(f.store, 'a', 200000, 'PAIR-FEE', 1)).toMatchObject({ entry: '12.2', rebates: '0', totalFills: 1 });
  });
  it('never guesses the owner from only a coincident exchange order id', () => {
    const f = fixture(); f.order('one', 'BYBIT'); f.store.saveBook('a', [bill('one')], 200000);
    f.store.saveTrades('a', 'profile-a', [{ ...fill('one'), text: 'foreign-client' }], 200000);
    expect(feeSummary(f.store, 'a', 200000).assigned.amount).toBeNull();
    expect(feeSummary(f.store, 'a', 200000).assigned.status).toBe('unavailable');
    f.store.begin('b', 'profile-b', 100000); f.store.saveBook('b', [bill('one')], 200000); f.store.saveTrades('b', 'profile-b', [fill('one')], 200000);
    expect(feeDetail(f.store, 'b', 200000, 'PAIR-FEE', 1)).toBeNull();
  });
  it('retains verified attribution after old execution rows are cleaned up', () => {
    const f = fixture(); f.order('one', 'BYBIT'); f.store.saveBook('a', [bill('one')], 200000); f.store.saveTrades('a', 'profile-a', [fill('one')], 200000);
    f.db.prepare('DELETE FROM execution_orders').run(); f.db.prepare('DELETE FROM execution_strategies').run();
    expect(feeSummary(f.store, 'a', 200000).tasks[0].metric.amount).toBe('12.2');
  });
  it('exposes missing FX, historical coverage and conflicting ledger records', () => {
    const f = fixture(); f.order('one', 'BYBIT', 'unknown');
    f.store.saveBook('a', [bill('one', 'one', 'BTC')], 200000); f.store.saveTrades('a', 'profile-a', [{ ...fill('one'), fee_coin: 'BTC' }], 200000);
    expect(feeSummary(f.store, 'a', 200000).total).toMatchObject({ amount: null, pending: 1 });
    f.store.saveBook('a', [bill('one', 'one', 'BTC', '-99')], 200000);
    expect(feeDetail(f.store, 'a', 200000, null, 1)?.entries[0].reason).toBe('fee_conflicting_evidence');
    expect(feeSummary(f.store, 'a', 200000).yesterday.amount).toBeNull();
  });
  it('uses independent task phases and subtracts rebates only once', () => {
    const f = fixture(); f.order('open', 'DERIBIT'); f.order('repair', 'BYBIT', 'adjustment');
    f.store.saveBook('a', [bill('open', 'open', 'USDC', '-12.18', 'DERIBIT'), bill('repair'), bill('rebate', 'repair', 'USDT', '2')], 200000);
    f.store.saveTrades('a', 'profile-a', [fill('open', 'DERIBIT'), fill('repair')], 200000);
    const result = feeDetail(f.store, 'a', 200000, 'PAIR-FEE', 1)!;
    expect(result.entry).toBe('12.15564'); expect(result.adjustment).toBe('12.2'); expect(result.rebates).toBe('2'); expect(result.metric.amount).toBe('22.35564');
  });
});
