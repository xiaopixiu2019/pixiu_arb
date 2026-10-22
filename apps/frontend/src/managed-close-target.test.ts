import { describe, expect, it } from 'vitest';
import type { ManagedCloseTarget } from '@gate-crossex/shared-types';
import { matchManagedCloseTarget } from './managed-close-target.js';
import type { PositionTableRow } from './strategy-positions.js';

const rows = [{ symbol: 'KRAKEN_FUTURE_WLFI_USD', side: 'Short', quantity: -10000 },
  { symbol: 'DERIBIT_FUTURE_WLFI_USDC', side: 'Long', quantity: 10000 }] as PositionTableRow[];
const target = { strategy: { id: 'PAIR-TEST' }, scope: { accountProfileId: 'account-1', legs: [
  { symbol: rows[0].symbol, side: 'SELL' }, { symbol: rows[1].symbol, side: 'BUY' },
] } } as ManagedCloseTarget;

describe('grouped close target', () => {
  it('matches both exact contracts and directions in either display order', () => {
    expect(matchManagedCloseTarget(rows, [target], 'account-1')).toBe(target);
    expect(matchManagedCloseTarget([...rows].reverse(), [target], 'account-1')).toBe(target);
  });
  it('refuses ambiguous owners, other accounts, single legs and extra legs', () => {
    for (const input of [rows.slice(0, 1), [...rows, rows[0]], [rows[0], rows[0]]]) {
      expect(matchManagedCloseTarget(input, [target], 'account-1')).toBeNull();
    }
    expect(matchManagedCloseTarget(rows, [target, target], 'account-1')).toBeNull();
    expect(matchManagedCloseTarget(rows, [target], 'other')).toBeNull();
    expect(matchManagedCloseTarget(rows, [], 'account-1')).toBeNull();
    expect(matchManagedCloseTarget(rows, [target], null)).toBeNull();
  });
  it('never treats an asset alias, different quote or opposite position as the same contract', () => {
    for (const patch of [{ symbol: 'KRAKEN_FUTURE_WLFI_USDT' }, { side: 'Long' as const }, { quantity: 0 }, { quantity: NaN }]) {
      expect(matchManagedCloseTarget([{ ...rows[0], ...patch }, rows[1]], [target], 'account-1')).toBeNull();
    }
  });
});
