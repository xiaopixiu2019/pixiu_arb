import { describe, expect, it } from 'vitest';
import { MarginSnapshotSchema } from '@gate-crossex/shared-types';
import { riskAmount, riskEventCopy, riskFresh, protectionCopy } from './risk-presentation.js';

const snapshot = () => MarginSnapshotSchema.parse({ accountId: 'a', accountLabel: 'Test', sampledAt: 10000, ageMs: 0,
  fresh: true, metrics: { initialPct: '240', maintenancePct: '1600', marginBalance: '1200', initialMargin: '500', maintenanceMargin: '75',
    availableMargin: '700', initialHeadroom: '650', maintenanceHeadroom: '1050', accountMode: 'CROSS_EXCHANGE', exchangeType: 'CROSSEX', remoteUpdatedAt: '10000', assets: [] },
  status: 'clear', reason: null, entryBlocked: false, liveEnabled: true, incidentId: null,
  policy: {}, effectivePolicy: {}, groups: [], uncoveredSymbols: [] });

describe('risk page evidence and human-readable meaning', () => {
  it('discloses reconciling continuous protection without claiming paused ordinary trading resumed', () => {
    const s = snapshot();
    const next = { ...s, liveEnabled: false, continuousProtection: { enabled: true, state: 'RECONCILING' as const, groups: [] } };
    expect(protectionCopy(next, true, true).title).toContain('持续保护正在核对');
    expect(protectionCopy(next, true, true).title).not.toContain('未启用实盘');
    expect(protectionCopy(next, false, true).title).toContain('待核实');
  });
  it('never converts missing or invalid financial data into zero', () => {
    for (const value of [null, undefined, '', 'NaN', 'Infinity', ' ']) expect(riskAmount(value)).toBe('—');
    expect(riskAmount('0')).toBe('0');
  });
  it('does not treat unavailable, expired or future observations as fresh', () => {
    const s = snapshot();
    expect(riskFresh(s, 10000)).toBe(true);
    expect(riskFresh(s, 15000)).toBe(true);
    expect(riskFresh({ ...s, fresh: false }, 10000)).toBe(false);
    expect(riskFresh({ ...s, metrics: null }, 10000)).toBe(false);
    expect(riskFresh({ ...s, accountId: null }, 10000)).toBe(false);
    expect(riskFresh({ ...s, status: 'unavailable' }, 10000)).toBe(false);
    expect(riskFresh(s, 15001)).toBe(false);
    expect(riskFresh(s, 9999)).toBe(false);
  });
  it('separates recovery from permission to enter and execution from triggering', () => {
    expect(riskEventCopy('recovered', true).action).toContain('增仓仍锁定');
    expect(riskEventCopy('entry_auto_recovered', true)).toMatchObject({ label: '已恢复', tone: 'green' });
    expect(riskEventCopy('entry_auto_recovered', true).action).toContain('继续监控剩余仓位');
    expect(riskEventCopy('reduction_triggered', true).action).toContain('等待');
    expect(riskEventCopy('entry_reviewed', true).action).toContain('其他');
    expect(riskEventCopy('clear', true).title).toBe('本次检查未触发预警');
    expect(riskEventCopy('new_unknown_kind', true).tone).toBe('neutral');
    expect(riskEventCopy('new_unknown_kind', true).action).toContain('详情');
  });
  it('never claims automatic reduction when permission or scope is absent', () => {
    const s = snapshot();
    expect(protectionCopy(s, true, true).title).toContain('未授权');
    expect(protectionCopy({ ...s, liveEnabled: false }, true, true).title).toContain('未启用');
    expect(protectionCopy(null, false, true).title).toContain('待核实');
  });
  it('separates authorization from missing, blocked and verified model evidence', () => {
    const s = snapshot(), group = { id: 'g', strategyId: 's', asset: 'TEST', phase: 'MONITORING', eligible: true, authorized: true, reason: null };
    expect(protectionCopy({ ...s, metrics: { ...s.metrics!, accountMode: 'CROSS_EXCHANGE' }, groups: [group] }, true, true).title).toContain('待核实');
    const readiness = { status: 'blocked' as const, reason: 'margin_projection_parameters_missing', maxBatchQuantity: null, checkedAt: 10000 };
    expect(protectionCopy({ ...s, groups: [{ ...group, readiness }] }, true, true).detail).toContain('借币');
    expect(protectionCopy({ ...s, groups: [{ ...group, readiness: { ...readiness, status: 'ready', reason: null, maxBatchQuantity: '0.4' } }] }, true, true).title).toContain('已授权');
  });
});
