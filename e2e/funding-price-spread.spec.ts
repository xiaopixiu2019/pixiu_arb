import { expect, test } from '@playwright/test';

test('shows signed bps for the funding-selected legs and ranks across pages without changing other columns', async ({ page }) => {
  const fetchedAt = new Date().toISOString();
  const assets = ['BTC', 'ETH', 'ZERO', 'MISSING', ...Array.from({ length: 49 }, (_, i) => `A${String(i).padStart(2, '0')}`), 'ZZZ'];
  await page.route('**/api/markets/funding-overview', (route) => route.fulfill({ json: {
    assets: assets.map((asset, i) => ({ asset, assetClass: 'CRYPTO_BLUE_CHIP', venues: ['GATE', 'BINANCE', 'HYPERLIQUID'].map((venue) => {
      const quote = venue === 'HYPERLIQUID' ? 'USDC' : 'USDT';
      const buy = asset === 'BTC' ? 86350.3 : 100;
      const sell = asset === 'BTC' ? 86461 : asset === 'ETH' ? 99 : asset === 'ZERO' ? 100 : asset === 'ZZZ' ? 103 : 101;
      return { venue, symbol: `${venue}_FUTURE_${asset}_${quote}`, quote,
        fundingRate: venue === 'BINANCE' ? '0.00001' : venue === 'GATE' ? '0.0001' : (['BTC', 'ETH'].includes(asset) ? '0.0003' : '0.0002'),
        fundingIntervalHours: 8, fundingRate8h: venue === 'BINANCE' ? '0.00001' : venue === 'GATE' ? '0.0001' : (['BTC', 'ETH'].includes(asset) ? '0.0003' : '0.0002'),
        nextFundingAt: null, openInterestValue: String(100_000_000 - i * 1_000_000),
        lastPrice: '99999', // Deliberately unrelated: missing books must never fall back to this.
        bidPrice: asset === 'MISSING' ? null : String(venue === 'BINANCE' ? buy : venue === 'GATE' ? buy * 1.05 : sell),
        askPrice: asset === 'MISSING' ? null : String(venue === 'BINANCE' ? buy : venue === 'GATE' ? buy * 1.05 : sell),
        bookObservedAt: fetchedAt,
        change24h: null, fetchedAt,
      };
    }) })),
    venueStatus: ['GATE', 'BINANCE', 'HYPERLIQUID'].map((venue) => ({ venue, status: 'ok', fetchedAt, rowCount: assets.length })),
    classification: { source: 'COINGECKO', marketCapLimit: 20, status: 'fresh', fetchedAt }, fetchedAt, cacheStatus: 'fresh',
  } }));
  await page.route('**/api/markets/reference-quotes?*', (route) => {
    const symbols = new URL(route.request().url()).searchParams.get('symbols')!.split(',');
    return route.fulfill({ json: { fetchedAt, entries: symbols.map((symbol) => {
      const [venue, , asset] = symbol.split('_');
      const buy = asset === 'BTC' ? 86350.3 : 100;
      const sell = asset === 'BTC' ? 86461 : asset === 'ETH' ? 99 : asset === 'ZERO' ? 100 : asset === 'ZZZ' ? 103 : 101;
      const price = String(venue === 'BINANCE' ? buy : venue === 'GATE' ? buy * 1.05 : sell);
      return { symbol, status: asset === 'MISSING' ? 'unavailable' : 'ok', bidPrice: asset === 'MISSING' ? null : price,
        askPrice: asset === 'MISSING' ? null : price, bookObservedAt: fetchedAt, fetchedAt };
    }) } });
  });
  await page.goto('/funding-rates');
  const dialog = page.getByRole('dialog', { name: 'Risk disclaimer' });
  await dialog.waitFor({ state: 'visible', timeout: 1_000 }).catch(() => undefined);
  if (await dialog.isVisible()) {
    await dialog.getByRole('checkbox').check();
    await dialog.getByRole('button', { name: /Continue in read-only mode/ }).click();
  }
  const rows = page.locator('.funding-clickable-row');
  const btc = rows.filter({ has: page.getByRole('button', { name: 'BTC Historical funding', exact: true }) });
  await expect(page.getByRole('button', { name: 'APR', exact: true })).toHaveClass(/active/);
  await expect(page.locator('.sort-header').filter({ hasText: 'Max arb' })).toContainText('↓');
  await expect(btc.locator('.funding-price-cell')).toHaveText('+12.82 bps');
  await expect(btc.locator('.funding-price-cell strong')).toHaveClass('positive');
  await expect(rows.filter({ hasText: 'Ethereum' }).locator('.funding-price-cell strong')).toHaveClass('negative');
  await expect(page.locator('.funding-table th').nth(3)).toContainText('Max arb');
  await expect(page.locator('.funding-table th').nth(4)).toHaveText(/Price difference/);
  await expect(page.locator('.funding-table th').nth(5)).toContainText('Gate.io');
  await expect(btc.locator('.arb-cell')).toContainText('Long BN · Short HL');
  const originalCells = await btc.locator('td:not(.funding-price-cell)').allTextContents();
  const sort = page.locator('.funding-price-heading button');
  await sort.click();
  await expect(rows.first()).toContainText('ZZZ');
  await page.getByRole('button', { name: 'Last page', exact: true }).click();
  await expect(btc.locator('td:not(.funding-price-cell)')).toHaveText(originalCells);
  await expect(rows.last()).toContainText('MISSING');
  await expect(rows.last().locator('.funding-price-cell')).toHaveText('—');
  await sort.click();
  await expect(rows.first()).toContainText('ETH');
  await expect(rows.nth(1)).toContainText('ZERO');
  await expect(rows.nth(1).locator('.funding-price-cell')).toHaveText('+0.00 bps');
  await page.getByRole('button', { name: 'Last page', exact: true }).click();
  await expect(rows.last()).toContainText('MISSING');
  await page.getByRole('button', { name: 'First page', exact: true }).click();
  await page.locator('.exchange-filter').getByRole('button', { name: /Hyperliquid/ }).click();
  await expect(btc.locator('.arb-cell')).toContainText('Long BN · Short GT');
  await expect(btc.locator('.funding-price-cell')).toHaveText('+500.00 bps');
  // Historical ranking must resolve all symbols before selecting and sorting legs.
  let rankedSymbols = 0;
  await page.route(/\/api\/markets\/funding-(history|rankings)$/, (route) => {
    const { symbols } = route.request().postDataJSON() as { symbols: string[] };
    if (route.request().url().endsWith('rankings')) rankedSymbols = symbols.length;
    return route.fulfill({ json: { fetchedAt, entries: symbols.map((symbol) => ({
      symbol, status: 'ok', rate24h: null, rate7d: symbol.startsWith('GATE_') ? '-0.01' : '0.01', rate30d: null,
      settlementCount30d: 21, oldestFundingAt: fetchedAt, newestFundingAt: fetchedAt, fetchedAt,
    })) } });
  });
  await page.locator('.page-size select').selectOption('100');
  await page.getByRole('button', { name: 'Cumulative 7d', exact: true }).click();
  await expect(btc.locator('.arb-cell')).toContainText('Long GT · Short BN');
  await expect(btc.locator('.funding-price-cell')).toHaveText('-476.19 bps');
  expect(rankedSymbols).toBe(assets.length * 2);
});
