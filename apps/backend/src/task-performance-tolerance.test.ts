import { describe, it, expect } from 'vitest';
import { taskPnl } from './task-performance-model.js';
import { boundedTaskEstimate } from './task-performance-tolerance.js';
import type { PnlBook } from './task-performance-store.js';
const task = { ...taskPnl('s', [{id:'p',kind:'price',change:'6.4029413666309588632',coin:'USDT',rate:'1',conflict:false}],
  ['unallocated_account_cost','late_funding_attribution_pending'], true, 1) };
const bill=(id:string,change:string,coin='USDT',type='KRAKEN_CONVERSION'):PnlBook=>({id,change,coin,statement_type:type,
  exchange_type:coin==='USD'?'KRAKEN':'CROSSEX',business_id:'conversion',symbol:'',create_time:'100',balance:'0',conflict:false});
const value=(r:PnlBook)=>({id:r.id,kind:'other' as const,coin:r.coin,change:r.change,conflict:r.conflict,
  rate:r.coin==='USD'?'1.0001900361068603035':'1'});
const pair=(id:string,usd:string,usdt:string)=>[ {...bill(`${id}-a`,usd,'USD'),business_id:id}, {...bill(`${id}-b`,usdt),business_id:id} ];
describe('aggregate materiality for known attribution uncertainty',()=>{
  it('nets complete conversions, includes the late charge and shows the actual Samsung scale result',()=>{
    const rows=[...pair('a','0.462757090000001','-0.4628543'),...pair('b','0.3563993600000001','-0.35647779'),bill('late','-0.01653304','USD','FUNDING_FEE')];
    const r=boundedTaskEstimate(task,rows,new Set(['late']),r=>r.id==='late'?{...value(r),rate:'1.0003301089359488631'}:value(r));
    expect(r.status).toBe('estimated');expect(Number(r.amount).toFixed(2)).toBe('6.39');
    expect(Number(r.estimate?.maxError)).toBeLessThan(0.022);
    expect(Number(r.estimate?.adjustment)).toBeCloseTo(-0.01655847,8);
  });
  it('bounds known account interest and other costs individually rather than blocking tiny costs',()=>{
    const rows=[bill('interest','-0.000025563576','USDT','INTEREST_ISOLATED'),
      bill('liquidation','-0.000007753691','USDT','LIQUIDATION_FEE'),bill('credit','0.00003593927','USDT','BANKRUPT_COMPENSATION')];
    const r=boundedTaskEstimate(task,rows,new Set(),value);
    expect(r.status).toBe('estimated');expect(r.estimate?.maxError).toBe('0.005069256537');
    expect(boundedTaskEstimate(task,[{...rows[0],change:'-1'}],new Set(),value)).toBe(task);
    expect(boundedTaskEstimate(task,rows,new Set(),r=>({...value(r),rate:null}))).toBe(task);
  });
  it.each(['missing_historical_fx','history_incomplete','conflicting_evidence','ownership_unverified','fee_evidence_pending','price_evidence_pending','funding_evidence_pending','settlement_pending'])('never tolerates %s',reason=>{
    const r={...task,reasons:[...task.reasons,reason]};expect(boundedTaskEstimate(r,pair('a','0.4','-0.4001'),new Set(),value)).toBe(r);
  });
  it('does not net unrelated, unmatched or incorrectly identified conversion legs',()=>{
    const valid=pair('a','0.4','-0.4001');
    for(const rows of [[valid[0]],[valid[0],{...valid[1],business_id:'other'}],[valid[0],{...valid[1],create_time:'101'}],
      [valid[0],{...valid[1],exchange_type:'KRAKEN'}],[valid[0],{...valid[1],change:'0.4'}]])
      expect(boundedTaskEstimate(task,rows,new Set(),value)).toBe(task);
  });
  it('does not accept absent rates, conflicts or unknown cost categories even for a tiny amount',()=>{
    const rows=pair('a','0.4','-0.4001');
    expect(boundedTaskEstimate(task,rows,new Set(),r=>({...value(r),rate:null}))).toBe(task);
    expect(boundedTaskEstimate(task,rows,new Set(),r=>({...value(r),conflict:true}))).toBe(task);
    expect(boundedTaskEstimate(task,[bill('tiny','-0.001','USDT','UNKNOWN')],new Set(),value)).toBe(task);
    expect(boundedTaskEstimate(task,[bill('late','-0.001','USDT','FUNDING_FEE')],new Set(),value)).toBe(task);
  });
  it('sums absolute group uncertainty without letting opposite bills cancel it',()=>{
    const rows=[bill('a','-0.2','USDT','FUNDING_FEE'),bill('b','0.2','USDT','FUNDING_FEE')];
    expect(boundedTaskEstimate(task,rows,new Set(['a','b']),value)).toBe(task);
    expect(boundedTaskEstimate(task,[{...rows[0],change:'-0.2'}],new Set(['a']),value).status).toBe('estimated');
  });
  it('accepts exactly five percent including rounding, rejects larger ratios and zero/near-zero net',()=>{
    const make=(subtotal:string)=>({...task,price:{...task.price,amount:subtotal}});
    const row=bill('a','-0.045','USDT','FUNDING_FEE');
    const atLimit=boundedTaskEstimate(make('1.045'),[row],new Set(['a']),value);
    expect(atLimit.status).toBe('estimated');expect(atLimit.estimate?.maxErrorPct).toBe('5');
    for(const subtotal of ['1.0449','0.045','0.04501']) {
      const t=make(subtotal);expect(boundedTaskEstimate(t,[row],new Set(['a']),value)).toBe(t);
    }
    expect(boundedTaskEstimate(make('-0.955'),[row],new Set(['a']),value).estimate?.maxErrorPct).toBe('5');
  });
  it('never estimates open positions or an invalid confirmed component',()=>{
    const rows=pair('a','0.4','-0.4001');
    for(const t of [{...task,status:'open' as const},{...task,price:{amount:null,native:{},count:1}}])
      expect(boundedTaskEstimate(t,rows,new Set(),value)).toBe(t);
  });
});
