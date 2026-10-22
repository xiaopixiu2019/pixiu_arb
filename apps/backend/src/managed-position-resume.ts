import type Database from 'better-sqlite3';
import { Decimal } from 'decimal.js';
import type { ManagedState } from './managed-position-store.js';
import { TradingRuntimeError, type StrategyRecord } from './trading-runtime.js';
import type { ManagedLeg } from './managed-position-model.js';

export type ManagedResumeAction = 'OPENING' | 'MONITORING' | 'EXITING';

/** Describes intent only; fresh account and order reconciliation is still mandatory. */
export function managedResumeAction(record: StrategyRecord, state: ManagedState): ManagedResumeAction {
  if (state.stopIntent === 'KEEP') return 'MONITORING';
  if (state.exitRequested || state.stopIntent === 'EXIT') return 'EXITING';
  if (state.verified) return 'MONITORING';
  const filled = Decimal.min(record.filledLeft, record.filledRight);
  return filled.gte(record.config.totalAmount ?? '0') ? 'MONITORING' : 'OPENING';
}

export function managedResumeView(record: StrategyRecord, state: ManagedState | undefined) {
  return state ? { ...state, resumeAction: managedResumeAction(record, state) } : undefined;
}

/** An interrupted entry may continue only from fully explained, balanced holdings. */
export function verifyResumableEntry(db: Database.Database, record: StrategyRecord, state: ManagedState,
  quantities: [string, string], legs: [ManagedLeg, ManagedLeg]): void {
  const reject = () => { throw new TradingRuntimeError('managed_entry_resume_unverified', 409); };
  if (record.config.kind !== 'position' || record.config.reduceOnly || state.stopIntent || state.exitRequested
    || state.marginBatch || state.protectionIncident || state.positionSettlementSince || state.pauseAfterProtection
    || typeof state.adoptedLeft !== 'string' || typeof state.adoptedRight !== 'string') reject();
  const target = new Decimal(record.config.totalAmount ?? '0');
  const adopted = [new Decimal(state.adoptedLeft!), new Decimal(state.adoptedRight!)];
  if (!target.isPositive() || !adopted[0].eq(adopted[1]) || adopted.some(q => q.isNegative())) reject();
  const history = db.prepare(`SELECT strategy_leg, symbol, side, quantity, executed_quantity,
    reduce_only, remote_order_id, state, failure_reason FROM execution_orders WHERE strategy_id = ?`).all(record.id) as Array<{
      strategy_leg: string; symbol: string; side: string; quantity: string; executed_quantity: string;
      reduce_only: number; remote_order_id: string | null; state: string; failure_reason: string | null;
    }>;
  const filled = [new Decimal(0), new Decimal(0)];
  for (const row of history) {
    const index = row.strategy_leg === 'left' ? 0 : row.strategy_leg === 'right' ? 1 : -1;
    if (index < 0 || !row.remote_order_id || row.failure_reason || row.reduce_only
      || !['FILLED', 'CANCELLED'].includes(row.state)) reject();
    const leg = legs[index as 0 | 1];
    const quantity = new Decimal(row.executed_quantity);
    if (row.symbol !== leg.symbol || row.side !== leg.side || !quantity.isFinite()
      || quantity.isNegative() || quantity.gt(row.quantity) || row.state === 'FILLED' && !quantity.eq(row.quantity)) reject();
    filled[index] = filled[index].plus(quantity);
  }
  if (!filled[0].eq(filled[1]) || filled[0].gt(target)
    || !filled[0].eq(record.filledLeft) || !filled[1].eq(record.filledRight) || !filled[0].eq(record.filledQuantity)
    || filled.some((q, i) => !q.plus(adopted[i]).eq(quantities[i]))
    || state.openingQuantity !== '0' && filled[0].lt(target)) reject();
}
