import type Database from 'better-sqlite3';
import { Decimal } from 'decimal.js';
import type { ManagedMarginBatch } from './managed-position-store.js';
import type { ManagedState } from './managed-position-store.js';
import { isTerminalOrderState, type ExecutionOrder, type StrategyRecord } from './trading-runtime.js';
import type { ManagedLeg } from './managed-position-model.js';

export function marginBatchFills(db: Database.Database, strategyId: string, batch: ManagedMarginBatch, excludeOrderId?: string) {
  if (batch.version !== 2 || !batch.id || batch.firstLeg === undefined) throw new Error('margin_legacy_batch_requires_review');
  const rows = db.prepare(`SELECT id, strategy_leg AS leg, state, executed_quantity AS filled, quantity,
    remote_update_time AS remoteAt FROM execution_orders WHERE strategy_id = ? AND strategy_clip = ?`)
    .all(strategyId, `margin:${batch.id}`) as Array<{ id: string; leg: string; state: string; filled: string; quantity: string; remoteAt: string | null }>;
  const included = rows.filter(row => row.id !== excludeOrderId);
  const filled: [Decimal, Decimal] = [new Decimal(0), new Decimal(0)];
  const reserved: [Decimal, Decimal] = [new Decimal(0), new Decimal(0)];
  for (const row of included) {
    if (!['left', 'right'].includes(row.leg)) throw new Error('margin_order_attribution_invalid');
    const i = row.leg === 'left' ? 0 : 1, executed = new Decimal(row.filled), total = new Decimal(row.quantity);
    if (!executed.isFinite() || executed.lt(0) || executed.gt(total)) throw new Error('margin_order_fill_invalid');
    filled[i] = filled[i].plus(executed);
    reserved[i] = reserved[i].plus(isTerminalOrderState(row.state) ? executed : total);
  }
  if (reserved.some(n => n.gt(batch.quantity))) throw new Error('margin_batch_quantity_exceeded');
  return { filled, reserved, terminal: included.length > 0 && included.every(r => isTerminalOrderState(r.state)), rows: included };
}

/** Only invalidate a read for our exact persisted batch; this never grants execution or clears a lock. */
function knownMarginEvidence(db: Database.Database, record: StrategyRecord, state: ManagedState | undefined,
  account: string | null, legs: ManagedLeg[]) {
  if (!state?.verified || !state.marginBatch || record.status !== 'RUNNING' || record.accountProfileId !== account
    || state.stopIntent || state.protectionIncident || state.pauseAfterProtection
    || !['MONITORING', 'BALANCING'].includes(state.phase)) return null;
  if (![0, 1].includes(state.marginBatch.firstLeg!) || !new Decimal(state.marginBatch.quantity).gt(0)
    || !new Decimal(state.marginBatch.quantity).lte(state.marginBatch.before)) return null;
  const claims = db.prepare('SELECT symbol FROM managed_position_claims WHERE strategy_id=? AND account_id=?')
    .all(record.id, account) as Array<{ symbol: string }>;
  if (claims.length !== 2 || !legs.every(l => claims.some(c => c.symbol === l.symbol))) return null;
  const orders = db.prepare(`SELECT id,remote_order_id,symbol,side,order_type,time_in_force,reduce_only,failure_reason,strategy_leg
    FROM execution_orders WHERE strategy_id=? AND strategy_clip=?`).all(record.id, `margin:${state.marginBatch.id}`) as
    Array<{ id: string; remote_order_id: string | null; symbol: string; side: string; order_type: string;
      time_in_force: string | null; reduce_only: number; failure_reason: string | null; strategy_leg: string | null }>;
  if (!orders.length || orders.some(o => {
    const leg = legs[o.strategy_leg === 'left' ? 0 : o.strategy_leg === 'right' ? 1 : -1];
    return !leg || !o.remote_order_id || o.failure_reason || o.symbol !== leg.symbol || o.side === leg.side
      || !['BUY', 'SELL'].includes(o.side) || o.order_type !== 'MARKET' || o.time_in_force !== 'IOC' || o.reduce_only !== 1;
  })) return null;
  const evidence = marginBatchFills(db, record.id, state.marginBatch);
  if (evidence.filled[1 - state.marginBatch.firstLeg!].gt(evidence.filled[state.marginBatch.firstLeg!])) return null;
  return { ...evidence, orders, batch: state.marginBatch };
}

export function knownMarginOrder(db: Database.Database, record: StrategyRecord, state: ManagedState | undefined,
  account: string | null, legs: ManagedLeg[], order: ExecutionOrder): boolean {
  try {
    const evidence = knownMarginEvidence(db, record, state, account, legs);
    return !!evidence && evidence.orders.some(o => o.id === order.id)
      && ['NEW', 'OPEN', 'PARTIALLY_FILLED', 'FILLED', 'PENDING_CANCEL', 'CANCELLED'].includes(order.state);
  } catch { return false; }
}

export function knownMarginPosition(db: Database.Database, record: StrategyRecord, state: ManagedState | undefined,
  account: string | null, legs: ManagedLeg[], payload: Record<string, unknown>): boolean {
  try {
    const evidence = knownMarginEvidence(db, record, state, account, legs), index = legs.findIndex(l => l.symbol === payload.symbol);
    if (!evidence || index < 0 || evidence.rows.some(r => new Decimal(r.filled).gt(0) && !r.remoteAt)) return false;
    let quantity = new Decimal(String(payload.position_qty));
    if (payload.position_side === 'SHORT') quantity = quantity.abs().neg();
    if (payload.position_side === 'LONG') quantity = quantity.abs();
    return quantity.abs().eq(new Decimal(evidence.batch.before).minus(evidence.filled[index]))
      && (quantity.isZero() || (quantity.gt(0) ? 'BUY' : 'SELL') === legs[index].side);
  } catch { return false; }
}

export function assertMarginHoldings(db: Database.Database, id: string, batch: ManagedMarginBatch, quantities: [string, string]): void {
  const { filled, terminal } = marginBatchFills(db, id, batch);
  if (!terminal) throw new Error('margin_batch_holdings_unexplained');
  if (quantities.every((q, i) => new Decimal(batch.before).minus(filled[i]).eq(q))) return;
  if (quantities.every((q, i) => new Decimal(q).gte(new Decimal(batch.before).minus(filled[i])) && new Decimal(q).lte(batch.before)))
    throw new Error('margin_positions_settlement_pending');
  throw new Error('margin_batch_holdings_unexplained');
}

export function assertMarginSubmission(db: Database.Database, id: string, batch: ManagedMarginBatch, index: number, quantity: Decimal, excludeOrderId?: string): void {
  const facts = marginBatchFills(db, id, batch, excludeOrderId);
  if (facts.reserved[index].plus(quantity).gt(batch.quantity)) throw new Error('margin_batch_quantity_exceeded');
  if (index === batch.firstLeg) {
    if (facts.rows.length) throw new Error('margin_first_leg_already_submitted');
  } else if (!facts.terminal || quantity.gt(facts.filled[batch.firstLeg!].minus(facts.filled[index])))
    throw new Error('margin_pairing_budget_exceeded');
}

export function managedReductionTotals(db: Database.Database, id: string): [string, string] {
  const rows = db.prepare('SELECT strategy_leg AS leg, executed_quantity AS quantity FROM execution_orders WHERE strategy_id = ? AND reduce_only = 1')
    .all(id) as Array<{ leg: string; quantity: string }>;
  return ['left', 'right'].map(leg => rows.filter(r => r.leg === leg).reduce((n, r) => n.plus(r.quantity), new Decimal(0)).toString()) as [string, string];
}

/** Prefer existing order responsibility and unexplained holdings over a new first leg. */
export function managedActionPriority(db: Database.Database, id: string, state: ManagedState, quantities: [string, string]): number {
  if (state.pendingOrderId || state.marginBatch) return 0;
  if (state.protectionIncident || !new Decimal(quantities[0]).eq(quantities[1])) return 1;
  const reductions = managedReductionTotals(db, id);
  if (state.observedReductions && [state.leftQuantity, state.rightQuantity].some((before, i) => before !== null
    && !new Decimal(before).minus(new Decimal(reductions[i]).minus(state.observedReductions![i])).eq(quantities[i]))) return 1;
  return 2;
}

export function observedHoldings(state: ManagedState, reductions: [string, string], quantities: [string, string]): 'match' | 'pending' | 'external' {
  if (!state.observedReductions || state.leftQuantity === null || state.rightQuantity === null) return 'match';
  const before = [state.leftQuantity, state.rightQuantity].map(q => new Decimal(q));
  const expected = before.map((q, i) => q.minus(new Decimal(reductions[i]).minus(state.observedReductions![i])));
  if (quantities.every((q, i) => expected[i].eq(q))) return 'match';
  return quantities.every((q, i) => expected[i].lte(q) && before[i].gte(q)) ? 'pending' : 'external';
}
