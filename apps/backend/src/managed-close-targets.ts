import type Database from 'better-sqlite3';
import type { ManagedCloseScope, ManagedCloseTarget, StrategyRecord } from '@gate-crossex/shared-types';
import { managedLegs } from './managed-position-manager.js';
import { readManagedState } from './managed-position-store.js';
import { CreateStrategyInputSchema, TradingRuntimeError } from './trading-runtime.js';

/** Read-only projection of actual claims; asset-name grouping is never ownership. */
export function managedCloseTargets(db: Database.Database, records: StrategyRecord[], account: string | null): ManagedCloseTarget[] {
  if (!account) return [];
  return records.flatMap(strategy => {
    if (strategy.accountProfileId !== account || !strategy.config.management || strategy.status === 'COMPLETED') return [];
    const state = readManagedState(db, strategy.id);
    if (!state || ['TRANSFERRED', 'COMPLETED'].includes(state.phase)) return [];
    const config = CreateStrategyInputSchema.safeParse(strategy.config);
    if (!config.success) return [];
    const legs = managedLegs(config.data);
    const claims = db.prepare('SELECT symbol FROM managed_position_claims WHERE account_id = ? AND strategy_id = ?')
      .all(account, strategy.id) as Array<{ symbol: string }>;
    if (new Set(legs.map(leg => leg.symbol)).size !== 2 || claims.length !== 2
      || !legs.every(leg => claims.some(claim => claim.symbol === leg.symbol))) return [];
    return [{ strategy, scope: { accountProfileId: account, legs } }];
  });
}

/** Called synchronously inside the existing authenticated-write boundary, before Stop. */
export function assertManagedCloseTarget(db: Database.Database, records: StrategyRecord[], account: string | null,
  id: string, expected: ManagedCloseScope): void {
  const target = managedCloseTargets(db, records, account).find(item => item.strategy.id === id);
  if (!target || target.scope.accountProfileId !== expected.accountProfileId || expected.legs.length !== 2
    || !target.scope.legs.every(leg => expected.legs.some(item => item.symbol === leg.symbol && item.side === leg.side))) {
    throw new TradingRuntimeError('managed_close_target_changed', 409);
  }
}
