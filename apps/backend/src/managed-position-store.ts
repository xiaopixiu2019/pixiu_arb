import type Database from 'better-sqlite3';
import type { ManagedPositionView } from '@gate-crossex/shared-types';

export interface ManagedMarginBatch {
  before: string; quantity: string; incidentId: string;
  version?: 2; id?: string; accountKey?: string; firstLeg?: 0 | 1; startedAt?: number;
  settlementSince?: number;
}

export interface ManagedState extends ManagedPositionView {
  marginReadPending?: boolean;
  marginBatch?: ManagedMarginBatch | null;
  protectionIncident?: { reason: string; before: [string, string]; at: number } | null;
  observedReductions?: [string, string];
  positionSettlementSince?: number;
  makerOrderId: string | null;
  pendingOrderId: string | null;
  nextBatchAt: number;
  makerStartedAt: number | null;
  cancelRequestedAt: number | null;
  fallback: boolean;
  openingQuantity: string;
  maxLeft: string;
  maxRight: string;
  verified: boolean;
  after: number;
  adoptionBaseline?: Array<{ symbol: string; quantity: string; entryPrice: string | null; unrealizedPnl: string | null }>;
  stopFromOpening?: boolean;
  pauseAfterProtection?: boolean;
}
export function initialManagedState(): ManagedState {
  return { phase: 'OPENING', leftQuantity: null, rightQuantity: null, checkedAt: null,
    spreadBps: null, fundingAprPct: null, fundingCheckedAt: null, conditionSince: null,
    exitRequested: false, reason: null, signalReason: null, signalMissingSince: null,
    pendingOrderIds: [], makerOrderId: null, pendingOrderId: null,
    nextBatchAt: 0, makerStartedAt: null, cancelRequestedAt: null, fallback: false, openingQuantity: '0',
    maxLeft: '0', maxRight: '0', verified: false, after: 0 };
}
export function readManagedState(db: Database.Database, id: string): ManagedState | undefined {
  const row = db.prepare('SELECT state_json FROM managed_positions WHERE strategy_id = ?').get(id) as { state_json: string } | undefined;
  return row ? JSON.parse(row.state_json) as ManagedState : undefined;
}
export function writeManagedState(db: Database.Database, id: string, state: ManagedState): void {
  db.prepare('UPDATE managed_positions SET state_json = ?, updated_at = ? WHERE strategy_id = ?')
    .run(JSON.stringify(state), new Date().toISOString(), id);
}
export function managedRiskReason(db: Database.Database): string | null {
  const row = db.prepare('SELECT reason FROM managed_risk_lock WHERE singleton = 1').get() as { reason: string } | undefined;
  return row?.reason ?? null;
}
export const MANAGED_ACCOUNT_RECHECKING = 'managed_account_rechecking';
export const MANAGED_RECOVERY_WINDOW_MS = 25_000;
export function managedHardRiskReason(db: Database.Database): string | null {
  const reason = managedRiskReason(db);
  return reason === MANAGED_ACCOUNT_RECHECKING ? null : reason;
}
export function managedRiskBlock(db: Database.Database): string | null {
  const reason = managedRiskReason(db);
  return reason === MANAGED_ACCOUNT_RECHECKING ? reason : reason ? 'managed_global_risk_paused' : null;
}
export function managedOrderBlock(db: Database.Database, symbol: string, strategyId?: string, reduceOnly = false, confirmedPairing = false): string | null {
  const riskBlock = managedRiskBlock(db);
  if (riskBlock) return riskBlock;
  if (!confirmedPairing && db.prepare("SELECT 1 FROM managed_positions WHERE json_extract(state_json, '$.positionSettlementSince') IS NOT NULL LIMIT 1").get())
    return 'managed_positions_settlement_pending';
  const incident = db.prepare("SELECT strategy_id FROM managed_positions WHERE json_extract(state_json, '$.protectionIncident') IS NOT NULL LIMIT 1")
    .get() as { strategy_id: string } | undefined;
  if (incident && (!reduceOnly || incident.strategy_id !== strategyId)) return 'managed_external_reduction_pending';
  const reservation = db.prepare('SELECT strategy_id FROM managed_position_reservations WHERE symbol = ?').get(symbol) as { strategy_id: string } | undefined;
  if (reservation) return reservation.strategy_id === strategyId ? null : 'managed_position_owned';
  const owner = db.prepare('SELECT strategy_id FROM managed_position_claims WHERE symbol = ?').all(symbol) as Array<{ strategy_id: string }>;
  if (owner.some((claim) => claim.strategy_id !== strategyId)) return 'managed_position_owned';
  if (strategyId) {
    const state = readManagedState(db, strategyId);
    if (state && ['STOPPING', 'STOPPED', 'TRANSFERRED'].includes(state.phase)) return 'managed_task_stopped';
    if (state?.stopIntent === 'KEEP') return 'managed_task_stopped';
    if (state && state.phase !== 'OPENING' && !reduceOnly) return 'managed_reentry_forbidden';
  }
  return null;
}
export function hasManagedClaims(db: Database.Database): boolean {
  return Boolean(db.prepare('SELECT 1 FROM managed_position_claims LIMIT 1').get()
    || db.prepare('SELECT 1 FROM managed_position_reservations LIMIT 1').get());
}
