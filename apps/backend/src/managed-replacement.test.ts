import { describe, expect, it } from 'vitest';
import { proveReplacementTrades } from './managed-replacement.js';

const legs = [{ symbol: 'A', side: 'BUY' }, { symbol: 'B', side: 'SELL' }] as const;
const review = { before: ['150', '150'] as [string, string], detectedAt: 100_100, protectedAt: 101_000 };
const fill = (symbol: string, side: string, order_id: string, qty: string, at: number, transaction_id = order_id) =>
  ({ symbol, side, order_id, qty, create_time: String(at), transaction_id, position_side: 'NONE', position_mode: 'SINGLE' });
const rows = [fill('A','BUY','1','150',100_200), fill('B','SELL','2','110',99_900), fill('B','SELL','2','40',99_900,'3'),
  fill('A','BUY','4','500',102_000), fill('B','SELL','5','500',102_001),
  fill('B','SELL','6','500',103_000), fill('A','BUY','7','500',103_001)];
const prove = (trades = rows) => proveReplacementTrades(trades, legs, ['1','2'], review, '1000', 104_000);
describe('reverse monitor-only handoff', () => {
  it('attributes the complete old exit separately from the new two 500-unit fills per leg', () => {
    expect(prove().length).toBe(7);
  });
  it.each([rows.slice(1), rows.slice(0,-1), [...rows,rows[0]], [...rows,fill('A','SELL','8','1',102_001)],
    rows.map(r => r.order_id === '4' ? {...r,create_time:'100999'} : r),
    rows.map(r => r.order_id === '2' ? {...r,qty:'0'} : r),
    rows.map(r => r.order_id === '7' ? {...r,create_time:'105000'} : r)])('rejects incomplete or contradictory fills', (...items) => {
    expect(() => prove(items)).toThrow();
  });
});
