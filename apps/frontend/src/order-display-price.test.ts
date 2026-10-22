import { describe, expect, it } from 'vitest';
import { orderDisplayPrice } from './order-display-price.js';

describe('orderDisplayPrice', () => {
  it('shows the submitted limit price while the execution average is zero', () => {
    expect(orderDisplayPrice({ executedAveragePrice: '0', price: '65900.5' }, 'Market')).toBe('65900.5');
  });

  it('shows a positive execution average after the order fills', () => {
    expect(orderDisplayPrice({ executedAveragePrice: '65888.25', price: '65900.5' }, 'Market')).toBe('65888.25');
  });

  it('labels an order as market when neither price is positive', () => {
    expect(orderDisplayPrice({ executedAveragePrice: '0', price: null }, 'Market')).toBe('Market');
  });
});
