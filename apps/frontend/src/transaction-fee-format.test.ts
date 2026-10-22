import { describe, expect, it } from 'vitest';
import { feeAmount, sumFeeMetrics } from './transaction-fee-format.js';
const metric = (amount: string) => ({ amount, status: 'ready' as const, pending: 0, reason: null });
describe('fee UI totals', () => {
  it('distinguishes nonzero sub-cent charges and rebates from an actual zero', () => {
    expect(feeAmount('0.001', true)).toBe('<0.01');
    expect(feeAmount('-0.001', true)).toBe('净返佣 <0.01');
    expect(feeAmount('0', true)).toBe('0.00');
  });
  it('adds full-precision decimal strings before rounding the display', () => {
    expect(sumFeeMetrics([metric('0.1'), metric('0.2')]).amount).toBe('0.3');
    expect(sumFeeMetrics([metric('12.15564'), metric('12.2'), metric('-2')]).amount).toBe('22.35564');
    expect(feeAmount('22.35564', true)).toBe('22.36');
  });
  it('labels rebates and missing task evidence rather than pretending zero', () => {
    expect(feeAmount('-2', true)).toBe('净返佣 2.00'); expect(feeAmount(null, true)).toBe('—');
    expect(sumFeeMetrics([metric('12.2'), undefined])).toMatchObject({ amount: '12.2', status: 'partial', pending: 1 });
    expect(sumFeeMetrics([undefined]).amount).toBeNull();
  });
});
