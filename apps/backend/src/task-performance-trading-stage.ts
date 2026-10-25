import { Decimal } from 'decimal.js';
import type { TaskTradingResult } from '@gate-crossex/shared-types';
import { decimal, type TradingGroup } from './task-trading-groups.js';
import { adoptedBaseline, baseResult, unrealized, type TradingValuation } from './task-trading-report.js';
import { tradingCash, type TradingLedger } from './task-trading-ledger.js';
import type { TransactionFeeStore } from './transaction-fee-store.js';
import { coveredThrough, type CoverageRange } from './task-performance-coverage.js';

export interface TradingStage {
  base: TaskTradingResult; tail: string; from: number; to: number; closed: boolean;
  quantities: Record<string, string>; latestFillAt: number; baseline: string | null;
  cash: ReturnType<typeof tradingCash> | null; fundingNotBooked: boolean;
}
export function tradingStage(g: TradingGroup, ledger: TradingLedger, fees: TransactionFeeStore, key: string): TradingStage {
  return { base: baseResult(g), tail: g.tail.id, from: g.from, to: g.to, closed: g.closed, quantities: g.quantities,
    latestFillAt: g.latestFillAt, baseline: g.issues.length ? null : adoptedBaseline(g, fees, key),
    cash: g.issues.length ? null : tradingCash(g, ledger, fees, key),
    fundingNotBooked: !g.executionOnly && g.symbols.some(symbol => !(ledger.rows.get(g.id) ?? []).some(r => r.symbol === symbol && r.statement_type === 'FUNDING_FEE')) };
}
export function renderTrading(stage: TradingStage, ranges: readonly CoverageRange[], fees: TransactionFeeStore, key: string,
  profile: string, now: number, valuation?: TradingValuation): Record<string, TaskTradingResult> {
  const results: Record<string, TaskTradingResult> = {};
  results[stage.tail] = stage.cash ? calculate(stage, ranges, fees, key, profile, now, valuation) : stage.base;
  for (const id of stage.base.members.filter(id => id !== stage.tail)) results[id] = { ...stage.base, status: 'transferred', transferredTo: stage.tail };
  return results;
}
function calculate(s: TradingStage, ranges: readonly CoverageRange[], fees: TransactionFeeStore, key: string,
  profile: string, now: number, valuation?: TradingValuation): TaskTradingResult {
  const cash = s.cash!, through = coveredThrough(ranges, s.from), floating = unrealized(s, fees, key, profile, now, valuation);
  const reasons = [...cash.issues];
  if (through < (s.closed ? s.to : s.latestFillAt)) reasons.push('history_incomplete');
  if (floating === null) reasons.push('valuation_pending');
  if (s.baseline === null) reasons.push('adopted_basis_unverified');
  const pendingSettlement = s.closed && through < s.to + 60000;
  if (cash.provisional) reasons.push('provisional_trade_cashflows');
  if (pendingSettlement) reasons.push('settlement_pending');
  if (cash.error) reasons.push('late_funding_attribution_pending');
  if (s.fundingNotBooked) reasons.push('funding_not_booked');
  const blockers = reasons.filter(r => !['provisional_trade_cashflows', 'settlement_pending', 'late_funding_attribution_pending', 'funding_not_booked'].includes(r));
  const amount = !blockers.length && cash.subtotal !== null ? new Decimal(cash.subtotal).plus(cash.adjustment).plus(floating!).minus(s.baseline!).toFixed() : null;
  const pct = amount !== null && cash.error !== null && !new Decimal(amount).isZero() ? new Decimal(cash.error).div(new Decimal(amount).abs()).mul(100).toFixed() : null;
  const active = Object.values(s.quantities).some(q => !decimal(q)?.isZero());
  return { ...s.base, amount, confirmed: cash.confirmed, unrealized: floating, adjustment: cash.adjustment, maxError: cash.error, maxErrorPct: pct,
    provisionalCashflows: cash.provisionalCashflows, adoptionBaseline: s.baseline, components: cash.components,
    status: amount === null ? 'partial' : cash.estimated || active || pendingSettlement || s.fundingNotBooked ? 'estimated' : 'confirmed', reasons,
    ledgerThrough: through > s.from ? through : null, valuationAt: active ? valuation?.at ?? null : null,
    checkedAt: active ? valuation?.at ?? null : through > s.from ? through : null, stale: !s.closed && now - through > 120000 };
}
