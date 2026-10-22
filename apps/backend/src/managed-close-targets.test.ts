import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { StrategyRecordSchema } from '@gate-crossex/shared-types';
import { managedCloseTargets, assertManagedCloseTarget } from './managed-close-targets.js';

const legs = [{ symbol: 'KRAKEN_FUTURE_WLFI_USD', side: 'SELL' as const },
  { symbol: 'DERIBIT_FUTURE_WLFI_USDC', side: 'BUY' as const }];
const record = StrategyRecordSchema.parse({ id: 'PAIR-TEST', kind: 'position', status: 'RUNNING',
  accountProfileId: 'account-1', accountLabel: 'Synthetic', config: { kind: 'position', asset: 'WLFI', entryBps: '0',
    leftVenue: 'KRAKEN', rightVenue: 'DERIBIT', leftSide: 'SELL', rightSide: 'BUY', totalAmount: '10',
    perOrderQuantity: '1', reduceOnly: false, executionMethod: 'TAKER_TAKER', management: { perOrderQuantity: '1', durationSeconds: 2,
      intervalSeconds: 0, makerWaitSeconds: 5 } }, progress: 100, filledQuantity: '10', filledLeft: '10',
  filledRight: '10', openPosition: '10', realizedPnl: '0', createdAt: '2026-10-18T00:00:00Z',
  updatedAt: '2026-10-18T00:00:00Z', stoppedAt: null });

function fixture() {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE managed_position_claims (account_id TEXT, symbol TEXT, strategy_id TEXT); CREATE TABLE managed_positions (strategy_id TEXT, state_json TEXT);');
  db.prepare('INSERT INTO managed_positions VALUES (?, ?)').run(record.id, JSON.stringify({ phase: 'MONITORING' }));
  for (const leg of legs) db.prepare('INSERT INTO managed_position_claims VALUES (?, ?, ?)').run('account-1', leg.symbol, record.id);
  return db;
}

describe('managed close ownership resolution', () => {
  it('exposes only the exact currently owned pair and validates the same scope at confirmation', () => {
    const db = fixture();
    try {
      const targets = managedCloseTargets(db, [record], 'account-1');
      expect(targets).toEqual([{ strategy: record, scope: { accountProfileId: 'account-1', legs } }]);
      expect(() => assertManagedCloseTarget(db, [record], 'account-1', record.id, targets[0].scope)).not.toThrow();
      expect(managedCloseTargets(db, [record], 'account-2')).toEqual([]);
      expect(() => assertManagedCloseTarget(db, [record], 'account-2', record.id, targets[0].scope)).toThrow('managed_close_target_changed');
      db.prepare('UPDATE managed_position_claims SET strategy_id = ? WHERE symbol = ?').run('PAIR-OTHER', legs[1].symbol);
      expect(managedCloseTargets(db, [record], 'account-1')).toEqual([]);
      expect(() => assertManagedCloseTarget(db, [record], 'account-1', record.id, targets[0].scope)).toThrow('managed_close_target_changed');
    } finally { db.close(); }
  });

  it('rejects missing/extra claims, transferred/completed tasks and wrong contract or direction', () => {
    const db = fixture();
    try {
      const scope = { accountProfileId: 'account-1', legs };
      for (const changed of [legs.map(l => ({ ...l, side: 'BUY' as const })),
        legs.map(l => ({ ...l, symbol: l.symbol.replace('USD', 'USDT') }))]) {
        expect(() => assertManagedCloseTarget(db, [record], 'account-1', record.id, { ...scope, legs: changed })).toThrow();
      }
      expect(managedCloseTargets(db, [{ ...record, status: 'COMPLETED' }], 'account-1')).toEqual([]);
      db.prepare('UPDATE managed_positions SET state_json = ?').run(JSON.stringify({ phase: 'TRANSFERRED' }));
      expect(managedCloseTargets(db, [record], 'account-1')).toEqual([]);
      db.prepare('UPDATE managed_positions SET state_json = ?').run(JSON.stringify({ phase: 'STOPPED', stopIntent: 'KEEP' }));
      expect(managedCloseTargets(db, [record], 'account-1')).toHaveLength(1);
      db.prepare('INSERT INTO managed_position_claims VALUES (?, ?, ?)').run('account-1', 'OTHER', record.id);
      expect(managedCloseTargets(db, [record], 'account-1')).toEqual([]);
      db.exec('DELETE FROM managed_position_claims');
      expect(managedCloseTargets(db, [record], 'account-1')).toEqual([]);
    } finally { db.close(); }
  });
});
