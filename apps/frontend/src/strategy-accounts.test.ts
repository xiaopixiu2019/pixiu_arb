import { describe, expect, it } from 'vitest';
import { scopeStrategiesToAccount, strategyBelongsToAccount } from './strategy-accounts.js';

function strategy(id: string, accountProfileId: string | null) {
  return { id, accountProfileId };
}

describe('strategyBelongsToAccount', () => {
  it('matches strategies created on the active account', () => {
    expect(strategyBelongsToAccount(strategy('PAIR-1', 'profile-a'), 'profile-a')).toBe(true);
  });

  it('hides strategies from other accounts, including deleted profiles', () => {
    expect(strategyBelongsToAccount(strategy('PAIR-1', 'profile-b'), 'profile-a')).toBe(false);
    expect(strategyBelongsToAccount(strategy('PAIR-2', 'deleted-profile'), 'profile-a')).toBe(false);
  });

  it('treats unowned legacy strategies as part of the active account', () => {
    expect(strategyBelongsToAccount(strategy('PAIR-1', null), 'profile-a')).toBe(true);
    expect(strategyBelongsToAccount(strategy('PAIR-1', null), null)).toBe(true);
  });
});

describe('scopeStrategiesToAccount', () => {
  const strategies = [
    strategy('PAIR-A', 'profile-a'),
    strategy('PAIR-B', 'profile-b'),
    strategy('PAIR-LEGACY', null),
  ];

  it('keeps every strategy until the connection status has loaded', () => {
    expect(scopeStrategiesToAccount(strategies, null)).toEqual(strategies);
  });

  it('filters to the active account once connected', () => {
    expect(scopeStrategiesToAccount(strategies, { activeProfileId: 'profile-a' }).map((entry) => entry.id))
      .toEqual(['PAIR-A', 'PAIR-LEGACY']);
  });

  it('shows only unowned strategies when no account is active', () => {
    expect(scopeStrategiesToAccount(strategies, { activeProfileId: null }).map((entry) => entry.id))
      .toEqual(['PAIR-LEGACY']);
  });
});
