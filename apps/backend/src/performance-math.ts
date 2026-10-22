import { Decimal } from 'decimal.js';

export interface PerformanceSample { at: number; equity: string | null; available: string | null; reason: string | null; rates: Record<string, string> }
export interface PerformanceFlow { at: number; amount: string | null; reason: string | null }
export interface BalanceValue { venue: string; coin: string; equity: string; availableBalance: string; liability: string }
export function decimal(value: string): Decimal | null {
  try { const result = new Decimal(value); return result.isFinite() ? result : null; } catch { return null; }
}

/** Gate documents equity as per-currency NET margin equity: do not subtract liability or add upnl again. */
export function valueBalances(balances: BalanceValue[], rates: Record<string, string>) {
  let equity = new Decimal(0), available = new Decimal(0);
  const seen = new Set<string>();
  if (!balances.length) return { equity: null, available: null, reason: 'balance_coverage_missing' };
  for (const b of balances) {
    if (b.venue === 'CROSSEX' && balances.some((other) => other.coin === b.coin && other.venue !== 'CROSSEX')) return { equity: null, available: null, reason: 'invalid_balances' };
    const key = `${b.venue}:${b.coin}`;
    const e = decimal(b.equity), a = decimal(b.availableBalance), rate = decimal(rates[b.coin] ?? '');
    if (seen.has(key) || !e || !a) return { equity: null, available: null, reason: 'invalid_balances' };
    seen.add(key);
    if (!e.isZero() || !a.isZero()) {
      if (!rate?.gt(0)) return { equity: null, available: null, reason: 'missing_fx' };
      equity = equity.plus(e.mul(rate)); available = available.plus(a.mul(rate));
    }
  }
  return { equity: equity.toFixed(), available: available.toFixed(), reason: null };
}

/** Modified Dietz for one day (or a partial first/current day), with signed external flows. */
export function performancePeriod(start: PerformanceSample, end: PerformanceSample, flows: PerformanceFlow[]) {
  const unknown = start.reason ?? end.reason ?? flows.find((f) => f.reason || f.amount === null)?.reason;
  const e0 = decimal(start.equity ?? ''), e1 = decimal(end.equity ?? '');
  if (unknown || !e0 || !e1 || flows.some((f) => f.amount === null)) return { profit: null, returnPct: null, reason: unknown ?? 'missing_equity' };
  if (end.at <= start.at) return { profit: '0', returnPct: e0.gt(0) ? '0' : null, reason: e0.gt(0) ? null : 'invalid_return_basis' };
  const inside = flows.filter((f) => f.at > start.at && f.at <= end.at);
  const net = inside.reduce((n, f) => n.plus(f.amount!), new Decimal(0));
  const weighted = inside.reduce((n, f) => n.plus(new Decimal(f.amount!).mul(end.at - f.at).div(end.at - start.at)), new Decimal(0));
  const profit = e1.minus(e0).minus(net), denominator = e0.plus(weighted);
  return { profit: profit.toFixed(), returnPct: denominator.gt(0) ? profit.div(denominator).mul(100).toFixed() : null,
    reason: denominator.gt(0) ? null : 'invalid_return_basis' };
}

export function dayStart(at: number): number { return Math.floor((at + 8 * 3_600_000) / 86_400_000) * 86_400_000 - 8 * 3_600_000; }
