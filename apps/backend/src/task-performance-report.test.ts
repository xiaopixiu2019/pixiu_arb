import { afterEach,describe,it,expect } from 'vitest';
import type Database from 'better-sqlite3';
import { fileURLToPath } from 'node:url';
import { openDatabase } from './database.js';
import { TransactionFeeStore } from './transaction-fee-store.js';
import { TaskPerformanceStore } from './task-performance-store.js';
import { taskPerformanceReport } from './task-performance-report.js';
import { runDatabaseMaintenance } from './database-maintenance.js';
import type { GateAccountBookRecord,GateCrossExTrade } from './crossex-client.js';
const dbs:Database.Database[]=[];
afterEach(()=>{for(const db of dbs.splice(0))db.close();});
function fixture(){
  const db=openDatabase(':memory:',fileURLToPath(new URL('../../../migrations/',import.meta.url)));dbs.push(db);
  const fees=new TransactionFeeStore(db),store=new TaskPerformanceStore(db);
  fees.begin('a','p',100000);fees.rates('a',200000,{USD:'1.2',USDT:'1'});
  db.prepare(`INSERT INTO execution_strategies(id,kind,environment,status,config_json,created_at,updated_at,stopped_at,credential_profile_id)
    VALUES ('s','position','live','COMPLETED','{}',?,?,?,'p')`).run(new Date(100000).toISOString(),new Date(250000).toISOString(),new Date(250000).toISOString());
  const state={phase:'COMPLETED',leftQuantity:'0',rightQuantity:'0',adoptedLeft:'0',adoptedRight:'0',groupId:'s'};
  db.prepare('INSERT INTO managed_positions VALUES (?,?,?,?)').run('s','p',JSON.stringify(state),new Date(250000).toISOString());
  const book:GateAccountBookRecord[]=[],trades:GateCrossExTrade[]=[];
  const bill=(id:string,order:string,type:string,venue:string,coin:string,symbol:string,change:string,at:number)=>
    ({id,business_id:order,statement_type:type,exchange_type:venue,coin,symbol,change,balance:'100',create_time:String(at)});
  for(const venue of ['KRAKEN','GATE']){
    const coin=venue==='KRAKEN'?'USD':'USDT',symbol=`${venue}_FUTURE_TEST_${coin}`;
    for(const phase of ['entry','exit']){
      const id=`${venue}-${phase}`,at=phase==='entry'?150000:250000,side=phase==='entry'?'BUY':'SELL';
      db.prepare(`INSERT INTO execution_orders(id,remote_order_id,client_order_id,environment,symbol,venue,side,order_type,time_in_force,quantity,state,executed_quantity,strategy_id,fee_phase,created_at,updated_at)
        VALUES (?,?,?,'live',?,?,?,'MARKET','IOC','1','FILLED','1','s',?,?,?)`).run(id,id,`c-${id}`,symbol,venue,side,phase,new Date(at).toISOString(),new Date(at).toISOString());
      trades.push({transaction_id:`t-${id}`,order_id:id,text:`c-${id}`,symbol,exchange_type:venue,business_type:'FUTURE',side,qty:'1',price:'100',fee:'1',fee_coin:coin,fee_rate:'0.01',match_role:'TAKER',rpnl:phase==='exit'?'2':'0',position_mode:'SINGLE',position_side:'LONG',create_time:String(at)});
      book.push(bill(`f-${id}`,id,'TRADING_FEE',venue,coin,symbol,'-1',at));
      if(phase==='exit')book.push(bill(`p-${id}`,id,'TRANSACTION',venue,coin,symbol,'2',at));
    }
    book.push(bill(`fund-${venue}`,'position_200','FUNDING_FEE',venue,coin,symbol,'1',200000));
  }
  fees.saveBook('a',book,310000);fees.saveTrades('a','p',trades,310000);store.save('a',book,100000,310000);
  return {db,fees,store,book,trades,state,report:()=>taskPerformanceReport(store,'a','p',310000,null)};
}
describe('task ledger completeness and ownership',()=>{
  it('never classifies an unknown statement by an inherited object property',()=>{
    const h=fixture();h.store.save('a',[{...h.book[0],id:'unknown-kind',statement_type:'constructor',change:'100'}],100000,310000);
    expect(h.report().tasks[0].reasons).toContain('unclassified_ledger');expect(h.report().tasks[0].amount).toBeNull();
  });
  it('marks malformed upstream PnL unavailable instead of throwing or calculating it',()=>{
    const h=fixture();h.db.prepare('UPDATE fee_trades SET payload=? WHERE id=?').run(JSON.stringify({...h.trades[0],rpnl:'not-a-number'}),h.trades[0].transaction_id);
    expect(h.report().tasks[0].reasons).toContain('invalid_trade_evidence');expect(h.report().tasks[0].amount).toBeNull();
  });
  it('does not silently discard funding posted after the known position closed',()=>{
    const h=fixture(),fund=h.book.find(r=>r.statement_type==='FUNDING_FEE')!;
    h.store.save('a',[{...fund,id:'late',business_id:'position_300',create_time:'400000'}],310000,450000);
    expect(h.report().tasks[0].reasons).toContain('late_funding_attribution_pending');expect(h.report().tasks[0].amount).toBeNull();
  });
  it('shows a bounded net estimate for a known small late funding bill',()=>{
    const h=fixture(),fund=h.book.find(r=>r.statement_type==='FUNDING_FEE')!;
    h.fees.rates('a',400000,{USD:'1.2',USDT:'1'});
    h.store.save('a',[{...fund,id:'late',business_id:'position_240',change:'-0.01653304',create_time:'400000'}],310000,450000);
    const r=h.report().tasks[0];expect(r.status).toBe('estimated');expect(r.amount).toBe('2.180160352');
    expect(r.estimate?.maxError).toBe('0.024839648');expect(r.funding.amount).toBe('2.2');
    expect(r.reasons).toContain('late_funding_attribution_pending');
  });
  it('handles complete conversion pairs plus tiny account interest and late funding end to end',()=>{
    const h=fixture(),fund=h.book.find(r=>r.statement_type==='FUNDING_FEE')!;
    h.fees.rates('a',400000,{USD:'1.2',USDT:'1'});
    h.store.save('a',[{...fund,id:'late',business_id:'position_240',change:'-0.01653304',create_time:'400000'}],310000,450000);
    h.store.save('a',[
      {...fund,id:'usd',business_id:'conversion',symbol:'',statement_type:'KRAKEN_CONVERSION',change:'0.4'},
      {...fund,id:'usdt',business_id:'conversion',symbol:'',statement_type:'KRAKEN_CONVERSION',coin:'USDT',exchange_type:'CROSSEX',change:'-0.48001'},
      {...fund,id:'interest',business_id:'interest',symbol:'',statement_type:'INTEREST_ISOLATED',coin:'USDT',exchange_type:'DERIBIT',change:'-0.00007'},
    ],100000,310000);
    const r=h.report().tasks[0];expect(r.status).toBe('estimated');expect(r.amount).toBe('2.180080352');
    expect(r.estimate?.adjustment).toBe('-0.019919648');
  });
  it('does not allocate funding while another fill shares the position',()=>{
    const h=fixture(),trade={...h.trades[0],transaction_id:'manual',order_id:'manual',text:'manual'};
    h.fees.saveTrades('a','p',[trade],310000);
    expect(h.report().tasks[0].reasons).toContain('funding_evidence_pending');expect(h.report().tasks[0].amount).toBeNull();
  });
  it('settles from canonical bills with non-parity FX and exact trade bindings',()=>{
    const h=fixture(),r=h.report().tasks[0];expect(r.reasons).toEqual([]);expect(r.amount).toBe('2.2');
    expect(r.price.amount).toBe('4.4');expect(r.funding.amount).toBe('2.2');expect(r.fees.amount).toBe('-4.4');
  });
  it('deduplicates replay and detects corrections instead of rewriting immutable evidence',()=>{
    const h=fixture();h.store.save('a',h.book,100000,310000);expect(h.report().tasks[0].amount).toBe('2.2');
    h.store.save('a',[{...h.book[0],change:'-9'}],100000,310000);expect(h.report().tasks[0].amount).toBeNull();
  });
  it('does not treat a missing fee or realized PnL bill as zero',()=>{
    const h=fixture();h.db.prepare('DELETE FROM task_pnl_book WHERE id=?').run('f-KRAKEN-exit');
    expect(h.report().tasks[0].reasons).toContain('fee_evidence_pending');
    h.db.prepare('DELETE FROM task_pnl_book WHERE id=?').run('p-GATE-exit');expect(h.report().tasks[0].reasons).toContain('price_evidence_pending');
  });
  it('retains original amounts when historical FX is missing',()=>{
    const h=fixture();h.db.exec('DELETE FROM fee_rates;UPDATE fee_book SET usd=NULL,rate=NULL');
    const r=h.report().tasks[0];expect(r.amount).toBeNull();expect(r.native.USD).toBe('1');expect(r.reasons).toContain('missing_historical_fx');
  });
  it('blocks unknown costs, adoption and late ambiguous funding rather than assigning by name',()=>{
    const h=fixture();h.store.save('a',[{...h.book[0],id:'cost',symbol:null,statement_type:'KRAKEN_CONVERSION',change:'-1'}],100000,310000);
    expect(h.report().tasks[0].reasons).toContain('unallocated_account_cost');
    h.db.prepare('UPDATE managed_positions SET state_json=?').run(JSON.stringify({...h.state,adoptedLeft:'1'}));
    expect(h.report().tasks[0].reasons).toContain('adopted_basis_unverified');
  });
  it('does not cross accounts or lose retained proof when execution rows expire',()=>{
    const h=fixture();expect(h.store.rows('other')).toEqual([]);
    runDatabaseMaintenance(h.db,Date.parse('2028-01-01T00:00:00Z'));
    expect(h.db.prepare('SELECT count(*) n FROM execution_orders').get()).toEqual({n:0});
    expect(h.report().tasks[0].amount).toBe('2.2');
  });
  it('keeps a partial ledger and KEEP nonflat task unsettled',()=>{
    const h=fixture();h.db.exec('DELETE FROM task_pnl_coverage');expect(h.report().tasks[0].reasons).toContain('history_incomplete');
    h.db.prepare("UPDATE execution_strategies SET status='STOPPED'").run();expect(h.report().tasks[0].status).toBe('open');
  });
});
