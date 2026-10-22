import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { defaultManagementDraft, managementConfig, managementSummary } from './position-management-config.js';
import { ManagementSettings, ManagedPositionStatus } from './position-management.js';
import type { StrategyRecord } from './api.js';

describe('position management launch controls', () => {
  it.each(['EXITING', 'COMPLETED'] as const)('does not present a persisted economic warning as a current %s error', (phase) => {
    const strategy: StrategyRecord = { id: 'PAIR-STATUS01', kind: 'position', status: phase === 'COMPLETED' ? 'COMPLETED' : 'RUNNING',
      accountProfileId: null, accountLabel: null, progress: 100, filledQuantity: '4000', filledLeft: '4000', filledRight: '4000',
      openPosition: '0', realizedPnl: '0', createdAt: '2026-09-29T00:00:00Z', updatedAt: '2026-09-29T00:00:00Z', stoppedAt: null,
      config: { kind: 'position', asset: 'SIREN', leftVenue: 'BYBIT', rightVenue: 'GATE', leftSide: 'SELL', rightSide: 'BUY',
        perOrderQuantity: '2000', reduceOnly: false, executionMethod: 'MAKER_TAKER', management: managementConfig(defaultManagementDraft, '2000', 'left')! }, management: {
      phase, reason: 'manual_exit', signalReason: 'managed_quote_unavailable:GATE_FUTURE_SIREN_USDT',
      leftQuantity: '0', rightQuantity: '0', spreadBps: null, fundingAprPct: null, checkedAt: null,
      fundingCheckedAt: null, conditionSince: null, exitRequested: true, pendingOrderIds: [],
    } };
    const html = renderToStaticMarkup(<ManagedPositionStatus strategy={strategy} language="zh" tradingMode="live" />);
    expect(html).not.toContain('正在重连'); expect(html).not.toContain('触发计时'); expect(html).not.toContain('manual_exit');
    expect(html).toContain(phase === 'COMPLETED' ? '已核实两腿清仓' : '手动平仓请求已生效');
    strategy.management!.reason = 'managed_exit_quote_unavailable:BYBIT_FUTURE_SIREN_USDT';
    if (phase === 'EXITING') expect(renderToStaticMarkup(<ManagedPositionStatus strategy={strategy} language="zh" />)).toContain('等待有效报价后继续退出');
  });
  it('defaults new entry drafts to the requested signed OR thresholds while inheriting quantity and maker leg', () => {
    expect(managementConfig(defaultManagementDraft, '3', 'right')).toMatchObject({
      spreadBps: '-90', fundingAprPct: '-150', condition: 'OR', durationSeconds: 3000,
      perOrderQuantity: '3', makerLeg: 'right', marketFallback: false,
    });
  });
  it('validates settings without converting missing thresholds to zero', () => {
    expect(managementConfig({ ...defaultManagementDraft, spreadBps: '' }, '3', 'left')).toBeNull();
    expect(managementConfig({ ...defaultManagementDraft, durationSeconds: '0' }, '3', 'left')).toBeNull();
    expect(managementConfig({ ...defaultManagementDraft, quantity: '-1' }, '3', 'left')).toBeNull();
  });
  it('provides accessible explanations and visible exit controls in both languages', () => {
    const en = renderToStaticMarkup(<ManagementSettings value={defaultManagementDraft} onChange={vi.fn()} entryQuantity="3" language="en" />);
    const zh = renderToStaticMarkup(<ManagementSettings value={defaultManagementDraft} onChange={vi.fn()} entryQuantity="3" language="zh" />);
    expect(en).toContain('Exit settings help · ?'); expect(en).toContain('Allow market clips after maker timeout');
    expect(zh).toContain('分批退出说明 · ?'); expect(zh).toContain('价差低于（bps）');
    expect(zh).not.toContain('退出一旦触发');
    expect(managementSummary(managementConfig(defaultManagementDraft, '3', 'left')!, 'zh')).toContain('后重新挂单');
  });
  it('allows the user to keep the legacy one-shot execution', () => {
    const html = renderToStaticMarkup(<ManagementSettings value={{ ...defaultManagementDraft, enabled: false }} onChange={vi.fn()} entryQuantity="3" language="en" />);
    expect(html).not.toContain('Spread below (bps)');
  });
});
