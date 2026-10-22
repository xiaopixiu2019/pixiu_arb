import { test, expect, type WebSocketRoute } from '@playwright/test';
import { MarginSnapshotSchema, StrategyRecordSchema } from '../packages/shared-types/src/index.js';

test('healthy margin never conceals paused tasks, readonly, partial recovery or stale evidence', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('crossex-language', 'zh'));
  await page.route('**/api/preferences', r => r.fulfill({ json: { preferences: { language: 'zh' } } }));
  await page.route('**/api/onboarding/connection', async r => {
    const original = await (await r.fetch()).json();
    await r.fulfill({ json: { ...original, configured: true, activeProfileId: 'synthetic' } });
  });
  await page.route('**/api/trading-mode', r => r.fulfill({ json: { mode: 'readonly' } }));
  const initial = Date.now(), at = initial + 60_000;
  // Keep the pause target ahead of real elapsed setup time (test timeout: 30 s).
  await page.clock.install({ time: new Date(initial) }); await page.clock.pauseAt(new Date(at));
  const assets = ['XMR','MSTR','SNDK','SOXL'];
  const reason = 'Five consecutive maker quotes were rejected; check credentials, balances, and venue status';
  const tasks = assets.map(asset => StrategyRecordSchema.parse({ id: `PAIR-${asset}`, kind: 'position', status: 'PAUSED',
    accountProfileId: 'synthetic', accountLabel: 'Test', progress: 0, filledQuantity: '0', filledLeft: '0', filledRight: '0', openPosition: '0', realizedPnl: '0',
    createdAt: new Date(at).toISOString(), updatedAt: new Date(at).toISOString(), stoppedAt: null,
    config: { kind: 'position', asset, leftVenue: 'BYBIT', rightVenue: 'DERIBIT', leftSide: 'BUY', rightSide: 'SELL',
      entryBps: '10', totalAmount: '1', perOrderQuantity: '1', executionMethod: 'MAKER_TAKER', makerLeg: 'left', reduceOnly: false },
    management: { phase: 'RISK_PAUSED', leftQuantity: '0', rightQuantity: '0', checkedAt: new Date(at).toISOString(), spreadBps: null,
      fundingAprPct: null, fundingCheckedAt: null, conditionSince: null, exitRequested: false, reason, pendingOrderIds: [] } }));
  let current = MarginSnapshotSchema.parse({ accountId: 'risk-a', accountLabel: 'Test', sampledAt: at, ageMs: 0, fresh: true,
    status: 'clear', reason: null, entryBlocked: false, liveEnabled: false, incidentId: null, policy: {}, effectivePolicy: {}, uncoveredSymbols: [],
    groups: tasks.map(task => ({ id: task.id, strategyId: task.id, asset: task.config.asset, phase: 'RISK_PAUSED', eligible: false, authorized: true, reason: 'group_not_monitoring' })),
    metrics: { initialPct: '450', maintenancePct: '1170', marginBalance: '450', initialMargin: '100', maintenanceMargin: '38', availableMargin: '350',
      initialHeadroom: '340', maintenanceHeadroom: '370', accountMode: 'CROSS_EXCHANGE', exchangeType: 'CROSSEX', remoteUpdatedAt: String(at), assets: [] } });
  let stream: WebSocketRoute | undefined;
  await page.routeWebSocket('**/ws/stream', ws => { stream = ws; });
  const writes: string[] = [];
  await page.route('**/api/**', async r => {
    if (r.request().method() !== 'GET') { writes.push(new URL(r.request().url()).pathname); return r.abort(); }
    return r.fallback();
  });
  await page.route('**/api/strategies', r => r.fulfill({ json: { strategies: tasks } }));
  await page.route('**/api/risk/margin', r => r.fulfill({ json: current }));
  await page.route('**/api/risk/margin/events*', r => r.fulfill({ json: { accountId: current.accountId, events: [], hasMore: false } }));
  await page.goto('/risk-management');
  // The synthetic stream is silent initially and the timer is intentionally frozen.
  // Request the first snapshot explicitly, as the existing freshness tests do.
  await page.getByRole('button', { name: '刷新数据', exact: true }).click();
  await expect(page.locator('.risk-execution-notice h2')).toHaveText('4 个托管任务已风险暂停');
  await expect(page.locator('.risk-execution-notice')).toContainText('连续五次 Maker 报价被拒绝');
  await expect(page.locator('.risk-topbar')).toContainText('暂停 4');
  await expect(page.locator('.risk-topbar')).toHaveAttribute('title', /IMR 450.00%/);
  const pausedBadgeWidth = (await page.locator('.risk-topbar').boundingBox())!.width;
  await expect(page.locator('.risk-status')).toContainText('实盘锁定');
  await expect(page.locator('.risk-metrics')).toContainText('450%');
  await expect(page.getByRole('button', { name: '查看并复核', exact: true })).toHaveCount(0);
  await page.screenshot({ path: 'data/hyperliquid-price-fix-20261013/risk-paused.png', fullPage: true });
  for (const width of [1440, 1024, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  current = { ...current, liveEnabled: true, groups: current.groups.map((g, index) => index === 0 ? { ...g, phase: 'MONITORING' } : g) };
  stream!.send(JSON.stringify({ type: 'risk.margin', payload: current }));
  await expect(page.locator('.risk-execution-notice h2')).toHaveText('3 个托管任务已风险暂停');
  await expect(page.locator('.risk-execution-notice')).toContainText('这些暂停任务的自动执行尚未恢复');
  current = { ...current, groups: current.groups.map(g => ({ ...g, phase: 'MONITORING' })) };
  stream!.send(JSON.stringify({ type: 'risk.margin', payload: current }));
  await expect(page.locator('.risk-execution-notice')).toHaveCount(0);
  expect(pausedBadgeWidth).toBeLessThanOrEqual((await page.locator('.risk-topbar').boundingBox())!.width);
  await page.clock.fastForward(6000);
  await expect(page.locator('.risk-execution-notice h2')).toHaveText('执行状态待核实');
  await expect(page.locator('.risk-topbar')).toHaveAttribute('data-execution-state', 'unavailable');
  current = { ...current, accountId: 'risk-b', sampledAt: at + 6000, groups: [], liveEnabled: false };
  stream!.send(JSON.stringify({ type: 'risk.margin', payload: current }));
  await expect(page.locator('.risk-execution-notice h2')).toHaveText('实盘执行已锁定');
  await expect(page.locator('.risk-execution-notice')).not.toContainText('PAIR-XMR');
  expect(writes).toEqual([]);
});
