import type Database from 'better-sqlite3';
import { Decimal } from 'decimal.js';
import type { ManagedState } from './managed-position-store.js';
import { TradingRuntimeError, type StrategyRecord } from './trading-runtime.js';
import type { ManagedLeg } from './managed-position-model.js';
import { managedLegs } from './managed-legs.js';
import { expiredEntryIoc } from './entry-ioc.js';

export type ManagedResumeAction = 'OPENING' | 'MONITORING' | 'EXITING';

/** Describes intent only; fresh account and order reconciliation is still mandatory. */
export function managedResumeAction(record: StrategyRecord, state: ManagedState): ManagedResumeAction {
  if (state.stopIntent === 'KEEP') return 'MONITORING';
  if (state.exitRequested || state.stopIntent === 'EXIT') return 'EXITING';
  if (record.config.management?.monitorOnly || state.entryIntent === 'MONITORING' || state.protectionIncident || state.marginBatch || state.pauseAfterProtection) return 'MONITORING';
  if (state.verified && state.entryIntent !== 'OPENING') return 'MONITORING';
  const filled = Decimal.min(record.filledLeft, record.filledRight);
  return filled.gte(record.config.totalAmount ?? '0') ? 'MONITORING' : 'OPENING';
}

export function canContinueEntry(db: Database.Database, record: StrategyRecord, state: ManagedState): boolean {
  if (record.status !== 'RUNNING' || state.phase !== 'MONITORING' || state.entryIntent === 'MONITORING'
    || state.stopIntent || state.exitRequested || state.openingQuantity !== '0'
    || state.leftQuantity === null || state.rightQuantity === null
    || new Decimal(record.filledQuantity).gte(record.config.totalAmount ?? '0')
    || db.prepare("SELECT 1 FROM execution_strategy_logs WHERE strategy_id=? AND event='Stop requested' LIMIT 1").get(record.id)) return false;
  try { verifyResumableEntry(db, record, state, [state.leftQuantity, state.rightQuantity], managedLegs(record.config)); return true; }
  catch { return false; }
}
export function managedResumeView(record: StrategyRecord, state: ManagedState | undefined, db?: Database.Database) {
  return state ? { ...state, resumeAction: managedResumeAction(record, state),
    ...(state.preparationRecovery ? { entryPreparation: { failures: state.preparationRecovery.failures,
      nextAt: state.preparationRecovery.nextAt, review: state.preparationRecovery.review } } : {}),
    ...(db && canContinueEntry(db, record, state) ? { remainingEntryQuantity: new Decimal(record.config.totalAmount!).minus(record.filledQuantity).toString() } : {}) } : undefined;
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
    order_type, time_in_force, reduce_only, remote_order_id, state, failure_reason FROM execution_orders WHERE strategy_id = ?`).all(record.id) as Array<{
      order_type: string; time_in_force: string;
      strategy_leg: string; symbol: string; side: string; quantity: string; executed_quantity: string;
      reduce_only: number; remote_order_id: string | null; state: string; failure_reason: string | null;
    }>;
  const gross = [new Decimal(0), new Decimal(0)], reductions = [new Decimal(0), new Decimal(0)];
  for (const row of history) {
    const index = row.strategy_leg === 'left' ? 0 : row.strategy_leg === 'right' ? 1 : -1;
    const expiredHedge = record.config.executionMethod === 'MAKER_TAKER'
      && row.strategy_leg !== (record.config.makerLeg ?? 'left') && expiredEntryIoc({ state: row.state,
        type: row.order_type, timeInForce: row.time_in_force, reduceOnly: Boolean(row.reduce_only),
        remoteOrderId: row.remote_order_id, failureReason: row.failure_reason, quantity: row.quantity, executedQuantity: row.executed_quantity });
    if (index < 0 || !row.remote_order_id || row.failure_reason && !expiredHedge
      || !['FILLED', 'CANCELLED'].includes(row.state)) reject();
    const leg = legs[index as 0 | 1];
    const quantity = new Decimal(row.executed_quantity), expectedSide = row.reduce_only ? leg.side === 'BUY' ? 'SELL' : 'BUY' : leg.side;
    if (row.symbol !== leg.symbol || row.side !== expectedSide || !quantity.isFinite()
      || quantity.isNegative() || quantity.gt(row.quantity) || row.state === 'FILLED' && !quantity.eq(row.quantity)) reject();
    if (row.reduce_only) reductions[index] = reductions[index].plus(quantity);
    else gross[index] = gross[index].plus(quantity);
  }
  const paired = new Decimal(record.filledQuantity), net = gross.map((quantity, index) => quantity.minus(reductions[index]));
  if (!paired.isFinite() || paired.isNegative() || paired.gt(target) || !paired.eq(Decimal.min(...gross))
    || !gross[0].eq(record.filledLeft) || !gross[1].eq(record.filledRight)
    || net.some((quantity, index) => quantity.isNegative() || !quantity.eq(paired)
      || !quantity.plus(adopted[index]).eq(quantities[index]))
    || state.openingQuantity !== '0' && paired.lt(target)) reject();
}
