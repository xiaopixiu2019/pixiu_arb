import { afterEach,describe,it,expect,vi } from 'vitest';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type Database from 'better-sqlite3';
import Fastify from 'fastify';
import { openDatabase } from './database.js';
import { TransactionFeeStore } from './transaction-fee-store.js';
import { TaskPerformanceService } from './task-performance-service.js';
import { registerTaskPerformanceRoutes } from './task-performance-routes.js';
import type { GateAccountBookRecord,ReadOnlyCrossExGateway } from './crossex-client.js';
import type { CredentialVault } from './credential-vault.js';
const dbs:Database.Database[]=[];
afterEach(()=>{for(const db of dbs.splice(0))db.close();});
function fixture(){
  const db=openDatabase(':memory:',fileURLToPath(new URL('../../../migrations/',import.meta.url)));dbs.push(db);
  let profile='a',now=1000000,blocked:Promise<void>|null=null,repeat=false,dense=false,failed=false;
  const queries:Array<{from:number;to:number}>=[];
  const key=createHash('sha256').update('a:user').digest('hex');new TransactionFeeStore(db).begin(key,'a',100000);
  db.prepare(`INSERT INTO execution_strategies(id,kind,environment,status,config_json,created_at,updated_at,credential_profile_id)
    VALUES ('s','position','live','COMPLETED','{}',?,?,'a')`).run(new Date(100000).toISOString(),new Date(100000).toISOString());
  const bill:GateAccountBookRecord={id:'bill',business_id:'opaque',statement_type:'FUNDING_FEE',symbol:'GATE_FUTURE_TEST_USDT',exchange_type:'GATE',coin:'USDT',change:'1',balance:'2',create_time:'200000'};
  const gateway={queryAccount:async()=>{if(blocked)await blocked;if(failed)throw new Error('synthetic_timeout');return {user_id:'user'};},
    queryAccountBook:async(_c:unknown,q:{from:number;to:number})=>{queries.push(q);return repeat||dense&&q.to-q.from>6*3600000?Array.from({length:200},()=>bill):Number(bill.create_time)>=q.from&&Number(bill.create_time)<=q.to?[bill]:[];},
  } as unknown as ReadOnlyCrossExGateway;
  const vault={get:async()=>({apiKey:'synthetic',apiSecret:'synthetic'})} as unknown as CredentialVault;
  const service=new TaskPerformanceService({database:db,gateway,vault,profile:()=>profile,context:()=>profile,now:()=>now});
  return {db,key,service,gateway,queries,fail:()=>{failed=true;},advance:()=>{now+=60000;},change:()=>{profile='b';now+=60000;},wait:(p:Promise<void>)=>{blocked=p;},repeat:()=>{repeat=true;},dense:()=>{dense=true;now=3*86400000;}};
}
describe('scoped read-only task accounting collector',()=>{
  it('detects account switches in the background without making a page query start collection',async()=>{
    vi.useFakeTimers();const h=fixture(),read=vi.spyOn(h.gateway,'queryAccount');
    try {
      h.service.start();await h.service.refresh();expect(read).toHaveBeenCalledTimes(1);
      h.change();expect((await h.service.summary()).tasks).toEqual([]);expect(read).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1000);expect(read).toHaveBeenCalledTimes(2);
      expect((await h.service.summary()).profileId).toBe('b');
    } finally {await h.service.stop();vi.useRealTimers();}
  });
  it('serves ten ordinary queries without history scans, cache writes or gateway requests',async()=>{
    const h=fixture();await h.service.refresh();
    const queries=vi.spyOn(h.db,'prepare'), gateway=vi.spyOn(h.gateway,'queryAccount');
    try {
      for(let n=0;n<10;n++)await h.service.summary();
      expect(queries.mock.calls.filter(([sql])=>/task_pnl_book|fee_trades|fee_book|fee_order_bindings|task_pnl_coverage\b|INSERT|UPDATE|DELETE/.test(sql))).toEqual([]);
      expect(gateway).not.toHaveBeenCalled();
    } finally {queries.mockRestore();await h.service.stop();}
  });
  it('does not start a second physical valuation when an aborted gateway ignores cancellation',async()=>{
    const h=fixture();await h.service.refresh();const expired=new AbortController();const spy=vi.spyOn(AbortSignal,'timeout').mockReturnValue(expired.signal);
    const query=vi.fn(()=>new Promise<never>(()=>undefined));h.gateway.queryPositions=query;
    const schedule=h.service as unknown as {scheduleValuation(scope:string):void};
    try{schedule.scheduleValuation('a');await Promise.resolve();await Promise.resolve();expect(query).toHaveBeenCalledTimes(1);
      expired.abort();await new Promise<void>(resolve=>setImmediate(resolve));h.advance();schedule.scheduleValuation('a');await Promise.resolve();expect(query).toHaveBeenCalledTimes(1);
    }finally{spy.mockRestore();await h.service.stop();}
  });
  it('retains task rows after a successful read then a transient failure',async()=>{
    const h=fixture();await h.service.refresh();expect((await h.service.summary()).tasks).toHaveLength(1);
    h.fail();await h.service.refresh();const r=await h.service.summary();expect(r.tasks).toHaveLength(1);expect(r.stale).toBe(true);await h.service.stop();
  });
  it('serves locally while refresh is blocked and drops data immediately on account change',async()=>{
    const h=fixture();await h.service.refresh();h.wait(new Promise<void>(()=>undefined));h.advance();
    expect((await h.service.summary()).tasks).toHaveLength(1);h.change();expect((await h.service.summary()).tasks).toHaveLength(0);await h.service.stop();
  });
  it('does not let old tasks before the trusted fee epoch delay current supported history',async()=>{
    const h=fixture();h.db.prepare('UPDATE fee_epochs SET started_at=500000 WHERE account_key=?').run(h.key);
    await h.service.refresh();expect(h.queries.length).toBeGreaterThan(0);expect(h.queries.every(q=>q.from>=500000)).toBe(true);await h.service.stop();
  });
  it('shrinks an overfull daily window without claiming its unverified remainder',async()=>{
    const h=fixture();h.dense();await h.service.refresh();
    expect(h.db.prepare('SELECT to_at FROM task_pnl_coverage WHERE from_at=100000').get()).toEqual({to_at:100000+6*3600000});
    await h.service.stop();
  });
  it('persists raw bills and coverage without duplicating repeated refreshes',async()=>{
    const h=fixture();await h.service.refresh();await h.service.refresh();expect(h.db.prepare('SELECT count(*) n FROM task_pnl_book').get()).toEqual({n:1});await h.service.stop();
  });
  it('rejects repeated full pages without claiming complete coverage',async()=>{
    const h=fixture();h.repeat();await h.service.refresh();expect((await h.service.summary()).reason).toBe('task_data_unavailable');
    expect(h.db.prepare('SELECT count(*) n FROM task_pnl_coverage').get()).toEqual({n:0});await h.service.stop();
  });
  it('drops a delayed response after account changes',async()=>{
    const h=fixture();let release!:()=>void;h.wait(new Promise<void>(r=>{release=r;}));const pending=h.service.refresh();
    h.change();release();await pending;expect(h.db.prepare('SELECT count(*) n FROM task_pnl_book').get()).toEqual({n:0});await h.service.stop();
  });
  it('aborts shutdown even when an upstream ignores the abort signal',async()=>{
    const h=fixture();h.wait(new Promise<void>(()=>undefined));const pending=h.service.refresh();await h.service.stop();await pending;
    expect(h.db.prepare('SELECT count(*) n FROM task_pnl_book').get()).toEqual({n:0});
  });
  it('requires read intent and refuses account overrides and writes',async()=>{
    const h=fixture(),app=Fastify();registerTaskPerformanceRoutes(app,h.service);
    expect((await app.inject('/api/crossex/task-performance')).statusCode).toBe(403);
    expect((await app.inject({url:'/api/crossex/task-performance?profile=other',headers:{'x-gct-read-intent':'task-performance'}})).statusCode).toBe(400);
    expect((await app.inject({method:'POST',url:'/api/crossex/task-performance'})).statusCode).toBe(404);
    await app.close();await h.service.stop();
  });
});
