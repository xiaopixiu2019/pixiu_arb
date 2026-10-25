import type Database from 'better-sqlite3';
import { TransactionFeeStore, type FinancialReadScope } from './transaction-fee-store.js';
import { TaskPerformanceStore, type PnlBook } from './task-performance-store.js';
import { legacyContext, legacyStage } from './task-performance-legacy-stage.js';
import { tradingGroups } from './task-trading-groups.js';
import { sharedIds, tradingLedger } from './task-trading-ledger.js';
import { tradingStage } from './task-performance-trading-stage.js';
import { pnlComponent, type PnlEntry } from './task-performance-model.js';
import type { GroupScope } from './task-performance-projection-scope.js';
import type { ProjectionWork, FxDependency } from './task-performance-projection-model.js';

/** One contract-connected component supplies attribution context; only dirty groups calculate cash stages. */
export function buildProjection(db: Database.Database, key: string, profile: string, at: number, scope: FinancialReadScope,
  targets: GroupScope[], poolSymbols: string[]): ProjectionWork {
  const dependencies = new Map<string, FxDependency>();
  const fees = new TransactionFeeStore(db, scope, (coin, time, rate) => {
    if (coin !== 'USDT' && Number.isFinite(time)) dependencies.set(JSON.stringify([coin, time]), { coin, at: time, rate });
  });
  const rows = new TaskPerformanceStore(db, undefined, scope).rows(key);
  const legacy = legacyContext(fees, key, profile, at, rows), groups = tradingGroups(fees, key, profile, at);
  const ledger = tradingLedger(rows, groups, fees, key), shared = sharedIds(rows);
  const stages = targets.map(group => {
    const g = groups.find(g => g.id === group.id); if (!g) throw new Error('task_projection_scope_changed');
    const members=legacy.all.filter(p=>group.taskIds.includes(p.task.id));
    const retainedScope={...group,from:Math.min(group.from,Number.isFinite(g.from)?g.from:0,...members.map(p=>Number.isFinite(p.from)?p.from:0)),
      to:g.closed&&members.every(p=>p.closed)?Math.max(group.to,Number.isFinite(g.to)?g.to+60000:Number.MAX_SAFE_INTEGER):Number.MAX_SAFE_INTEGER};
    return { schema: 1 as const, group:retainedScope, legacy: members.map(p => legacyStage(p, legacy, at)),
      trading: tradingStage(g, ledger, fees, key) };
  });
  const ordered = (selected: PnlBook[], value: (row: PnlBook) => PnlEntry) => selected.map(r => ({at:Number(r.create_time),id:r.id,value:value(r)}));
  const pools = poolSymbols.map(symbol => {
    const entries = { unallocated: ordered(legacy.ambiguous.filter(r => (r.symbol ?? '') === symbol),legacy.value),
      accountCosts: ordered(rows.filter(r => (r.symbol ?? '') === symbol && shared.has(r.id)),ledger.value),
      unresolvedCashflows: ordered(ledger.unassigned.filter(r => (r.symbol ?? '') === symbol),ledger.value) };
    return { symbol, entries, unallocated:pnlComponent(entries.unallocated.map(r=>r.value)),
      accountCosts:pnlComponent(entries.accountCosts.map(r=>r.value)),unresolvedCashflows:pnlComponent(entries.unresolvedCashflows.map(r=>r.value)) };
  });
  return { groups: stages, pools, dependencies: [...dependencies.values()] };
}
