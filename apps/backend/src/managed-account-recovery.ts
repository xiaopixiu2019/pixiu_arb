import type Database from 'better-sqlite3';
import { Decimal } from 'decimal.js';
import { GateApiError, type GateCrossExOrder } from './crossex-client.js';
import type { ExecutionOrder, StrategyRecord } from './trading-runtime.js';
import type { ManagedState } from './managed-position-store.js';
import { entryHoldings } from './managed-position-adoption.js';
import { assertMarginHoldings, marginBatchFills, managedReductionTotals, observedHoldings } from './managed-margin-batch.js';

export interface AccountReadFault {
  code: string; fatal: boolean; status?: number; label: string;
  endpoint?: string; phase?: string; retryAfterMs?: number;
}
export class ManagedReadFailure extends Error {
  readonly fault: AccountReadFault;
  constructor(error: unknown) {
    const gate = error instanceof GateApiError ? error : null;
    const local = error instanceof Error ? error.message : '';
    const fatal = Boolean(gate && [401, 403].includes(gate.statusCode))
      || ['credential_not_configured', 'managed_account_changed', 'credential_context_changed'].includes(local);
    const code = fatal ? 'managed_account_authorization_failed'
      : local === 'managed_account_timeout' ? local : 'managed_account_read_failed';
    super(code);
    this.fault = { code, fatal, status: gate?.statusCode, label: gate?.label ?? (local === 'managed_account_timeout' ? 'READ_TIMEOUT' : 'LOCAL_READ_ERROR'),
      endpoint: gate?.context?.endpoint, phase: gate?.context?.phase, retryAfterMs: gate?.retryAfterMs };
  }
}

export interface ControlledCancellation { startedAt: number; deadline: number }
export type RecoveryVerdict = { kind: 'match' } | { kind: 'wait' | 'fault'; reason: string };
const fault = (reason: string): RecoveryVerdict => ({ kind: 'fault', reason });

export function recoveryHoldings(db: Database.Database, record: StrategyRecord, state: ManagedState,
  quantities: [string, string]): RecoveryVerdict {
  if (state.protectionIncident || state.pauseAfterProtection) return fault('managed_recovery_incident_unresolved');
  if (state.phase === 'OPENING' || !state.verified) {
    const expected = entryHoldings(db, record.id);
    if (quantities.every((q, i) => new Decimal(q).eq(expected[i]))) return { kind: 'match' };
    const before = [state.leftQuantity ?? state.adoptedLeft, state.rightQuantity ?? state.adoptedRight];
    if (before.every(q => typeof q === 'string') && quantities.every((q, i) => new Decimal(q).gte(before[i]!)
      && new Decimal(q).lte(expected[i]))) return { kind: 'wait', reason: 'managed_positions_settlement_pending' };
    return fault('managed_entry_exposure_changed');
  }
  const reductions = managedReductionTotals(db, record.id);
  if (state.marginBatch) {
    try {
      const batch = marginBatchFills(db, record.id, state.marginBatch);
      if (!batch.terminal) return quantities.every((q, i) => new Decimal(q).lte(state.marginBatch!.before)
        && new Decimal(q).gte(new Decimal(state.marginBatch!.before).minus(batch.reserved[i])))
        ? { kind: 'wait', reason: 'margin_order_confirmation_pending' } : fault('managed_margin_holdings_conflict');
      assertMarginHoldings(db, record.id, state.marginBatch, quantities);
    }
    catch (error) { return error instanceof Error && error.message === 'margin_positions_settlement_pending'
      ? { kind: 'wait', reason: error.message } : fault('managed_margin_holdings_conflict'); }
  }
  if (!state.observedReductions) {
    if (reductions.some(q => !new Decimal(q).isZero())) return fault('managed_recovery_baseline_unavailable');
    return quantities.every((q, i) => new Decimal(q).eq(i === 0 ? state.maxLeft : state.maxRight))
      ? { kind: 'match' } : fault('managed_position_mismatch');
  }
  const observed = observedHoldings(state, reductions, quantities);
  return observed === 'match' ? { kind: 'match' } : observed === 'pending'
    ? { kind: 'wait', reason: 'managed_positions_settlement_pending' } : fault('managed_external_reduction');
}

export function recoveryOrder(remote: GateCrossExOrder, local: ExecutionOrder): RecoveryVerdict {
  if (remote.order_id !== local.remoteOrderId || remote.symbol !== local.symbol || remote.side !== local.side || remote.type !== local.type
    || remote.time_in_force !== local.timeInForce || String(remote.reduce_only) !== String(local.reduceOnly)
    || !new Decimal(remote.qty).eq(local.quantity)
    || remote.text && remote.text !== local.clientOrderId
    || local.type === 'LIMIT' && (!remote.price || !local.price || !new Decimal(remote.price).eq(local.price))) return fault('managed_order_state_conflict');
  const executed = new Decimal(remote.executed_qty);
  if (executed.lt(local.executedQuantity) || executed.gt(local.quantity)) return fault('managed_order_state_conflict');
  if (!executed.eq(local.executedQuantity) || remote.state !== local.state) return { kind: 'wait', reason: 'managed_order_update_pending' };
  return { kind: 'match' };
}
