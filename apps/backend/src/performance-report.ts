import { Decimal } from 'decimal.js';
import type { AccountPerformance, PerformanceMetric, PerformanceRange } from '@gate-crossex/shared-types';
import { dayStart, performancePeriod, type PerformanceFlow, type PerformanceSample } from './performance-math.js';

const iso = (at: number | undefined) => at === undefined ? null : new Date(at).toISOString();
function metric(value: string | null, reason: string | null, from?: number, to?: number, partial = false): PerformanceMetric {
  return { value, reason, status: value === null ? 'unavailable' : partial ? 'partial' : 'ready', from: iso(from), to: iso(to) };
}
export function emptyPerformance(profileId: string | null, reason = 'account_unavailable'): AccountPerformance {
  const missing = metric(null, reason);
  return { profileId, checkedAt: null, baselineAt: null, currency: 'USDT', timezone: 'Asia/Shanghai', totalEquity: missing,
    availableBalance: missing, cumulativeProfit: missing, cumulativeReturn: missing, todayProfit: missing, yesterdayProfit: missing, points: [] };
}
function dayMetric(samples: PerformanceSample[], flows: PerformanceFlow[], from: number, to: number, coverage: number, current: boolean): PerformanceMetric {
  const start = samples.find((s) => s.at >= from && s.at < to), end = current ? samples.at(-1) : samples.find((s) => s.at >= to);
  if (!start || !end || start.at === end.at) return metric(null, 'insufficient_day_history');
  if (end.at > coverage) return metric(null, 'ledger_incomplete', start.at, end.at);
  const partial = start.at - from > 60_000 || (!current && end.at - to > 60_000);
  const result = performancePeriod(start, end, flows.filter((f) => f.at > start.at && f.at <= end.at));
  return metric(result.profit, result.reason ?? (partial ? 'partial_day' : null), start.at, end.at, partial);
}
function cumulativeReturns(samples: PerformanceSample[], flows: PerformanceFlow[], coverage: number) {
  let base = samples[0], compound = new Decimal(1), lastReturn: string | null = '0', broken = false;
  return samples.map((s, index) => {
    // A whole missing day prevents a trustworthy daily-chain return, although total PnL can still reconcile.
    if (index && s.at - samples[index - 1].at > 90_000 && dayStart(s.at) !== dayStart(samples[index - 1].at)) broken = true;
    if (dayStart(s.at) !== dayStart(base.at) && !broken) {
      if (lastReturn === null) broken = true;
      else { compound = new Decimal(lastReturn).div(100).plus(1); base = samples[index - 1]; }
    }
    const period = performancePeriod(base, s, flows.filter((f) => f.at > base.at && f.at <= s.at));
    const value = broken || s.at > coverage || period.returnPct === null ? null : compound.mul(new Decimal(period.returnPct).div(100).plus(1)).minus(1).mul(100).toFixed();
    lastReturn = value;
    return { at: s.at, equity: s.equity, returnPct: value, reason: s.reason ?? (value === null ? 'return_coverage_missing' : null) };
  });
}
export function performanceReport(profileId: string, samples: PerformanceSample[], flows: PerformanceFlow[], coverage: number, range: PerformanceRange, now: number, failure: string | null): AccountPerformance {
  const first = samples.findIndex((s) => s.equity !== null && s.reason === null);
  if (first < 0) return emptyPerformance(profileId, samples.at(-1)?.reason ?? failure ?? 'waiting_for_baseline');
  const valid = samples.slice(first), start = valid[0], end = valid.at(-1)!;
  const stale = now - end.at > 120_000, complete = coverage >= end.at;
  const raw = cumulativeReturns(valid, flows, coverage), cumulative = performancePeriod(start, end, flows);
  const since = range === 'all' ? start.at : now - ({ '24h': 1, '7d': 7, '30d': 30 }[range]) * 86_400_000;
  const points = raw.filter((p) => p.at >= since).flatMap((point, index, selected) => index && point.at - selected[index - 1].at > 90_000
    ? [{ at: selected[index - 1].at + 1000, equity: null, returnPct: null, reason: 'sample_gap' }, point] : [point]);
  const reason = failure ?? 'ledger_incomplete', day = dayStart(now);
  return { profileId, currency: 'USDT', timezone: 'Asia/Shanghai', checkedAt: iso(end.at), baselineAt: iso(start.at),
    totalEquity: metric(end.equity, end.reason ?? (stale ? 'stale_snapshot' : null), end.at, end.at, stale),
    availableBalance: metric(end.available, end.reason ?? (stale ? 'stale_snapshot' : null), end.at, end.at, stale),
    cumulativeProfit: metric(complete ? cumulative.profit : null, complete ? cumulative.reason : reason, start.at, end.at, stale),
    cumulativeReturn: metric(complete ? raw.at(-1)!.returnPct : null, complete ? raw.at(-1)!.reason : reason, start.at, end.at, stale),
    todayProfit: dayMetric(valid, flows, day, now + 1, coverage, true), yesterdayProfit: dayMetric(valid, flows, day - 86_400_000, day, coverage, false),
    points: points.filter((p, i) => i === 0 || i === points.length - 1 || i % Math.ceil(points.length / 1500) === 0
      || p.reason === 'sample_gap' || (p.equity === null) !== (points[i - 1]?.equity === null) || (p.returnPct === null) !== (points[i - 1]?.returnPct === null)) };
}
