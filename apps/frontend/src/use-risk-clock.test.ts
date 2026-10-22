import { describe, expect, it } from 'vitest';
import { riskExpiryDelay } from './use-risk-clock.js';

describe('risk expiry scheduling', () => {
  it('keeps the inclusive 5000 ms boundary and never extends an observation deadline', () => {
    expect(riskExpiryDelay(1000, 2000, 2002)).toBe(3999);
    expect(riskExpiryDelay(1000, 6000, 6000)).toBe(1);
    expect(riskExpiryDelay(1000, 6001, 6001)).toBeNull();
  });

  it('repaints once when a fresh render becomes expired before its passive effect', () => {
    expect(riskExpiryDelay(1000, 6000, 6002)).toBe(0);
    expect(riskExpiryDelay(1000, 6002, 6003)).toBeNull();
    expect(riskExpiryDelay(1000, 6000, 6001)).toBe(0);
  });

  it('handles clock jumps without looping or trusting a distant future observation', () => {
    expect(riskExpiryDelay(1000, 2000, 9000)).toBe(0);
    expect(riskExpiryDelay(1000, 9000, 9001)).toBeNull();
    expect(riskExpiryDelay(1000, 2000, 0)).toBeNull();
    expect(riskExpiryDelay(undefined, 2000, 2000)).toBeNull();
    expect(riskExpiryDelay(null, 2000, 2000)).toBeNull();
    expect(riskExpiryDelay(NaN, 2000, 2000)).toBeNull();
  });
});
