import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { Decimal } from 'decimal.js';
import type { ExecutionOrder, StrategyRecord } from './trading-runtime.js';
import { managedLegs } from './managed-legs.js';
import { readManagedState } from './managed-position-store.js';

export const ROUTER_REVIEW = 'managed_router_entry_review';
export const ROUTER_WAIT = 'managed_router_entry_backoff';
interface Evidence { fingerprint: string; kind: string; observed_at: number; working_since: number | null }
interface Retry { scope: string; failures: number; next_at: number; review: number; last_sequence: number }
const zero = (value: unknown): boolean => typeof value === 'string' && /^0+(?:\.0+)?$/.test(value);
export function routerFailure(reason: string | null): boolean {
  if (reason === 'NOT_BEST_ACCOUNT_ROUTER') return true;
  try { return JSON.parse(reason ?? 'null')?.label === 'NOT_BEST_ACCOUNT_ROUTER'; } catch { return false; }
}
function fingerprint(order: ExecutionOrder): string {
  return createHash('sha256').update(JSON.stringify([order.id, order.remoteOrderId, order.clientOrderId,
    order.strategyId, order.strategyLeg, order.symbol, order.side, order.type, order.timeInForce,
    order.quantity, order.reduceOnly, order.state, order.executedQuantity, order.failureReason])).digest('hex');
}
function evidence(db: Database.Database, order: ExecutionOrder): Evidence | undefined {
  const row = db.prepare('SELECT * FROM router_order_evidence WHERE order_id=?').get(order.id) as Evidence | undefined;
  return row?.fingerprint === fingerprint(order) ? row : undefined;
}
/** Called only after transport identity matching, before notifying any order consumer. */
export function recordRouterEvidence(db: Database.Database, order: ExecutionOrder, raw: Record<string, unknown>, now = Date.now()): void {
  if (!order.strategyId || order.type !== 'LIMIT' || order.timeInForce !== 'POC' || order.reduceOnly) return;
  if (raw.order_id !== order.remoteOrderId || raw.text !== undefined && raw.text !== order.clientOrderId
    || raw.symbol !== undefined && raw.symbol !== order.symbol || raw.side !== undefined && raw.side !== order.side) return;
  const previous = db.prepare('SELECT * FROM router_order_evidence WHERE order_id=?').get(order.id) as Evidence | undefined;
  const working = raw.state === 'OPEN' && order.state === 'OPEN' && zero(raw.executed_qty) && !order.failureReason;
  const workingSince = working ? previous?.working_since ?? now : previous?.working_since ?? null;
  const remoteAt = typeof raw.update_time === 'string' && /^\d+$/.test(raw.update_time) ? Number(raw.update_time) : NaN;
  const kind = raw.state === 'FAIL' && order.state === 'FAIL' && zero(raw.executed_qty) && zero(order.executedQuantity)
    && routerFailure(typeof raw.reason === 'string' ? raw.reason : null) ? 'router'
    : raw.state === 'FILLED' && order.state === 'FILLED' && new Decimal(order.executedQuantity).gt(0) && !order.failureReason ? 'success'
    : working && workingSince !== null && now - workingSince >= 2000 && remoteAt >= workingSince + 2000
      && remoteAt <= now + 2000 && now - remoteAt <= 5000 ? 'success'
    : raw.state === 'CANCELLED' && order.state === 'CANCELLED' && zero(raw.executed_qty) && workingSince !== null
      && (!order.failureReason || order.failureReason.toLowerCase() === 'cancelled_by_user') ? 'success' : 'unverified';
  db.prepare(`INSERT INTO router_order_evidence VALUES (?,?,?,?,?,?) ON CONFLICT(order_id) DO UPDATE SET
    remote_id=excluded.remote_id,fingerprint=excluded.fingerprint,kind=excluded.kind,observed_at=excluded.observed_at,working_since=excluded.working_since`)
    .run(order.id, order.remoteOrderId, fingerprint(order), kind, now, workingSince);
}
export function recordNoDispatch(db: Database.Database, order: ExecutionOrder): void {
  if (order.state !== 'FAIL' || order.remoteOrderId || !zero(order.executedQuantity) || order.failureReason !== 'ORDER_NOT_DISPATCHED') return;
  db.prepare('INSERT OR REPLACE INTO router_order_evidence VALUES (?,?,?,?,?,NULL)')
    .run(order.id, null, fingerprint(order), 'not_dispatched', Date.now());
}
export function provenRouterHistory(db: Database.Database, order: ExecutionOrder): boolean {
  const kind = evidence(db, order)?.kind;
  return zero(order.executedQuantity)
    && (order.state === 'FAIL' && ['router', 'not_dispatched'].includes(kind ?? '') || order.state === 'CANCELLED' && kind === 'success')
    && !db.prepare('SELECT 1 FROM execution_fills WHERE order_id=? LIMIT 1').get(order.id);
}
export function routerOwner(db: Database.Database, record: StrategyRecord, order: ExecutionOrder): boolean {
  const state = readManagedState(db, record.id), legs = managedLegs(record.config);
  const index = legs.findIndex(l => l.symbol === order.symbol && l.side === order.side);
  const claims = db.prepare('SELECT account_id,symbol FROM managed_position_claims WHERE strategy_id=?').all(record.id) as Array<{account_id:string;symbol:string}>;
  const original = db.prepare('SELECT scope FROM router_order_context WHERE order_id=?').get(order.id) as {scope:string} | undefined;
  return original?.scope === scope(record) && record.config.executionMethod === 'MAKER_TAKER' && !!record.config.management && !record.config.reduceOnly
    && order.strategyId === record.id && order.strategyLeg === (index === 0 ? 'left' : 'right') && index >= 0
    && (record.config.makerLeg ?? 'left') === order.strategyLeg && order.type === 'LIMIT' && order.timeInForce === 'POC' && !order.reduceOnly
    && !!state && ['OPENING','RISK_PAUSED'].includes(state.phase) && !state.stopIntent && !state.exitRequested
    && !state.marginBatch && !state.protectionIncident && !state.positionSettlementSince && !state.pauseAfterProtection
    && claims.length === 2 && legs.every(l => claims.some(c => c.symbol === l.symbol && c.account_id === record.accountProfileId));
}
export function isolatedRouterRejection(db: Database.Database, record: StrategyRecord, order: ExecutionOrder, account: string | null): boolean {
  return record.status === 'RUNNING' && record.accountProfileId === account && readManagedState(db, record.id)?.phase === 'OPENING'
    && routerOwner(db, record, order) && evidence(db, order)?.kind === 'router' && provenRouterHistory(db, order);
}
function scope(record: StrategyRecord): string { return JSON.stringify([record.accountProfileId, record.config]); }
export function captureRouterContext(db: Database.Database, record: StrategyRecord, orderId: string): void {
  db.prepare('INSERT INTO router_order_context VALUES (?,?)').run(orderId, scope(record));
}
export function routerRetry(db: Database.Database, id: string): Retry | undefined {
  return db.prepare('SELECT * FROM router_entry_retry WHERE strategy_id=?').get(id) as Retry | undefined;
}
/** Durable idempotent outcome processing; a late old success never resets a newer failure. */
export function consumeRouterOutcome(db: Database.Database, record: StrategyRecord, order: ExecutionOrder): void {
  const proof = evidence(db, order);
  if (!routerOwner(db, record, order) || !proof || !['router','success'].includes(proof.kind)) return;
  if (proof.kind === 'router' && !provenRouterHistory(db, order)) return;
  db.transaction(() => {
    const inserted = db.prepare('INSERT OR IGNORE INTO router_retry_events VALUES (?,?,?)').run(order.id, proof.kind, record.id);
    if (!inserted.changes) return;
    const sequence = (db.prepare('SELECT rowid n FROM execution_orders WHERE id=?').get(order.id) as {n:number}).n;
    const old = routerRetry(db, record.id);
    if (old && (old.review || old.scope !== scope(record))) return;
    if (old && sequence < old.last_sequence && proof.kind === 'success') return;
    const failures = proof.kind === 'router' ? (old?.failures ?? 0) + 1 : 0;
    const next = failures ? proof.observed_at + 2000 * 2 ** Math.min(failures, 4) : 0;
    db.prepare(`INSERT OR REPLACE INTO router_entry_retry VALUES (?,?,?,?,?,?)`)
      .run(record.id, scope(record), failures, Math.max(next, proof.kind === 'router' ? old?.next_at ?? 0 : 0), failures >= 5 ? 1 : 0, Math.max(sequence,old?.last_sequence ?? 0));
  })();
}
export function routerEntryBlock(db: Database.Database, record: StrategyRecord, now = Date.now()): string | null {
  const retry = routerRetry(db, record.id);
  return retry && (retry.scope !== scope(record) || retry.review) ? ROUTER_REVIEW
    : retry && retry.next_at > now ? ROUTER_WAIT : null;
}
export function resetRouterRetry(db: Database.Database, record: StrategyRecord): void {
  db.prepare('UPDATE router_entry_retry SET scope=?,failures=0,next_at=0,review=0 WHERE strategy_id=?').run(scope(record), record.id);
}
