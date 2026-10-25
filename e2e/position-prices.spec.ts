import { expect, test, type Page } from '@playwright/test';
import { TradingSnapshotSchema } from '@gate-crossex/shared-types';
import AxeBuilder from '@axe-core/playwright';

const now = '2030-01-01T00:00:00.000Z';
const legs = [
  { venue: 'HYPERLIQUID', quote: 'USDC', quantity: '100', entry: '51.12345678', mark: '52.12' },
  { venue: 'KRAKEN', quote: 'USD', quantity: '-100', entry: '53.34', mark: '54.56' },
  { venue: 'BYBIT', quote: 'USDT', quantity: '-10', entry: '', mark: '0' },
];

async function setup(page: Page, count: number, stale = false) {
  await page.addInitScript(() => localStorage.setItem('crossex-language', 'en'));
  await page.route('**/api/preferences', route => route.request().method() === 'GET'
    ? route.fulfill({ json: { preferences: { language: 'en' } } }) : route.continue());
  await page.route('**/api/onboarding/connection', async route => {
    const original = await (await route.fetch()).json();
    await route.fulfill({ json: { ...original, configured: true, activeProfileId: 'gate-crossex-default' } });
  });
  const positions = legs.slice(0, count).map((leg, i) => ({
    position_id: `synthetic-price-${i}`, symbol: `${leg.venue}_FUTURE_HYPE_${leg.quote}`, venue: leg.venue,
    quantity: leg.quantity, entry_price: leg.entry, mark_price: leg.mark, realized_pnl: '2', updated_at: now,
  }));
  // Snapshot source is always live; execution permission remains the fixture server's readonly mode.
  const snapshot = TradingSnapshotSchema.parse({ mode: 'live', orders: [], fills: [], balances: [], positions });
  await page.routeWebSocket('**/ws/stream', socket => {
    const server = socket.connectToServer();
    server.onMessage(message => {
      const event = JSON.parse(String(message));
      socket.send(event.type === 'execution.snapshot' ? JSON.stringify({ ...event, payload: snapshot }) : message);
    });
  });
  await page.route('**/api/trading/snapshot', route => route.fulfill({ json: snapshot }));
  await page.route('**/api/crossex/positions-snapshot', route => route.fulfill({ json: snapshot }));
  await page.route('**/api/crossex/portfolio-snapshot', route => route.fulfill({ json: {
    dataStatus: stale ? 'stale' : 'fresh', remoteStatus: stale ? 'unavailable' : 'healthy',
    reconciliation: { id: 'synthetic-price', createdAt: now, status: 'clean', previousFetchedAt: null, currentFetchedAt: now, issues: [] },
    snapshot: { source: 'gate_crossex_authenticated_rest', fetchedAt: now,
      account: { availableMargin: '1000', marginBalance: '2000', initialMargin: '100', maintenanceMargin: '10',
        initialMarginRate: '5', maintenanceMarginRate: '200', positionMode: 'SINGLE', accountMode: 'CROSS_EXCHANGE', exchangeType: 'CROSSEX', remoteUpdatedAt: now },
      balances: [], marginPositions: [], openOrders: [], recentFills: [], futuresPositions: positions.map((p, i) => ({
        positionId: p.position_id, symbol: p.symbol, positionSide: i ? 'SHORT' : 'LONG', quantity: p.quantity,
        initialMargin: '50', maintenanceMargin: '5', value: '500', unrealizedPnl: '3', unrealizedPnlRate: '0',
        entryPrice: p.entry_price, markPrice: p.mark_price, leverage: '1', maxLeverage: '20', riskLimit: '1', fee: '0',
        fundingFee: '0', fundingTime: now, createdAt: now, updatedAt: now, realizedPnl: '2',
      })) },
  } }));
}

test('stale strategy holdings remain visible with timestamps and disabled close actions', async ({ page }) => {
  await setup(page, 2, true);
  const writes: string[] = [];
  const closeReads: string[] = [];
  page.on('request', request => { if (new URL(request.url()).pathname === '/api/strategies/close-targets') closeReads.push(request.url()); });
  page.on('request', request => { if (/\/api\/strategies\/.*\/stop/.test(request.url()) && request.method() !== 'GET') writes.push(request.url()); });
  await open(page, '/strategies/paired-position');
  await expect(page.getByRole('tab', { name: /^Positions/ })).toContainText('—');
  await expect(page.getByRole('status').filter({ hasText: 'last-confirmed positions' })).toContainText(now);
  const table = page.locator('.positions-table');
  await expect(table).toContainText('HYPE');
  await expect(table).toContainText('51.1235');
  const closes = table.getByRole('button').filter({ hasText: /Close/ });
  expect(await closes.count()).toBeGreaterThan(0);
  for (const button of await closes.all()) await expect(button).toBeDisabled();
  expect(writes).toEqual([]);
  expect(closeReads).toEqual([]);
});

async function open(page: Page, path: string) {
  await page.goto(path);
  const dialog = page.getByRole('dialog', { name: 'Risk disclaimer' });
  await dialog.waitFor({ state: 'visible', timeout: 1500 }).catch(() => undefined);
  if (await dialog.isVisible()) {
    await dialog.getByRole('checkbox').check();
    await dialog.getByRole('button', { name: 'Continue in read-only mode' }).click();
  }
  if (path.startsWith('/strategies')) await page.getByRole('tab', { name: /^Positions/ }).click();
}

for (const path of ['/', '/portfolio', '/strategies/paired-position']) {
  test(`per-leg prices and existing expansion on ${path}`, async ({ page }) => {
    await page.setViewportSize({ width: 1920, height: 1440 });
    await setup(page, 2);
    await open(page, path);
    const group = page.locator('.aggregate-row').filter({ hasText: 'HYPE PERP' });
    const prices = group.locator('.position-price-cell');
    await expect(prices.nth(0)).toContainText('Long · HYPERLIQUID');
    await expect(prices.nth(0)).toContainText('51.1235 USDC');
    await expect(prices.nth(0)).toContainText('53.34 USD');
    await expect(prices.nth(1)).toContainText('Short · KRAKEN');
    await expect(prices.nth(1)).toContainText('52.12 USDC');
    await expect(prices.nth(1)).toContainText('54.56 USD');
    await expect(prices.nth(0).locator('.position-price-line').filter({ hasText: 'HYPERLIQUID' }))
      .toHaveAttribute('title', /51\.12345678 USDC/);
    const financialCells = [2, 3, 4, 8, 9, 10];
    const before = await Promise.all(financialCells.map(i => group.locator('td').nth(i).innerText()));
    const mutations: string[] = [];
    page.on('request', request => {
      if (new URL(request.url()).pathname.startsWith('/api/') && !['GET', 'HEAD'].includes(request.method())) mutations.push(request.url());
    });
    await group.locator('.expand-position').click();
    await expect(page.locator('.position-leg')).toHaveCount(2);
    await expect(page.locator('.position-leg').filter({ hasText: 'Kraken' }).locator('.position-price-cell').nth(0)).toHaveText('53.34 USD');
    if (path === '/portfolio') await page.locator('.positions-table').screenshot({ path: 'data/investigations/grouped-position-prices-20261023/desktop-fixed.png' });
    await group.locator('.expand-position').click();
    await expect(page.locator('.position-leg')).toHaveCount(0);
    expect(await Promise.all(financialCells.map(i => group.locator('td').nth(i).innerText()))).toEqual(before);
    expect(mutations).toEqual([]);
  });
}

test('three legs expand all prices with missing and explicit zero at narrow width', async ({ page }) => {
  await page.setViewportSize({ width: 640, height: 900 });
  await setup(page, 3);
  await open(page, '/portfolio');
  const group = page.locator('.aggregate-row').filter({ hasText: 'HYPE PERP' });
  await expect(group.locator('.position-price-cell').first()).toHaveText('3 leg prices · Expand');
  await group.getByRole('button', { name: 'HYPE · Entry price · Expand', exact: true }).click();
  await expect(page.locator('.position-leg')).toHaveCount(3);
  const missing = page.locator('.position-leg').filter({ hasText: 'Bybit' });
  await expect(missing.locator('.position-price-cell').nth(0)).toHaveText('Unavailable');
  await expect(missing.locator('.position-price-cell').nth(1)).toHaveText('0 USDT');
  await page.locator('.positions-table').screenshot({ path: 'data/investigations/grouped-position-prices-20261023/narrow-fixed.png' });
  await group.getByRole('button', { name: 'HYPE · Mark price · Collapse', exact: true }).click();
  await expect(page.locator('.position-leg')).toHaveCount(0);
});

for (const theme of ['dark', 'light']) {
  test(`price labels stay readable in ${theme} theme and scroll within a narrow table`, async ({ page }) => {
    await page.setViewportSize({ width: 1920, height: 1080 });
    await setup(page, 2);
    await page.addInitScript(value => localStorage.setItem('crossex-theme', value), theme);
    await open(page, '/portfolio');
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    const group = page.locator('.aggregate-row').filter({ hasText: 'HYPE PERP' });
    await expect(group.locator('.position-price-cell').first()).toContainText('51.1235 USDC');
    const audit = await new AxeBuilder({ page }).include('.position-price-cell').analyze();
    expect(audit.violations.map(item => ({ id: item.id, impact: item.impact }))).toEqual([]);
    await group.screenshot({ path: `data/investigations/grouped-position-prices-20261023/summary-${theme}.png` });
    await page.setViewportSize({ width: 640, height: 900 });
    const entry = group.locator('.position-price-cell').first();
    await entry.scrollIntoViewIfNeeded();
    await expect(entry).toContainText('53.34 USD');
    expect(await entry.evaluate(cell => cell.scrollWidth <= cell.clientWidth + 1)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}
