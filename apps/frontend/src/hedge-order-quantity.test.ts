import { describe, expect, it } from 'vitest';
import { halfOrderQuantity } from './hedge-order-quantity.js';

describe('half-size hedge entry default', () => {
  it.each([['0.10', '0.05'], ['3', '1.5'], ['200', '100'], ['0.001', '0.0005'], ['2.5000', '1.25'],
    ['9007199254740993', '4503599627370496.5'], ['0.000000000000000003', '0.0000000000000000015']])('halves %s exactly without rounding up to a trading minimum', (total, expected) => {
    expect(halfOrderQuantity(total)).toBe(expected);
  });
  it.each(['', ' ', '-1', '1e3', 'NaN', 'Infinity', '1,000', '0', '0.00', '.'])('keeps an invalid or empty total unavailable: %s', total => expect(halfOrderQuantity(total)).toBe(''));
});
