import { describe, expect, it } from 'vitest';
import type { ManagedCloseTarget, StrategyRecord } from '@gate-crossex/shared-types';
import type { PositionTableRow } from './strategy-positions.js';
import { closeReceipt, receiptForRows, reconcileReceipt, transitionReceipt } from './managed-close-receipt.js';

const strategy = { id: 'PAIR-ONE', accountProfileId: 'account', status: 'RUNNING',
  config: { kind: 'position', asset: 'TEST', leftVenue: 'BYBIT', rightVenue: 'BINANCE', leftSide: 'SELL', rightSide: 'BUY' },
  management: { phase: 'MONITORING', groupId: 'group', leftQuantity: '10', rightQuantity: '10', pendingOrderIds: [], exitRequested: false },
} as unknown as StrategyRecord;
const target: ManagedCloseTarget = { strategy, scope: { accountProfileId: 'account', legs: [
  { symbol: 'BYBIT_FUTURE_TEST_USDT', side: 'SELL' }, { symbol: 'BINANCE_FUTURE_TEST_USDT', side: 'BUY' },
] } };
const rows = target.scope.legs.map(leg => ({ symbol: leg.symbol, side: leg.side === 'SELL' ? 'Short' : 'Long', quantity: 10 })) as PositionTableRow[];
const completed = { ...strategy, status: 'COMPLETED', management: { ...strategy.management!, phase: 'COMPLETED',
  leftQuantity: '0', rightQuantity: '0', exitRequested: true, checkedAt: '2026-10-21T00:00:00Z' } } as StrategyRecord;

describe('submitted close receipt is display evidence, not new close authority', () => {
  it('retains accepted identity after targets disappear and for a remaining exact leg', () => {
    const receipt = transitionReceipt(closeReceipt(target), 'accepted');
    expect(receiptForRows(rows, [receipt], 'account', [])?.state).toBe('accepted');
    expect(receiptForRows(rows.slice(0, 1), [receipt], 'account', [])?.state).toBe('accepted');
    expect(receipt.scope).not.toBe(target.scope);
    expect(receipt.scope.legs[0]).not.toBe(target.scope.legs[0]);
  });
  it('does not bind another account, alias, direction or new owner to an old receipt', () => {
    const receipt = transitionReceipt(closeReceipt(target), 'accepted');
    expect(receiptForRows(rows, [receipt], 'other', [])).toBeNull();
    expect(receiptForRows([{ ...rows[0], side: 'Long' }, rows[1]], [receipt], 'account', [])).toBeNull();
    expect(receiptForRows([{ ...rows[0], symbol: 'BYBIT_FUTURE_TEST_USDC' }], [receipt], 'account', [])).toBeNull();
    expect(receiptForRows([...rows, rows[0]], [receipt], 'account', [])).toBeNull();
    const owner = { ...target, strategy: { ...strategy, id: 'PAIR-NEW' } };
    expect(receiptForRows(rows, [receipt], 'account', [owner])).toBeNull();
  });
  it('requires review for changed or ambiguous current ownership', () => {
    const receipt = transitionReceipt(closeReceipt(target), 'accepted');
    const changed = { ...target, scope: { ...target.scope, legs: [...target.scope.legs].reverse().map(l => ({ ...l, side: 'BUY' as const })) } };
    expect(receiptForRows(rows, [receipt], 'account', [changed])?.state).toBe('review');
    expect(receiptForRows(rows, [receipt], 'account', [target, { ...target, strategy: { ...strategy, id: 'OTHER' } }])?.state).toBe('review');
  });
  it('only authoritative same-task flat completion finishes a receipt and never regresses', () => {
    const receipt = transitionReceipt(closeReceipt(target), 'accepted');
    const done = reconcileReceipt(receipt, [completed]);
    expect(done.state).toBe('completed');
    expect(transitionReceipt(done, 'accepted').state).toBe('completed');
    expect(reconcileReceipt(done, [strategy]).state).toBe('completed');
    for (const record of [{ ...completed, id: 'OTHER' }, { ...completed, accountProfileId: 'other' },
      { ...completed, management: { ...completed.management!, leftQuantity: '1' } },
      { ...completed, management: { ...completed.management!, pendingOrderIds: ['unknown'] } },
      { ...completed, management: { ...completed.management!, groupId: 'new-group' } }]) {
      expect(reconcileReceipt(receipt, [record as StrategyRecord]).state).not.toBe('completed');
    }
  });
  it('keeps unknown responses under review through ordinary polls and late acknowledgements', () => {
    const receipt = transitionReceipt(closeReceipt(target), 'review');
    expect(transitionReceipt(receipt, 'accepted').state).toBe('review');
    expect(reconcileReceipt(receipt, [strategy]).state).toBe('review');
    expect(receiptForRows(rows, [receipt], 'account', [])?.state).toBe('review');
  });
  it.each(['TRANSFERRED', 'STOPPED', 'RISK_PAUSED', 'KEEP'])('does not claim exit continues after authoritative %s', phase => {
    const receipt = transitionReceipt(closeReceipt(target), 'accepted');
    const record = { ...strategy, management: { ...strategy.management!, ...(phase === 'KEEP' ? { stopIntent: 'KEEP' } : { phase }) } } as StrategyRecord;
    expect(reconcileReceipt(receipt, [record]).state).toBe('review');
  });
});
