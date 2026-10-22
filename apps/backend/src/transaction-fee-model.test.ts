import { describe, expect, it } from 'vitest';
import { feeBookRecord, feeMetric, feeExpenses, feeOrderKey, type FeeBinding } from './transaction-fee-model.js';
const book = (id: string, change: string, coin = 'USDT') => ({ id, business_id: 'order', statement_type: 'TRADING_FEE', exchange_type: 'BYBIT', coin, change, balance: '100', create_time: '1000' });
describe('actual transaction fee accounting', () => {
  it('normalizes debit and rebate signs once and never mixes funding fees', () => {
    const debit = feeBookRecord(book('1', '-12.2'), '1'), credit = feeBookRecord(book('2', '2'), '1');
    expect(feeMetric([debit, credit]).amount).toBe('10.2');
    expect(feeMetric([credit]).amount).toBe('-2');
    expect(() => feeBookRecord({ ...book('3', '-8'), statement_type: 'FUNDING_FEE' }, '1')).toThrow('invalid_fee_record');
  });
  it('does not assume USDC parity or turn an unknown currency into zero', () => {
    expect(feeBookRecord(book('1', '-12.18', 'USDC'), '.998'.replace(/^\./, '0.')).usd).toBe('12.15564');
    expect(feeMetric([feeBookRecord(book('2', '-12.18', 'USDC'), null)])).toMatchObject({ amount: null, pending: 1, status: 'unavailable' });
  });
  it('shows confirmed parts explicitly and preserves unclassified phase costs', () => {
    const rows = [feeBookRecord(book('1', '-8'), '1'), feeBookRecord(book('2', '-2', 'USDC'), null)];
    expect(feeMetric(rows)).toMatchObject({ amount: '8', status: 'partial', pending: 1 });
    expect(feeExpenses([rows[0]], 'unknown', new Map())).toBe('8');
    const bindings = new Map<string, FeeBinding>([[feeOrderKey('BYBIT', 'order'), { venue: 'BYBIT', order_id: 'order', task_id: 'task', task_started_at: 0, phase: 'entry', leg: 'left', client_order_id: 'client' }]]);
    expect(feeExpenses([rows[0]], 'entry', bindings)).toBe('8');
  });
});
