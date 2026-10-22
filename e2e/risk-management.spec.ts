import { expect, test } from '@playwright/test';
import { DEFAULT_MARGIN_POLICY, type MarginSnapshot } from '../packages/shared-types/src/margin-risk.js';

function snapshot(): MarginSnapshot {
  return { accountId: 'synthetic-risk-account', accountLabel: '测试账户', sampledAt: Date.now(), ageMs: 0,
    status: 'warning', reason: null, fresh: true, entryBlocked: true, liveEnabled: false, incidentId: null,
    policy: DEFAULT_MARGIN_POLICY, effectivePolicy: DEFAULT_MARGIN_POLICY, uncoveredSymbols: ['GATE_FUTURE_ETH_USDT'],
    groups: [{ id: 'PAIR-TEST', strategyId: 'PAIR-TEST', asset: 'BTC', phase: 'MONITORING', eligible: true, authorized: false, reason: null }],
    metrics: { initialPct: '109.9', maintenancePct: '800', marginBalance: '1099', initialMargin: '1000', maintenanceMargin: '137.375', availableMargin: '99',
      initialHeadroom: '-1', maintenanceHeadroom: '824.25', accountMode: 'CROSS_EXCHANGE', exchangeType: 'CROSSEX', remoteUpdatedAt: String(Date.now()),
      assets: [{ venue: 'HYPERLIQUID', coin: 'USDC', equity: '-25', liability: '25', borrowingInitialMargin: '5', borrowingMaintenanceMargin: '2.5' }] } };
}
for (const mobile of [false, true]) test(`risk workspace ${mobile ? 'mobile' : 'desktop'} shows evidence and explicit configuration preview`, async ({ page }) => {
  await page.setViewportSize({ width: mobile ? 430 : 1440, height: 1000 });
  await page.addInitScript(() => localStorage.setItem('crossex-language', 'zh'));
  let configured = DEFAULT_MARGIN_POLICY;
  const current = () => ({ ...snapshot(), policy: configured, effectivePolicy: configured });
  await page.route('**/api/preferences', (r) => r.fulfill({ json: { preferences: { language: 'zh' } } }));
  await page.route('**/api/risk/margin', (r) => r.fulfill({ json: current() }));
  const historyRequests: string[] = [];
  page.on('request', (request) => { if (request.url().includes('/api/risk/margin/history')) historyRequests.push(request.url()); });
  await page.route('**/api/risk/margin/events*', (r) => r.fulfill({ json: { accountId: 'synthetic-risk-account', hasMore: false, events: [{ id: 1, at: Date.now(), kind: 'warning', detail: 'IMR below 110%', revision: 0 }] } }));
  await page.route('**/api/notifications/telegram', (r) => r.fulfill({ json: { configured: false, botName: null, chatId: null, testedAt: null,
    lastSentAt: null, lastError: null, retryAt: null, storage: 'env_file', csrfToken: 'synthetic-csrf-token-for-tests' } }));
  await page.route('**/api/risk/margin/policy', (r) => {
    if (r.request().method() === 'PUT') { configured = { ...r.request().postDataJSON().policy, revision: configured.revision + 1 }; return r.fulfill({ json: current() }); }
    return r.fulfill({ json: { policy: configured, accountId: 'synthetic-risk-account', csrfToken: 'synthetic-csrf-token-for-tests' } });
  });
  await page.goto('/risk-management');
  const disclaimer = page.getByRole('dialog', { name: /Risk disclaimer|风险免责声明/ });
  await disclaimer.waitFor({ state: 'visible', timeout: 1500 }).catch(() => undefined);
  if (await disclaimer.isVisible()) { await disclaimer.getByRole('checkbox').check(); await disclaimer.getByRole('button', { name: /Continue in read-only mode|以只读模式继续/ }).click(); }
  await expect(page.getByRole('heading', { name: '风险管理', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '刷新数据', exact: true }).click();
  await expect(page.locator('.risk-metrics')).toContainText('109.9%');
  await expect(page.getByRole('heading', { name: '保证金变化', exact: true })).toHaveCount(0);
  expect(historyRequests).toEqual([]);
  await expect(page.locator('.risk-sidebar')).toContainText('无实盘权限');
  await page.locator('.risk-settings summary').click();
  await expect(page.locator('.risk-threshold-grid input')).toHaveCount(6);
  const groups = await page.locator('.risk-protected-groups').boundingBox();
  const thresholds = await page.locator('.risk-threshold-grid').boundingBox();
  expect(groups!.y + groups!.height).toBeLessThanOrEqual(thresholds!.y);
  await page.locator('.risk-protected-groups input[type=checkbox]').check();
  await expect(page.getByLabel('分批市价减仓 (%)').first()).toHaveValue('105');
  await page.getByLabel('预警并禁止增仓 (%)').first().fill('111');
  await page.getByRole('button', { name: '刷新数据', exact: true }).click();
  await page.getByRole('button', { name: '预览修改效果' }).click();
  await expect(page.locator('.risk-settings')).toContainText('按当前数据将预警并阻止增仓');
  expect(configured.initial.warn).toBe(110);
  expect(configured.protectedGroupIds).toEqual([]);
  await page.getByRole('button', { name: '确认保存并应用' }).click();
  await expect(page.locator('.risk-settings')).toContainText('已保存');
  expect(configured.initial.warn).toBe(111);
  expect(configured.protectedGroupIds).toEqual(['PAIR-TEST']);
  for (const width of [1536, 1024, 768, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    await expect(page.getByLabel('预警并禁止增仓 (%)').first()).toHaveValue('111');
    await expect(page.locator('.risk-protected-groups input[type=checkbox]')).toBeChecked();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
  await page.setViewportSize({ width: mobile ? 430 : 1440, height: 1000 });
  await page.locator('.risk-notification-details summary').click();
  await expect(page.getByRole('link', { name: '安全配置机器人' })).toHaveAttribute('href', '/secure/telegram');
  await expect(page.getByRole('button', { name: '发送测试消息' })).toBeDisabled();
  await page.evaluate(() => scrollTo(0, 0));
  await page.screenshot({ path: `data/risk-management-${mobile ? 'mobile' : 'desktop'}.png`, fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.reload(); await expect(page.getByRole('heading', { name: '风险管理', exact: true })).toBeVisible();
});
