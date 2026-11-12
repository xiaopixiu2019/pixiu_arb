import type Database from 'better-sqlite3';
import type { StrategyRecord } from './trading-runtime.js';
import { readManagedState, writeManagedState } from './managed-position-store.js';

export const PREPARATION_WAIT = 'managed_entry_preparation_wait';
export const PREPARATION_REVIEW = 'managed_entry_preparation_review';
export function isPreparationTimeout(code: string, label?: string): boolean {
  if (code === 'paired_entry_preparation_unavailable') return true;
  try {
    const detail = JSON.parse(label ?? '') as { kind?: unknown; stage?: unknown; reason?: unknown; actual?: unknown };
    return detail.kind === 'timeout' && (code === 'paired_entry_read_failed' && detail.stage === 'catalog'
      || code === 'paired_entry_margin_mode_unverified' && detail.stage === 'margin_mode'
        && detail.reason === 'cross_margin_mode_unknown' && detail.actual === null);
  } catch { return false; }
}
export function preparationIdentity(db: Database.Database, record: StrategyRecord): string {
  return JSON.stringify([record.accountProfileId, record.config,
    db.prepare('SELECT symbol,account_id FROM managed_position_claims WHERE strategy_id=? ORDER BY symbol').all(record.id)]);
}
export function preparationEntryBlock(db: Database.Database, record: StrategyRecord, now = Date.now()): string | null {
  const retry = readManagedState(db, record.id)?.preparationRecovery;
  return retry && (retry.scope !== preparationIdentity(db, record) || retry.review) ? PREPARATION_REVIEW
    : retry && now < retry.nextAt ? PREPARATION_WAIT : null;
}
export function failedPreparation(db: Database.Database, record: StrategyRecord, attempt: string, now: number, expectedScope = preparationIdentity(db, record)): boolean | null {
  const state = readManagedState(db, record.id);
  if (!state || state.phase !== 'OPENING' || state.stopIntent || state.exitRequested) return null;
  const old = state.preparationRecovery, scope = preparationIdentity(db, record);
  if (scope !== expectedScope || record.status !== 'RUNNING') return null;
  if (old && (old.attempt === attempt || old.review)) return old.review;
  if (old && old.scope !== scope) throw new Error('managed_entry_preparation_scope_changed');
  const failures = (old?.failures ?? 0) + 1;
  writeManagedState(db, record.id, { ...state, preparationRecovery: { scope, attempt, failures,
    nextAt: now + 2000 * 2 ** Math.min(failures, 4), review: failures >= 5 } });
  return failures >= 5;
}
export function clearPreparationRecovery(db: Database.Database, record: StrategyRecord): void {
  const state = readManagedState(db, record.id);
  if (!state?.preparationRecovery || state.preparationRecovery.review) return;
  if (state.preparationRecovery.scope !== preparationIdentity(db, record)) throw new Error('managed_entry_preparation_scope_changed');
  writeManagedState(db, record.id, { ...state, preparationRecovery: undefined });
}
