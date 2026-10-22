import { describe, expect, it } from 'vitest';
import { pairedQuantities, reductionPlan, exitCondition, freshManagedQuote } from './managed-position-model.js';

describe('managed position decisions', () => {
  it('trims only the excess and flattens a surviving leg', () => {
    expect(reductionPlan('100', '80', '1', '1')).toEqual({ leg: 'left', quantity: '20' });
    expect(reductionPlan('0', '80', '1', '1')).toEqual({ leg: 'right', quantity: '80' });
    expect(reductionPlan('80', '80', '1', '1')).toBeNull();
  });
  it('never rounds a reduction above the available position', () => {
    expect(reductionPlan('0.15', '0.12', '0.1', '0.01')).toEqual({ leg: 'left', quantity: '0.1' });
    expect(() => reductionPlan('0.05', '0', '0.1', '0.01')).toThrow('managed_untradeable_dust');
  });
  it('accepts confirmed absent positions as zero but rejects wrong-side and duplicate positions', () => {
    const legs = [{ symbol: 'A', side: 'BUY' as const }, { symbol: 'B', side: 'SELL' as const }];
    expect(pairedQuantities([], legs)).toEqual(['0', '0']);
    expect(pairedQuantities([{ symbol: 'A', position_side: 'NONE', position_qty: '3' }], legs)).toEqual(['3', '0']);
    expect(() => pairedQuantities([{ symbol: 'A', position_side: 'SHORT', position_qty: '3' }], legs)).toThrow();
    expect(() => pairedQuantities([{ symbol: 'A', position_side: 'NONE', position_qty: 'NaN' }], legs)).toThrow();
  });
  it('uses strict signed AND/OR thresholds and never treats unavailable inputs as zero', () => {
    const config = { spreadBps: '-20', fundingAprPct: '-100', condition: 'AND' as const };
    expect(exitCondition(config, '-21', '-101')).toBe(true);
    expect(exitCondition(config, '-20', '-101')).toBe(false);
    expect(exitCondition(config, '-21', null)).toBe(false);
    expect(exitCondition({ ...config, condition: 'OR' }, '1', '-101')).toBe(true);
    expect(exitCondition({ ...config, condition: 'OR' }, null, '-101')).toBe(false);
  });
  it('requires authentic timely uncrossed best quotes', () => {
    const now = Date.now();
    const quote = { bidPrice: '99', askPrice: '100', source: 'gate_crossex_websocket', updatedAt: new Date(now).toISOString(), receivedAt: new Date(now).toISOString() };
    expect(freshManagedQuote(quote, now)).toBe(true);
    expect(freshManagedQuote({ ...quote, bidPrice: '101' }, now)).toBe(false);
    expect(freshManagedQuote(quote, now + 16_000)).toBe(false);
    expect(freshManagedQuote({ ...quote, source: 'seed' }, now)).toBe(false);
  });
});
