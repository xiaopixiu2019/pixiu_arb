import { Decimal } from 'decimal.js';
import type { TaskTradingResult } from '@gate-crossex/shared-types';
import { TaskPerformanceStore } from './task-performance-store.js';
import { TransactionFeeStore } from './transaction-fee-store.js';
import { decimal, tradingGroups, type TradingGroup } from './task-trading-groups.js';
import { pnlComponent } from './task-performance-model.js';
import { tradingCash, tradingLedger } from './task-trading-ledger.js';
export interface TradingValuation {
  profileId: string; at: number;
  positions: Array<{ symbol: string; quantity: string; unrealizedPnl: string }>;
}
function unrealized(g: TradingGroup, fees: TransactionFeeStore, key: string, profile: string, now: number, valuation?: TradingValuation): string | null {
  const held = Object.entries(g.quantities).filter(([, q]) => !decimal(q)?.isZero());
  if (!held.length) return '0';
  if (!valuation || valuation.profileId !== profile || valuation.at > now + 2000 || now - valuation.at > 15000 || valuation.at < g.latestFillAt) return null;
  let total = new Decimal(0);
  for (const [symbol, quantity] of held) {
    const rows = valuation.positions.filter(p => p.symbol === symbol && !decimal(p.quantity)?.isZero());
    if (rows.length !== 1 || !decimal(rows[0].quantity)?.eq(quantity) || !decimal(rows[0].unrealizedPnl)) return null;
    const rate = fees.rateAt(key, symbol.split('_').at(-1)!, valuation.at);
    if (!decimal(rate)?.gt(0)) return null;
    total = total.plus(new Decimal(rows[0].unrealizedPnl).mul(rate!));
  }
  return total.toFixed();
}
function adoptedBaseline(g: TradingGroup, fees: TransactionFeeStore, key: string): string | null {
  if (!g.external) return '0';
  const root = g.tasks.find(t => t.id === g.id)!, at = Date.parse(root.state.adoptedAt ?? '');
  if (!Number.isFinite(at) || !root.state.adoptionBaseline?.length) return null;
  let total = new Decimal(0);
  for (const b of root.state.adoptionBaseline) {
    const rate = fees.rateAt(key, b.symbol.split('_').at(-1)!, at);
    if (!decimal(b.unrealizedPnl) || !decimal(rate)?.gt(0)) return null;
    total = total.plus(new Decimal(b.unrealizedPnl!).mul(rate!));
  }
  return total.toFixed();
}
function baseResult(g: TradingGroup): TaskTradingResult {
  return { amount: null, confirmed: null, unrealized: null, status: 'unavailable', scope: g.executionOnly ? 'execution' : g.external ? 'since_adoption' : g.tasks.length > 1 ? 'group' : 'task',
    groupId: g.id, members: g.tasks.map(t => t.id), reasons: [...g.issues], checkedAt: null, ledgerThrough: null, valuationAt: null,
    stale: false, adjustment: '0', maxError: null, maxErrorPct: null };
}
export function taskTradingReport(store: TaskPerformanceStore, key: string, profile: string, now: number, valuation?: TradingValuation) {
  const fees = new TransactionFeeStore(store.db), groups = tradingGroups(fees, key, profile, now), ledger = tradingLedger(store.rows(key), groups, fees, key);
  const results: Record<string, TaskTradingResult> = {};
  for (const g of groups) {
    let result = baseResult(g);
    if (!g.issues.length) result = calculate(g, store, fees, key, profile, now, valuation, ledger);
    results[g.tail.id] = result;
    for (const task of g.tasks.filter(t => t.id !== g.tail.id)) results[task.id] = { ...baseResult(g), status: 'transferred', transferredTo: g.tail.id };
  }
  return { results, accountCosts: ledger.accountCosts, unresolvedCashflows: pnlComponent(ledger.unassigned.map(ledger.value)) };
}
function calculate(g: TradingGroup, store: TaskPerformanceStore, fees: TransactionFeeStore, key: string, profile: string, now: number,
  valuation: TradingValuation | undefined, ledger: ReturnType<typeof tradingLedger>): TaskTradingResult {
  const result = baseResult(g), cash = tradingCash(g, ledger, fees, key), through = store.through(key, g.from);
  const floating = unrealized(g, fees, key, profile, now, valuation), baseline = adoptedBaseline(g, fees, key);
  const reasons = [...cash.issues];
  if (through < (g.closed ? g.to : g.latestFillAt)) reasons.push('history_incomplete');
  if (floating === null) reasons.push('valuation_pending');
  if (baseline === null) reasons.push('adopted_basis_unverified');
  const pendingSettlement = g.closed && through < g.to + 60000;
  if (cash.provisional) reasons.push('provisional_trade_cashflows');
  if (pendingSettlement) reasons.push('settlement_pending');
  if (cash.error) reasons.push('late_funding_attribution_pending');
  const fundingNotBooked = !g.executionOnly && g.symbols.some(symbol => !(ledger.rows.get(g.id) ?? []).some(r => r.symbol === symbol && r.statement_type === 'FUNDING_FEE'));
  if (fundingNotBooked) reasons.push('funding_not_booked');
  const blockers = reasons.filter(r => !['provisional_trade_cashflows', 'settlement_pending', 'late_funding_attribution_pending', 'funding_not_booked'].includes(r));
  const amount = !blockers.length && cash.subtotal !== null ? new Decimal(cash.subtotal).plus(cash.adjustment).plus(floating!).minus(baseline!).toFixed() : null;
  const pct = amount !== null && cash.error !== null && !new Decimal(amount).isZero() ? new Decimal(cash.error).div(new Decimal(amount).abs()).mul(100).toFixed() : null;
  const active = Object.values(g.quantities).some(q => !decimal(q)?.isZero());
  return { ...result, amount, confirmed: cash.confirmed, unrealized: floating, adjustment: cash.adjustment, maxError: cash.error, maxErrorPct: pct,
    provisionalCashflows: cash.provisionalCashflows, adoptionBaseline: baseline, components: cash.components,
    status: amount === null ? 'partial' : cash.estimated || active || pendingSettlement || fundingNotBooked ? 'estimated' : 'confirmed', reasons,
    ledgerThrough: through > g.from ? through : null, valuationAt: active ? valuation?.at ?? null : null,
    checkedAt: active ? valuation?.at ?? null : through > g.from ? through : null, stale: !g.closed && now - through > 120000 };
}
