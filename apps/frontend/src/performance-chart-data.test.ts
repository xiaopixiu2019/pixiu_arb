import { describe, expect, it } from 'vitest';
import { performanceSegments, performanceTimeLabel } from './performance-chart-data.js';
describe('performance chart gaps', () => {
  it('uses separate drawable series across missing snapshots, not whitespace bridging', () => {
    const points = [{ at: 1000, equity: '100', returnPct: '0', reason: null },
      { at: 2000, equity: null, returnPct: null, reason: 'sample_gap' }, { at: 3000, equity: '110', returnPct: '10', reason: null }];
    expect(performanceSegments(points, 'equity').map((s) => s.map((p) => p.time))).toEqual([[1], [3]]);
  });
  it('keeps asset observations when only the return is unavailable', () => {
    const points = [{ at: 1000, equity: '100', returnPct: null, reason: 'ledger_incomplete' }, { at: 2000, equity: '110', returnPct: '10', reason: null }];
    expect(performanceSegments(points, 'equity')[0]).toHaveLength(2);
    expect(performanceSegments(points, 'returnPct')[0]).toEqual([{ time: 2, value: 10 }]);
  });
  it('sorts, deduplicates timestamps, rejects nonfinite values and preserves zero', () => {
    expect(performanceSegments([{ at: 2000, equity: 'Infinity', returnPct: null, reason: null },
      { at: 1000, equity: '0', returnPct: '0', reason: null }, { at: 1100, equity: '1', returnPct: '0', reason: null }], 'equity')).toEqual([[{ time: 1, value: 1 }]]);
  });
});

describe('performance axis time zone', () => {
  it('uses UTC+8 at the day boundary even when the browser is in UTC', () => {
    const boundary = Date.parse('2026-09-30T16:00:00Z');
    expect(performanceTimeLabel(boundary, 'zh', true)).toBe('00:00');
    expect(performanceTimeLabel(boundary, 'en', false)).toBe('01/10');
  });
});
