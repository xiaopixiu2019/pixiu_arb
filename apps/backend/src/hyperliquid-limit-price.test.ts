import { describe, expect, it } from 'vitest';
import { Decimal } from 'decimal.js';
import { assertHyperliquidLimitPrice, hyperliquidLimitPrice } from './hyperliquid-limit-price.js';

describe('Hyperliquid directional limit prices', () => {
  const historical = [
    ['538.839', '538.84', '538.83'], ['538.919', '538.92', '538.91'], ['538.809', '538.81', '538.80'],
    ['538.879', '538.88', '538.87'], ['538.849', '538.85', '538.84'],
    ['336.573', '336.58', '336.57'], ['336.573', '336.58', '336.57'], ['336.573', '336.58', '336.57'],
    ['336.573', '336.58', '336.57'], ['336.583', '336.59', '336.58'],
  ];
  it.each(historical)('repairs historical %s while respecting both side boundaries', (raw, sell, buy) => {
    expect(hyperliquidLimitPrice(raw, '0.001', 'SELL')).toBe(new Decimal(sell).toFixed());
    expect(hyperliquidLimitPrice(raw, '0.001', 'BUY')).toBe(new Decimal(buy).toFixed());
    expect(() => assertHyperliquidLimitPrice(raw, '0.001')).toThrow('hyperliquid_limit_price_invalid');
  });
  it.each([
    ['53.839', '0.001', '53.839', '53.839'], ['999.999', '0.001', '1000', '999.99'],
    ['9999.99', '0.01', '10000', '9999.9'], ['10000.1', '0.1', '10001', '10000'],
    ['123456', '0.1', '123456', '123456'], ['123456.1', '0.1', '123457', '123456'],
    ['0.000000123456', '0.000000000001', '0.00000012346', '0.00000012345'],
    ['1000.01', '0.06', '1000.2', '999.96'], ['100000.001', '0.03', '100002', '99999'],
    ['538.8400', '0.001', '538.84', '538.84'], ['0.999999999999999999999', '1', '1', null],
    ['1.000000000000000000001', '1', '2', '1'],
  ])('handles decade/step boundary %s on %s', (raw, tick, sell, buy) => {
    expect(hyperliquidLimitPrice(raw!, tick, 'SELL')).toBe(sell);
    if (buy === null) expect(() => hyperliquidLimitPrice(raw!, tick, 'BUY')).toThrow('hyperliquid_limit_price_invalid');
    else expect(hyperliquidLimitPrice(raw!, tick, 'BUY')).toBe(buy);
  });
  it.each([null, undefined, '', '0', '-0.001', 'NaN', 'Infinity', '1e-3'])('rejects unusable tick %s', tick => {
    expect(() => hyperliquidLimitPrice('100', tick, 'SELL')).toThrow('hyperliquid_price_rules_unavailable');
  });
  it.each(['0', '-1', 'NaN', '1e-7', '', '1'.repeat(129)])('rejects invalid input %s', raw => {
    expect(() => hyperliquidLimitPrice(raw, '0.001', 'BUY')).toThrow('hyperliquid_limit_price_invalid');
  });
  it('uses the nearest legal grid point, not a blanket five-digit or decimal rounding', () => {
    // Enumerate an independent small integer grid around a significant-digit boundary.
    const legal = Array.from({ length: 601 }, (_, n) => 99700 + n)
      .filter(n => n % 6 === 0 && (n % 100 === 0 || String(n).replace(/0+$/, '').length <= 5))
      .map(n => new Decimal(n).div(100));
    for (let n = 999900; n <= 1000100; n += 7) {
      const raw = new Decimal(n).div(1000);
      for (const side of ['BUY', 'SELL'] as const) {
        const expected = side === 'BUY' ? legal.filter(p => p.lte(raw)).at(-1)! : legal.find(p => p.gte(raw))!;
        const result = hyperliquidLimitPrice(raw.toFixed(), '0.06', side);
        expect(result).toBe(expected.toFixed());
        expect(hyperliquidLimitPrice(result, '0.06', side)).toBe(result);
        expect(() => assertHyperliquidLimitPrice(result, '0.06')).not.toThrow();
      }
    }
  });
  it('does not inherit or mutate global Decimal rounding settings', () => {
    const original = { precision: Decimal.precision, rounding: Decimal.rounding };
    try {
      Decimal.set({ precision: 4, rounding: Decimal.ROUND_UP });
      expect(hyperliquidLimitPrice('538.839', '0.001', 'SELL')).toBe('538.84');
      expect(Decimal.precision).toBe(4); expect(Decimal.rounding).toBe(Decimal.ROUND_UP);
    } finally { Decimal.set(original); }
  });
});
