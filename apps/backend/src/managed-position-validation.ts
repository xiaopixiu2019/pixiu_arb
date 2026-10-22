import { Decimal } from 'decimal.js';
import { freshManagedQuote, type ManagedLeg } from './managed-position-model.js';

export interface ManagedSizeConstraints { min_size: string | null; lot_size: string | null; min_notional: string | null }
export interface ManagedSizeIssue {
  code: 'managed_constraints_unavailable' | 'managed_market_data_unavailable' | 'managed_order_invalid_quantity'
    | 'managed_order_below_minimum_size' | 'managed_order_invalid_lot_size' | 'managed_order_below_minimum_notional';
  symbol: string; quantity: string; minimum?: string; step?: string; notional?: string;
}
type Quote = Parameters<typeof freshManagedQuote>[0];

function ruleDecimal(value: string | null, fallback: string): Decimal {
  try { return new Decimal(value ?? fallback); } catch { return new Decimal(NaN); }
}

export function managedConstraintsValid(constraints: ManagedSizeConstraints): boolean {
  const minimum = ruleDecimal(constraints.min_size, 'NaN'), step = ruleDecimal(constraints.lot_size, 'NaN');
  const notional = ruleDecimal(constraints.min_notional, '0');
  return minimum.isFinite() && minimum.gte(0) && step.isFinite() && step.gt(0) && notional.isFinite() && notional.gte(0);
}

/** Missing prices are unavailable evidence, never an instruction to enlarge a reduction. */
export function managedOrderSizeIssue(leg: ManagedLeg, quantity: Decimal, constraints: ManagedSizeConstraints, quote: Quote, now: number): ManagedSizeIssue | null {
  const detail = { symbol: leg.symbol, quantity: quantity.toString() };
  if (!quantity.isFinite() || quantity.lte(0)) return { ...detail, code: 'managed_order_invalid_quantity' };
  if (!managedConstraintsValid(constraints)) {
    return { ...detail, code: 'managed_constraints_unavailable' };
  }
  const minimum = new Decimal(constraints.min_size!), step = new Decimal(constraints.lot_size!);
  const minimumNotional = new Decimal(constraints.min_notional ?? '0');
  if (quantity.lt(minimum)) return { ...detail, code: 'managed_order_below_minimum_size', minimum: minimum.toString() };
  if (!quantity.mod(step).isZero()) return { ...detail, code: 'managed_order_invalid_lot_size', step: step.toString() };
  if (minimumNotional.isZero()) return null;
  if (!freshManagedQuote(quote, now)) return { ...detail, code: 'managed_market_data_unavailable' };
  const price = new Decimal(leg.side === 'BUY' ? quote!.bidPrice : quote!.askPrice);
  const notional = quantity.mul(price);
  return notional.lt(minimumNotional) ? { ...detail, code: 'managed_order_below_minimum_notional',
    minimum: minimumNotional.toString(), notional: notional.toString() } : null;
}

export function isManagedQuantityIssue(issue: ManagedSizeIssue): boolean {
  return issue.code !== 'managed_market_data_unavailable' && issue.code !== 'managed_constraints_unavailable';
}
