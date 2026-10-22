import { Decimal } from 'decimal.js';
import type { MarginMetrics, MarginPolicy } from '@gate-crossex/shared-types';
import type { GateCrossExAccount } from './crossex-client.js';

function amount(value: string): Decimal {
  if (!/^[+-]?\d+(\.\d+)?$/.test(value)) throw new Error('margin_invalid_number');
  const number = new Decimal(value);
  if (!number.isFinite()) throw new Error('margin_invalid_number');
  return number;
}
function ratio(raw: string, requirement: Decimal, balance: Decimal): string | null {
  if (requirement.lt(0)) throw new Error('margin_invalid_requirement');
  if (requirement.isZero()) {
    if (balance.lt(0)) return '0';
    return null; // no requirement is not a 0% coverage ratio
  }
  const result = amount(raw).mul(100);
  // Gate rounds ratio fields. Negative equity remains critical, never a green missing value.
  if (balance.lte(0)) return Decimal.min(0, result).toString();
  if (result.lt(0) || result.minus(balance.div(requirement).mul(100)).abs().gt('0.05'))
    throw new Error('margin_ratio_inconsistent');
  return result.toString();
}
export function marginMetrics(account: GateCrossExAccount, policy: MarginPolicy): MarginMetrics {
  const balance = amount(account.margin_balance), initial = amount(account.initial_margin);
  const maintenance = amount(account.maintenance_margin), available = amount(account.available_margin);
  if (initial.isZero() && maintenance.gt(0)) throw new Error('margin_inconsistent_requirements');
  return {
    initialPct: ratio(account.initial_margin_rate, initial, balance),
    maintenancePct: ratio(account.maintenance_margin_rate, maintenance, balance),
    marginBalance: balance.toString(), initialMargin: initial.toString(), maintenanceMargin: maintenance.toString(),
    availableMargin: available.toString(), initialHeadroom: balance.minus(initial.mul(policy.initial.warn).div(100)).toString(),
    maintenanceHeadroom: balance.minus(maintenance.mul(policy.maintenance.warn).div(100)).toString(),
    accountMode: account.account_mode, exchangeType: account.exchange_type, remoteUpdatedAt: account.update_time,
    assets: account.assets.map((a) => ({ venue: a.exchange_type, coin: a.coin, equity: amount(a.equity).toString(),
      liability: amount(a.liability).toString(), borrowingInitialMargin: amount(a.borrowing_initial_margin).toString(),
      borrowingMaintenanceMargin: amount(a.borrowing_maintenance_margin).toString(),
      ...(a.balance === undefined ? {} : { balance: amount(a.balance).toString() }),
      ...(a.futures_initial_margin === undefined ? {} : { futuresInitialMargin: amount(a.futures_initial_margin).toString() }),
      ...(a.futures_maintenance_margin === undefined ? {} : { futuresMaintenanceMargin: amount(a.futures_maintenance_margin).toString() }) })),
  };
}
export function marginBelow(metrics: MarginMetrics, policy: MarginPolicy, level: 'warn' | 'reduce'): boolean {
  return (metrics.initialPct !== null && new Decimal(metrics.initialPct).lt(policy.initial[level]))
    || (metrics.maintenancePct !== null && new Decimal(metrics.maintenancePct).lt(policy.maintenance[level]));
}
export function marginRecovered(metrics: MarginMetrics, policy: MarginPolicy): boolean {
  return (metrics.initialPct === null || new Decimal(metrics.initialPct).gte(policy.initial.recover))
    && (metrics.maintenancePct === null || new Decimal(metrics.maintenancePct).gte(policy.maintenance.recover))
    && new Decimal(metrics.marginBalance).gte(0);
}
export function projectedMarginAllowed(metrics: MarginMetrics, policy: MarginPolicy, initial: string, maintenance: string): boolean {
  const balance = new Decimal(metrics.marginBalance);
  return balance.gte(new Decimal(metrics.initialMargin).plus(initial).mul(policy.initial.warn).div(100))
    && balance.gte(new Decimal(metrics.maintenanceMargin).plus(maintenance).mul(policy.maintenance.warn).div(100));
}
