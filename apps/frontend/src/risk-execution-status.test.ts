import { describe, expect, it } from 'vitest';
import { MarginSnapshotSchema } from '@gate-crossex/shared-types';
import { riskExecutionStatus } from './risk-execution-status.js';

function snapshot() {
  return MarginSnapshotSchema.parse({ accountId: 'a', accountLabel: 'Test', sampledAt: 10000, ageMs: 0,
    status: 'clear', reason: null, fresh: true, entryBlocked: false, metrics: null,
    policy: {}, effectivePolicy: {}, liveEnabled: false, incidentId: null, uncoveredSymbols: [],
    groups: ['XMR','MSTR','SNDK','SOXL'].map(asset => ({ id: asset, strategyId: asset, asset, phase: 'RISK_PAUSED', eligible: false, authorized: true, reason: 'group_not_monitoring' })) });
}
describe('risk execution display', () => {
  it('shows four paused tasks despite healthy margin, retaining exact matching task reasons', () => {
    const s = snapshot(), copy = structuredClone(s);
    const v = riskExecutionStatus(s, true, [{ id: 'XMR', status: 'PAUSED', management: { phase: 'RISK_PAUSED', reason: 'synthetic reason' } }]);
    expect(v.state).toBe('paused'); expect(v.locked).toBe(true); expect(v.paused).toHaveLength(4);
    expect(v.paused[0].reason).toBe('synthetic reason'); expect(s).toEqual(copy);
  });
  it('does not claim tasks resumed merely because live was restored', () => {
    const s = snapshot(); s.liveEnabled = true; s.groups[0].phase = 'MONITORING';
    expect(riskExecutionStatus(s, true)).toMatchObject({ state: 'paused', locked: false });
    expect(riskExecutionStatus(s, true).paused).toHaveLength(3);
  });
  it('treats readonly and unavailable data separately and never carries reasons across group identities', () => {
    const s = snapshot(); s.groups = [];
    expect(riskExecutionStatus(s, true)).toMatchObject({ state: 'locked', paused: [] });
    s.liveEnabled = true; expect(riskExecutionStatus(s, true).state).toBe('enabled');
    expect(riskExecutionStatus(s, false)).toEqual({ state: 'unavailable', paused: [], locked: true });
    expect(riskExecutionStatus(null, false).state).toBe('unavailable');
    expect(riskExecutionStatus(snapshot(), true, [{ id: 'OTHER', status: 'PAUSED', management: { phase: 'RISK_PAUSED', reason: 'other account' } }]).paused.every(g => g.reason === null)).toBe(true);
  });
});
