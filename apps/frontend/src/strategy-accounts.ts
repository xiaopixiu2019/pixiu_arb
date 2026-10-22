/**
 * Ownership convention shared with the backend strategy engine: a strategy belongs to the
 * account it was created on, and legacy rows without an owner follow the active account.
 */
export function strategyBelongsToAccount(
  strategy: { accountProfileId: string | null },
  activeProfileId: string | null,
): boolean {
  return strategy.accountProfileId === null || strategy.accountProfileId === activeProfileId;
}

export function scopeStrategiesToAccount<T extends { accountProfileId: string | null }>(
  strategies: T[],
  connection: { activeProfileId: string | null } | null,
): T[] {
  if (!connection) return strategies;
  return strategies.filter((strategy) => strategyBelongsToAccount(strategy, connection.activeProfileId));
}
