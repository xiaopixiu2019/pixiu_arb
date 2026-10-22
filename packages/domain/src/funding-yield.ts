import { Decimal } from 'decimal.js';
const D = Decimal.clone({ precision: 40 });
export interface FundingYieldLeg {
  quantity: string; value: string; initialMargin: string; rate8h: string; fx: string; fetchedAt: number;
}
/** Current simple funding yield, with explicit conversion and no price PnL. */
export function pairedFundingYield(legs: FundingYieldLeg[], now: number) {
  try {
    if (!legs.length || !Number.isFinite(now)) return null;
    let expected = new D(0), margin = new D(0), value = new D(0), oldest = now;
    for (const leg of legs) {
      const q = new D(leg.quantity), v = new D(leg.value), m = new D(leg.initialMargin), r = new D(leg.rate8h), fx = new D(leg.fx);
      if (![q, v, m, r, fx].every(x => x.isFinite()) || q.isZero() || v.lte(0) || m.lte(0) || fx.lte(0)
        || !Number.isFinite(leg.fetchedAt) || leg.fetchedAt > now || now - leg.fetchedAt > 60000) return null;
      expected = expected.minus(v.mul(r).mul(fx).mul(q.isPositive() ? 1 : -1));
      margin = margin.plus(m.mul(fx)); value = value.plus(v.mul(fx)); oldest = Math.min(oldest, leg.fetchedAt);
    }
    const annual = expected.mul(1095);
    return { aprPercent: annual.div(margin).mul(100).toString(), expected8h: expected.toString(),
      annualizedFunding: annual.toString(), grossNotional: value.toString(), initialMargin: margin.toString(),
      effectiveLeverage: value.div(margin).toString(), oldestQuoteAt: new Date(oldest).toISOString() };
  } catch { return null; }
}
