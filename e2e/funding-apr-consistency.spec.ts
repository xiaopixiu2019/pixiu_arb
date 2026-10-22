import { expect, test } from '@playwright/test';

test('matrix and execution share overview APR despite conflicting streamed funding, including zero and missing values', async ({ page }) => {
  let requests = 0;
  let rate: string | null = '0.000222288';
  await page.route('**/api/markets/funding-overview*', route => {
    requests += 1;
    const fetchedAt = new Date().toISOString();
    return route.fulfill({ json: {
      assets: [{ asset: 'ETH', assetClass: 'CRYPTO_BLUE_CHIP', venues: ['OKX', 'HYPERLIQUID'].map(venue => ({
        venue, symbol: `${venue}_FUTURE_ETH_${venue === 'OKX' ? 'USDT' : 'USDC'}`, quote: venue === 'OKX' ? 'USDT' : 'USDC',
        fundingRate: venue === 'OKX' ? '0' : rate === null ? null : String(Number(rate) / 8),
        fundingRate8h: venue === 'OKX' ? '0' : rate, fundingIntervalHours: venue === 'OKX' ? 8 : 1,
        nextFundingAt: null, openInterestValue: '10000000', lastPrice: '50000', change24h: null, fetchedAt,
      })) }],
      venueStatus: ['OKX','HYPERLIQUID'].map(venue => ({ venue, status: 'ok', fetchedAt, rowCount: 1 })),
      classification: { source: 'COINGECKO', marketCapLimit: 20, status: 'fresh', fetchedAt }, cacheStatus: 'fresh', fetchedAt,
    } });
  });
  await page.clock.install();
  await page.goto('/funding-rates');
  const disclaimer = page.getByRole('dialog', { name: 'Risk disclaimer' });
  await disclaimer.waitFor({ state: 'visible', timeout: 1000 }).catch(() => undefined);
  if (await disclaimer.isVisible()) {
    await disclaimer.getByRole('checkbox').check();
    await disclaimer.getByRole('button', { name: /Continue in read-only mode/ }).click();
  }
  await page.getByRole('button', { name: 'APR', exact: true }).click();
  await expect(page.locator('.arb-summary strong')).toHaveText('+24.34%');
  await page.getByRole('button', { name: 'Open hedge strategy: ETH, Long OKX, Short Hyperliquid', exact: true }).click();
  await page.request.post('/__e2e/fresh-quotes');
  await expect(page.locator('.strategy-leg').first().locator('dd').first()).toContainText('3,862.4');
  await expect(page.locator('.compact-trigger .ready')).toHaveCount(0); // A fresh book does not make a reconnecting feed executable.
  const apr = page.locator('.position-funding-summary > div').nth(1).locator('strong');
  await expect(apr).toHaveText('+24.34%');
  // The shared snapshot survives navigation; one normal entry refresh also feeds
  // the existing independent price fallback.
  await expect.poll(() => requests).toBe(2);
  const market = await (await page.request.get('/api/markets')).json();
  const streamed = market.markets.find((entry: { symbol: string }) => entry.symbol === 'HYPERLIQUID_FUTURE_ETH_USDC');
  expect(streamed.source).toBe('gate_crossex_websocket');
  expect(Number(streamed.fundingRate) * 8).not.toBe(Number(rate));
  await page.getByRole('button', { name: 'Switch direction', exact: true }).click();
  await expect(apr).toHaveText('-24.34%');
  await page.getByRole('button', { name: 'Funding Rates', exact: true }).click();
  await expect(page.locator('.arb-summary strong')).toHaveText('+24.34%');
  expect(requests).toBe(2);
  // Direct navigation also obtains the same authoritative source. Zero is valid;
  // missing data stays missing even with positive streamed funding available.
  rate = '0';
  await page.reload();
  await page.getByRole('button', { name: 'APR', exact: true }).click();
  await expect(page.locator('.arb-summary strong')).toHaveText('0.00%');
  await page.locator('.arb-strategy-button').click();
  await expect(apr).toHaveText('+0.00%');
  rate = null;
  await page.clock.fastForward(31_000);
  await expect(page.locator('.position-funding-summary > div').nth(1).locator('strong')).toHaveText('—');
});
