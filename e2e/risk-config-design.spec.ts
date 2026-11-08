import { expect, test } from '@playwright/test';
import { openRiskConfig, riskConfigFixture } from './risk-config-fixture.js';

test('six parameters are on the first screen before the long group list and edit only by intent', async ({ page }) => {
  const f = await riskConfigFixture(page); await page.setViewportSize({ width: 1440, height: 900 }); await openRiskConfig(page);
  const fields = page.locator('.risk-threshold-grid input');
  await expect(fields).toHaveCount(6);
  for (const field of await fields.all()) { await expect(field).toBeVisible(); await expect(field).toHaveAttribute('readonly', '');
    const box = (await field.boundingBox())!; expect(box.y + box.height).toBeLessThan(850); }
  expect(f.writes).toEqual([]);
  await page.getByRole('button', { name: '修改参数', exact: true }).click();
  await page.getByLabel('预警并禁止增仓 (%)').first().fill('111');
  await page.getByRole('button', { name: '预览修改效果', exact: true }).click();
  await expect(page.getByRole('region', { name: '修改预览' })).toContainText('110% → 111%');
  expect(f.writes).toEqual([]);
  await page.getByRole('button', { name: '确认保存并应用' }).click();
  await expect.poll(() => f.writes.length).toBe(1);
  expect(f.writes[0].body).toMatchObject({ accountId: 'risk-config-a', policy: { revision: 0, initial: { warn: 111 } } });
  await expect(fields.first()).toHaveValue('111'); await expect(fields.first()).toHaveAttribute('readonly', '');
});

test('blank and invalid ordering remain drafts and never become zero or write', async ({ page }) => {
  const f = await riskConfigFixture(page); await openRiskConfig(page);
  await page.getByRole('button', { name: '修改参数', exact: true }).click();
  const warn = page.getByLabel('预警并禁止增仓 (%)').first(); await warn.fill('');
  await expect(warn).toHaveValue(''); await expect(warn).toHaveAttribute('aria-invalid', 'true');
  await expect(page.getByRole('button', { name: '预览修改效果' })).toBeDisabled();
  await warn.fill('104'); await expect(page.locator('.risk-field-error').first()).toContainText('减仓');
  expect(f.writes).toEqual([]); expect(f.policy.initial.warn).toBe(110);
});

test('background policy conflicts keep the draft and invalidate its confirmation', async ({ page }) => {
  const f = await riskConfigFixture(page); await openRiskConfig(page);
  await page.getByRole('button', { name: '修改参数', exact: true }).click();
  await page.getByLabel('预警并禁止增仓 (%)').first().fill('111');
  await page.getByRole('button', { name: '预览修改效果' }).click();
  f.change({ revision: 1, initial: { warn: 112, reduce: 105, recover: 115 } });
  await expect(page.getByRole('alert').filter({ hasText: '新版本' })).toBeVisible();
  await expect(page.getByLabel('预警并禁止增仓 (%)').first()).toHaveValue('111');
  await expect(page.getByRole('button', { name: '确认保存并应用' })).toHaveCount(0);
  expect(f.writes).toEqual([]);
});

test('saved and incident-effective thresholds remain visibly distinct', async ({ page }) => {
  const f = await riskConfigFixture(page); const old = structuredClone(f.policy);
  f.change({ revision: 1, initial: { warn: 112, reduce: 106, recover: 116 } }); f.effective(old);
  await openRiskConfig(page);
  await expect(page.getByLabel('预警并禁止增仓 (%)').first()).toHaveValue('110');
  await expect(page.locator('.risk-effective-notice')).toContainText('当前事件仍使用原有效参数');
  await expect(page.locator('.risk-parameter-cell').first()).toContainText('112%');
  await page.getByRole('button', { name: '修改参数', exact: true }).click();
  await expect(page.getByLabel('预警并禁止增仓 (%)').first()).toHaveValue('112');
  expect(f.writes).toEqual([]);
});

test('filtering does not revoke hidden groups and default fill is only a draft', async ({ page }) => {
  const f = await riskConfigFixture(page); f.change({ protectedGroupIds: ['g-old-2'] }); await openRiskConfig(page);
  await page.getByRole('button', { name: '管理范围', exact: true }).click();
  await page.getByLabel('搜索托管组').fill('BTC');
  await page.getByLabel('托管组筛选').selectOption('eligible');
  await expect(page.locator('.risk-scope-list .risk-group')).toHaveCount(1);
  await page.getByRole('button', { name: '填入默认阈值（仅草稿）' }).click(); expect(f.writes).toEqual([]);
  await page.getByLabel('预警并禁止增仓 (%)').first().fill('111');
  f.send(); await page.getByRole('button', { name: '预览修改效果' }).click();
  await page.getByRole('button', { name: '确认保存并应用' }).click();
  await expect.poll(() => f.writes.length).toBe(1);
  expect(f.policy.protectedGroupIds).toEqual(['g-old-2']);
});

test('lost save response is reconciled by reads without a second PUT', async ({ page }) => {
  const f = await riskConfigFixture(page); let writes = 0;
  await page.route('**/api/risk/margin/policy', route => {
    if (route.request().method() === 'PUT') {
      writes++; f.change({ ...route.request().postDataJSON().policy, revision: 1 }); return route.abort();
    }
    return route.fulfill({ json: { policy: f.policy, accountId: 'risk-config-a', csrfToken: 'synthetic' } });
  });
  await openRiskConfig(page); await page.getByRole('button', { name: '修改参数', exact: true }).click();
  await page.getByLabel('预警并禁止增仓 (%)').first().fill('111');
  await page.getByRole('button', { name: '预览修改效果' }).click(); await page.getByRole('button', { name: '确认保存并应用' }).click();
  await expect(page.getByRole('status').filter({ hasText: '保存结果待核实' })).toBeVisible();
  expect(writes).toBe(1);
  await page.getByRole('button', { name: '核实最新配置' }).click();
  await expect(page.getByRole('status').filter({ hasText: '最新配置与本次修改一致' })).toBeVisible();
  await expect(page.getByLabel('预警并禁止增仓 (%)').first()).toHaveValue('111'); expect(writes).toBe(1);
});

test('confirmation is discarded after editing and after data becomes stale', async ({ page }) => {
  const f = await riskConfigFixture(page); await openRiskConfig(page);
  await page.getByRole('button', { name: '修改参数', exact: true }).click();
  await page.getByLabel('预警并禁止增仓 (%)').first().fill('111'); await page.getByRole('button', { name: '预览修改效果' }).click();
  await page.getByLabel('预警并禁止增仓 (%)').first().fill('112');
  await expect(page.getByRole('button', { name: '确认保存并应用' })).toHaveCount(0);
  f.send(); await page.getByRole('button', { name: '预览修改效果' }).click();
  await page.clock.install(); await page.clock.fastForward(6000);
  await expect(page.getByRole('button', { name: '确认保存并应用' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '预览修改效果' })).toBeDisabled(); expect(f.writes).toEqual([]);
});

test('a delayed old-account preflight never sends its draft after account replacement', async ({ page }) => {
  const f = await riskConfigFixture(page); let release!: () => void, reads = 0, puts = 0;
  const wait = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/risk/margin/policy', async route => {
    if (route.request().method() === 'PUT') { puts++; return route.fulfill({ json: f.snapshot() }); }
    reads++; if (reads === 2) await wait;
    return route.fulfill({ json: { policy: f.policy, accountId: reads <= 2 ? 'risk-config-a' : 'risk-config-b', csrfToken: 'synthetic' } });
  });
  try {
    await openRiskConfig(page); await page.getByRole('button', { name: '修改参数', exact: true }).click();
    await page.getByLabel('预警并禁止增仓 (%)').first().fill('111');
    await page.getByRole('button', { name: '预览修改效果' }).click(); await page.getByRole('button', { name: '确认保存并应用' }).click();
    await expect.poll(() => reads).toBe(2); f.account('risk-config-b');
    const response = page.waitForResponse(r => r.url().endsWith('/api/risk/margin/policy')); release(); await (await response).finished();
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(page.locator('.risk-heading')).toContainText('risk-config-b'); expect(puts).toBe(0);
    await expect(page.getByLabel('预警并禁止增仓 (%)').first()).toHaveValue('110');
  } finally { release(); }
});

test('unsaved edits require a leave decision and never submit on navigation', async ({ page }) => {
  const f = await riskConfigFixture(page); await openRiskConfig(page);
  await page.getByRole('button', { name: '修改参数', exact: true }).click(); await page.getByLabel('预警并禁止增仓 (%)').first().fill('111');
  page.once('dialog', dialog => dialog.dismiss()); await page.getByRole('button', { name: '资金费率', exact: true }).click();
  await expect(page).toHaveURL(/risk-management$/); await expect(page.getByLabel('预警并禁止增仓 (%)').first()).toHaveValue('111');
  page.once('dialog', dialog => dialog.accept()); await page.getByRole('button', { name: '资金费率', exact: true }).click();
  await expect(page).toHaveURL(/funding-rates$/); expect(f.writes).toEqual([]);
});

test('the editor remains usable at desktop and narrow widths in both themes', async ({ page }) => {
  const f = await riskConfigFixture(page); await openRiskConfig(page); await page.getByRole('button', { name: '修改参数', exact: true }).click();
  await page.getByLabel('预警并禁止增仓 (%)').first().fill('111');
  for (const theme of ['dark', 'light']) for (const width of [1440, 1024, 375]) {
    await page.setViewportSize({ width, height: 900 }); await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
    await expect(page.locator('.risk-threshold-grid input')).toHaveCount(6);
    await expect(page.getByLabel('预警并禁止增仓 (%)').first()).toHaveValue('111');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    if (width === 1440) {
      const bar = (await page.locator('.risk-draft-actions').boundingBox())!;
      for (const field of await page.locator('.risk-threshold-grid input').all()) {
        const box = (await field.boundingBox())!; expect(box.y + box.height).toBeLessThan(bar.y);
      }
    }
    if (width === 1440 || width === 375) await page.screenshot({ path: `logs/risk-ui-20261028/risk-${theme}-${width}.png`, fullPage: true });
  }
  expect(f.writes).toEqual([]);
});

test('continuous protection failures remain visible even when margin is clear and scope is closed', async ({ page }) => {
  const f = await riskConfigFixture(page);
  f.override({ continuousProtection: { enabled: true, state: 'BLOCKED', groups: [{ strategyId: 'task-unknown', state: 'BLOCKED', reason: 'unknown_order', checkedAt: Date.now() }] } });
  await openRiskConfig(page);
  await expect(page.locator('.risk-status')).toHaveClass('risk-status clear');
  const panel = page.getByRole('region', { name: '暂停期间持续保护' });
  await expect(panel.getByRole('alert')).toContainText('task-unknown');
  await expect(panel.getByRole('alert')).toContainText('unknown_order');
  await expect(panel.locator('details')).not.toHaveAttribute('open'); expect(f.writes).toEqual([]);
});

test('an obsolete reconciliation response never replaces a newer pushed policy', async ({ page }) => {
  const f = await riskConfigFixture(page); let writes = 0;
  await page.route('**/api/risk/margin/policy', route => {
    if (route.request().method() === 'PUT') { writes++; return route.abort(); }
    return route.fulfill({ json: { policy: f.policy, accountId: 'risk-config-a', csrfToken: 'synthetic' } });
  });
  await openRiskConfig(page); await page.getByRole('button', { name: '修改参数', exact: true }).click();
  await page.getByLabel('预警并禁止增仓 (%)').first().fill('111'); await page.getByRole('button', { name: '预览修改效果' }).click();
  await page.getByRole('button', { name: '确认保存并应用' }).click();
  await expect(page.getByRole('status').filter({ hasText: '保存结果待核实' })).toBeVisible();
  let release!: () => void, reads = 0; const wait = new Promise<void>(resolve => { release = resolve; });
  const old = { ...f.snapshot(), policy: { ...f.policy, revision: 1, initial: { warn: 111, reduce: 105, recover: 115 } } };
  await page.route('**/api/risk/margin', async route => { reads++; await wait; return route.fulfill({ json: old }); });
  try {
    await page.getByRole('button', { name: '核实最新配置' }).click(); await expect.poll(() => reads).toBe(1);
    f.change({ revision: 2, initial: { warn: 112, reduce: 105, recover: 115 } });
    const response = page.waitForResponse(r => r.url().endsWith('/api/risk/margin')); release(); await (await response).finished();
    await expect(page.getByRole('status').filter({ hasText: '结果仍不确定' })).toBeVisible();
    await expect(page.getByRole('alert').filter({ hasText: '新版本' })).toContainText('112');
    await page.getByRole('button', { name: '放弃修改', exact: true }).click();
    await expect(page.getByLabel('预警并禁止增仓 (%)').first()).toHaveValue('112'); expect(writes).toBe(1);
  } finally { release(); }
});

test('a delayed initial GET cannot roll back a newer pushed revision', async ({ page }) => {
  const f = await riskConfigFixture(page); const old = f.snapshot(); let reads = 0, release!: () => void;
  const wait = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/onboarding/connection', async route => {
    const original = await (await route.fetch()).json();
    return route.fulfill({ json: { ...original, configured: true, activeProfileId: 'synthetic-risk-profile' } });
  });
  await page.route('**/api/risk/margin', async route => {
    reads++; if (reads === 1) { await wait; return route.fulfill({ json: old }); }
    return route.fulfill({ json: f.snapshot() });
  });
  try {
    await openRiskConfig(page); await expect.poll(() => reads).toBeGreaterThanOrEqual(2);
    f.change({ revision: 2, initial: { warn: 112, reduce: 105, recover: 115 } });
    await expect(page.getByLabel('预警并禁止增仓 (%)').first()).toHaveValue('112');
    const response = page.waitForResponse(r => r.url().endsWith('/api/risk/margin')); release(); await (await response).finished();
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(page.getByLabel('预警并禁止增仓 (%)').first()).toHaveValue('112'); expect(f.writes).toEqual([]);
  } finally { release(); }
});

test('an older healthy stream sample cannot clear a newer HTTP warning', async ({ page }) => {
  const f = await riskConfigFixture(page); await openRiskConfig(page);
  const oldAt = Date.now() - 200;
  await page.route('**/api/risk/margin', route => route.fulfill({ json: { ...f.snapshot(), status: 'warning', entryBlocked: true } }));
  await page.getByRole('button', { name: '刷新数据', exact: true }).click();
  await expect(page.locator('.risk-status')).toHaveClass('risk-status warning');
  f.override({ status: 'clear', entryBlocked: false, sampledAt: oldAt });
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await expect(page.locator('.risk-status')).toHaveClass('risk-status warning');
});

test('stream invalidation fences a pending initial HTTP read', async ({ page }) => {
  const f = await riskConfigFixture(page); let release!: () => void, reads = 0;
  const wait = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/onboarding/connection', async route => route.fulfill({ json: {
    ...await (await route.fetch()).json(), configured: true, activeProfileId: 'synthetic-risk-profile',
  } }));
  await page.route('**/api/risk/margin', async route => {
    const body = f.snapshot(); reads++;
    if (reads === 1) await wait;
    return route.fulfill({ json: body });
  });
  try {
    await openRiskConfig(page); await expect.poll(() => reads).toBeGreaterThanOrEqual(2);
    f.override({ fresh: false, status: 'unavailable' });
    await expect(page.locator('.risk-status')).toHaveClass('risk-status unavailable');
    const response = page.waitForResponse(r => r.url().endsWith('/api/risk/margin')); release(); await (await response).finished();
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(page.locator('.risk-status')).toHaveClass('risk-status unavailable');
  } finally { release(); }
});

test('switching accounts without a stream clear still reads and shows the new account', async ({ page }) => {
  const f = await riskConfigFixture(page); let profile = 'profile-a';
  // Deliberately no portfolio.cleared or risk.margin messages: exercise HTTP-only account recovery.
  await page.routeWebSocket('**/ws/stream', () => {});
  const connection = () => ({ configured: true, storage: 'memory_test_only', label: profile, lastVerifiedAt: null,
    secureEntryPath: '/secure/credentials', readOnly: true, activeProfileId: profile,
    profiles: ['profile-a', 'profile-b'].map(id => ({ id, label: id, storage: 'memory_test_only', lastVerifiedAt: null, active: id === profile })) });
  await page.route('**/api/onboarding/connection', route => route.fulfill({ json: connection() }));
  await page.route('**/api/onboarding/accounts/profile-b/activate', route => {
    profile = 'profile-b'; f.account('risk-config-b'); return route.fulfill({ json: connection() });
  });
  await openRiskConfig(page); await expect(page.locator('.risk-heading')).toContainText('risk-config-a');
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('button', { name: /管理和切换账户/ }).click();
  const dialog = page.getByRole('dialog', { name: '管理和切换账户' });
  await dialog.locator('.account-manager-row').filter({ hasText: 'profile-b' }).getByRole('button', { name: '切换', exact: true }).click();
  await expect(page.locator('.risk-heading')).toContainText('risk-config-b');
  expect(profile).toBe('profile-b'); expect(f.writes).toEqual([]);
});

test('a current HTTP snapshot recovers an invalid future-dated stream sample', async ({ page }) => {
  const f = await riskConfigFixture(page); await openRiskConfig(page);
  f.override({ sampledAt: Date.now() + 60000 });
  await expect(page.locator('.risk-status')).toHaveClass('risk-status unavailable');
  await page.route('**/api/risk/margin', route => route.fulfill({ json: { ...f.snapshot(), sampledAt: Date.now() } }));
  await page.getByRole('button', { name: '刷新数据', exact: true }).click();
  await expect(page.locator('.risk-status')).toHaveClass('risk-status clear');
});

test('a same-sample old HTTP reply cannot erase a newer blocked control state', async ({ page }) => {
  const f = await riskConfigFixture(page); f.override({ sampledAt: Date.now() }); await openRiskConfig(page);
  let release!: () => void; const wait = new Promise<void>(resolve => { release = resolve; });
  const old = f.snapshot(); let reads = 0;
  await page.route('**/api/risk/margin', async route => { reads++; await wait; return route.fulfill({ json: old }); });
  try {
    await page.getByRole('button', { name: '刷新数据', exact: true }).click(); await expect.poll(() => reads).toBe(1);
    f.override({ sampledAt: old.sampledAt, status: 'blocked', entryBlocked: true });
    await expect(page.locator('.risk-status')).toHaveClass('risk-status blocked');
    const response = page.waitForResponse(r => r.url().endsWith('/api/risk/margin')); release(); await (await response).finished();
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(page.locator('.risk-status')).toHaveClass('risk-status blocked');
  } finally { release(); }
});

test('HTTP can establish verified identity after an account-unavailable stream snapshot', async ({ page }) => {
  const f = await riskConfigFixture(page);
  await page.routeWebSocket('**/ws/stream', socket => socket.send(JSON.stringify({ type: 'risk.margin', payload: {
    ...f.snapshot(), accountId: null, accountLabel: '', fresh: false, status: 'unavailable', metrics: null,
  } })));
  await page.goto('/risk-management');
  const dialog = page.getByRole('dialog', { name: /Risk disclaimer|风险免责声明/ });
  await dialog.waitFor({ state: 'visible', timeout: 1500 }).catch(() => undefined);
  if (await dialog.isVisible()) { await dialog.getByRole('checkbox').check(); await dialog.getByRole('button', { name: /Continue in read-only mode|以只读模式继续/ }).click(); }
  await expect(page.locator('.risk-status')).toHaveClass('risk-status unavailable');
  await page.getByRole('button', { name: '刷新数据', exact: true }).click();
  await expect(page.locator('.risk-heading')).toContainText('risk-config-a');
  await expect(page.locator('.risk-status')).toHaveClass('risk-status clear');
  expect(f.writes).toEqual([]);
});
