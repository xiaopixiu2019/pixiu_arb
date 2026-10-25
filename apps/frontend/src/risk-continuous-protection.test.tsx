import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MarginSnapshotSchema } from '@gate-crossex/shared-types';
import { ContinuousProtectionSettings } from './risk-continuous-protection.js';

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(1000); });
afterEach(() => { vi.useRealTimers(); });

function snapshot() {
  return MarginSnapshotSchema.parse({ accountId: 'synthetic', accountLabel: 'Synthetic', sampledAt: 1000, ageMs: 0,
    status: 'clear', reason: null, fresh: true, entryBlocked: false, metrics: null, policy: {}, effectivePolicy: {},
    liveEnabled: true, incidentId: null, groups: [], uncoveredSymbols: [], continuousProtection: {
      enabled: true, state: 'RECONCILING', groups: [
        { strategyId: 'current', state: 'WATCHING', reason: null, checkedAt: 1000 },
        { strategyId: 'opening', state: 'RECONCILING', reason: 'protection_entry_in_progress', checkedAt: 0 },
      ], coverage: [
        { groupId: 'stable', strategyId: 'current', enrolled: true, reason: null },
        { groupId: 'opening', strategyId: 'opening', enrolled: true, reason: null },
        { groupId: 'missing', strategyId: 'missing', enrolled: false, reason: 'protection_group_not_enrolled' },
      ],
    } });
}
describe('continuous protection coverage disclosure', () => {
  it('counts all groups and differentiates enrollment, verification and uncovered scopes', () => {
    const html = renderToStaticMarkup(<ContinuousProtectionSettings snapshot={snapshot()} zh />);
    expect(html).toContain('当前托管组 3 · 已登记 2 · 已核实保护 1');
    expect(html).toContain('missing · 未覆盖'); expect(html).toContain('此组尚未登记，请核实并授权');
    expect(html).toContain('建仓中，等待实际持仓核实'); expect(html).toContain('启动确认时自动登记');
    expect(html).not.toContain('protection_entry_in_progress');
  });
  it('discloses new launch authority and preserves revocation in English', () => {
    const html = renderToStaticMarkup(<ContinuousProtectionSettings snapshot={snapshot()} zh={false} />);
    expect(html).toContain('Current managed groups 3 · Enrolled 2 · Verified protection 1');
    expect(html).toContain('KEEP, explicit read-only and revocation take precedence');
    expect(html).toContain('Entry in progress; awaiting verified holdings');
  });
  it('does not count expired observations as verified protection', () => {
    vi.setSystemTime(6001);
    const html = renderToStaticMarkup(<ContinuousProtectionSettings snapshot={snapshot()} zh />);
    expect(html).toContain('当前托管组 3 · 已登记 2 · 已核实保护 0');
    expect(html).toContain('保护核对已过期，等待新数据');
  });
});
