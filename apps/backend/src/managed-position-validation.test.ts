import { describe, expect, it } from 'vitest';
import { Decimal } from 'decimal.js';
import { managedOrderSizeIssue } from './managed-position-validation.js';

const leg = { symbol: 'KRAKEN_FUTURE_CRO_USD', side: 'SELL' as const };
const constraints = { min_size: '10', lot_size: '10', min_notional: '1' };
const now = Date.now();
const quote = { bidPrice: '0.0627', askPrice: '0.0628', source: 'gate_crossex_websocket',
  updatedAt: new Date(now).toISOString(), receivedAt: new Date(now).toISOString() };
describe('managed quantity validation evidence', () => {
  it('accepts 500 CRO with authentic prices and exact venue limits', () => {
    expect(managedOrderSizeIssue(leg, new Decimal(500), constraints, quote, now)).toBeNull();
  });
  it.each([null, { ...quote, source: 'demo_seed', bidPrice: '0', askPrice: '0' },
    { ...quote, updatedAt: new Date(now - 20000).toISOString() },
    { ...quote, updatedAt: new Date(now - 5000).toISOString() },
    { ...quote, receivedAt: '' }])('reports unavailable evidence, not small size, for invalid quotes %#', (invalid) => {
    expect(managedOrderSizeIssue(leg, new Decimal(500), constraints, invalid, now)).toMatchObject({ code: 'managed_market_data_unavailable', symbol: leg.symbol, quantity: '500' });
  });
  it('distinguishes minimum quantity, lot size and minimum notional', () => {
    expect(managedOrderSizeIssue(leg, new Decimal(5), constraints, quote, now)).toMatchObject({ code: 'managed_order_below_minimum_size', minimum: '10' });
    expect(managedOrderSizeIssue(leg, new Decimal(501), constraints, quote, now)).toMatchObject({ code: 'managed_order_invalid_lot_size', step: '10' });
    expect(managedOrderSizeIssue(leg, new Decimal(10), constraints, quote, now)).toMatchObject({ code: 'managed_order_below_minimum_notional', minimum: '1', notional: '0.628' });
  });
  it('does not require a price for a protective market reduction when no minimum notional applies', () => {
    expect(managedOrderSizeIssue(leg, new Decimal(500), { ...constraints, min_notional: null }, null, now)).toBeNull();
    expect(managedOrderSizeIssue(leg, new Decimal(500), { ...constraints, min_notional: '0' }, null, now)).toBeNull();
  });
  it('keeps missing instrument rules separate from small quantities', () => {
    expect(managedOrderSizeIssue(leg, new Decimal(500), { ...constraints, lot_size: null }, quote, now)).toMatchObject({ code: 'managed_constraints_unavailable' });
  });
  it.each(['min_size', 'lot_size', 'min_notional'] as const)('classifies malformed %s as unavailable rules', (key) => {
    for (const invalid of ['', 'N/A', 'Infinity', '-1']) {
      expect(managedOrderSizeIssue(leg, new Decimal(500), { ...constraints, [key]: invalid }, quote, now)).toMatchObject({ code: 'managed_constraints_unavailable' });
    }
  });
});
