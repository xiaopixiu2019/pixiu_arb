import type { FundingOverviewResponse } from '@gate-crossex/shared-types';
import { expect, test, type Page } from '@playwright/test';

async function readonly(page: Page) {
  await page.request.post('/__e2e/trading-mode', { data: { mode: 'readonly' } });
  await page.addInitScript(() => window.localStorage.setItem('crossex-language', 'en'));
  await page.route('**/api/preferences', (route) => route.request().method() === 'GET'
    ? route.fulfill({ json: { preferences: { language: 'en' } } }) : route.continue());
}
async function dismiss(page: Page) {
  const dialog = page.getByRole('dialog', { name: 'Risk disclaimer' });
  await dialog.waitFor({ state: 'visible', timeout: 1000 }).catch(() => undefined);
  if (await dialog.isVisible()) { await dialog.getByRole('checkbox').check(); await dialog.getByRole('button', { name: /Continue in read-only mode/ }).click(); }
}
function overview(assets: string[], rate: (asset: string) => number): FundingOverviewResponse {
  const fetchedAt = new Date().toISOString();
  return { fetchedAt, cacheStatus: 'fresh', classification: { source: 'COINGECKO', marketCapLimit: 20, status: 'fresh', fetchedAt },
    venueStatus: ['GATE', 'HYPERLIQUID'].map((venue) => ({ venue, status: 'ok', fetchedAt, rowCount: assets.length })),
    assets: assets.map((asset) => ({ asset, assetClass: 'CRYPTO_ALTCOIN', venues: ['GATE', 'HYPERLIQUID'].map((venue) => ({
      venue, symbol: `${venue}_FUTURE_${asset}_${venue === 'GATE' ? 'USDT' : 'USDC'}`, quote: venue === 'GATE' ? 'USDT' : 'USDC',
      fundingRate: venue === 'GATE' ? '0' : String(rate(asset)), fundingRate8h: venue === 'GATE' ? '0' : String(rate(asset)),
      fundingIntervalHours: 8, nextFundingAt: null, openInterestValue: '10000000', lastPrice: '99999', change24h: null, fetchedAt,
    })) })) };
}

test('pending historical funding never displays zero and refreshes in place when complete', async ({ page }) => {
  await readonly(page); await page.clock.install();
  let complete = false, reads = 0;
  await page.route('**/api/markets/funding-overview*', route => route.fulfill({ json: overview(['BTC', 'ETH'], () => 0.0001) }));
  for (const endpoint of ['funding-history', 'funding-rankings']) {
    await page.route(`**/api/markets/${endpoint}`, async route => {
      const symbols: string[] = route.request().postDataJSON().symbols;
      if (endpoint === 'funding-history') reads++;
      await route.fulfill({ json: { fetchedAt: new Date().toISOString(), entries: symbols.map(symbol => ({
        symbol, status: complete ? 'ok' : 'pending', rate24h: complete ? '0.001' : null,
        rate7d: complete ? '0.002' : null, rate30d: complete ? '0.003' : null,
        settlementCount30d: complete ? 3 : 0, oldestFundingAt: null, newestFundingAt: null,
        fetchedAt: new Date().toISOString(),
      })) } });
    });
  }
  await page.goto('/funding-rates'); await dismiss(page);
  await page.getByRole('button', { name: 'Cumulative 24h', exact: true }).click();
  const cells = page.locator('.funding-clickable-row .average-funding-cell');
  await expect.poll(() => reads).toBeGreaterThan(0);
  await expect(cells).toHaveText(['—', '—']);
  const order = await page.locator('.funding-clickable-row .funding-history-link').allTextContents();
  complete = true; await page.clock.fastForward(8_100);
  await expect(cells.first()).toContainText('0.1');
  expect(await page.locator('.funding-clickable-row .funding-history-link').allTextContents()).toEqual(order);
});

test('APR values update without moving rows until explicit ranking, preserving manual metric/sort', async ({ page }) => {
  await readonly(page); await page.clock.install();
  let refresh = false;
  await page.route('**/api/markets/funding-overview*', (route) => route.fulfill({ json: overview(['AAA', 'BTC', 'ZZZ', ...Array.from({ length: 27 }, (_, index) => `M${index}`)], (asset) => asset === (refresh ? 'AAA' : 'ZZZ') ? 0.0003 : 0.0001) }));
  await page.route('**/api/markets/reference-quotes?*', (route) => route.fulfill({ json: { entries: [], fetchedAt: new Date().toISOString() } }));
  await page.goto('/funding-rates'); await dismiss(page);
  const rows = page.locator('.funding-clickable-row');
  await expect(page.getByRole('button', { name: 'APR', exact: true })).toHaveClass(/active/);
  await expect(rows.first()).toContainText('ZZZ');
  await page.locator('.page-size select').selectOption('25');
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  const secondPage = await rows.locator('.funding-history-link').allTextContents();
  refresh = true; await page.clock.fastForward(31_000);
  expect(await rows.locator('.funding-history-link').allTextContents()).toEqual(secondPage);
  await page.getByRole('button', { name: 'First page', exact: true }).click();
  await expect(rows.first()).toContainText('ZZZ');
  await expect(rows.first().locator('.arb-summary strong')).toHaveText('+10.95%');
  await page.getByRole('button', { name: 'Update ranking', exact: true }).click();
  await expect(rows.first()).toContainText('AAA');
  await page.getByRole('button', { name: 'Per interval', exact: true }).click();
  await page.locator('th .sort-header').filter({ hasText: /^Asset/ }).click();
  await expect(rows.first()).toContainText('AAA');
  refresh = false; await page.clock.fastForward(31_000);
  await expect(page.getByRole('button', { name: 'Per interval', exact: true })).toHaveClass(/active/);
  await expect(rows.first()).toContainText('AAA');
  await expect(page.locator('th .sort-header').filter({ hasText: /^Asset/ })).toContainText('↑');
});

test('funding and hedge use the same books, reversal reads opposite sides, missing books never become zero or ready', async ({ page }) => {
  await readonly(page); await page.clock.install();
  const writes: string[] = [];
  page.on('request', (request) => { if (request.headers()['x-gct-trading-intent']) writes.push(request.url()); });
  let missing = false;
  await page.route('**/api/markets/catalog', (route) => route.fulfill({ json: { fetchedAt: new Date().toISOString(), cacheStatus: 'fresh', assets: [
    { asset: 'MNT', streamed: false, venues: [{ venue: 'GATE', symbol: 'GATE_FUTURE_MNT_USDT', quote: 'USDT' }, { venue: 'HYPERLIQUID', symbol: 'HYPERLIQUID_FUTURE_MNT_USDC', quote: 'USDC' }] },
  ] } }));
  await page.route('**/api/markets/funding-overview*', (route) => route.fulfill({ json: overview(['MNT'], () => 0.0003) }));
  await page.route('**/api/markets/reference-quotes?*', (route) => {
    const fetchedAt = new Date().toISOString();
    const symbols = new URL(route.request().url()).searchParams.get('symbols')!.split(',');
    return route.fulfill({ json: { fetchedAt, entries: symbols.map((symbol) => ({ symbol, status: missing ? 'unavailable' : 'ok', fetchedAt,
      bookObservedAt: fetchedAt, bidPrice: symbol.startsWith('GATE_') ? '100' : '103', askPrice: symbol.startsWith('GATE_') ? '101' : '104',
    })) } });
  });
  await page.goto('/funding-rates'); await dismiss(page);
  const value = page.locator('.funding-price-cell');
  await expect(value).toHaveText('+198.02 bps');
  await page.screenshot({ path: 'data/funding-spread-consistency-20261011/funding-reference.png', fullPage: true });
  await page.getByRole('button', { name: /Open hedge strategy: MNT/ }).click();
  await expect(page.locator('.leg-spread strong')).toHaveText('+198.02 bps');
  await page.screenshot({ path: 'data/funding-spread-consistency-20261011/hedge-reference.png', fullPage: true });
  await expect(page.locator('.compact-trigger .ready')).toHaveCount(0);
  await page.getByRole('button', { name: 'Switch direction', exact: true }).click();
  await expect(page.locator('.leg-spread strong')).toHaveText('-384.62 bps');
  missing = true; await page.clock.fastForward(16_000);
  await expect(page.locator('.leg-spread strong')).toHaveText('—');
  await expect(page.locator('.compact-trigger .ready')).toHaveCount(0);
  await expect(page.locator('.leg-spread strong')).toHaveAttribute('title', /unavailable or stale/);
  expect(writes).toEqual([]);
});

test('global price ranking retains all 1002 contracts beyond the shared cache limit', async ({ page }) => {
  await readonly(page);
  const assets = Array.from({ length: 501 }, (_, index) => `R${String(index).padStart(3, '0')}`);
  const requested = new Set<string>();
  await page.route('**/api/markets/funding-overview*', (route) => route.fulfill({ json: overview(assets, () => 0.0001) }));
  await page.route('**/api/markets/reference-quotes?*', (route) => {
    const fetchedAt = new Date().toISOString(), symbols = new URL(route.request().url()).searchParams.get('symbols')!.split(',');
    expect(symbols.length).toBeLessThanOrEqual(20);
    return route.fulfill({ json: { fetchedAt, entries: symbols.map((symbol) => {
      requested.add(symbol);
      const index = Number(symbol.split('_')[2].slice(1));
      const price = symbol.startsWith('GATE_') ? 100 : 100 + index / 100;
      return { symbol, status: 'ok', bidPrice: String(price), askPrice: String(price), fetchedAt, bookObservedAt: fetchedAt };
    }) } });
  });
  await page.goto('/funding-rates'); await dismiss(page);
  await page.locator('.funding-price-heading button').click();
  await expect.poll(() => requested.size, { timeout: 20_000 }).toBe(1002);
  await expect(page.locator('.funding-clickable-row').first()).toContainText('R500');
  await page.getByRole('button', { name: 'Last page', exact: true }).click();
  await expect(page.locator('.funding-clickable-row').last()).toContainText('R000');
  await expect(page.locator('.funding-clickable-row').last().locator('.funding-price-cell')).toHaveText('+0.00 bps');
});

test('a stalled global quote collection does not age out the independently refreshed visible page', async ({ page }) => {
  await readonly(page); await page.clock.install();
  const assets = Array.from({ length: 150 }, (_, index) => `D${String(index).padStart(3, '0')}`);
  let stalled = false, visibleReads = 0, release: (() => void) | undefined;
  const barrier = new Promise<void>((resolve) => { release = resolve; });
  await page.route('**/api/markets/funding-overview*', (route) => route.fulfill({ json: overview(assets, () => 0.0001) }));
  await page.route('**/api/markets/reference-quotes?*', async (route) => {
    const symbols = new URL(route.request().url()).searchParams.get('symbols')!.split(',');
    if (symbols.some((symbol) => Number(symbol.split('_')[2].slice(1)) >= 50)) { stalled = true; await barrier; }
    else visibleReads += 1;
    const fetchedAt = await page.evaluate(() => new Date().toISOString());
    await route.fulfill({ json: { fetchedAt, entries: symbols.map((symbol) => {
      const index = Number(symbol.split('_')[2].slice(1)), price = symbol.startsWith('GATE_') ? 100 : 100 + index / 100;
      return { symbol, status: 'ok', bidPrice: String(price), askPrice: String(price), fetchedAt, bookObservedAt: fetchedAt };
    }) } });
  });
  await page.goto('/funding-rates'); await dismiss(page);
  await expect(page.locator('.funding-clickable-row').nth(49).locator('.funding-price-cell')).toHaveText('+49.00 bps');
  await page.locator('.funding-price-heading button').click();
  await expect.poll(() => stalled).toBe(true);
  // Partial batches must not move rows before the single ranking commit.
  await expect(page.locator('.funding-clickable-row').first()).toContainText('D000');
  const readsBefore = visibleReads;
  await page.clock.fastForward(16_000);
  await expect(page.locator('.funding-clickable-row').first()).toContainText('D049');
  await expect(page.getByRole('button', { name: 'Update ranking', exact: true })).toBeEnabled();
  await page.clock.fastForward(30_000);
  await expect.poll(() => visibleReads).toBeGreaterThan(readsBefore);
  await expect(page.locator('.funding-clickable-row').first().locator('.funding-price-cell')).toHaveText('+49.00 bps');
  await expect(page.getByText('Loading reference quotes; order stays in place…', { exact: true })).toBeVisible();
  release!();
  await expect(page.getByText('Loading reference quotes; order stays in place…', { exact: true })).toBeHidden();
  await expect(page.locator('.funding-clickable-row').first()).toContainText('D049');
  await page.getByRole('button', { name: 'Update ranking', exact: true }).click();
  await expect(page.locator('.funding-clickable-row').first()).toContainText('D149');
});

test('price changes, unavailable quotes and recovery update cells without moving the action target', async ({ page }) => {
  await readonly(page); await page.clock.install();
  let mode: 'initial' | 'changed' | 'missing' | 'stale' = 'initial';
  await page.route('**/api/markets/funding-overview*', (route) => route.fulfill({ json: overview(['BTC', 'ETH', 'SOL'], () => 0.0001) }));
  await page.route('**/api/markets/reference-quotes?*', async (route) => {
    const fetchedAt = await page.evaluate(() => new Date().toISOString());
    const symbols = new URL(route.request().url()).searchParams.get('symbols')!.split(',');
    await route.fulfill({ json: { fetchedAt, entries: symbols.map((symbol) => {
      const asset = symbol.split('_')[2];
      const price = symbol.startsWith('GATE_') ? 100 : asset === 'BTC' ? 103 : asset === 'ETH' ? mode === 'initial' ? 102 : 104 : 101;
      return { symbol, status: mode === 'missing' && asset === 'BTC' ? 'unavailable' : 'ok',
        bidPrice: String(price), askPrice: String(price), fetchedAt, bookObservedAt: mode === 'stale' && asset === 'BTC' ? new Date(Date.parse(fetchedAt) - 46_000).toISOString() : fetchedAt };
    }) } });
  });
  await page.goto('/funding-rates'); await dismiss(page);
  await page.locator('.funding-price-heading button').click();
  const rows = page.locator('.funding-clickable-row');
  const assets = () => rows.locator('.funding-history-link').evaluateAll((elements) => elements.map((element) => element.getAttribute('aria-label')));
  await expect(page.getByRole('button', { name: 'Update ranking', exact: true })).toBeEnabled();
  const original = await assets();
  mode = 'changed'; await page.clock.fastForward(6_000);
  await expect(rows.nth(1).locator('.funding-price-cell')).toHaveText('+400.00 bps');
  expect(await assets()).toEqual(original);
  mode = 'stale'; await page.clock.fastForward(6_000);
  await expect(rows.first().locator('.funding-price-cell')).toHaveText('—');
  expect(await assets()).toEqual(original);
  mode = 'missing'; await page.clock.fastForward(6_000);
  await expect(rows.first().locator('.funding-price-cell')).toHaveText('—');
  expect(await assets()).toEqual(original);
  mode = 'changed'; await page.clock.fastForward(6_000);
  await expect(rows.first().locator('.funding-price-cell')).toHaveText('+300.00 bps');
  expect(await assets()).toEqual(original);
  await page.getByRole('button', { name: 'Update ranking', exact: true }).click();
  await expect(rows.first()).toContainText('ETH');
  await expect(rows.nth(1)).toContainText('BTC');
  await rows.nth(1).getByRole('button', { name: /Open hedge strategy: BTC/ }).click();
  await expect(page).toHaveURL(/strategies\/paired-position/);
});

test('OI threshold crossings and removed assets preserve membership until explicit refresh', async ({ page }) => {
  await readonly(page); await page.clock.install();
  let changed = false;
  await page.route('**/api/markets/funding-overview*', (route) => {
    const response = overview(changed ? ['BTC', 'SOL'] : ['BTC', 'ETH', 'SOL'], () => 0.0001);
    for (const asset of response.assets) for (const venue of asset.venues) {
      venue.openInterestValue = (asset.asset === 'SOL' ? !changed : asset.asset === 'BTC' && changed) ? '4900000' : '5100000';
    }
    return route.fulfill({ json: response });
  });
  await page.route('**/api/markets/reference-quotes?*', (route) => route.fulfill({ json: { entries: [], fetchedAt: new Date().toISOString() } }));
  await page.goto('/funding-rates'); await dismiss(page);
  const rows = page.locator('.funding-clickable-row');
  await expect(rows).toHaveCount(2);
  await expect(rows.first()).toContainText('BTC');
  await expect(rows.last()).toContainText('ETH');
  changed = true; await page.clock.fastForward(31_000);
  await expect(rows.first().locator('.oi-avg')).toHaveText('avg $4.9M');
  await expect(rows).toHaveCount(2);
  await expect(rows.last()).toContainText('ETH');
  await expect(rows.last().locator('.arb-strategy-button')).toHaveCount(0);
  await expect(rows.last().locator('.arb-summary strong')).toHaveText('—');
  await expect(page.getByText('Filter matches changed; update ranking to apply.', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Update ranking', exact: true }).click();
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText('SOL');
  await page.getByRole('button', { name: 'Any', exact: true }).click();
  await expect(rows).toHaveCount(2);
});

test('switching filters cancels pending historical ranking and ignores its late result', async ({ page }) => {
  await readonly(page);
  const fetchedAt = new Date().toISOString();
  let release: (() => void) | undefined, requested = false;
  const barrier = new Promise<void>((resolve) => { release = resolve; });
  await page.route('**/api/markets/funding-overview*', (route) => route.fulfill({ json: overview(['BTC', 'ETH'], () => 0.0001) }));
  await page.route('**/api/markets/reference-quotes?*', (route) => route.fulfill({ json: { entries: [], fetchedAt } }));
  await page.route('**/api/markets/funding-rankings', async (route) => {
    const { symbols } = route.request().postDataJSON() as { symbols: string[] };
    if (symbols.some((symbol) => symbol.includes('_ETH_'))) { requested = true; await barrier; }
    await route.fulfill({ json: { fetchedAt, entries: symbols.map((symbol) => ({ symbol, status: 'ok', rate24h: '0.01', rate7d: '0.01', rate30d: '0.01',
      settlementCount30d: 1, oldestFundingAt: fetchedAt, newestFundingAt: fetchedAt, fetchedAt })) } });
  });
  await page.goto('/funding-rates'); await dismiss(page);
  await page.getByRole('button', { name: 'Cumulative 7d', exact: true }).click();
  await expect.poll(() => requested).toBe(true);
  await page.getByRole('textbox', { name: 'Search asset', exact: true }).fill('BTC');
  const rows = page.locator('.funding-clickable-row');
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText('BTC');
  release!();
  await expect(page.getByRole('button', { name: 'Update ranking', exact: true })).toBeEnabled();
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText('BTC');
});
