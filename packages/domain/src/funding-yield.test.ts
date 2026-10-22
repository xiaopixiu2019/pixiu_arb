import { describe, expect, it } from 'vitest';
import { pairedFundingYield } from './funding-yield.js';
const now = 1800000000000;
const leg = { quantity: '10', value: '100', initialMargin: '10', rate8h: '0.001', fx: '1', fetchedAt: now };
describe('one funding-yield contract for execution and display', () => {
  it('uses actual initial margin and currency conversion, not the mean of leg yields', () => {
    const result = pairedFundingYield([leg, { ...leg, quantity: '-10', rate8h: '0.003', initialMargin: '20', fx: '0.98' }], now)!;
    expect(Number(result.expected8h)).toBeCloseTo(0.194);
    expect(Number(result.aprPercent)).toBeCloseTo(0.194 * 1095 / 29.6 * 100);
  });
  it('preserves signed yield and valid zero', () => {
    expect(Number(pairedFundingYield([leg], now)?.aprPercent)).toBeLessThan(0);
    expect(pairedFundingYield([{ ...leg, rate8h: '0' }], now)?.aprPercent).toBe('0');
  });
  it.each([{ fetchedAt: now + 1 }, { fetchedAt: now - 60001 }, { rate8h: 'NaN' }, { fx: 'NaN' }, { initialMargin: '0' }])('rejects unavailable evidence %j', (change) => {
    expect(pairedFundingYield([{ ...leg, ...change }], now)).toBeNull();
  });
});
