import { Decimal } from 'decimal.js';
import type { TaskPerformanceSummary } from '@gate-crossex/shared-types';
import { taskPnl, pnlComponent, type PnlEntry, type PnlKind } from './task-performance-model.js';
import { TransactionFeeStore, type StoredFeeTrade } from './transaction-fee-store.js';
import { feeSummary } from './transaction-fee-report.js';
import { TaskPerformanceStore, type PnlBook } from './task-performance-store.js';
import { strictDecimal, type FeeBinding, type FeeBookRow } from './transaction-fee-model.js';
import { boundedTaskEstimate } from './task-performance-tolerance.js';

interface TaskRow { id: string; status: string; created_at: string; stopped_at: string | null; config_json: string; state_json: string | null }
export interface Proof { task: TaskRow; bindings: FeeBinding[]; trades: StoredFeeTrade[]; symbols: string[]; from: number; to: number; closed: boolean; reasons: string[] }
const kinds: Record<string,PnlKind> = {TRANSACTION:'price',FUNDING_FEE:'funding',TRADING_FEE:'fees',LIQUIDATION_FEE:'other',INTEREST_ISOLATED:'other',BANKRUPT_COMPENSATION:'other'};
export const kindOf=(type:string):PnlKind|undefined=>Object.hasOwn(kinds,type)?kinds[type]:undefined;
const transfers = new Set(['TRANSFER_IN','TRANSFER_OUT']);
function validTrade(t:StoredFeeTrade):boolean {
  try {return ['BUY','SELL'].includes(t.side) && strictDecimal(t.qty).gt(0) && strictDecimal(t.rpnl).isFinite();}
  catch {return false;}
}
function venueMatches(r: PnlBook, b: FeeBinding): boolean {
  if (r.coin!==b.symbol?.split('_').at(-1)) return false;
  return r.exchange_type === b.venue || r.exchange_type === 'CROSSEX' && r.coin === 'USDT'
    && ['GATE','BINANCE','OKX','BYBIT'].includes(b.venue);
}
export function proofs(fees: TransactionFeeStore, key: string, profile: string, now: number): Proof[] {
  const bindings = fees.bindings(key), trades = fees.trades(key);
  const tasks = fees.reportTasks(profile);
  return tasks.map(task => {
    const own = bindings.filter(b=>b.task_id===task.id), fills = trades.filter(t=>own.some(b=>b.venue===t.exchange_type && b.order_id===t.order_id && b.symbol===t.symbol && b.client_order_id===t.text));
    const state = task.state_json ? JSON.parse(task.state_json) : null;
    const closed = task.status==='COMPLETED' && state?.phase==='COMPLETED' && state.leftQuantity==='0' && state.rightQuantity==='0';
    const reasons: string[] = [];
    if (!state || !fills.length || own.some(b=>!b.symbol || b.quantity==null)) reasons.push('ownership_unverified');
    if (state && [state.adoptedLeft,state.adoptedRight].some(q=>q!=null && !new Decimal(q).isZero())) reasons.push('adopted_basis_unverified');
    if (state?.transferredTo || state?.groupId && state.groupId!==task.id) reasons.push('transferred_basis_unverified');
    if (fills.some(t=>t.conflict)) reasons.push('conflicting_evidence');
    if (fills.some(t=>!validTrade(t))) reasons.push('invalid_trade_evidence');
    const symbols = [...new Set(own.flatMap(b=>b.symbol ? [b.symbol]:[]))];
    if (symbols.length!==2) reasons.push('ownership_unverified');
    for (const symbol of symbols) {
      const net = fills.filter(t=>t.symbol===symbol && validTrade(t)).reduce((sum,t)=>sum.plus(new Decimal(t.qty).mul(t.side==='BUY'?1:-1)),new Decimal(0));
      if (closed && !net.isZero()) reasons.push('fill_coverage_incomplete');
    }
    return {task,bindings:own,trades:fills,symbols,from:fills.length?Math.min(...fills.map(t=>Number(t.create_time))):Date.parse(task.created_at),
      to:closed?Date.parse(task.stopped_at ?? ''):now,closed,reasons};
  });
}
export function entry(r: PnlBook, fees: TransactionFeeStore, key: string, feeBooks: Map<string,FeeBookRow>): PnlEntry {
  const fee=r.statement_type==='TRADING_FEE'?feeBooks.get(r.id):undefined;
  return {id:r.id,kind:kindOf(r.statement_type) ?? 'other',coin:r.coin,change:r.change,
    rate:fee?.rate ?? fees.rateAt(key,r.coin,Number(r.create_time)),conflict:r.conflict || !!fee?.conflict};
}
export function directOwner(r: PnlBook, all: Proof[]): Proof[] {
  if (!r.symbol) return [];
  return all.filter(p=>p.bindings.some(b=>b.symbol===r.symbol && b.order_id===r.business_id && venueMatches(r,b)));
}
/** A verified flat-to-flat lifecycle and unique fills are required; names/time alone never establish ownership. */
export function fundingOwner(r: PnlBook, all: Proof[], trades: StoredFeeTrade[], links: Map<string,Set<string>>): Proof[] {
  const at=Number(r.create_time);
  const candidates=all.filter(p=>p.symbols.includes(r.symbol ?? '') && at>=p.from && at<=p.to
    && p.bindings.some(b=>b.symbol===r.symbol && venueMatches(r,b)));
  if (candidates.length!==1 || candidates[0].reasons.length) return [];
  const p=candidates[0];
  const separator=r.business_id.lastIndexOf('_'),prefix=r.business_id.slice(0,separator);
  if(separator<=0 || !/^\d+$/.test(r.business_id.slice(separator+1)))return [];
  // A reused position identifier or delayed bill spanning another task is ambiguous, not a new task's income.
  if(links.get(`${r.symbol}:${prefix}`)?.size!==1)return [];
  const interfering=trades.some(t=>t.symbol===r.symbol && Number(t.create_time)>=p.from && Number(t.create_time)<=p.to
    && !p.trades.some(own=>own.transaction_id===t.transaction_id && own.exchange_type===t.exchange_type));
  return interfering?[]:candidates;
}
export function fundingLinks(rows:PnlBook[],all:Proof[]):Map<string,Set<string>> {
  const links=new Map<string,Set<string>>();
  for(const r of rows.filter(r=>r.statement_type==='FUNDING_FEE')){
    const prefix=r.business_id.slice(0,r.business_id.lastIndexOf('_')),key=`${r.symbol}:${prefix}`,owners=links.get(key)??new Set<string>();
    for(const p of all)if(p.symbols.includes(r.symbol??'')&&Number(r.create_time)>=p.from&&Number(r.create_time)<=p.to)owners.add(p.task.id);
    links.set(key,owners);
  }
  return links;
}
export function priceCoverage(p: Proof, rows: PnlBook[]): boolean {
  if(p.trades.some(t=>!validTrade(t)))return false;
  return p.bindings.every(b=>{
    const fills=p.trades.filter(t=>t.exchange_type===b.venue && t.order_id===b.order_id);
    const bills=rows.filter(r=>r.statement_type==='TRANSACTION' && r.symbol===b.symbol && r.business_id===b.order_id && venueMatches(r,b));
    const side=(values:string[],positive:boolean)=>values.reduce((sum,v)=>sum.plus(positive?Decimal.max(0,v):Decimal.min(0,v)),new Decimal(0));
    return [true,false].every(positive=>side(fills.map(t=>t.rpnl),positive).eq(side(bills.map(r=>r.change),positive)));
  });
}
export function taskPerformanceReport(store: TaskPerformanceStore, key: string, profile: string, now: number, failure: string | null): TaskPerformanceSummary {
  const fees=new TransactionFeeStore(store.db), all=proofs(fees,key,profile,now), rows=store.rows(key), trades=fees.trades(key);
  const links=fundingLinks(rows,all), feeBooks=new Map(fees.book(key).map(r=>[r.id,r])), valued=new Map<string,PnlEntry>();
  const value=(r:PnlBook)=>{let v=valued.get(r.id);if(!v){v=entry(r,fees,key,feeBooks);valued.set(r.id,v);}return v;};
  const feeTasks=feeSummary(fees,key,now).tasks, assigned=new Map<string,PnlBook[]>(), ambiguous: PnlBook[]=[];
  for (const r of rows.filter(r=>!transfers.has(r.statement_type))) {
    const owner=r.statement_type==='FUNDING_FEE'?fundingOwner(r,all,trades,links):directOwner(r,all);
    if (owner.length!==1) { ambiguous.push(r); continue; }
    const list=assigned.get(owner[0].task.id)??[]; list.push(r); assigned.set(owner[0].task.id,list);
  }
  const tasks=all.map(p=>{
    const own=assigned.get(p.task.id)??[], reasons=[...p.reasons], fee=feeTasks.find(f=>f.taskId===p.task.id)?.metric;
    if (failure) reasons.push(failure);
    if (!Number.isFinite(p.from) || !Number.isFinite(p.to) || store.through(key,p.from)<p.to+60_000) reasons.push('history_incomplete');
    if (now<p.to+60_000) reasons.push('settlement_pending');
    if (fee?.status!=='ready') reasons.push('fee_evidence_pending');
    const feeTotal=pnlComponent(own.filter(r=>r.statement_type==='TRADING_FEE').map(value)).amount;
    if(fee?.amount==null || feeTotal===null || !new Decimal(fee.amount).negated().eq(feeTotal)) reasons.push('fee_evidence_pending');
    if (!priceCoverage(p,own)) reasons.push('price_evidence_pending');
    if (p.symbols.some(s=>!own.some(r=>r.statement_type==='FUNDING_FEE' && r.symbol===s))) reasons.push('funding_evidence_pending');
    const unallocated=ambiguous.filter(r=>Number(r.create_time)>=p.from && Number(r.create_time)<=p.to+60_000 && (!r.symbol || p.symbols.includes(r.symbol)));
    if (unallocated.length) reasons.push('unallocated_account_cost');
    const positionKey=(r:PnlBook)=>`${r.symbol}:${r.business_id.slice(0,r.business_id.lastIndexOf('_'))}`;
    const fundingKeys=new Set(own.filter(r=>r.statement_type==='FUNDING_FEE' && r.business_id.includes('_')).map(positionKey));
    const late=ambiguous.filter(r=>r.statement_type==='FUNDING_FEE' && fundingKeys.has(positionKey(r)));
    if(late.length)reasons.push('late_funding_attribution_pending');
    if (own.some(r=>!kindOf(r.statement_type))) reasons.push('unclassified_ledger');
    const unresolved=[...new Map([...unallocated,...late].map(r=>[r.id,r])).values()];
    return boundedTaskEstimate(taskPnl(p.task.id,own.map(value),reasons,p.closed,now),unresolved,new Set(late.map(r=>r.id)),value);
  });
  return {profileId:profile,checkedAt:now,reason:failure,tasks,unallocated:pnlComponent(ambiguous.map(value))};
}
