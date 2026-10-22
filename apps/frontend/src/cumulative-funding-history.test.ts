import { describe, expect, it } from 'vitest';
import { cumulativeFundingHistory, cumulativeFundingPnl, realizedFundingEdgeWindows } from './cumulative-funding-history.js';

const DAY = 86_400_000;

describe('realizedFundingEdgeWindows', () => {
  const longSettlements = [
    { timestamp: DAY * 0.5, rate: '0.0001' },
    { timestamp: DAY * 1.0, rate: '0.0001' },
    { timestamp: DAY * 1.5, rate: '0.0001' },
    { timestamp: DAY * 2.0, rate: '0.0001' },
  ];
  const shortSettlements = [
    { timestamp: DAY * 0.5, rate: '0.0004' },
    { timestamp: DAY * 1.0, rate: '0.0004' },
    { timestamp: DAY * 1.5, rate: '0.0002' },
    { timestamp: DAY * 2.0, rate: '0.0002' },
  ];

  it('accumulates short minus long inside each trailing window, excluding the window boundary', () => {
    expect(realizedFundingEdgeWindows(longSettlements, shortSettlements, 0, 2, [1, 2])).toEqual([
      // Trailing day covers (DAY, 2*DAY]: settlements at 1.5d and 2d only.
      { days: 1, value: 0.02, settlements: 2 },
      { days: 2, value: 0.08, settlements: 4 },
    ]);
  });

  it('flips sign when the legs swap direction', () => {
    expect(realizedFundingEdgeWindows(shortSettlements, longSettlements, 0, 2, [2])).toEqual([
      { days: 2, value: -0.08, settlements: 4 },
    ]);
  });

  it('handles venues on different settlement cadences via merged timestamps', () => {
    const hourly = Array.from({ length: 6 }, (_, index) => ({ timestamp: DAY + (index + 1) * 3_600_000, rate: '0.00005' }));
    const windows = realizedFundingEdgeWindows(longSettlements, hourly, 0, 2, [1]);
    // Short accumulates 6 × 0.005% = 0.03%; long has settlements at 1.5d and 2d = 0.02%.
    expect(windows[0].value).toBeCloseTo(0.01, 10);
  });

  it('reports null when a venue has no settlements inside the window', () => {
    expect(realizedFundingEdgeWindows(longSettlements, [], 0, 2, [1])).toEqual([
      { days: 1, value: null, settlements: 0 },
    ]);
  });
});

describe('cumulativeFundingHistory', () => {
  it('sorts settlements, converts fractions to percent, and accumulates them', () => {
    expect(cumulativeFundingHistory([
      { timestamp: 300, rate: '-0.0001' },
      { timestamp: 200, rate: '0.0002' },
    ], 100)).toEqual([
      { time: 100, value: 0 },
      { time: 200, value: 0.02 },
      { time: 300, value: 0.01 },
    ]);
  });

  it('ignores malformed settlements and does not add a baseline without data', () => {
    expect(cumulativeFundingHistory([
      { timestamp: 200, rate: 'invalid' },
    ], 100)).toEqual([]);
  });
});

describe('cumulativeFundingPnl', () => {
  it('subtracts the long funding history from the short history at every settlement', () => {
    expect(cumulativeFundingPnl([
      { time: 100_000, value: 0 },
      { time: 200_006, value: 0.02 },
      { time: 300_006, value: 0.03 },
    ], [
      { time: 100_000, value: 0 },
      { time: 250_000, value: 0.01 },
      { time: 300_000, value: 0.04 },
    ])).toEqual([
      { time: 100_000, value: 0 },
      { time: 200_000, value: -0.02 },
      { time: 250_000, value: -0.01 },
      { time: 300_000, value: 0.01 },
    ]);
  });

  it('waits until both venue histories have a value', () => {
    expect(cumulativeFundingPnl([
      { time: 200_000, value: 0.02 },
    ], [
      { time: 100_000, value: 0.01 },
      { time: 300_000, value: 0.03 },
    ])).toEqual([
      { time: 200_000, value: -0.01 },
      { time: 300_000, value: 0.01 },
    ]);
    expect(cumulativeFundingPnl([], [{ time: 100_000, value: 0 }])).toEqual([]);
  });
});
