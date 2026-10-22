import { afterEach, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import type Database from 'better-sqlite3';
import { openDatabase } from './database.js';
import { TransactionFeeStore } from './transaction-fee-store.js';
import { TaskPerformanceStore } from './task-performance-store.js';
import { taskTradingReport } from './task-trading-report.js';
import type { GateAccountBookRecord, GateCrossExTrade } from './crossex-client.js';
const dbs: Database.Database[] = [];
afterEach(() => { for (const db of dbs.splice(0)) db.close(); });

function fixture(open = false) {
  const db = openDatabase(':memory:', fileURLToPath(new URL('../../../migrations/', import.meta.url))); dbs.push(db);
  const fees = new TransactionFeeStore(db), store = new TaskPerformanceStore(db);
  fees.begin('a', 'p', 100000); fees.rates('a', 200000, { USD: '1.2', USDT: '1' });
  fees.rates('a', 310000, { USD: '1.2', USDT: '1' });
  db.prepare(`INSERT INTO execution_strategies(id,kind,environment,status,config_json,created_at,updated_at,stopped_at,credential_profile_id)
    VALUES ('s','position','live',?,'{}',?,?,?,'p')`).run(open ? 'RUNNING' : 'COMPLETED', new Date(100000).toISOString(), new Date(250000).toISOString(), open ? null : new Date(250000).toISOString());
  const state = { phase: open ? 'MONITORING' : 'COMPLETED', leftQuantity: open ? '1' : '0', rightQuantity: open ? '1' : '0', adoptedLeft: '0', adoptedRight: '0', groupId: 's' };
  db.prepare('INSERT INTO managed_positions VALUES (?,?,?,?)').run('s', 'p', JSON.stringify(state), new Date(250000).toISOString());
  const books: GateAccountBookRecord[] = [], trades: GateCrossExTrade[] = [];
  const bill = (id: string, order: string, type: string, venue: string, coin: string, symbol: string, change: string, at: number) =>
    ({ id, business_id: order, statement_type: type, exchange_type: venue, coin, symbol, change, balance: '100', create_time: String(at) });
  for (const venue of ['KRAKEN', 'GATE']) {
    const coin = venue === 'KRAKEN' ? 'USD' : 'USDT', symbol = `${venue}_FUTURE_TEST_${coin}`;
    for (const phase of open ? ['entry'] : ['entry', 'exit']) {
      const id = `${venue}-${phase}`, at = phase === 'entry' ? 150000 : 250000;
      const side = (venue === 'KRAKEN') === (phase === 'entry') ? 'BUY' : 'SELL';
      db.prepare(`INSERT INTO execution_orders(id,remote_order_id,client_order_id,environment,symbol,venue,side,order_type,time_in_force,quantity,state,executed_quantity,strategy_id,fee_phase,created_at,updated_at)
        VALUES (?,?,?,'live',?,?,?,'MARKET','IOC','1','FILLED','1','s',?,?,?)`).run(id, id, `c-${id}`, symbol, venue, side, phase, new Date(at).toISOString(), new Date(at).toISOString());
      trades.push({ transaction_id: `t-${id}`, order_id: id, text: `c-${id}`, symbol, exchange_type: venue, business_type: 'FUTURE', side, qty: '1', price: '100', fee: '1', fee_coin: coin, fee_rate: '0.01', match_role: 'TAKER', rpnl: phase === 'exit' ? '2' : '0', position_mode: 'SINGLE', position_side: 'NONE', create_time: String(at) });
      books.push(bill(`f-${id}`, id, 'TRADING_FEE', venue, coin, symbol, '-1', at));
      if (phase === 'exit') books.push(bill(`p-${id}`, id, 'TRANSACTION', venue, coin, symbol, '2', at));
    }
    books.push(bill(`fund-${venue}`, `position-${venue}_200`, 'FUNDING_FEE', venue, coin, symbol, '1', 200000));
  }
  fees.saveBook('a', books, 310000); fees.saveTrades('a', 'p', trades, 310000); store.save('a', books, 100000, 310000);
  const valuation = { profileId: 'p', at: 310000, positions: [
    { symbol: 'KRAKEN_FUTURE_TEST_USD', quantity: '1', unrealizedPnl: '5' },
    { symbol: 'GATE_FUTURE_TEST_USDT', quantity: '-1', unrealizedPnl: '3' },
  ] };
  return { db, fees, store, books, trades, valuation, report: () => taskTradingReport(store, 'a', 'p', 310000, open ? valuation : undefined) };
}

describe('dynamic trading results', () => {
  it.each(['FAIL', 'REJECT', 'REJECTED', 'CANCELLED'])('reports zero for a completed zero-fill task with definitive %s orders', (state) => {
    const h=fixture();
    h.db.prepare('DELETE FROM fee_order_bindings').run();h.db.prepare('DELETE FROM fee_trades').run();h.db.prepare('DELETE FROM task_pnl_book').run();
    h.db.prepare('UPDATE execution_orders SET state=?,executed_quantity=\'0\',remote_order_id=NULL').run(state);
    expect(h.report().results.s).toMatchObject({amount:'0',status:'confirmed'});
  });
  it.each(['PENDING_SUBMIT', 'PENDING_CANCEL', 'OPEN', 'UNKNOWN', 'FAILED'])('does not turn a zero-fill %s order into zero PnL', (state) => {
    const h=fixture();
    h.db.prepare('DELETE FROM fee_order_bindings').run();h.db.prepare('DELETE FROM fee_trades').run();h.db.prepare('DELETE FROM task_pnl_book').run();
    h.db.prepare('UPDATE execution_orders SET state=?,executed_quantity=\'0\',remote_order_id=NULL').run(state);
    expect(h.report().results.s).toMatchObject({amount:null,reasons:expect.arrayContaining(['order_reconciliation_pending'])});
  });
  it.each(['FAIL', 'REJECT'])('requires retained fills even for terminal %s with reported execution',state=>{
    const h=fixture();h.db.prepare('DELETE FROM fee_order_bindings').run();h.db.prepare('DELETE FROM fee_trades').run();
    h.db.prepare('UPDATE execution_orders SET state=?').run(state);
    expect(h.report().results.s).toMatchObject({amount:null,reasons:expect.arrayContaining(['fill_coverage_incomplete'])});
  });
  it('keeps the verified trading result when a completed pair also has a zero-fill REJECT quote', () => {
    const h=fixture();
    h.db.prepare(`INSERT INTO execution_orders(id,client_order_id,remote_order_id,environment,symbol,venue,side,order_type,time_in_force,
      quantity,state,executed_quantity,strategy_id,created_at,updated_at)
      VALUES ('rejected-quote','rejected-client','rejected-remote','live','KRAKEN_FUTURE_TEST_USD','KRAKEN','BUY','LIMIT','POC',
      '1','REJECT','0','s',?,?)`).run(new Date(140000).toISOString(),new Date(140001).toISOString());
    expect(h.report().results.s).toMatchObject({amount:'2.2',status:'confirmed',stale:false});
  });
  it('shows a closed trading result independently from account interest', () => {
    const h = fixture(); h.store.save('a', [{ ...h.books[0], id: 'interest', symbol: '', statement_type: 'INTEREST_ISOLATED', change: '-10' }], 100000, 310000);
    const r = h.report(); expect(r.results.s).toMatchObject({ amount: '2.2', status: 'confirmed' }); expect(r.accountCosts.amount).toBe('-12');
  });
  it('includes live unrealized values without requiring future ledger coverage', () => {
    const h = fixture(true); expect(h.report().results.s).toMatchObject({ amount: '9', unrealized: '9', status: 'estimated' });
    expect(h.report().results.s.reasons).not.toContain('settlement_pending');
  });
  it('does not combine new positions with old fills or use a different account', () => {
    const h = fixture(true); h.valuation.positions[0].quantity = '0.5'; expect(h.report().results.s.amount).toBeNull();
    h.valuation.positions[0].quantity = '1'; h.valuation.profileId = 'other'; expect(h.report().results.s.amount).toBeNull();
  });
  it('shows known late attribution beyond five percent and does not duplicate it', () => {
    const h = fixture(), f = h.books.find(r => r.statement_type === 'FUNDING_FEE')!;
    const row = { ...f, id: 'late', business_id: 'position-KRAKEN_280', create_time: '300000', change: '-0.8' };
    h.store.save('a', [row], 100000, 310000); h.store.save('a', [row], 100000, 310000);
    const r = h.report().results.s; expect(r.amount).toBe('1.24'); expect(r.status).toBe('estimated'); expect(Number(r.maxErrorPct)).toBeGreaterThan(5);
  });
  it('uses actual fills provisionally then replaces them with bills once', () => {
    const h = fixture(); h.db.prepare('DELETE FROM task_pnl_book WHERE id=?').run('p-KRAKEN-exit');
    expect(h.report().results.s).toMatchObject({ amount: '2.2', status: 'estimated' });
    h.store.save('a', [h.books.find(r => r.id === 'p-KRAKEN-exit')!], 100000, 310000);
    expect(h.report().results.s).toMatchObject({ amount: '2.2', status: 'confirmed' });
  });
  it('keeps unknown or conflicting evidence unavailable rather than exempting it as shared costs', () => {
    const h = fixture(); h.store.save('a', [{ ...h.books[0], id: 'unknown', symbol: '', statement_type: 'UNKNOWN', change: '-0.001' }], 100000, 310000);
    expect(h.report().results.s.amount).toBeNull();
  });
  it('supports tasks without managed state and does not infer closure from execution completion', () => {
    const h = fixture(true); h.db.prepare('DELETE FROM managed_positions').run(); h.db.prepare("UPDATE execution_strategies SET status='COMPLETED'").run();
    expect(h.report().results.s).toMatchObject({ amount: '9', unrealized: '9' });
  });
  it('combines a verified internal handoff once and rejects a changed transfer quantity', () => {
    const h = fixture(), at = new Date(200000).toISOString();
    h.db.prepare(`INSERT INTO execution_strategies(id,kind,environment,status,config_json,created_at,updated_at,stopped_at,credential_profile_id)
      VALUES ('child','position','live','COMPLETED','{}',?,?,?,'p')`).run(at, new Date(250000).toISOString(), new Date(250000).toISOString());
    h.db.prepare("UPDATE execution_strategies SET status='STOPPED',stopped_at=? WHERE id='s'").run(at);
    h.db.prepare('UPDATE managed_positions SET state_json=? WHERE strategy_id=?').run(JSON.stringify({ groupId:'s',phase:'TRANSFERRED',transferredTo:'child',adoptedLeft:'0',adoptedRight:'0',leftQuantity:'1',rightQuantity:'1' }),'s');
    const child={groupId:'s',phase:'COMPLETED',adoptedLeft:'1',adoptedRight:'1',adoptedAt:at,leftQuantity:'0',rightQuantity:'0'};
    h.db.prepare('INSERT INTO managed_positions VALUES (?,?,?,?)').run('child','p',JSON.stringify(child),at);
    h.db.prepare("UPDATE execution_orders SET strategy_id='child' WHERE fee_phase='exit'").run();
    h.db.prepare("UPDATE fee_order_bindings SET task_id='child' WHERE phase='exit'").run();
    expect(h.report().results.child).toMatchObject({amount:'2.2',scope:'group'});
    expect(h.report().results.s).toMatchObject({amount:null,status:'transferred',transferredTo:'child'});
    h.db.prepare("UPDATE managed_positions SET state_json=? WHERE strategy_id='child'").run(JSON.stringify({...child,adoptedLeft:'2'}));
    expect(h.report().results.child.amount).toBeNull();
  });
  it('keeps fresh quantity and account identity checks even for a tiny holding', () => {
    const h=fixture(true);h.valuation.positions.push({...h.valuation.positions[0]});expect(h.report().results.s.amount).toBeNull();
    h.valuation.positions.pop();h.valuation.at=100000;expect(h.report().results.s.amount).toBeNull();
  });
  it('does not invent zero when executed quantity exists but retained fills are absent',()=>{
    const h=fixture();h.db.prepare('DELETE FROM fee_trades').run();expect(h.report().results.s.amount).toBeNull();
  });
  it('keeps a short-lived group visible with funding not yet booked',()=>{
    const h=fixture();h.db.prepare("DELETE FROM task_pnl_book WHERE json_extract(payload,'$.statement_type')='FUNDING_FEE'").run();
    expect(h.report().results.s).toMatchObject({amount:'0',status:'estimated'});expect(h.report().results.s.reasons).toContain('funding_not_booked');
  });
  it('reports a close-only execution without inventing a new reverse position',()=>{
    const h=fixture();h.db.prepare("UPDATE execution_strategies SET config_json=?").run(JSON.stringify({reduceOnly:true,closePlan:{targets:[{symbol:'KRAKEN_FUTURE_TEST_USD'}]}}));
    h.db.prepare('DELETE FROM managed_positions').run();
    h.db.prepare("DELETE FROM fee_order_bindings WHERE phase='entry'").run();
    h.db.prepare("DELETE FROM execution_orders WHERE fee_phase='entry'").run();
    h.db.prepare("DELETE FROM fee_trades WHERE at=150000").run();
    h.db.prepare("DELETE FROM task_pnl_book WHERE at<250000").run();
    const r=h.report().results.s;expect(r).toMatchObject({amount:'2.2',unrealized:'0',scope:'execution'});
    h.store.save('a',[{...h.books.find(r=>r.statement_type==='FUNDING_FEE')!,id:'whole-position-funding',business_id:'unowned-position_250',create_time:'250000',change:'100'}],100000,310000);
    expect(h.report().results.s.amount).toBe('2.2');
    const foreign={...h.trades[0],transaction_id:'foreign',order_id:'foreign',text:'foreign',create_time:'250000'};
    h.db.prepare('INSERT INTO fee_trades VALUES (?,?,?,?,?,0,?)').run('a',foreign.exchange_type,foreign.transaction_id,foreign.order_id,250000,JSON.stringify(foreign));
    expect(h.report().results.s.amount).toBe('2.2');
  });
  it('values external adoption with a positive native SHORT quantity and no new fills, including funding',()=>{
    const h=fixture(true);
    h.db.prepare('DELETE FROM fee_order_bindings').run();h.db.prepare('DELETE FROM execution_orders').run();h.db.prepare('DELETE FROM fee_trades').run();
    h.db.prepare("DELETE FROM task_pnl_book WHERE json_extract(payload,'$.statement_type')!='FUNDING_FEE'").run();
    h.db.prepare('UPDATE execution_strategies SET config_json=?').run(JSON.stringify({asset:'TEST',leftVenue:'KRAKEN',rightVenue:'GATE',leftSide:'BUY',rightSide:'SELL'}));
    const state={groupId:'s',phase:'MONITORING',adoptedLeft:'1',adoptedRight:'1',adoptedAt:new Date(150000).toISOString(),leftQuantity:'1',rightQuantity:'1',
      adoptionBaseline:[{symbol:'KRAKEN_FUTURE_TEST_USD',quantity:'1',unrealizedPnl:'2'},{symbol:'GATE_FUTURE_TEST_USDT',quantity:'1',unrealizedPnl:'1'}]};
    h.db.prepare('UPDATE managed_positions SET state_json=?').run(JSON.stringify(state));
    expect(h.report().results.s).toMatchObject({amount:'7.8',unrealized:'9',adoptionBaseline:'3.4',scope:'since_adoption'});
  });
  it('accepts nullable initial managed quantities without pretending a failed input is complete',()=>{
    const h=fixture(true);h.db.prepare('UPDATE managed_positions SET state_json=?').run(JSON.stringify({groupId:'s',phase:'OPENING',leftQuantity:null,rightQuantity:null}));
    expect(h.report().results.s).toMatchObject({amount:'9',status:'estimated'});
  });
});
