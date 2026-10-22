import { expect, test, type Page } from '@playwright/test';
import { installFeeFixture, verifyFeeInteractions } from './fee-fixture.js';
import type { AccountPerformance, AuthenticatedPortfolioSnapshot } from '@gate-crossex/shared-types';

test.beforeEach(async ({ page }) => {
  await page.request.post('/__e2e/trading-mode', { data: { mode: 'readonly' } });
  await page.addInitScript(() => window.localStorage.setItem('crossex-language', 'en'));
  await page.route('**/api/preferences', (route) => route.request().method() === 'GET' ? route.fulfill({ json: { preferences: { language: 'en' } } }) : route.continue());
});

function observeTradingWrites(page: Page): string[] {
  const writes: string[] = [];
  page.on('request', (request) => {
    if (request.method() !== 'GET' && (request.headers()['x-gct-trading-intent']
      || /\/api\/(strategies|trading(?:\/|-mode)|crossex\/transfers)/.test(request.url()))) writes.push(`${request.method()} ${new URL(request.url()).pathname}`);
  });
  return writes;
}

async function dismiss(page: Page) {
  const dialog = page.getByRole('dialog', { name: /Risk disclaimer|风险免责声明/ });
  await dialog.waitFor({ state: 'visible', timeout: 1500 }).catch(() => undefined);
  if (await dialog.isVisible()) { await dialog.getByRole('checkbox').check(); await dialog.getByRole('button', { name: /Continue in read-only mode|以只读模式继续/ }).click(); }
}
test('execution separates market evidence from the order ticket and retains all conditional controls', async ({ page }) => {
  const writes = observeTradingWrites(page);
  await page.setViewportSize({ width: 2560, height: 1440 });
  await page.goto('/strategies/paired-position'); await dismiss(page);
  await expect(page.locator('.hedge-execution')).toBeVisible();
  await expect(page.locator('.running-strategies')).toHaveCount(1);
  const market = await page.locator('.strategy-market-panel').boundingBox();
  const chart = await page.locator('.strategy-funding-history').boundingBox();
  const entry = await page.locator('.strategy-rules').boundingBox();
  const management = await page.locator('.position-management-settings').boundingBox();
  const review = await page.locator('.strategy-launch').boundingBox();
  expect(market!.x + market!.width).toBeLessThan(chart!.x);
  expect(Math.abs(management!.y - entry!.y)).toBeLessThan(2);
  expect(entry!.x + entry!.width).toBeLessThan(management!.x);
  expect(Math.abs(entry!.width - management!.width)).toBeLessThan(2);
  expect(review!.width).toBeGreaterThan(2400);
  expect(review!.y).toBeGreaterThanOrEqual(Math.max(entry!.y + entry!.height, management!.y + management!.height));
  await expect(page.getByLabel('Exit clip quantity', { exact: true })).toBeVisible();
  await expect(page.locator('.hedge-review-details')).not.toHaveAttribute('open');
  await expect(page.locator('.hedge-review-group.fees')).toBeVisible();
  await page.screenshot({ path: 'data/hedge-layout-wide-visible.png', fullPage: true });
  const expanded = await page.locator('.position-management-settings').boundingBox();
  expect(expanded!.width).toBeGreaterThan(1100);
  expect(expanded!.width).toBeLessThan(1300);
  const expandedEntry = await page.locator('.strategy-rules').boundingBox();
  expect(Math.abs(expanded!.y - expandedEntry!.y)).toBeLessThan(2);
  await page.getByRole('button', { name: /Maker–Taker/, exact: false }).first().click();
  await expect(page.getByRole('group', { name: 'Choose maker leg' })).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Search asset', exact: true })).toBeVisible();
  for (const name of [/^Exchange A:/, /^Exchange B:/, /^Exchange A leverage:/, /^Exchange B leverage:/]) await expect(page.getByRole('button', { name })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Switch direction', exact: true })).toBeVisible();
  for (const name of ['Per-order quantity', 'Total amount', 'Entry threshold']) await expect(page.getByRole('textbox', { name, exact: true })).toBeVisible();
  await expect(page.getByRole('checkbox', { name: /Reduce only/ })).toBeVisible();
  await page.locator('.reduce-only-control b').click();
  await expect(page.getByRole('checkbox', { name: 'Reduce only', exact: true })).toBeChecked();
  await page.locator('.reduce-only-control b').click();
  await expect(page.getByRole('checkbox', { name: 'Reduce only', exact: true })).not.toBeChecked();
  await expect(page.getByRole('group', { name: 'Execution method', exact: true })).toBeVisible();
  await expect(page.locator('.hedge-review-group')).toHaveCount(6);
  await expect(page.getByRole('checkbox', { name: /Keep monitoring and exit automatically/ })).toBeChecked();
  await expect(page.getByLabel('Trigger rule', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Exit clip quantity', { exact: true })).toBeVisible();
  await expect(page.getByRole('checkbox', { name: /Allow market clips after maker timeout/ })).toBeVisible();
  const adopt = page.getByRole('checkbox', { name: /Adopt balanced holdings/ });
  const checked = await adopt.isChecked();
  const help = page.getByRole('button', { name: /Adopt balanced holdings.*\?/ });
  await help.click(); await expect(page.getByRole('note', { name: /Adopt balanced holdings/ })).toBeVisible();
  expect(await adopt.isChecked()).toBe(checked); await page.keyboard.press('Escape'); await expect(help).toBeFocused();
  for (const name of ['Spread below (bps)', 'Net funding APR below (%)', 'Confirmation duration (seconds)', 'Exit clip quantity', 'Batch interval (seconds)', 'Maker wait (seconds)', 'Exit maker leg']) await expect(page.getByLabel(name, { exact: true })).toBeVisible();
  await page.getByRole('textbox', { name: 'Total amount', exact: true }).fill('0.20');
  await page.getByRole('textbox', { name: 'Per-order quantity', exact: true }).fill('0.02');
  await page.getByLabel('Spread below (bps)', { exact: true }).fill('-25');
  await page.getByRole('checkbox', { name: 'Reduce only', exact: true }).check();
  await expect(page.locator('.position-management-settings')).toHaveCount(0);
  await page.getByRole('checkbox', { name: 'Reduce only', exact: true }).uncheck();
  await expect(page.getByLabel('Spread below (bps)', { exact: true })).toHaveValue('-25');
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: 'data/ui-redesign-execution-desktop.png', fullPage: true });
  for (const width of [2560, 1920, 1440, 1024, 768, 390]) {
    await page.setViewportSize({ width, height: 900 });
    const overflow = await page.evaluate(() => [...document.querySelectorAll('body *')].map((element) => ({ tag: element.tagName, className: element.className, right: element.getBoundingClientRect().right })).filter((r) => r.right > window.innerWidth + 1).slice(0, 12));
    expect(await page.evaluate(() => document.documentElement.scrollWidth), JSON.stringify(overflow)).toBe(width);
    await expect(page.getByRole('textbox', { name: 'Total amount', exact: true })).toHaveValue('0.20');
    await expect(page.getByRole('textbox', { name: 'Per-order quantity', exact: true })).toHaveValue('0.02');
    await expect(page.getByLabel('Spread below (bps)', { exact: true })).toHaveValue('-25');
  }
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: 'data/ui-redesign-execution-mobile.png', fullPage: true });
  await chineseScreenshot(page, 'execution');
  expect(writes).toEqual([]);
});

test('asset management preserves the original panels and adds six metrics with one shared modal view', async ({ page }) => {
  await page.setViewportSize({ width: 1536, height: 1024 });
  const at = Date.now(), metric = (value: string) => ({ value, status: 'ready' as const, reason: null, from: new Date(at - 86_400_000).toISOString(), to: new Date(at).toISOString() });
  const fixture: AccountPerformance = { profileId: 'gate-crossex-default', currency: 'USDT', timezone: 'Asia/Shanghai', baselineAt: new Date(at - 86_400_000).toISOString(), checkedAt: new Date(at).toISOString(),
    totalEquity: metric('128640.52'), availableBalance: metric('84312.80'), cumulativeProfit: metric('8640.52'), cumulativeReturn: metric('7.2004333333'), todayProfit: metric('142.86'), yesterdayProfit: metric('315.20'),
    points: Array.from({ length: 30 }, (_, i) => ({ at: at - (29 - i) * 60_000, equity: String(120000 + i * 8640.52 / 29), returnPct: String(i * 7.2004333333 / 29), reason: null })) };
  const writes = observeTradingWrites(page);
  const fetchedAt = new Date().toISOString();
  const portfolio: AuthenticatedPortfolioSnapshot = { dataStatus: 'fresh', remoteStatus: 'healthy',
    reconciliation: { id: 'design-test', createdAt: fetchedAt, status: 'clean', previousFetchedAt: null, currentFetchedAt: fetchedAt, issues: [] },
    snapshot: { source: 'gate_crossex_authenticated_rest', fetchedAt, account: { availableMargin: '84312.80', marginBalance: '128640.52', initialMargin: '40000', maintenanceMargin: '2000', initialMarginRate: '3', maintenanceMarginRate: '60', positionMode: 'SINGLE', accountMode: 'CROSS_EXCHANGE', exchangeType: 'CROSSEX', remoteUpdatedAt: fetchedAt },
      balances: [], marginPositions: [], openOrders: [], recentFills: [],
      futuresPositions: ['BINANCE', 'BYBIT'].map((venue, i) => ({ positionId: `test-${venue}`, symbol: `${venue}_FUTURE_BTC_USDT`, positionSide: i ? 'LONG' : 'SHORT', initialMargin: '20000', maintenanceMargin: '1000', quantity: i ? '1' : '-1', value: '128640.52', unrealizedPnl: '0', unrealizedPnlRate: '0', entryPrice: '128640.52', markPrice: '128640.52', leverage: '6', maxLeverage: '20', riskLimit: '1', fee: '0', fundingFee: '0', fundingTime: fetchedAt, createdAt: fetchedAt, updatedAt: fetchedAt, realizedPnl: '0', marginMode: 'ISOLATED', liquidationPrice: i ? '100000' : '160000', liquidationPriceCheckedAt: fetchedAt })) } };
  await page.route('**/api/onboarding/connection', async (route) => { const original = await (await route.fetch()).json(); await route.fulfill({ json: { ...original, configured: true, activeProfileId: fixture.profileId, label: 'Design QA · synthetic account' } }); });
  await page.route('**/api/crossex/portfolio-snapshot', (route) => route.fulfill({ json: portfolio }));
  await page.route('**/api/markets/funding-overview*', (route) => route.fulfill({ json: {
    assets: [{ asset: 'BTC', assetClass: 'CRYPTO_BLUE_CHIP', venues: ['BINANCE', 'BYBIT'].map((venue, i) => ({ venue, symbol: `${venue}_FUTURE_BTC_USDT`, quote: 'USDT', fundingRate: String((i ? -1 : 1) * .1842 / 2190), fundingRate8h: String((i ? -1 : 1) * .1842 / 2190), fundingIntervalHours: 8, nextFundingAt: null, openInterestValue: '10000000', lastPrice: '128640.52', change24h: null, fetchedAt })) }],
    venueStatus: ['BINANCE', 'BYBIT'].map((venue) => ({ venue, status: 'ok', fetchedAt, rowCount: 1 })), classification: { source: 'COINGECKO', marketCapLimit: 20, status: 'fresh', fetchedAt }, cacheStatus: 'fresh', fetchedAt } }));
  await page.request.post('/__e2e/paused-managed-strategy');
  await page.route('**/api/crossex/performance*', (route) => route.fulfill({ json: fixture }));
  await installFeeFixture(page);
  await page.goto('/position-management'); await dismiss(page);
  await expect(page.locator('.performance-kpi')).toHaveCount(6);
  await expect(page.locator('.performance-kpis')).toContainText('128,640.52');
  await expect(page.locator('.performance-kpis')).toContainText('+7.20%');
  await expect(page.locator('.performance-chart')).toHaveCount(1);
  await expect(page.locator('.performance-kpi').filter({ hasText: /Current funding APR|当前资金费年化/ })).toContainText('+18.42%');
  await expect(page).toHaveURL(/\/portfolio$/);
  await expect(page.locator('.portfolio-summary article')).toHaveCount(7);
  await expect(page.locator('.performance-kpis')).toContainText('128.46');
  await expect(page.locator('.performance-kpi').last().getByText('0', { exact: true })).toHaveCount(0);
  await expect(page.locator('.transaction-fee-overview')).toHaveCount(0);
  await expect(page.locator('.running-strategies')).toHaveCount(0);
  await page.getByRole('button', { name: '7D', exact: true }).click();
  await page.getByRole('button', { name: 'Net assets · left axis USDT' }).click();
  await page.getByRole('button', { name: 'Net assets · left axis USDT' }).click();
  await page.getByRole('button', { name: 'Positions · BTC', exact: true }).click();
  await expect(page.locator('.position-leg .liquidation-cell')).toHaveCount(0);
  await page.getByRole('textbox', { name: 'Transfer amount' }).fill('2.5');
  await page.locator('.portfolio-shortcut').click();
  const assetDialog = page.getByRole('dialog', { name: 'Asset overview', exact: true });
  await expect(assetDialog).toBeVisible();
  await expect(page.locator('.performance-kpi')).toHaveCount(6);
  await expect(assetDialog.getByRole('textbox', { name: 'Transfer amount' })).toHaveValue('2.5');
  // This synthetic BTC pair has no owning managed task. It must not use ordinary orders.
  await expect(assetDialog.getByRole('button', { name: 'Close all', exact: true })).toBeDisabled();
  await expect(assetDialog.getByText('No unique managed task owns this pair')).toBeVisible();
  await expect(assetDialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(assetDialog).toHaveCount(0);
  await expect(page.locator('.portfolio-shortcut')).toBeFocused();
  await expect(page.getByRole('textbox', { name: 'Transfer amount' })).toHaveValue('2.5');
  expect(writes).toEqual([]);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: 'data/ui-redesign-positions-desktop.png', fullPage: true });
  for (const width of [1440, 1024, 768, 390]) { await page.setViewportSize({ width, height: 900 }); expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width); }
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: 'data/ui-redesign-positions-mobile.png', fullPage: true });
  await chineseScreenshot(page, 'positions');
  await page.goto('/strategies/paired-position'); await dismiss(page);
  await verifyFeeInteractions(page);
  expect(writes).toEqual([]);
});

test.afterEach(async ({ page }) => { await page.request.delete('/__e2e/paused-managed-strategy'); await page.request.put('/api/preferences', { data: { language: 'en' } }); });
async function chineseScreenshot(page: Page, kind: 'execution' | 'positions') {
  await page.setViewportSize({ width: 1536, height: 1024 });
  await page.unroute('**/api/preferences');
  await page.route('**/api/preferences', (route) => route.request().method() === 'GET' ? route.fulfill({ json: { preferences: { language: 'zh' } } }) : route.continue());
  await page.reload(); await dismiss(page);
  if (kind === 'execution') {
    await page.locator('.execution-method-options button').last().click();
    await page.locator('.compact-fields input').nth(0).fill('0.01');
    await page.locator('.compact-fields input').nth(1).fill('0.10');
    await expect(page.locator('.management-fields')).toHaveCount(2);
  } else {
    await expect(page.locator('.performance-kpi').filter({ hasText: /Current funding APR|当前资金费年化/ })).toContainText('+18.42%');
    await expect(page.locator('.performance-kpis')).toContainText('128.46');
  }
  await page.evaluate(() => window.scrollTo(0, 0));
  const documentHeight = await page.evaluate(() => document.documentElement.scrollHeight);
  await page.setViewportSize({ width: 1536, height: Math.max(1024, documentHeight) });
  await page.mouse.move(0, 0);
  await page.screenshot({ path: `data/ui-redesign-${kind}-zh.png` });
}
