import type { ManagedCloseTarget } from '@gate-crossex/shared-types';
import type { PositionTableRow } from './strategy-positions.js';

export function matchManagedCloseTarget(rows: readonly PositionTableRow[], targets: readonly ManagedCloseTarget[],
  profileId: string | null | undefined): ManagedCloseTarget | null {
  if (!profileId || rows.length !== 2 || new Set(rows.map(row => row.symbol)).size !== 2) return null;
  const matches = targets.filter(({ scope }) => scope.accountProfileId === profileId && scope.legs.length === 2
    && rows.every(row => Number.isFinite(row.quantity) && row.quantity !== 0 && scope.legs.some(leg =>
      leg.symbol === row.symbol && leg.side === (row.side === 'Long' ? 'BUY' : 'SELL'))));
  return matches.length === 1 ? matches[0] : null;
}
