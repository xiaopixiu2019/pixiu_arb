import { afterEach, describe, expect, it, vi } from 'vitest';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type Database from 'better-sqlite3';
import { openDatabase } from './database.js';
import { TransactionFeeStore } from './transaction-fee-store.js';
import { TaskPerformanceStore } from './task-performance-store.js';
import { taskTradingReport } from './task-trading-report.js';
import type { GateAccountBookRecord, GateCrossExTrade } from './crossex-client.js';
import type { TaskPerformanceSummary } from '@gate-crossex/shared-types';
const dbs: Database.Database[] = [];
afterEach(() => { for (const db of dbs.splice(0)) db.close(); });

function fixture(open = false, asset = 'TEST', taskId = 's', existing?: Database.Database) {
  const db = existing ?? openDatabase(':memory:', fileURLToPath(new URL('../../../migrations/', import.meta.url))); if (!existing) dbs.push(db);
  const fees = new TransactionFeeStore(db), store = new TaskPerformanceStore(db);
  fees.begin('a', 'p', 100000); fees.rates('a', 200000, { USD: '1.2', USDT: '1' });
  fees.rates('a', 310000, { USD: '1.2', USDT: '1' });
  db.prepare(`INSERT INTO execution_strategies(id,kind,environment,status,config_json,created_at,updated_at,stopped_at,credential_profile_id)
    VALUES (?,'position','live',?,'{}',?,?,?,'p')`).run(taskId,open ? 'RUNNING' : 'COMPLETED', new Date(100000).toISOString(), new Date(250000).toISOString(), open ? null : new Date(250000).toISOString());
  const state = { phase: open ? 'MONITORING' : 'COMPLETED', leftQuantity: open ? '1' : '0', rightQuantity: open ? '1' : '0', adoptedLeft: '0', adoptedRight: '0', groupId: taskId };
  db.prepare('INSERT INTO managed_positions VALUES (?,?,?,?)').run(taskId, 'p', JSON.stringify(state), new Date(250000).toISOString());
  const books: GateAccountBookRecord[] = [], trades: GateCrossExTrade[] = [];
  const bill = (id: string, order: string, type: string, venue: string, coin: string, symbol: string, change: string, at: number) =>
    ({ id, business_id: order, statement_type: type, exchange_type: venue, coin, symbol, change, balance: '100', create_time: String(at) });
  for (const venue of ['KRAKEN', 'GATE']) {
    const coin = venue === 'KRAKEN' ? 'USD' : 'USDT', symbol = `${venue}_FUTURE_${asset}_${coin}`;
    for (const phase of open ? ['entry'] : ['entry', 'exit']) {
      const id = `${asset === 'TEST' ? '' : asset + '-'}${venue}-${phase}`, at = phase === 'entry' ? 150000 : 250000;
      const side = (venue === 'KRAKEN') === (phase === 'entry') ? 'BUY' : 'SELL';
      db.prepare(`INSERT INTO execution_orders(id,remote_order_id,client_order_id,environment,symbol,venue,side,order_type,time_in_force,quantity,state,executed_quantity,strategy_id,fee_phase,created_at,updated_at)
        VALUES (?,?,?,'live',?,?,?,'MARKET','IOC','1','FILLED','1',?,?,?,?)`).run(id, id, `c-${id}`, symbol, venue, side, taskId,phase, new Date(at).toISOString(), new Date(at).toISOString());
      trades.push({ transaction_id: `t-${id}`, order_id: id, text: `c-${id}`, symbol, exchange_type: venue, business_type: 'FUTURE', side, qty: '1', price: '100', fee: '1', fee_coin: coin, fee_rate: '0.01', match_role: 'TAKER', rpnl: phase === 'exit' ? '2' : '0', position_mode: 'SINGLE', position_side: 'NONE', create_time: String(at) });
      books.push(bill(`f-${id}`, id, 'TRADING_FEE', venue, coin, symbol, '-1', at));
      if (phase === 'exit') books.push(bill(`p-${id}`, id, 'TRANSACTION', venue, coin, symbol, '2', at));
    }
    books.push(bill(`fund-${asset}-${venue}`, `position-${venue}_200`, 'FUNDING_FEE', venue, coin, symbol, '1', 200000));
  }
  fees.saveBook('a', books, 310000); fees.saveTrades('a', 'p', trades, 310000); store.save('a', books, 100000, 310000);
  const valuation = { profileId: 'p', at: 310000, positions: [
    { symbol: `KRAKEN_FUTURE_${asset}_USD`, quantity: '1', unrealizedPnl: '5' },
    { symbol: `GATE_FUTURE_${asset}_USDT`, quantity: '-1', unrealizedPnl: '3' },
  ] };
  return { db, fees, store, books, trades, valuation, report: () => taskTradingReport(store, 'a', 'p', 310000, open ? valuation : undefined) };
}

import { TaskPerformanceProjection } from './task-performance-projection.js';
import { TaskPerformanceWorker } from './task-performance-worker-client.js';
import { PerformanceStore } from './performance-store.js';
import { taskPerformanceReport } from './task-performance-report.js';
function comparable(value: unknown): unknown {
  const summary=value as TaskPerformanceSummary;
  return {...summary,checkedAt:null,contextToken:undefined,tasks:summary.tasks.map(t=>({...t,checkedAt:null}))};
}
async function compare(h: ReturnType<typeof fixture>, projection: TaskPerformanceProjection, at=310000) {
  await projection.update(at);
  const legacy=taskPerformanceReport(h.store,'a','p',at,null);
  const trading=taskTradingReport(h.store,'a','p',at,h.valuation);
  const actual=projection.summary(at,null,h.valuation)!;
  expect(comparable(actual)).toEqual(comparable({...legacy,stale:false,accountCosts:trading.accountCosts,unresolvedCashflows:trading.unresolvedCashflows,
    tasks:legacy.tasks.map(t=>({...t,trading:trading.results[t.taskId]}))}));
}
describe('incremental task projections',()=>{
  it('recovers a malformed fallback FX sample instead of trapping its dependent groups',async()=>{
    const h=fixture(),p=new TaskPerformanceProjection(h.db,'a','p');await compare(h,p);h.db.exec('DELETE FROM fee_rates');
    const samples=new PerformanceStore(h.db);samples.saveSample('a',{at:200000,equity:'1',available:'1',reason:null,rates:{USD:'invalid',USDT:'1'}},[]);
    await compare(h,p);samples.saveSample('a',{at:200000,equity:'1',available:'1',reason:null,rates:{USD:'1.2',USDT:'1'}},[]);await compare(h,p);
  });
  it('retains the legacy cost scope of a flat KEEP task after its trading view closes',async()=>{
    const h=fixture(),p=new TaskPerformanceProjection(h.db,'a','p');await compare(h,p);
    h.db.prepare("UPDATE execution_strategies SET status='STOPPED'").run();await compare(h,p);
    h.fees.rates('a',400000,{USD:'1.2',USDT:'1'});
    h.store.save('a',[{...h.books[0],id:'after-keep',symbol:'',statement_type:'INTEREST_ISOLATED',create_time:'400000',change:'-0.01'}],100000,450000);
    await compare(h,p,450000);
  });
  it('invalidates a bill-ID fee dependency even when its incoming attribution fields disagree',async()=>{
    const h=fixture(),p=new TaskPerformanceProjection(h.db,'a','p');await compare(h,p);const bill=h.books[0];
    h.db.prepare('DELETE FROM fee_book WHERE id=?').run(bill.id);await compare(h,p);
    const conflicting={...bill,business_id:'unrelated',symbol:null,create_time:'9000000'};
    h.db.prepare('INSERT INTO fee_book VALUES(?,?,?,?,?,?,?,?,?,?,?)')
      .run('a',bill.id,9000000,'KRAKEN','unrelated','USD','1','2','2',1,JSON.stringify(conflicting));
    await compare(h,p);expect(p.summary(310000,null)?.tasks[0].trading?.amount).toBeNull();
  });
  it('uses the same validated group identity as the original reader for malformed managed fields',async()=>{
    const h=fixture(true),p=new TaskPerformanceProjection(h.db,'a','p');await compare(h,p);
    h.db.prepare('UPDATE managed_positions SET state_json=?').run(JSON.stringify({groupId:'other-root',adoptedLeft:1,phase:'MONITORING'}));
    await compare(h,p);expect(p.summary(310000,null,h.valuation)?.reason).toBeNull();
    expect(p.summary(310000,null,h.valuation)?.tasks[0].trading?.reasons).toContain('invalid_evidence');
  });
  it('invalidates shared costs from verified fills that precede a task metadata timestamp',async()=>{
    const h=fixture(),p=new TaskPerformanceProjection(h.db,'a','p');await compare(h,p);
    h.db.prepare('UPDATE execution_strategies SET created_at=?').run(new Date(200000).toISOString());await compare(h,p);
    h.store.save('a',[{...h.books[0],id:'early-interest',symbol:'',statement_type:'INTEREST_ISOLATED',change:'-0.01',create_time:'155000'}],100000,310000);await compare(h,p);
    expect(p.summary(310000,null)?.tasks[0].status).toBe('estimated');
  });
  it('keeps readers pending after a lost publication notice and retires only acknowledged work',async()=>{
    const h=fixture(),writer=new TaskPerformanceProjection(h.db,'a','p');await compare(h,writer);
    const reader=new TaskPerformanceProjection(h.db,'a','p',undefined,true);
    h.db.prepare('DELETE FROM task_pnl_book WHERE id=?').run('p-KRAKEN-exit');await compare(h,writer);
    expect(h.db.prepare('SELECT COUNT(*) n FROM task_pnl_changes').get()).toEqual({n:0});
    expect(reader.pending()).toBe(true);expect(reader.summary(310000,null)?.stale).toBe(true);reader.reload();expect(reader.pending()).toBe(false);
    h.fees.begin('b','p',100000);const other=new TaskPerformanceProjection(h.db,'b','p');await other.update(310000);
    h.db.prepare("UPDATE execution_strategies SET status='STOPPED' WHERE id='s'").run();await writer.update(310000);
    expect(other.pending()).toBe(true);expect((h.db.prepare('SELECT COUNT(*) n FROM task_pnl_changes').get() as {n:number}).n).toBeGreaterThan(0);
    await other.update(310000);expect(h.db.prepare('SELECT COUNT(*) n FROM task_pnl_changes').get()).toEqual({n:0});
  });
  it('preserves provisional mixed-sign decimal ordering inside the selected group',async()=>{
    const h=fixture();fixture(false,'SECOND','other',h.db);const p=new TaskPerformanceProjection(h.db,'a','p');await compare(h,p);
    h.db.prepare("DELETE FROM task_pnl_book WHERE json_extract(payload,'$.statement_type') IN ('TRANSACTION','TRADING_FEE')").run();
    h.fees.rates('a',200000,{USD:'1',USDT:'1'});h.fees.rates('a',310000,{USD:'1',USDT:'1'});
    for(const trade of h.trades.filter(t=>t.order_id.endsWith('exit')))h.db.prepare('UPDATE fee_trades SET payload=? WHERE id=?')
      .run(JSON.stringify({...trade,rpnl:trade.exchange_type==='KRAKEN'?'100000000000000000000':'-100000000000000000000'}),trade.transaction_id);
    await compare(h,p);
  });
  it('detects removed FX currencies even when an older writer uses INSERT OR REPLACE',async()=>{
    const h=fixture(),p=new TaskPerformanceProjection(h.db,'a','p');await compare(h,p);
    h.db.prepare('INSERT OR REPLACE INTO fee_rates VALUES(?,?,?)').run('a',200000,'{"USDT":"1"}');await compare(h,p);
    expect(p.summary(310000,null)?.tasks[0].reasons).toContain('missing_historical_fx');
  });
  it('invalidates attribution when a different-symbol fill reuses a retained order identity',async()=>{
    const h=fixture(),p=new TaskPerformanceProjection(h.db,'a','p');await compare(h,p);
    h.fees.saveTrades('a','p',[{...h.trades[0],transaction_id:'cross-symbol',symbol:'KRAKEN_FUTURE_OTHER_USD'}],310000);
    await compare(h,p);expect(p.summary(310000,null)?.tasks[0].reasons).toContain('fee_evidence_pending');
  });
  it('publishes on a worker while the caller keeps serving the previous version and survives termination',async()=>{
    const h=fixture(),dir=mkdtempSync(join(tmpdir(),'pnl-worker-')),path=join(dir,'source.sqlite');
    await h.db.backup(path);const db=openDatabase(path,fileURLToPath(new URL('../../../migrations/',import.meta.url)));
    let worker=new TaskPerformanceWorker(path);
    try {
      const reader=new TaskPerformanceProjection(db,'a','p',undefined,true);
      await worker.update('a','p',310000);reader.reload();expect(reader.summary(310000,null)?.tasks[0].trading?.amount).toBe('2.2');
      const insert=db.prepare('INSERT INTO task_pnl_book VALUES(?,?,?,?,0)');
      db.transaction(()=>{for(let i=0;i<2000;i++){const row={...h.books[0],id:'orphan-'+i,business_id:'unowned_'+i,symbol:'GATE_FUTURE_OTHER_USDT',coin:'USDT',statement_type:'FUNDING_FEE',change:'0.001'};
        insert.run('a',row.id,Number(row.create_time),JSON.stringify(row));}})();
      expect(reader.summary(310000,null)?.stale).toBe(true);
      let pulses=0;const heartbeat=setInterval(()=>{pulses++;},1);
      try {await worker.update('a','p',310000);} finally {clearInterval(heartbeat);}
      expect(pulses).toBeGreaterThan(1);reader.reload();expect(reader.summary(310000,null)?.unallocated.amount).toBe('2');
      await expect(reader.update(310000)).rejects.toThrow('task_projection_read_only');
      new TaskPerformanceStore(db).save('a',[{...h.books[0],id:'after-worker-stop'}],100000,310000);
      const pending=worker.update('a','p',310000).catch(e=>(e as Error).message);await worker.stop();
      expect(await pending).toBe('task_projection_stopped');
      worker=new TaskPerformanceWorker(path,1);await expect(worker.update('a','p',310000)).rejects.toThrow('task_projection_timeout');await worker.stop();
      worker=new TaskPerformanceWorker(path);await worker.update('a','p',310000);reader.reload();
      const expected=taskPerformanceReport(new TaskPerformanceStore(db),'a','p',310000,null);
      expect(comparable({...reader.summary(310000,null)!,tasks:reader.summary(310000,null)!.tasks.map(({trading,...t})=>{void trading;return t;}) ,accountCosts:undefined,unresolvedCashflows:undefined}))
        .toEqual(comparable({...expected,stale:false,accountCosts:undefined,unresolvedCashflows:undefined}));
    } finally {await worker.stop();db.close();rmSync(dir,{recursive:true,force:true});}
  },15000);
  it('preserves original account summation order across independently cached currency pools',async()=>{
    const h=fixture(),p=new TaskPerformanceProjection(h.db,'a','p');await compare(h,p);const before=p.statistics.historyGroups;
    h.store.save('a',[
      {...h.books[0],id:'huge-in',symbol:'GATE_FUTURE_ORPHANA_USDT',coin:'USDT',change:'100000000000000000000',create_time:'170000'},
      {...h.books[0],id:'tiny',symbol:'GATE_FUTURE_ORPHANB_USDT',coin:'USDT',change:'1',create_time:'180000'},
      {...h.books[0],id:'huge-out',symbol:'GATE_FUTURE_ORPHANA_USDT',coin:'USDT',change:'-100000000000000000000',create_time:'190000'},
    ],100000,310000);await compare(h,p);expect(p.statistics.historyGroups).toBe(before);
  });
  it('updates only the owning group for a fee and keeps shared costs at account scope',async()=>{
    const h=fixture();fixture(false,'SECOND','other',h.db);const p=new TaskPerformanceProjection(h.db,'a','p');await compare(h,p);
    expect(p.statistics.historyGroups).toBe(2);
    h.store.save('a',[{...h.books[0],id:'one-fee',change:'-0.01'}],100000,310000);await compare(h,p);
    expect(p.statistics.historyGroups).toBe(3);
    h.store.save('a',[{...h.books[0],id:'public-interest',symbol:'',statement_type:'INTEREST_ISOLATED',change:'-0.01'}],100000,310000);await compare(h,p);
    expect(p.statistics.historyGroups).toBe(5);
  });
  it('changes only floating valuation for new prices and ignores unchanged historical FX samples',async()=>{
    const h=fixture(true),p=new TaskPerformanceProjection(h.db,'a','p');await compare(h,p);const count=p.statistics.historyGroups;
    h.valuation.positions[0].unrealizedPnl='7';await compare(h,p);expect(p.statistics.historyGroups).toBe(count);
    h.fees.rates('a',200001,{USD:'1.20',USDT:'1'});await compare(h,p);expect(p.statistics.historyGroups).toBe(count);
    h.fees.rates('a',200000,{USD:'1.1',USDT:'1'});await compare(h,p);expect(p.statistics.historyGroups).toBe(count+1);
    h.valuation.at=100000;await compare(h,p);expect(p.statistics.historyGroups).toBe(count+1);
  });
  it('does not turn frequent managed observation timestamps into changed financial evidence',async()=>{
    const h=fixture(true),p=new TaskPerformanceProjection(h.db,'a','p');await compare(h,p);const before={...p.statistics};
    const row=h.db.prepare('SELECT state_json FROM managed_positions WHERE strategy_id=?').get('s') as {state_json:string};
    for(let n=0;n<10;n++)h.db.prepare('INSERT OR REPLACE INTO managed_positions VALUES (?,?,?,?)')
      .run('s','p',JSON.stringify({...JSON.parse(row.state_json),checkedAt:new Date(310000+n).toISOString(),spreadBps:String(n)}),'updated');
    await p.update(310000);expect(p.statistics).toEqual(before);
  });
  it('rolls back evidence and dirty notices together and discards unpublished work after a concurrent mutation',async()=>{
    const h=fixture(),p=new TaskPerformanceProjection(h.db,'a','p');await compare(h,p);
    const sequence=()=>h.db.prepare('SELECT MAX(sequence) n FROM task_pnl_changes').get();const before=sequence();
    expect(()=>h.db.transaction(()=>{h.store.save('a',[{...h.books[0],id:'rolled-back'}],100000,310000);throw Error('rollback');})()).toThrow('rollback');
    expect(sequence()).toEqual(before);expect(p.pending()).toBe(false);
    h.store.save('a',[{...h.books[0],id:'first'}],100000,310000);
    let once=true;const changed=new TaskPerformanceProjection(h.db,'a','p',async()=>{if(once){once=false;h.store.save('a',[{...h.books[0],id:'second'}],100000,310000);}});
    expect(await changed.update(310000)).toBe(false);expect(changed.pending()).toBe(true);await compare(h,changed);
  });
  it('preserves transfer chains, settlement clocks and ownership conflicts across restart',async()=>{
    const h=fixture(),p=new TaskPerformanceProjection(h.db,'a','p');await compare(h,p);const at=new Date(200000).toISOString();
    h.db.prepare(`INSERT INTO execution_strategies(id,kind,environment,status,config_json,created_at,updated_at,stopped_at,credential_profile_id)
      VALUES ('child','position','live','COMPLETED','{}',?,?,?,'p')`).run(at,new Date(250000).toISOString(),new Date(250000).toISOString());
    h.db.prepare("UPDATE execution_strategies SET status='STOPPED',stopped_at=? WHERE id='s'").run(at);
    h.db.prepare('UPDATE managed_positions SET state_json=? WHERE strategy_id=?').run(JSON.stringify({groupId:'s',phase:'TRANSFERRED',transferredTo:'child',adoptedLeft:'0',adoptedRight:'0',leftQuantity:'1',rightQuantity:'1'}),'s');
    const child={groupId:'s',phase:'COMPLETED',adoptedLeft:'1',adoptedRight:'1',adoptedAt:at,leftQuantity:'0',rightQuantity:'0'};
    h.db.prepare('INSERT INTO managed_positions VALUES (?,?,?,?)').run('child','p',JSON.stringify(child),at);
    h.db.prepare("UPDATE execution_orders SET strategy_id='child' WHERE fee_phase='exit'").run();
    h.db.prepare("UPDATE fee_order_bindings SET task_id='child' WHERE phase='exit'").run();await compare(h,p);
    expect(p.summary(310000,null,h.valuation)?.tasks.find(t=>t.taskId==='s')?.trading?.status).toBe('transferred');
    const restarted=new TaskPerformanceProjection(h.db,'a','p');await compare(h,restarted);expect(restarted.statistics.historyGroups).toBe(0);
    h.db.prepare("UPDATE managed_positions SET state_json=? WHERE strategy_id='child'").run(JSON.stringify({...child,adoptedLeft:'2'}));await compare(h,restarted);
    await compare(h,restarted,500000); // fee freshness changes without historical recomputation.
  });
  it('retains external adoption cost baselines and rejects ambiguous manual fills',async()=>{
    const h=fixture(true),p=new TaskPerformanceProjection(h.db,'a','p');await compare(h,p);
    h.db.exec("DELETE FROM fee_order_bindings; DELETE FROM execution_orders; DELETE FROM fee_trades; DELETE FROM task_pnl_book WHERE json_extract(payload,'$.statement_type')!='FUNDING_FEE'");
    h.db.prepare('UPDATE execution_strategies SET config_json=?').run(JSON.stringify({asset:'TEST',leftVenue:'KRAKEN',rightVenue:'GATE',leftSide:'BUY',rightSide:'SELL'}));
    const state={groupId:'s',phase:'MONITORING',adoptedLeft:'1',adoptedRight:'1',adoptedAt:new Date(150000).toISOString(),leftQuantity:'1',rightQuantity:'1',
      adoptionBaseline:[{symbol:'KRAKEN_FUTURE_TEST_USD',quantity:'1',unrealizedPnl:'2'},{symbol:'GATE_FUTURE_TEST_USDT',quantity:'1',unrealizedPnl:'1'}]};
    h.db.prepare('UPDATE managed_positions SET state_json=?').run(JSON.stringify(state));await compare(h,p);
    h.fees.saveTrades('a','p',[{...h.trades[0],transaction_id:'manual',order_id:'manual',text:'manual'}],310000);await compare(h,p);
  });
  it.each([false,true])('matches original financial formulas for open=%s without read-time history',async open=>{
    const h=fixture(open),p=new TaskPerformanceProjection(h.db,'a','p'); await compare(h,p);
    const spy=vi.spyOn(h.db,'prepare');
    for(let n=0;n<10;n++)p.summary(310000,null,h.valuation);
    expect(spy.mock.calls.filter(([sql])=>/task_pnl_book|fee_trades|fee_book|fee_order_bindings|task_pnl_coverage\b|INSERT|UPDATE|DELETE/.test(sql))).toEqual([]);
    spy.mockRestore(); expect(p.statistics.historyGroups).toBe(1);
    const before={...p.statistics};h.store.save('a',h.books,100000,310000);h.fees.saveBook('a',h.books,310000);h.fees.saveTrades('a','p',h.trades,310000);
    await p.update(310000);expect(p.statistics).toEqual(before);
  });
  it('revises late, conflicting and provisional cashflows and preserves unallocated account costs',async()=>{
    const h=fixture(),p=new TaskPerformanceProjection(h.db,'a','p');await compare(h,p);
    h.db.prepare('DELETE FROM task_pnl_book WHERE id=?').run('p-KRAKEN-exit');await compare(h,p);
    h.store.save('a',[h.books.find(r=>r.id==='p-KRAKEN-exit')!],100000,310000);await compare(h,p);
    h.store.save('a',[{...h.books[0],id:'interest',symbol:'',statement_type:'INTEREST_ISOLATED',change:'-0.01'}],100000,310000);await compare(h,p);
    h.store.save('a',[{...h.books[0],change:'-99'}],100000,310000);await compare(h,p);
    h.db.exec('DELETE FROM fee_rates; UPDATE fee_book SET usd=NULL,rate=NULL');await compare(h,p);
    h.fees.rates('a',200000,{USD:'1.2',USDT:'1'});h.fees.revalueUnpriced('a');await compare(h,p);
  });
  it('resumes unpublished stages after interruption and keeps old confirmed results marked pending',async()=>{
    const h=fixture();const p=new TaskPerformanceProjection(h.db,'a','p');await compare(h,p);
    h.store.save('a',[{...h.books[0],id:'late-fee',change:'-0.1'}],100000,310000);
    expect(p.summary(310000,null,h.valuation)?.stale).toBe(true);
    let valid=true;const interrupted=new TaskPerformanceProjection(h.db,'a','p',async()=>{valid=false;});
    await expect(interrupted.update(310000,()=>valid)).rejects.toThrow('task_projection_interrupted');
    const restarted=new TaskPerformanceProjection(h.db,'a','p');await compare(h,restarted);
    expect(restarted.statistics.resumedBatches).toBeGreaterThan(0);expect(restarted.statistics.historyGroups).toBe(0);
  });
});
