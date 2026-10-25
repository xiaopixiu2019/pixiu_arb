import { expect, test, type WebSocketRoute } from '@playwright/test';
import { DEFAULT_MARGIN_POLICY, MarginSnapshotSchema } from '../packages/shared-types/src/margin-risk.js';

test('continuous protection requires explicit scoped confirmation and shows paused protection truthfully', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('crossex-language', 'zh'));
  let enabled = false, revision = 0;
  let stream: WebSocketRoute | undefined;
  const writes: Array<{ enabled: boolean; groupIds: string[]; acknowledge: boolean }> = [];
  const state = () => ({ enabled, state: enabled ? 'WATCHING' : 'DISABLED', groups: enabled
    ? [{ strategyId: 'PAIR-TEST', state: 'WATCHING', reason: null, checkedAt: Date.now() }] : [] });
  const response = () => ({ accountId: 'synthetic-account', authorization: revision
    ? { accountId: 'synthetic-account', profileId: 'synthetic-profile', revision, enabled, groupIds: enabled ? ['PAIR-TEST'] : [] } : null,
  protection: state(), csrfToken: 'synthetic-continuous-protection-csrf' });
  await page.route('**/api/preferences', r => r.fulfill({ json: { preferences: { language: 'zh' } } }));
  await page.route('**/api/trading-mode', r => r.fulfill({ json: { mode: 'protect_only' } }));
  const snapshot = () => ({
    accountId: 'synthetic-account', accountLabel: 'Synthetic', sampledAt: Date.now(), ageMs: 0, fresh: true,
    status: 'clear', reason: null, entryBlocked: true, liveEnabled: false, incidentId: null, uncoveredSymbols: [],
    policy: { ...DEFAULT_MARGIN_POLICY, protectedGroupIds: ['PAIR-TEST'] }, effectivePolicy: DEFAULT_MARGIN_POLICY,
    continuousProtection: state(),
    metrics: { initialPct: '240', maintenancePct: '1600', marginBalance: '2400', initialMargin: '1000', maintenanceMargin: '150',
      availableMargin: '1400', initialHeadroom: '1300', maintenanceHeadroom: '2100', accountMode: 'CROSS_EXCHANGE',
      exchangeType: 'CROSSEX', remoteUpdatedAt: String(Date.now()), assets: [] },
    groups: [{ id: 'PAIR-TEST', strategyId: 'PAIR-TEST', asset: 'BTC', phase: 'RISK_PAUSED', eligible: true, authorized: true,
      reason: null, readiness: { status: 'ready', reason: null, maxBatchQuantity: '1', checkedAt: Date.now() } }],
  });
  await page.route('**/api/risk/margin', r => r.fulfill({ json: snapshot() }));
  await page.routeWebSocket('**/ws/stream', socket => { stream = socket; socket.send(JSON.stringify({ type: 'risk.margin', payload: snapshot() })); });
  await page.route('**/api/risk/protection', r => {
    if (r.request().method() === 'PUT') {
      const input = r.request().postDataJSON(); writes.push(input);
      enabled = input.enabled; revision += 1;
      stream?.send(JSON.stringify({ type: 'risk.margin', payload: snapshot() }));
    }
    return r.fulfill({ json: response() });
  });
  await page.goto('/risk-management');
  await page.getByRole('button', { name: '刷新数据', exact: true }).click();
  const panel = page.getByRole('region', { name: '暂停期间持续保护' });
  await expect(panel).toBeVisible(); await panel.locator('summary').click();
  await panel.getByRole('checkbox').check();
  await panel.getByRole('button', { name: '启用或更新范围' }).click();
  expect(writes).toHaveLength(0);
  await panel.getByRole('button', { name: '确认启用持续保护' }).click();
  await expect.poll(() => writes.length).toBe(1);
  expect(writes[0]).toMatchObject({ enabled: true, groupIds: ['PAIR-TEST'], acknowledge: true });
  await expect(panel.getByText('持续保护已授权', { exact: true })).toBeVisible();
  await expect(page.getByText('自动下单与自动减仓已停止；保证金数据正常不代表任务正在执行。', { exact: true })).toHaveCount(0);
  await panel.getByRole('button', { name: '关闭持续保护', exact: true }).click(); expect(writes).toHaveLength(1);
  await panel.getByRole('button', { name: '确认关闭持续保护' }).click();
  await expect.poll(() => writes.length).toBe(2); expect(writes[1].enabled).toBe(false);
  await expect(panel.getByText('持续保护未授权', { exact: true })).toBeVisible();
});

test('completion frames update protection without refresh, writes or renewing expired margin evidence', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('crossex-language', 'zh'));
  const initial = Date.now(), at = initial + 60_000;
  await page.clock.install({ time: new Date(initial) }); await page.clock.pauseAt(new Date(at));
  const writes: string[] = [];
  await page.route('**/api/**', r => {
    if (r.request().method() !== 'GET') { writes.push(r.request().url()); return r.abort(); }
    return r.fallback();
  });
  await page.route('**/api/preferences', r => r.fulfill({ json: { preferences: { language: 'zh' } } }));
  await page.route('**/api/trading-mode', r => r.fulfill({ json: { mode: 'protect_only' } }));
  let current = MarginSnapshotSchema.parse({ accountId: 'protection-test-a', accountLabel: 'Synthetic', sampledAt: at,
    ageMs: 0, fresh: true, status: 'clear', reason: null, entryBlocked: true, liveEnabled: false, incidentId: null,
    policy: {}, effectivePolicy: {}, uncoveredSymbols: [], groups: [],
    continuousProtection: { enabled: true, state: 'RECONCILING', groups: ['PAIR-A', 'PAIR-B'].map(strategyId =>
      ({ strategyId, state: 'RECONCILING', reason: null, checkedAt: at })) },
    metrics: { initialPct: '240', maintenancePct: '1600', marginBalance: '2400', initialMargin: '1000', maintenanceMargin: '150',
      availableMargin: '1400', initialHeadroom: '1300', maintenanceHeadroom: '2100', accountMode: 'CROSS_EXCHANGE',
      exchangeType: 'CROSSEX', remoteUpdatedAt: String(at), assets: [] } });
  let stream: WebSocketRoute | undefined;
  await page.routeWebSocket('**/ws/stream', ws => { stream = ws; ws.send(JSON.stringify({ type: 'risk.margin', payload: current })); });
  await page.route('**/api/risk/margin', r => r.fulfill({ json: current }));
  await page.route('**/api/risk/margin/events*', r => r.fulfill({ json: { accountId: current.accountId, events: [], hasMore: false } }));
  await page.route('**/api/risk/protection', r => r.fulfill({ json: { accountId: current.accountId, authorization: null,
    protection: current.continuousProtection, csrfToken: 'synthetic-completion-tests-csrf' } }));
  await page.goto('/risk-management');
  const panel = page.getByRole('region', { name: '暂停期间持续保护' });
  await expect(panel).toContainText('PAIR-A · RECONCILING');
  for (const state of ['WATCHING', 'BLOCKED', 'RECONCILING'] as const) {
    current = { ...current, continuousProtection: { enabled: true, state, groups: [
      { strategyId: 'PAIR-A', state, reason: state === 'BLOCKED' ? 'protection_order_unresolved' : null, checkedAt: at },
      { strategyId: 'PAIR-B', state: 'WATCHING', reason: null, checkedAt: at }] } };
    stream!.send(JSON.stringify({ type: 'risk.margin', payload: current }));
    await expect(panel).toContainText(`PAIR-A · ${state}`); await expect(panel).toContainText('PAIR-B · WATCHING');
    await expect(page.locator('.risk-status .risk-health strong')).toHaveText('已阻止');
  }
  await page.clock.runFor(6000);
  stream!.send(JSON.stringify({ type: 'risk.margin', payload: current }));
  await expect(page.locator('.risk-status')).toHaveClass('risk-status unavailable');
  current = { ...current, accountId: 'protection-test-b', continuousProtection: { enabled: false, state: 'DISABLED', groups: [] } };
  stream!.send(JSON.stringify({ type: 'risk.margin', payload: current }));
  await expect(panel).toContainText('持续保护未授权'); await expect(panel).not.toContainText('PAIR-A');
  expect(writes).toEqual([]);
});
