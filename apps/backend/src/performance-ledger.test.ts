import { describe, expect, it } from 'vitest';
import { ledgerFlows, readAllPages } from './performance-ledger.js';
import type { GateAccountBookRecord, GateTransferRecord } from './crossex-client.js';
const book = (type: string, amount: string, id = '1'): GateAccountBookRecord => ({ id, business_id: id, statement_type: type, exchange_type: 'CROSSEX', coin: 'USDT', change: amount, balance: '100', create_time: '1000' });
const transfer = (from: GateTransferRecord['from_account_type'], to: GateTransferRecord['to_account_type']): GateTransferRecord => ({ id: 't1', text: '', from_account_type: from, to_account_type: to, coin: 'USDT', amount: '50', actual_receive: '50', status: 'SUCCESS', fail_reason: null, create_time: 1000, update_time: 1000 });
describe('performance ledger evidence', () => {
  it('subtracts external deposits but ignores balanced internal transfers', () => {
    expect(ledgerFlows([book('TRANSFER_IN', '50')], [transfer('SPOT', 'CROSSEX')], 0, 2000, () => '1')[0].amount).toBe('50');
    expect(ledgerFlows([book('TRANSFER_IN', '50'), book('TRANSFER_OUT', '-50', '2')], [transfer('CROSSEX_BINANCE', 'CROSSEX_OKX')], 0, 2000, () => '1')).toEqual([]);
  });
  it('rejects uncertain, ambiguous and unknown cash-flow evidence', () => {
    expect(() => ledgerFlows([book('OTHER', '50')], [], 0, 2000, () => '1')).toThrow('unclassified_ledger');
    expect(() => ledgerFlows([book('TRANSFER_IN', '50')], [], 0, 2000, () => '1')).toThrow('unreconciled_transfer');
    expect(() => ledgerFlows([], [{ ...transfer('SPOT', 'CROSSEX'), status: 'PENDING' }], 0, 2000, () => '1')).toThrow('pending_transfer');
  });
  it('never treats a capped or repeated page as complete history', async () => {
    await expect(readAllPages(async () => [{ id: '1' }, { id: '2' }], 2)).rejects.toThrow('ledger_pagination_incomplete');
    expect(await readAllPages(async (page) => page === 1 ? [{ id: '1' }, { id: '2' }] : [{ id: '3' }], 2)).toHaveLength(3);
  });
  it('does not silently discard malformed times or amounts as out-of-range records', () => {
    expect(() => ledgerFlows([{ ...book('FUNDING_FEE', '2'), create_time: 'invalid' }], [], 0, 2000, () => '1')).toThrow('invalid_ledger');
    expect(() => ledgerFlows([book('FUNDING_FEE', 'NaN')], [], 0, 2000, () => '1')).toThrow('invalid_ledger');
  });
  it('rejects conflicting duplicate records even on a short final page', async () => {
    await expect(readAllPages(async (page) => page === 1 ? [{ id: '1', value: '50' }, { id: '2', value: '80' }] : [{ id: '1', value: '99' }], 2)).rejects.toThrow('ledger_page_changed');
  });
});
