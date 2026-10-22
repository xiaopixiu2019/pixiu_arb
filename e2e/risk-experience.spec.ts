import { test, expect, type Page, type WebSocketRoute } from '@playwright/test';
import { MarginSnapshotSchema } from '../packages/shared-types/src/margin-risk.js';

const current = (overrides = {}) => MarginSnapshotSchema.parse({ accountId: 'risk-a', accountLabel: '示例账户', sampledAt: Date.now(), ageMs: 0,
  fresh: true, status: 'clear', reason: null, entryBlocked: false, liveEnabled: true, incidentId: null, policy: {}, effectivePolicy: {}, groups: [], uncoveredSymbols: [],
  metrics: { initialPct: '248', maintenancePct: '1653.33', marginBalance: '1240', initialMargin: '500', maintenanceMargin: '75', availableMargin: '740',
    initialHeadroom: '690', maintenanceHeadroom: '1090', accountMode: 'CROSS_EXCHANGE', exchangeType: 'CROSSEX', remoteUpdatedAt: String(Date.now()), assets: [] }, ...overrides });
async function open(page: Page) {
  await page.goto('/risk-management');
  const dialog = page.getByRole('dialog', { name: /Risk disclaimer|风险免责声明/ });
  await dialog.waitFor({ state: 'visible', timeout: 1500 }).catch(() => undefined);
  if (await dialog.isVisible()) { await dialog.getByRole('checkbox').check(); await dialog.getByRole('button', { name: /Continue in read-only mode|以只读模式继续/ }).click(); }
  await page.getByRole('button', { name: '刷新数据', exact: true }).click();
}
async function setup(page: Page) {
  await page.addInitScript(() => localStorage.setItem('crossex-language', 'zh'));
  await page.route('**/api/preferences', r => r.fulfill({ json: { preferences: { language: 'zh' } } }));
  await page.route('**/api/notifications/telegram', r => r.fulfill({ json: { configured: false, botName: null, chatId: null, testedAt: null,
    lastSentAt: null, lastError: null, retryAt: null, storage: 'env_file', csrfToken: 'synthetic' } }));
}

test('approximate protection and delayed fee details preserve healthy official risk and authorization', async ({ page }) => {
  await setup(page); const policy = { ...current().policy, protectedGroupIds: ['g'] };
  await page.route('**/api/risk/margin', r => r.fulfill({ json: current({ policy, effectivePolicy: policy,
    costAccounting: { pendingBatches: 1, reserved: '0.04' }, groups: [{ id: 'g', strategyId: 's', asset: 'TEST', phase: 'MONITORING', eligible: true, authorized: true, reason: null,
      readiness: { status: 'ready', approximate: true, reason: null, maxBatchQuantity: '0.08', checkedAt: Date.now() } }] }) }));
  await page.route('**/api/risk/margin/events*', r => r.fulfill({ json: { accountId: 'risk-a', events: [], hasMore: false } }));
  await open(page); await expect(page.locator('.risk-status')).toHaveClass('risk-status clear');
  await expect(page.locator('.risk-status')).toContainText('费用明细待对账，已预留约 0.04 USDT');
  await expect(page.locator('.risk-scope-status')).toHaveText('1 个授权组可按估算减仓');
  await expect(page.locator('.risk-sidebar')).toContainText('约1:1');
});

test('saved authorization does not claim borrowing protection when model evidence is missing', async ({ page }) => {
  await setup(page);
  const policy = { ...current().policy, protectedGroupIds: ['g'] };
  await page.route('**/api/risk/margin', r => r.fulfill({ json: current({ policy, effectivePolicy: policy,
    groups: [{ id: 'g', strategyId: 's', asset: 'TEST', phase: 'MONITORING', eligible: true, authorized: true, reason: null,
      readiness: { status: 'blocked', reason: 'margin_projection_parameters_missing', maxBatchQuantity: null, checkedAt: Date.now() } }] }) }));
  await page.route('**/api/risk/margin/events*', r => r.fulfill({ json: { accountId: 'risk-a', events: [], hasMore: false } }));
  await open(page);
  await expect(page.locator('.risk-status')).toHaveClass('risk-status clear');
  await expect(page.locator('.risk-scope-status')).toHaveText('已授权，规划证据待核实');
  await expect(page.locator('.risk-sidebar')).toContainText('借币');
  await page.locator('.risk-settings summary').click();
  await expect(page.locator('.risk-group').filter({ hasText: 'TEST' })).toContainText('暂不可规划');
  await expect(page.locator('.risk-group').filter({ hasText: 'TEST' }).locator('input')).toBeChecked();
});

test('fresh stream observations stay valid between clock ticks and expire without another message', async ({ page }) => {
  await setup(page); const at = Date.now(); let stream: WebSocketRoute | undefined;
  await page.clock.install({ time: new Date(at) }); await page.clock.pauseAt(new Date(at));
  await page.routeWebSocket('**/ws/stream', ws => { stream = ws; });
  await page.route('**/api/risk/margin', r => r.fulfill({ json: current({ sampledAt: at }) }));
  await page.route('**/api/risk/margin/events*', r => r.fulfill({ json: { accountId: 'risk-a', events: [], hasMore: false } }));
  await open(page); await expect(page.locator('.risk-status')).toHaveClass('risk-status clear');
  await page.clock.runFor(100);
  const healthy = current({ sampledAt: at + 50, metrics: { ...current().metrics!, initialPct: '249' } });
  expect(stream).toBeDefined(); stream!.send(JSON.stringify({ type: 'risk.margin', payload: healthy }));
  await expect(page.locator('.risk-metric-value strong').first()).toHaveText('249%');
  // Time is paused before the next interval: retries cannot hide a one-tick false alarm.
  expect(await page.locator('.risk-status').getAttribute('class')).toBe('risk-status clear');
  expect(await page.locator('.risk-topbar').getAttribute('class')).toContain('clear');
  stream!.send(JSON.stringify({ type: 'risk.margin', payload: current({ sampledAt: at + 101 }) }));
  await expect(page.locator('.risk-status')).toHaveClass('risk-status unavailable');
  expect(await page.locator('.risk-topbar').getAttribute('class')).toContain('unavailable');
  stream!.send(JSON.stringify({ type: 'risk.margin', payload: current({ sampledAt: at - 4900 }) }));
  await expect(page.locator('.risk-status')).toHaveClass('risk-status clear');
  // Exactly 5000 ms is valid; at 5001 ms the UI must expire without another stream frame.
  await page.clock.runFor(1);
  await expect(page.locator('.risk-status')).toHaveClass('risk-status unavailable');
  expect(await page.locator('.risk-topbar').getAttribute('class')).toContain('unavailable');
});

test('a newer account observation replaces the previous expiry without extending its own deadline', async ({ page }) => {
  await setup(page); const at=Date.now(); let stream!: WebSocketRoute, latest=current({sampledAt:at});
  await page.clock.install({time:new Date(at)}); await page.clock.pauseAt(new Date(at));
  await page.routeWebSocket('**/ws/stream', ws=>{stream=ws;});
  await page.route('**/api/risk/margin', r=>r.fulfill({json:latest}));
  await page.route('**/api/risk/margin/events*', r=>r.fulfill({json:{accountId:latest.accountId,events:[],hasMore:false}}));
  await open(page); await page.clock.runFor(100);
  latest=current({sampledAt:at+100});stream.send(JSON.stringify({type:'risk.margin',payload:latest}));
  await expect(page.locator('.risk-status')).toHaveClass('risk-status clear');
  await page.clock.runFor(4900);
  latest=current({accountId:'risk-b',sampledAt:at+5000});stream.send(JSON.stringify({type:'risk.margin',payload:latest}));
  await expect(page.locator('.risk-status')).toHaveClass('risk-status clear');
  await page.clock.runFor(101); // Previous observation has expired; the new account remains valid.
  expect(await page.locator('.risk-status').getAttribute('class')).toBe('risk-status clear');
  await page.clock.runFor(4899);
  expect(await page.locator('.risk-topbar').getAttribute('class')).toContain('clear');
  await page.clock.runFor(1);
  await expect(page.locator('.risk-status')).toHaveClass('risk-status unavailable');
  expect(await page.locator('.risk-topbar').getAttribute('class')).toContain('unavailable');
});

test('portfolio margin ratios expire at the same 5001 ms boundary', async ({page})=>{
  await setup(page);let stream!:WebSocketRoute,latest=current();
  await page.routeWebSocket('**/ws/stream',ws=>{stream=ws;});
  await page.route('**/api/risk/margin',r=>r.fulfill({json:latest}));
  await page.route('**/api/risk/margin/events*',r=>r.fulfill({json:{accountId:'risk-a',events:[],hasMore:false}}));
  await open(page);
  await page.evaluate(()=>{history.pushState(null,'','/portfolio');window.dispatchEvent(new PopStateEvent('popstate'));});
  await page.locator('.portfolio-summary').waitFor();
  const rate=page.locator('.portfolio-summary article').filter({hasText:'起始保证金率'}).locator('strong');
  const at=Date.now();await page.clock.install({time:new Date(at)});await page.clock.pauseAt(new Date(at));
  latest=current({sampledAt:at});stream.send(JSON.stringify({type:'risk.margin',payload:latest}));
  await expect(rate).toContainText('248');await page.clock.runFor(100);
  latest=current({sampledAt:at-4900});stream.send(JSON.stringify({type:'risk.margin',payload:latest}));
  await expect(rate).toContainText('248');await page.clock.runFor(1);
  await expect(rate).toHaveText('—');expect(await page.locator('.risk-topbar').getAttribute('class')).toContain('unavailable');
});
test('human-readable history preserves evidence, separates locks and removes chart traffic', async ({ page }) => {
  await setup(page); await page.setViewportSize({ width: 1536, height: 1024 }); const history: string[] = [];
  page.on('request', r => { if (r.url().includes('/risk/margin/history')) history.push(r.url()); });
  await page.route('**/api/risk/margin', r => r.fulfill({ json: current() }));
  await page.route('**/api/risk/margin/events*', r => r.fulfill({ json: { accountId: 'risk-a', hasMore: false, events: [
    { id: 3, at: Date.now(), kind: 'clear', detail: 'clear', revision: 0 },
    { id: 2, at: Date.now() - 1000, kind: 'entry_reviewed', detail: 'reviewed', revision: 0 },
    { id: 1, at: Date.now() - 2000, kind: 'recovered', detail: 'recovered', revision: 0 },
  ] } }));
  await open(page);
  await expect(page.getByText('未授权自动减仓', { exact: true })).toBeVisible();
  await expect(page.locator('.risk-events')).toContainText('增仓仍锁定');
  await expect(page.locator('.risk-events')).not.toContainText('clear');
  await page.getByRole('button', { name: '全部记录', exact: true }).click();
  await expect(page.locator('.risk-events')).toContainText('本次检查未触发预警');
  await page.locator('.risk-events li').first().getByRole('button', { name: '详情' }).click();
  await expect(page.locator('.risk-event-detail')).toContainText('未附带有效指标');
  await page.locator('.risk-event-detail summary').click();
  await expect(page.locator('.risk-event-detail')).toContainText('clear');
  expect(history).toEqual([]);
  await page.getByRole('button', { name: '重要记录', exact: true }).click();
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: 'data/risk-page-release-20261004/desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: 'data/risk-page-release-20261004/mobile.png', fullPage: true });
});
test('failed history is not empty safety and stale observations block settings and review', async ({ page }) => {
  await setup(page);
  await page.route('**/api/risk/margin', r => r.fulfill({ json: current({ status: 'recovered', entryBlocked: true, sampledAt: Date.now() - 6000 }) }));
  await page.route('**/api/risk/margin/events*', r => r.fulfill({ status: 503, json: { error: 'risk_request_failed' } }));
  await open(page);
  await expect(page.locator('.risk-status')).toContainText('数据待核实');
  await expect(page.locator('.risk-records')).toContainText('记录加载失败');
  await expect(page.locator('.risk-records')).not.toContainText('暂无此类事项');
  await page.locator('.risk-settings summary').click();
  await expect(page.getByRole('button', { name: '预览修改效果' })).toBeDisabled();
  await expect(page.getByRole('button', { name: '查看并复核' })).toHaveCount(0);
});
test('entry review requires a separate confirmation and preserves failed reconciliation', async ({ page }) => {
  await setup(page); let submissions = 0;
  await page.route('**/api/risk/margin', r => r.fulfill({ json: current({ status: 'recovered', entryBlocked: true }) }));
  await page.route('**/api/risk/margin/events*', r => r.fulfill({ json: { accountId: 'risk-a', events: [], hasMore: false } }));
  await page.route('**/api/risk/margin/policy', r => r.fulfill({ json: { accountId: 'risk-a', policy: current().policy, csrfToken: 'synthetic' } }));
  await page.route('**/api/risk/margin/resume-entry', r => { submissions++; return r.fulfill({ status: 409, json: { error: 'margin_recovery_not_confirmed' } }); });
  await open(page); await page.getByRole('button', { name: '查看并复核' }).click();
  expect(submissions).toBe(0);
  await page.getByRole('button', { name: '确认风险已复核，解除新增锁' }).click();
  await expect.poll(() => submissions).toBe(1);
  await expect(page.locator('.risk-review [role=alert]')).toBeVisible();
  await expect(page.getByRole('group', { name: '确认风险复核' })).toBeVisible();
  await expect(page.locator('.risk-health')).toContainText('已阻止');
});
test('account changes clear previous history and ignore a delayed old-account page', async ({ page }) => {
  await setup(page); let account = 'risk-a'; let release!: () => void;
  let stream: WebSocketRoute | undefined;
  await page.routeWebSocket('**/ws/stream', ws => { stream = ws; });
  const delayed = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/risk/margin', r => r.fulfill({ json: current({ accountId: account }) }));
  await page.route('**/api/risk/margin/events*', async r => {
    const url = new URL(r.request().url()), id = url.searchParams.get('accountId');
    if (url.searchParams.has('before')) await delayed;
    return r.fulfill({ json: { accountId: id, hasMore: id === 'risk-a', events: [{ id: id === 'risk-a' ? 2 : 1, at: Date.now(), kind: id === 'risk-a' ? 'warning' : 'policy_updated', detail: id, revision: 0 }] } });
  });
  await open(page); await expect(page.locator('.risk-events')).toContainText('保证金触发预警');
  await page.getByRole('button', { name: '加载更早记录' }).click();
  account = 'risk-b';
  expect(stream).toBeDefined();
  stream!.send(JSON.stringify({ type: 'risk.margin', payload: current({ accountId: account }) }));
  release();
  await expect(page.locator('.risk-events')).toContainText('保护规则已更新');
  await expect(page.locator('.risk-events')).not.toContainText('保证金触发预警');
});

test('polling after an empty first read retains pagination and deduplicates older records', async ({ page }) => {
  await setup(page); await page.clock.install(); let reads = 0;
  await page.route('**/api/risk/margin', r => r.fulfill({ json: current() }));
  const record = { id: 3, at: Date.now(), kind: 'warning', detail: 'warning', revision: 0 };
  await page.route('**/api/risk/margin/events*', r => {
    const before = new URL(r.request().url()).searchParams.get('before');
    const events = before ? [record, { ...record, id: 2, kind: 'recovered' }] : ++reads === 1 ? [] : [record];
    return r.fulfill({ json: { accountId: 'risk-a', events, hasMore: !before && reads > 1 } });
  });
  await open(page); await expect(page.locator('.risk-records')).toContainText('暂无此类事项');
  await page.clock.fastForward(30000);
  await expect(page.getByRole('button', { name: '加载更早记录' })).toBeVisible();
  await page.getByRole('button', { name: '加载更早记录' }).click();
  await expect(page.locator('.risk-events > li')).toHaveCount(2);
  await expect(page.getByRole('button', { name: '加载更早记录' })).toHaveCount(0);
});
