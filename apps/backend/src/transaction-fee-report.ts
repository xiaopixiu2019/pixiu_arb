import { Decimal } from 'decimal.js';
import type { FeeDetail, FeeEvidence, FeeFill, FeeMetric, FeeSummary } from '@gate-crossex/shared-types';
import { dayStart } from './performance-math.js';
import { resolveFeeBooks } from './transaction-fee-identity.js';
import { pendingFeeEvidence, type PendingFeeEvidence } from './transaction-fee-coverage.js';
import { feeExpenses, feeMetric, feeOrderKey, type FeeBookRow, type FeeEpoch } from './transaction-fee-model.js';
import type { TransactionFeeStore } from './transaction-fee-store.js';

export function emptyFeeSummary(profileId: string | null, reason: string): FeeSummary {
  const missing: FeeMetric = { amount: null, status: 'unavailable', pending: 0, reason };
  return { profileId, currency: 'USDT', since: null, checkedAt: null, total: missing, today: missing, yesterday: missing, assigned: missing, unassigned: missing, tasks: [] };
}
function context(store: TransactionFeeStore, key: string, now: number, historyOnly = false) {
  const actual = store.epoch(key)!;
  const epoch = historyOnly ? { ...actual, checked_at: now, book_reason: null, trade_reason: null } : actual;
  const trades = store.trades(key), retained = store.bindings(key);
  const rows = resolveFeeBooks(store.book(key), retained, trades);
  const bindings = new Map(retained.map((b) => [feeOrderKey(b.venue, b.order_id), b]));
  const reason = epoch.book_reason ?? (epoch.checked_at === null ? 'fee_collecting' : now - epoch.checked_at > 120_000 ? 'fee_stale' : null);
  return { epoch, rows, trades, bindings, reason, pending: pendingFeeEvidence(rows, trades, store.coverageOrders(key, epoch.profile_id)) };
}
type Context = ReturnType<typeof context>;
function taskMetric(c: Context, id: string, startedAt: number): FeeMetric {
  const rows = c.rows.filter((r) => c.bindings.get(feeOrderKey(r.venue, r.order_id))?.task_id === id);
  const pending = c.pending.filter((o) => o.taskId === id).length;
  return feeMetric(rows, c.reason ?? c.epoch.trade_reason ?? (startedAt < c.epoch.started_at ? 'fee_history_partial' : null), pending);
}
function dated(rows: FeeBookRow[], epoch: FeeEpoch, reason: string | null, from: number, to: number, closed = false): FeeMetric {
  if (epoch.checked_at === null || epoch.covered_to < from) return feeMetric([], 'fee_collecting');
  return feeMetric(rows.filter((r) => r.at >= from && r.at < to), reason ?? (epoch.started_at > from || (closed && epoch.covered_to < to) ? 'fee_partial_day' : null));
}
export function feeSummary(store: TransactionFeeStore, key: string, now: number, historyOnly = false): FeeSummary {
  const c = context(store, key, now, historyOnly), day = dayStart(now);
  const taskStarts = new Map(store.tasks(c.epoch.profile_id).map((t) => [t.id, Date.parse(t.created_at)]));
  for (const b of c.bindings.values()) taskStarts.set(b.task_id, b.task_started_at);
  const assigned = c.rows.filter((r) => c.bindings.has(feeOrderKey(r.venue, r.order_id)));
  const unassigned = c.rows.filter((r) => !c.bindings.has(feeOrderKey(r.venue, r.order_id)));
  const windowPending = c.pending.filter((o) => o.at >= c.epoch.started_at);
  return { profileId: c.epoch.profile_id, currency: 'USDT', since: c.epoch.started_at, checkedAt: c.epoch.checked_at,
    total: feeMetric(c.rows, c.reason, windowPending.length), today: dated(c.rows, c.epoch, c.reason ?? (windowPending.some((o) => o.at >= day && o.fromAt <= now) ? 'fee_evidence_pending' : null), day, now + 1), yesterday: dated(c.rows, c.epoch, c.reason ?? (windowPending.some((o) => o.at >= day - 86_400_000 && o.fromAt < day) ? 'fee_evidence_pending' : null), day - 86_400_000, day, true),
    assigned: feeMetric(assigned, c.reason, windowPending.length), unassigned: feeMetric(unassigned, c.reason),
    tasks: [...taskStarts].map(([taskId, at]) => ({ taskId, metric: taskMetric(c, taskId, at), count: c.rows.filter((r) => c.bindings.get(feeOrderKey(r.venue, r.order_id))?.task_id === taskId).length })) };
}
function evidence(r: FeeBookRow, c: Context): FeeEvidence {
  const binding = c.bindings.get(feeOrderKey(r.venue, r.order_id));
  return { id: r.id, at: r.at, venue: r.venue, orderId: r.order_id, taskId: binding?.task_id ?? null, coin: r.coin, native: r.cost,
    converted: r.conflict ? null : r.usd, rate: r.rate, phase: binding?.phase ?? 'unknown',
    reason: r.conflict ? 'fee_conflicting_evidence' : r.usd === null ? 'fee_missing_fx' : null };
}
function venueTotals(rows: FeeBookRow[], pending: PendingFeeEvidence[]) {
  const keys = [...new Set([...rows.map((r) => JSON.stringify([r.venue, r.coin])), ...pending.map((o) => JSON.stringify([o.venue, o.coin]))])];
  return keys.map((key) => {
    const [venue, coin] = JSON.parse(key) as string[], selected = rows.filter((r) => r.venue === venue && r.coin === coin);
    const metric = feeMetric(selected, null, pending.filter((o) => o.venue === venue && o.coin === coin).length);
    const trusted = selected.filter((r) => !r.conflict);
    return { venue, coin, native: trusted.length ? trusted.reduce((sum, r) => sum.plus(r.cost), new Decimal(0)).toFixed() : null, converted: metric.amount, count: selected.length, pending: metric.pending };
  });
}
export function feeDetail(store: TransactionFeeStore, key: string, now: number, taskId: string | null, page: number): FeeDetail | null {
  const c = context(store, key, now), summary = feeSummary(store, key, now);
  const task = taskId ? summary.tasks.find((t) => t.taskId === taskId) : null;
  if (taskId && !task) return null;
  const rows = c.rows.filter((r) => !taskId || c.bindings.get(feeOrderKey(r.venue, r.order_id))?.task_id === taskId);
  const fills: FeeFill[] = c.trades.filter((t) => !taskId || c.bindings.get(feeOrderKey(t.exchange_type, t.order_id))?.task_id === taskId).map((t) => ({
    id: t.transaction_id, at: Number(t.create_time), orderId: t.order_id, venue: t.exchange_type, symbol: t.symbol, quantity: t.qty,
    fee: t.fee, coin: t.fee_coin, role: t.match_role, phase: c.bindings.get(feeOrderKey(t.exchange_type, t.order_id))?.phase ?? 'unknown',
  }));
  const offset = (page - 1) * 25;
  const confirmed = (task?.metric ?? summary.total).amount !== null;
  return { profileId: c.epoch.profile_id, taskId, since: c.epoch.started_at, checkedAt: c.epoch.checked_at, metric: task?.metric ?? summary.total,
    entry: confirmed ? feeExpenses(rows, 'entry', c.bindings) : null, exit: confirmed ? feeExpenses(rows, 'exit', c.bindings) : null, adjustment: confirmed ? feeExpenses(rows, 'adjustment', c.bindings) : null,
    unknown: confirmed ? feeExpenses(rows, 'unknown', c.bindings) : null, rebates: confirmed ? feeExpenses(rows, 'rebates', c.bindings) : null, venues: venueTotals(rows, c.pending.filter((o) => !taskId || o.taskId === taskId)),
    entries: [...rows].reverse().slice(offset, offset + 25).map((r) => evidence(r, c)), fills: [...fills].reverse().slice(offset, offset + 25),
    totalEntries: rows.length, totalFills: fills.length, page, pageSize: 25 };
}
