import { Decimal } from 'decimal.js';
import type { TaskPerformance } from '@gate-crossex/shared-types';
import { pnlComponent, type PnlEntry } from './task-performance-model.js';
import type { PnlBook } from './task-performance-store.js';

const tolerated = new Set(['unallocated_account_cost', 'late_funding_attribution_pending']);
const knownAccountCosts = new Set(['INTEREST_ISOLATED', 'LIQUIDATION_FEE', 'BANKRUPT_COMPENSATION']);
/** Only complete currency exchanges are netted. Unrelated debits/credits cannot cancel uncertainty. */
function conversionPair(rows: PnlBook[]): boolean {
  if (rows.length !== 2 || rows.some(r => r.symbol || !r.business_id || r.statement_type !== 'KRAKEN_CONVERSION')) return false;
  const usd = rows.find(r => r.coin === 'USD' && r.exchange_type === 'KRAKEN');
  const usdt = rows.find(r => r.coin === 'USDT' && r.exchange_type === 'CROSSEX');
  return !!usd && !!usdt && usd.business_id === usdt.business_id && usd.create_time === usdt.create_time
    && new Decimal(usd.change).mul(usdt.change).lt(0);
}

export function boundedTaskEstimate(task: TaskPerformance, unresolved: PnlBook[], lateIds: Set<string>,
  value: (row: PnlBook) => PnlEntry): TaskPerformance {
  if (task.status !== 'pending' || !task.reasons.length || task.reasons.some(r => !tolerated.has(r)) || !unresolved.length) return task;
  const groups = new Map<string, PnlBook[]>();
  for (const row of unresolved) {
    const key = row.statement_type === 'KRAKEN_CONVERSION' ? `conversion:${row.business_id}` : `bill:${row.id}`;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  let adjustment = new Decimal(0), maxError = new Decimal('0.005');
  for (const rows of groups.values()) {
    const late = rows.length === 1 && rows[0].statement_type === 'FUNDING_FEE' && lateIds.has(rows[0].id);
    const accountCost = rows.length === 1 && knownAccountCosts.has(rows[0].statement_type);
    if (!late && !accountCost && !conversionPair(rows)) return task;
    const amount = pnlComponent(rows.map(value)).amount;
    if (amount === null) return task;
    adjustment = adjustment.plus(amount);
    maxError = maxError.plus(new Decimal(amount).abs());
  }
  const subtotal = (['price', 'funding', 'fees', 'other'] as const).reduce((sum, key) => {
    const component = task[key];
    return sum.plus(component.amount ?? (component.count === 0 ? '0' : 'NaN'));
  }, new Decimal(0));
  if (!subtotal.isFinite()) return task;
  const net = subtotal.plus(adjustment);
  if (net.isZero() || maxError.gt(net.abs().mul('0.05'))) return task;
  return { ...task, amount: net.toFixed(), status: 'estimated',
    estimate: { adjustment: adjustment.toFixed(), maxError: maxError.toFixed(),
      maxErrorPct: maxError.div(net.abs()).mul(100).toFixed(), tolerancePct: '5' } };
}
