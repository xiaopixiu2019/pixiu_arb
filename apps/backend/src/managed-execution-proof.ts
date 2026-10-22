import type Database from 'better-sqlite3';
import { Decimal } from 'decimal.js';
import type { ExecutionOrder, StrategyRecord } from './trading-runtime.js';
import type { ManagedState } from './managed-position-store.js';
import type { ManagedLeg } from './managed-position-model.js';
import { managedReductionTotals } from './managed-margin-batch.js';

export function ownsManagedExecution(db: Database.Database, record: StrategyRecord, state: ManagedState | undefined,
  account: string | null, legs: ManagedLeg[]): boolean {
  if (!state || record.status !== 'RUNNING' || record.accountProfileId !== account || !record.config.management
    || state.stopIntent === 'KEEP' || state.marginBatch || state.protectionIncident || state.pauseAfterProtection
    || !['OPENING', 'MONITORING', 'EXITING', 'BALANCING'].includes(state.phase)) return false;
  const claims = db.prepare('SELECT symbol FROM managed_position_claims WHERE strategy_id=? AND account_id=?')
    .all(record.id, account) as Array<{ symbol: string }>;
  return claims.length === 2 && legs.every(l => claims.some(c => c.symbol === l.symbol));
}

export function ordinaryManagedOrder(db: Database.Database, record: StrategyRecord, state: ManagedState | undefined,
  order: ExecutionOrder, account: string | null, legs: ManagedLeg[], entryPrepared: boolean): boolean {
  const ordinaryCancel = order.state === 'CANCELLED' && order.failureReason?.toLowerCase() === 'cancelled_by_user';
  if (!ownsManagedExecution(db, record, state, account, legs) || !order.remoteOrderId || order.failureReason && !ordinaryCancel
    || !['NEW', 'OPEN', 'PARTIALLY_FILLED', 'FILLED', 'PENDING_CANCEL', 'CANCELLED'].includes(order.state)) return false;
  const index = legs.findIndex(l => l.symbol === order.symbol);
  if (index < 0 || order.strategyId !== record.id || order.strategyLeg !== (index === 0 ? 'left' : 'right')) return false;
  const filled = new Decimal(order.executedQuantity), quantity = new Decimal(order.quantity);
  if (!filled.isFinite() || filled.lt(0) || !quantity.gt(0) || filled.gt(quantity)) return false;
  if (!order.reduceOnly) return entryPrepared && state!.phase === 'OPENING' && !state!.exitRequested
    && order.side === legs[index].side && quantity.lte(record.config.totalAmount!);
  return state!.exitRequested && ['EXITING', 'BALANCING'].includes(state!.phase)
    && order.side !== legs[index].side && quantity.lte(index === 0 ? state!.maxLeft : state!.maxRight);
}

/** Exact local reduction from the last verified holdings; never infer a fill from a quote. */
export function projectedExitHoldings(db: Database.Database, id: string, state: ManagedState): [string, string] | null {
  if (!state.verified || !state.exitRequested || state.marginBatch || state.protectionIncident || state.pauseAfterProtection
    || !['EXITING', 'BALANCING'].includes(state.phase) || state.stopIntent === 'KEEP'
    || state.leftQuantity === null || state.rightQuantity === null || !state.observedReductions) return null;
  const reductions = managedReductionTotals(db, id);
  const projected = [state.leftQuantity, state.rightQuantity].map((q, i) => new Decimal(q)
    .minus(new Decimal(reductions[i]).minus(state.observedReductions![i])));
  if (projected.some((q, i) => !q.isFinite() || q.lt(0) || q.gt(i === 0 ? state.maxLeft : state.maxRight))) return null;
  return [projected[0].toString(), projected[1].toString()];
}

export function confirmedExitQuantity(db: Database.Database, record: StrategyRecord, state: ManagedState | undefined,
  account: string | null, legs: ManagedLeg[], index: number, quantity: Decimal, excludeOrderId?: string): boolean {
  if (!ownsManagedExecution(db, record, state, account, legs)) return false;
  const projected = projectedExitHoldings(db, record.id, state!);
  if (!projected || !quantity.gt(0) || quantity.gt(new Decimal(projected[index]).minus(projected[1 - index]))) return false;
  const pending = db.prepare(`SELECT id FROM execution_orders WHERE strategy_id=? AND order_type='MARKET'
    AND state IN ('PENDING_SUBMIT','NEW','OPEN','PARTIALLY_FILLED','PENDING_CANCEL')`).all(record.id) as Array<{ id: string }>;
  return pending.every(row => row.id === excludeOrderId);
}
