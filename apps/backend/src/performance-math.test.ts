import { describe, expect, it } from 'vitest';
import { performancePeriod, valueBalances, type PerformanceSample } from './performance-math.js';
const s = (at: number, equity: string | null, reason: string | null = null): PerformanceSample => ({ at, equity, available: equity, reason, rates: { USDT: '1' } });
describe('account performance accounting', () => {
  it('excludes deposits and withdrawals and weights their time, not final capital', () => {
    expect(performancePeriod(s(0, '1000'), s(100, '1600'), [{ at: 50, amount: '500', reason: null }])).toMatchObject({ profit: '100', returnPct: '8' });
    expect(performancePeriod(s(0, '1000'), s(100, '850'), [{ at: 50, amount: '-200', reason: null }])).toMatchObject({ profit: '50' });
  });
  it('retains losses and rejects missing flows, invalid denominators and valuations', () => {
    expect(performancePeriod(s(0, '1000'), s(100, '900'), [])).toMatchObject({ profit: '-100', returnPct: '-10' });
    expect(performancePeriod(s(0, '0'), s(100, '20'), []).returnPct).toBeNull();
    expect(performancePeriod(s(0, '1000'), s(100, null, 'missing_fx'), []).profit).toBeNull();
    expect(performancePeriod(s(0, '1000'), s(100, '900'), [{ at: 50, amount: null, reason: 'unknown_flow' }]).profit).toBeNull();
  });
  it('uses net equity once, converts USDC at its quote and rejects duplicates', () => {
    const balances = [{ venue: 'CROSSEX', coin: 'USDT', equity: '900', availableBalance: '500', liability: '100' },
      { venue: 'DERIBIT', coin: 'USDC', equity: '200', availableBalance: '100', liability: '0' }];
    expect(valueBalances(balances, { USDT: '1', USDC: '0.99' })).toMatchObject({ equity: '1098', available: '599', reason: null });
    expect(valueBalances(balances, { USDT: '1' }).equity).toBeNull();
    expect(valueBalances([...balances, balances[0]], { USDT: '1', USDC: '0.99' }).equity).toBeNull();
  });
});
