import { describe, expect, it } from 'vitest';
import { taskPnl, type PnlEntry } from './task-performance-model.js';

const row = (id: string, kind: PnlEntry['kind'], change: string, coin = 'USDT', rate: string | null = '1'): PnlEntry =>
  ({ id, kind, change, coin, rate, conflict: false });
describe('task net PnL accounting', () => {
  it('does not report empty components as verified zero while backfill is incomplete',()=>{
    const r=taskPnl('s',[],['history_incomplete'],true,100);
    expect(r.amount).toBeNull();
    for(const kind of ['price','funding','fees','other'] as const)expect(r[kind].amount).toBeNull();
  });
  it('replays the Samsung cash components without counting fill fees twice', () => {
    const entries = [row('a','price','3.22','USD'), row('b','price','-2.7383'), row('c','funding','7.25741301','USD'),
      row('d','fees','-0.55489841','USD'),row('e','fees','-0.78364069')];
    const r = taskPnl('s',entries,[],true,100);
    expect(r.amount).toBe('6.40057391'); expect(r.status).toBe('settled'); // synthetic 1:1 fixture, not production FX
    expect(r.native).toEqual({ USD:'9.9225146', USDT:'-3.52194069' });
  });
  it('converts every cash event at its historical rate and includes refunds', () => {
    expect(taskPnl('s',[row('1','price','10','USD','1.2'),row('2','fees','-2'),row('3','fees','0.5')],[],true,1).amount).toBe('10.5');
  });
  it('never turns missing FX or incomplete history into a final total', () => {
    const r=taskPnl('s',[row('1','funding','7','USD',null)],['history_incomplete'],true,1);
    expect(r.amount).toBeNull(); expect(r.funding.amount).toBeNull(); expect(r.funding.native.USD).toBe('7');
    expect(r.reasons).toContain('missing_historical_fx');
  });
  it('deduplicates identical entries but blocks contradictory evidence', () => {
    const a=row('1','price','10'); expect(taskPnl('s',[a,a],[],true,1).amount).toBe('10');
    expect(taskPnl('s',[a,{...a,change:'11'}],[],true,1).amount).toBeNull();
  });
  it('keeps partial exits and KEEP holdings unsettled', () => {
    expect(taskPnl('s',[row('1','price','10')],[],false,1)).toMatchObject({amount:null,status:'open'});
  });
  it('does not label a partial subtotal final when account costs are unallocated', () => {
    expect(taskPnl('s',[row('1','price','10')],['unallocated_account_cost'],true,1)).toMatchObject({amount:null,status:'pending'});
  });
});
