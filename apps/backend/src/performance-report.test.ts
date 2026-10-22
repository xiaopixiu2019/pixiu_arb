import { describe, expect, it } from 'vitest';
import { performanceReport } from './performance-report.js';
import { dayStart, type PerformanceSample } from './performance-math.js';
const s = (at: number, equity: string): PerformanceSample => ({ at, equity, available: equity, reason: null, rates: { USDT: '1' } });
describe('performance periods and missing data', () => {
  it('uses UTC+8 days, retains the baseline when a chart is clipped and breaks gaps', () => {
    const t = Date.parse('2026-09-30T15:59:30Z'), end = t + 180_000;
    expect(dayStart(t)).toBe(Date.parse('2026-09-29T16:00:00Z'));
    const report = performanceReport('a', [s(t, '1000'), s(end, '1100')], [], end, '24h', end, null);
    expect(report.cumulativeProfit.value).toBe('100');
    expect(report.cumulativeReturn.value).toBeNull();
    expect(report.points.some((p) => p.equity === null && p.reason === 'sample_gap')).toBe(true);
    expect(report.baselineAt).toBe(new Date(t).toISOString());
  });
  it('chains actual observed daily periods once and keeps negative returns', () => {
    const t = Date.parse('2026-09-30T15:59:30Z'), samples = [s(t, '1000'), s(t + 30_000, '1100'), s(t + 60_000, '990')];
    const r = performanceReport('a', samples, [], t + 60_000, 'all', t + 60_000, null);
    expect(Number(r.cumulativeReturn.value)).toBeCloseTo(-1);
    expect(r.cumulativeProfit.value).toBe('-10');
  });
});
