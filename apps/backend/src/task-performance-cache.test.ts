import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import type { TaskPerformanceSummary } from '@gate-crossex/shared-types';
import { openDatabase } from './database.js';
import { TaskPerformanceCache, retainTradingResults } from './task-performance-cache.js';
function result(): TaskPerformanceSummary {
  const component={amount:'0',native:{},count:0};
  return {profileId:'p',checkedAt:100,reason:null,unallocated:component,tasks:[{taskId:'s',amount:null,status:'open',reasons:[],checkedAt:100,currency:'USDT',native:{},price:component,funding:component,fees:component,other:component,
    trading:{amount:'2',confirmed:'1',unrealized:'1',status:'estimated',scope:'task',groupId:'s',members:['s'],reasons:[],checkedAt:100,ledgerThrough:100,valuationAt:100,stale:false,adjustment:'0',maxError:null,maxErrorPct:null}}]};
}
describe('account-bound financial display cache',()=>{
  it('restores after a new cache instance only for the same verified identity',()=>{
    const db=openDatabase(':memory:',fileURLToPath(new URL('../../../migrations/',import.meta.url)));
    try{new TaskPerformanceCache(db).save('identity','p',result());const cache=new TaskPerformanceCache(db);
      expect(cache.read('identity','p')?.tasks[0].trading?.amount).toBe('2');expect(cache.read('other','p')).toBeNull();expect(cache.read('identity','other')).toBeNull();
    }finally{db.close();}
  });
  it('does not rewrite unchanged financial evidence just because a GET has a new timestamp',()=>{
    const db=openDatabase(':memory:',fileURLToPath(new URL('../../../migrations/',import.meta.url)));
    try{const cache=new TaskPerformanceCache(db),first=result();cache.save('identity','p',first);
      const before=(db.prepare('SELECT total_changes() n').get() as {n:number}).n;
      cache.save('identity','p',{...first,checkedAt:200,tasks:first.tasks.map(t=>({...t,checkedAt:200}))});
      expect((db.prepare('SELECT total_changes() n').get() as {n:number}).n).toBe(before);
    }finally{db.close();}
  });
  it('retains an old composite value and original time during position/fill skew',()=>{
    const old=result(),next=result();next.tasks[0].trading={...next.tasks[0].trading!,amount:null,checkedAt:200,reasons:['valuation_pending']};
    const merged=retainTradingResults(next,old);expect(merged.tasks[0].trading).toMatchObject({amount:'2',checkedAt:100,stale:true,status:'partial'});
    expect(old.tasks[0].trading?.stale).toBe(false);
  });
  it('never carries an amount across accounts or an ownership transfer',()=>{
    const old=result(),next=result();next.profileId='other';next.tasks[0].trading!.amount=null;
    expect(retainTradingResults(next,old).tasks[0].trading!.amount).toBeNull();next.profileId='p';next.tasks[0].trading!.status='transferred';
    expect(retainTradingResults(next,old).tasks[0].trading!.amount).toBeNull();
  });
});
