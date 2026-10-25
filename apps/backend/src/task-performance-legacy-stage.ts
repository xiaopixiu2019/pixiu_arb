import { Decimal } from 'decimal.js';
import type { TaskPerformance } from '@gate-crossex/shared-types';
import { taskPnl, pnlComponent, type PnlEntry } from './task-performance-model.js';
import { directOwner, entry, fundingLinks, fundingOwner, kindOf, priceCoverage, proofs, type Proof } from './task-performance-report.js';
import { boundedTaskEstimate } from './task-performance-tolerance.js';
import { feeSummary } from './transaction-fee-report.js';
import type { TransactionFeeStore } from './transaction-fee-store.js';
import type { FeeEpoch } from './transaction-fee-model.js';
import type { PnlBook } from './task-performance-store.js';
import { coveredThrough, type CoverageRange } from './task-performance-coverage.js';

export interface LegacyStage {
  base: TaskPerformance; before: string[]; after: string[]; feeValid: boolean;
  from: number; to: number; closed: boolean; estimate?: TaskPerformance['estimate']; estimatedAmount?: string | null;
}
export function legacyContext(fees: TransactionFeeStore, key: string, profile: string, now: number, rows: PnlBook[]) {
  const all = proofs(fees, key, profile, now), trades = fees.trades(key), links = fundingLinks(rows, all);
  const feeBooks = new Map(fees.book(key).map(r => [r.id, r])), valued = new Map<string, PnlEntry>();
  const value = (row: PnlBook) => {
    let v = valued.get(row.id); if (!v) { v = entry(row, fees, key, feeBooks); valued.set(row.id, v); } return v;
  };
  const assigned = new Map<string, PnlBook[]>(), ambiguous: PnlBook[] = [];
  for (const row of rows.filter(r => !['TRANSFER_IN', 'TRANSFER_OUT'].includes(r.statement_type))) {
    const owner = row.statement_type === 'FUNDING_FEE' ? fundingOwner(row, all, trades, links) : directOwner(row, all);
    if (owner.length !== 1) ambiguous.push(row);
    else { const list = assigned.get(owner[0].task.id) ?? []; list.push(row); assigned.set(owner[0].task.id, list); }
  }
  return { all, assigned, ambiguous, value, feeTasks: feeSummary(fees, key, now, true).tasks };
}
export function legacyStage(p: Proof, context: ReturnType<typeof legacyContext>, at: number): LegacyStage {
  const { assigned, ambiguous, value, feeTasks } = context;
  const own = assigned.get(p.task.id) ?? [], after: string[] = [], fee = feeTasks.find(f => f.taskId === p.task.id)?.metric;
  const feeTotal = pnlComponent(own.filter(r => r.statement_type === 'TRADING_FEE').map(value)).amount;
  const feeValid = fee?.status === 'ready' && fee.amount !== null && feeTotal !== null && new Decimal(fee.amount).negated().eq(feeTotal);
  if (!priceCoverage(p, own)) after.push('price_evidence_pending');
  if (p.symbols.some(s => !own.some(r => r.statement_type === 'FUNDING_FEE' && r.symbol === s))) after.push('funding_evidence_pending');
  const unallocated = ambiguous.filter(r => Number(r.create_time) >= p.from && Number(r.create_time) <= p.to + 60000 && (!r.symbol || p.symbols.includes(r.symbol)));
  if (unallocated.length) after.push('unallocated_account_cost');
  const positionKey = (r: PnlBook) => `${r.symbol}:${r.business_id.slice(0, r.business_id.lastIndexOf('_'))}`;
  const keys = new Set(own.filter(r => r.statement_type === 'FUNDING_FEE' && r.business_id.includes('_')).map(positionKey));
  const late = ambiguous.filter(r => r.statement_type === 'FUNDING_FEE' && keys.has(positionKey(r)));
  if (late.length) after.push('late_funding_attribution_pending');
  if (own.some(r => !kindOf(r.statement_type))) after.push('unclassified_ledger');
  const unresolved = [...new Map([...unallocated, ...late].map(r => [r.id, r])).values()];
  const base = taskPnl(p.task.id, own.map(value), [], true, at);
  const estimated = boundedTaskEstimate({ ...base, status: 'pending', amount: null,
    reasons: [...new Set([...p.reasons, ...after, ...base.reasons])] }, unresolved, new Set(late.map(r => r.id)), value);
  return { base, before: p.reasons, after, feeValid, from: p.from, to: p.to, closed: p.closed,
    ...(estimated.estimate ? { estimate: estimated.estimate, estimatedAmount: estimated.amount } : {}) };
}
export function renderLegacy(stage: LegacyStage, ranges: readonly CoverageRange[], epoch: FeeEpoch | null, now: number, failure: string | null): TaskPerformance {
  const to = stage.closed ? stage.to : now, reasons = [...stage.before];
  if (failure) reasons.push(failure);
  if (!Number.isFinite(stage.from) || !Number.isFinite(to) || coveredThrough(ranges, stage.from) < to + 60000) reasons.push('history_incomplete');
  if (now < to + 60000) reasons.push('settlement_pending');
  if (!stage.feeValid || !epoch || epoch.book_reason || epoch.trade_reason || epoch.checked_at === null || now - epoch.checked_at > 120000) reasons.push('fee_evidence_pending');
  const unique = [...new Set([...reasons, ...stage.after, ...stage.base.reasons])];
  const components = Object.fromEntries((['price', 'funding', 'fees', 'other'] as const).map(kind => [kind,
    stage.base[kind].count === 0 && (unique.length || !stage.closed) ? { ...stage.base[kind], amount: null } : stage.base[kind]]));
  const estimated = stage.closed && unique.length > 0 && unique.every(r => ['unallocated_account_cost', 'late_funding_attribution_pending'].includes(r)) && !!stage.estimate;
  return { ...stage.base, ...components, amount: estimated ? stage.estimatedAmount! : stage.closed && !unique.length ? stage.base.amount : null,
    status: !stage.closed ? 'open' : estimated ? 'estimated' : unique.length ? 'pending' : 'settled', reasons: unique,
    ...(estimated ? { estimate: stage.estimate } : {}) };
}
