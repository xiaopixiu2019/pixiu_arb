import { describe, expect, it } from 'vitest';
import { DEFAULT_MARGIN_POLICY, MarginSnapshotSchema } from '@gate-crossex/shared-types';
import { draftPolicy, policyChanges, policyContent, policyDraft, thresholdError, policyScenario, olderRiskSnapshot, supersededRiskReply } from './risk-policy-draft.js';

describe('risk editor preserves the policy contract', () => {
  it('preserves blank intermediate inputs instead of converting to zero', () => {
    const draft = policyDraft(DEFAULT_MARGIN_POLICY); draft.initial.warn = '';
    expect(draftPolicy(draft)).toBeNull(); expect(draft.initial.warn).toBe('');
    expect(policyChanges(DEFAULT_MARGIN_POLICY, draft)).toEqual([{ key: 'initial.warn', before: '110%', after: '—' }]);
  });
  it.each(['100', '-1', 'Infinity', 'NaN', '1000001', ''])('rejects invalid threshold %s', value => {
    const draft = policyDraft(DEFAULT_MARGIN_POLICY); draft.initial.warn = value;
    expect(draftPolicy(draft)).toBeNull(); expect(thresholdError(draft.initial, 'warn', true)).toBeTruthy();
  });
  it('retains hidden authorization identities and reports only actual edits', () => {
    const base = { ...DEFAULT_MARGIN_POLICY, protectedGroupIds: ['closed-but-owned', 'active'] };
    const draft = policyDraft(base); draft.initial.warn = '111';
    expect(draftPolicy(draft)?.protectedGroupIds).toEqual(base.protectedGroupIds);
    expect(policyChanges(base, draft)).toHaveLength(1);
    expect(policyContent(base)).toBe(policyContent({ ...base, revision: 4, protectedGroupIds: ['active', 'closed-but-owned'] }));
  });
  it('keeps both threshold order rules and the reminder interval constraints', () => {
    const draft = policyDraft(DEFAULT_MARGIN_POLICY); draft.initial.reduce = '111';
    expect(thresholdError(draft.initial, 'reduce', true)).toContain('低于预警');
    expect(draftPolicy(draft)).toBeNull();
    draft.initial.reduce = '105'; draft.reminderMinutes = '1.5'; expect(draftPolicy(draft)).toBeNull();
    draft.reminderMinutes = '10'; expect(draftPolicy(draft)).toEqual(DEFAULT_MARGIN_POLICY);
  });
  const snapshot = () => MarginSnapshotSchema.parse({ accountId: 'test', accountLabel: 'Test', sampledAt: 1, ageMs: 0, status: 'clear', fresh: true,
    entryBlocked: false, liveEnabled: true, incidentId: null, reason: null, policy: {}, effectivePolicy: {}, groups: [], uncoveredSymbols: [],
    metrics: { initialPct: '240', maintenancePct: '360', marginBalance: '2400', initialMargin: '1000', maintenanceMargin: '666.67', availableMargin: '1400',
      initialHeadroom: '1300', maintenanceHeadroom: '1066', accountMode: 'ISOLATED_EXCHANGE', exchangeType: 'A', remoteUpdatedAt: '1', assets: [] } });
  it('uses every independent risk unit, including a worse MMR outside the lowest-IMR summary', () => {
    const s = snapshot(); s.units = [{ exchangeType: 'A', metrics: s.metrics }, { exchangeType: 'B', metrics: { ...s.metrics!, initialPct: '250', maintenancePct: '103' } }];
    expect(policyScenario(s, DEFAULT_MARGIN_POLICY)).toBe('reduce');
    s.units[1].metrics = null; expect(policyScenario(s, DEFAULT_MARGIN_POLICY)).toBe('unknown');
  });
  it('orders responses by revision and then observation time', () => {
    const s = snapshot(), next = { ...s, policy: { ...s.policy, revision: 2 }, sampledAt: 10 };
    expect(olderRiskSnapshot({ ...s, sampledAt: 100 }, next)).toBe(true);
    expect(olderRiskSnapshot({ ...next, sampledAt: 9 }, next)).toBe(true);
    expect(olderRiskSnapshot(next, s)).toBe(false);
  });
  it('does not let invalid future timestamps prevent a valid observation from recovering', () => {
    const future = { ...snapshot(), sampledAt: Date.now() + 60000 };
    expect(olderRiskSnapshot({ ...future, sampledAt: Date.now() }, future, Date.now())).toBe(false);
  });
  it('keeps newer control state when an older request returns the same financial sample', () => {
    const before = snapshot(), blocked = { ...before, status: 'blocked' as const, entryBlocked: true };
    expect(supersededRiskReply(before, blocked, before)).toBe(true);
    expect(supersededRiskReply({ ...blocked, sampledAt: 2 }, blocked, before)).toBe(false);
  });
});
