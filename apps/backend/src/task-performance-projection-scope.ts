import type Database from 'better-sqlite3';
import { TransactionFeeStore, type FinancialReadScope } from './transaction-fee-store.js';
import { managedLegs } from './managed-position-manager.js';
import { Decimal } from 'decimal.js';
import { readTradingTasks } from './task-trading-groups.js';

export interface GroupScope { id: string; taskIds: string[]; symbols: string[]; orders: string[]; from: number; to: number }
export interface PnlChange { sequence: number; kind: string; ref: string; payload: string }
interface ChangeData { task?: string; symbol?: string; order?: string; coin?: string; venue?: string; at?: number; type?: string; rates?: Record<string, string>; startedAt?: number }
function sameRate(a:string|null,b:string|null):boolean{
  if(a===b)return true;if(a===null||b===null)return false;
  try{return new Decimal(a).eq(b);}catch{return false;}
}
function feeDependencies(db:Database.Database,key:string,changes:PnlChange[]):PnlChange[]{
  return changes.flatMap(change=>{
    if(change.kind!=='fee')return [change];
    const ref=JSON.parse(change.ref) as string[];
    const row=db.prepare('SELECT payload FROM task_pnl_book WHERE account_key=? AND id=?').get(key,ref[1]) as {payload:string}|undefined;
    if(!row)return [change];
    const book=JSON.parse(row.payload) as {symbol?:string;business_id:string;coin:string;exchange_type:string;create_time:string;statement_type:string};
    return [change,{...change,kind:'book',payload:JSON.stringify({symbol:book.symbol,order:book.business_id,coin:book.coin,
      venue:book.exchange_type,at:Number(book.create_time),type:book.statement_type})}];
  });
}
function exactBookOwners(db: Database.Database, key: string, data: ChangeData, all: GroupScope[]): GroupScope[] {
  if (!data.symbol || !data.order || !data.venue || data.coin !== data.symbol.split('_').at(-1)) return [];
  const bindings = db.prepare(`SELECT b.task_id,b.venue FROM fee_order_bindings b JOIN fee_binding_coverage c
    ON c.account_key=b.account_key AND c.venue=b.venue AND c.order_id=b.order_id WHERE b.account_key=? AND b.order_id=? AND c.symbol=?`)
    .all(key, data.order, data.symbol) as Array<{ task_id: string; venue: string }>;
  const candidates = bindings.filter(b => (b.venue === data.venue || data.venue === 'CROSSEX' && data.coin === 'USDT'
    && ['GATE','BINANCE','OKX','BYBIT'].includes(b.venue)) && all.some(g => g.taskIds.includes(b.task_id)));
  if (new Set(candidates.map(b => b.task_id)).size !== 1) return [];
  return all.filter(g => g.taskIds.includes(candidates[0].task_id));
}
export function projectionGroups(db: Database.Database, key: string, profile: string): GroupScope[] {
  const fees = new TransactionFeeStore(db), bindings = fees.bindings(key), groups = new Map<string, GroupScope>();
  for (const row of readTradingTasks(fees,profile)) {
    const state=row.state;
    const id = typeof state.groupId === 'string' ? state.groupId : row.id;
    const old = groups.get(id), own = bindings.filter(b => b.task_id === row.id), symbols = own.flatMap(b => b.symbol ? [b.symbol] : []);
    try { symbols.push(...managedLegs(JSON.parse(row.config_json)).map(l => l.symbol).filter(s => /^[A-Z0-9]+_FUTURE_[A-Z0-9]+_[A-Z0-9]+$/.test(s))); } catch { /* Retained bindings still define known dependencies. */ }
    if (Array.isArray(state.adoptionBaseline)) for (const b of state.adoptionBaseline) if (typeof b?.symbol === 'string') symbols.push(b.symbol);
    const stopped = Date.parse(row.stopped_at ?? ''), from = Date.parse(row.created_at);
    groups.set(id, { id, taskIds: [...(old?.taskIds ?? []), row.id], symbols: [...new Set([...(old?.symbols ?? []), ...symbols])],
      orders: [...new Set([...(old?.orders ?? []), ...own.map(b => b.order_id)])],
      from: Math.min(old?.from ?? Infinity, Number.isFinite(from) ? from : 0),
      to: Math.max(old?.to ?? 0, Number.isFinite(stopped) ? stopped + 60000 : Number.MAX_SAFE_INTEGER) });
  }
  return [...groups.values()];
}
export function relatedScope(all: GroupScope[], targets: string[], symbols: string[] = []): FinancialReadScope {
  const ids = new Set(targets), contracts = new Set(symbols), orders = new Set<string>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const g of all) if (ids.has(g.id) || g.symbols.some(s => contracts.has(s)) || g.orders.some(o => orders.has(o))) {
      if (!ids.has(g.id)) { ids.add(g.id); changed = true; }
      for (const s of g.symbols) if (!contracts.has(s)) { contracts.add(s); changed = true; }
      for (const o of g.orders) if (!orders.has(o)) { orders.add(o); changed = true; }
    }
  }
  return { taskIds: all.filter(g => ids.has(g.id)).flatMap(g => g.taskIds), symbols: [...contracts] };
}
export function affectedProjection(db: Database.Database, key: string, changes: PnlChange[], all: GroupScope[], old: GroupScope[]) {
  const groups = new Set<string>(), symbols = new Set<string>(), combined = [...all, ...old];
  const add = (items: GroupScope[]) => { for (const g of items) { groups.add(g.id); g.symbols.forEach(s => symbols.add(s)); } };
  for (const change of feeDependencies(db,key,changes)) {
    const data = JSON.parse(change.payload) as ChangeData;
    if (change.kind === 'coverage' || change.kind === 'epoch') continue;
    if (change.kind === 'fx') {
      // Replacing a sample can remove a currency; inspecting only NEW payload keys misses that loss.
      const deps = db.prepare(`SELECT target_kind,target_id,coin,at,rate FROM task_pnl_dependencies WHERE account_key=? AND at BETWEEN ? AND ?`)
        .all(key, Number(data.at) - 90000, Number(data.at) + 90000) as Array<{ target_kind: string; target_id: string; coin:string; at: number; rate: string | null }>;
      const rates = new TransactionFeeStore(db);
      for (const d of deps) {
        const rate = rates.rateAt(key, d.coin, d.at);
        if (sameRate(rate,d.rate)) continue;
        if (d.target_kind === 'group') add(combined.filter(g => g.id === d.target_id)); else symbols.add(d.target_id);
      }
      continue;
    }
    if (data.symbol) symbols.add(data.symbol); else if (['book', 'fee'].includes(change.kind)) symbols.add('');
    const owning = combined.filter(g => !!data.task && g.taskIds.includes(data.task!) || !!data.order && g.orders.includes(data.order!));
    // A different-symbol fill/fee sharing an order can invalidate its retained attribution proof.
    if(['trade','fee'].includes(change.kind))add(owning);
    if (['task', 'order', 'binding'].includes(change.kind)) {
      add(owning); const shared = new Set(owning.flatMap(g => g.symbols));
      add(combined.filter(g => g.symbols.some(s => shared.has(s)))); continue;
    }
    const exact = data.type !== 'FUNDING_FEE' && ['book','fee'].includes(change.kind) ? exactBookOwners(db,key,data,all) : [];
    if (exact.length === 1) add(exact);
    else add(combined.filter(g => data.symbol ? g.symbols.includes(data.symbol) : data.at == null || data.at >= g.from && data.at <= g.to));
  }
  return { groups, symbols };
}
