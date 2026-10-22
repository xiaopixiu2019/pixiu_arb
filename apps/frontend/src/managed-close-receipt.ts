import type { ManagedCloseScope, ManagedCloseTarget, StrategyRecord } from '@gate-crossex/shared-types';
import type { PositionTableRow } from './strategy-positions.js';
import { matchManagedCloseTarget } from './managed-close-target.js';

export interface CloseReceipt {
  strategyId: string;
  scope: ManagedCloseScope;
  identity: string;
  state: 'pending' | 'accepted' | 'review' | 'completed';
}
function identity(record: StrategyRecord): string {
  const c = record.config;
  return JSON.stringify([record.accountProfileId, record.id, record.management?.groupId,
    c.kind, c.asset, c.leftVenue, c.rightVenue, c.leftSide, c.rightSide]);
}
function sameScope(a: ManagedCloseScope, b: ManagedCloseScope): boolean {
  return a.accountProfileId === b.accountProfileId && a.legs.length === b.legs.length
    && a.legs.every(leg => b.legs.some(other => leg.symbol === other.symbol && leg.side === other.side));
}
export function closeReceipt(target: ManagedCloseTarget): CloseReceipt {
  return { strategyId: target.strategy.id, identity: identity(target.strategy), state: 'pending',
    scope: { accountProfileId: target.scope.accountProfileId, legs: target.scope.legs.map(leg => ({ ...leg })) } };
}
export function sameCloseTask(receipt: CloseReceipt, record: StrategyRecord): boolean {
  return record.id === receipt.strategyId && record.accountProfileId === receipt.scope.accountProfileId
    && identity(record) === receipt.identity;
}
export function transitionReceipt(receipt: CloseReceipt, state: CloseReceipt['state']): CloseReceipt {
  if (receipt.state === 'completed' || receipt.state === 'review' && state !== 'completed' || receipt.state === state) return receipt;
  return { ...receipt, state };
}
export function reconcileReceipt(receipt: CloseReceipt, records: readonly StrategyRecord[]): CloseReceipt {
  const record = records.find(r => r.id === receipt.strategyId && r.accountProfileId === receipt.scope.accountProfileId);
  if (!record || receipt.state === 'completed') return receipt;
  if (identity(record) !== receipt.identity) return transitionReceipt(receipt, 'review');
  const m = record.management;
  if (record.status === 'PAUSED' || record.status === 'STOPPED' || m?.phase === 'RISK_PAUSED'
    || m?.phase === 'TRANSFERRED' || m?.phase === 'STOPPED' || m?.stopIntent === 'KEEP') return transitionReceipt(receipt, 'review');
  const zero = (value: string | null) => typeof value === 'string' && /^[-+]?\d+(?:\.\d+)?$/.test(value) && Number(value) === 0;
  if (record.status === 'COMPLETED' && m?.phase === 'COMPLETED' && m.exitRequested
    && m.checkedAt && Number.isFinite(Date.parse(m.checkedAt)) && m.pendingOrderIds.length === 0
    && zero(m.leftQuantity) && zero(m.rightQuantity)) return transitionReceipt(receipt, 'completed');
  return receipt;
}
/** Display-only: never feed a receipt into new-request ownership validation. */
export function receiptForRows(rows: readonly PositionTableRow[], receipts: readonly CloseReceipt[],
  profile: string | null | undefined, targets: readonly ManagedCloseTarget[]): CloseReceipt | null {
  if (!profile || !rows.length || rows.length > 2 || new Set(rows.map(r => r.symbol)).size !== rows.length) return null;
  const candidates = receipts.filter(r => r.scope.accountProfileId === profile && rows.every(row =>
    Number.isFinite(row.quantity) && row.quantity !== 0 && r.scope.legs.some(leg =>
      leg.symbol === row.symbol && leg.side === (row.side === 'Long' ? 'BUY' : 'SELL'))));
  const current = matchManagedCloseTarget(rows, targets, profile);
  if (current) {
    const receipt = candidates.find(r => r.strategyId === current.strategy.id && sameScope(r.scope, current.scope));
    return receipt ? sameCloseTask(receipt, current.strategy) ? receipt : { ...receipt, state: 'review' } : null;
  }
  if (candidates.length !== 1) return null;
  const receipt = candidates[0];
  const conflicts = targets.some(t => t.scope.accountProfileId === profile && (t.strategy.id === receipt.strategyId
    ? !sameScope(t.scope, receipt.scope) : t.scope.legs.some(leg => rows.some(row => row.symbol === leg.symbol))));
  return conflicts ? { ...receipt, state: 'review' } : receipt;
}
