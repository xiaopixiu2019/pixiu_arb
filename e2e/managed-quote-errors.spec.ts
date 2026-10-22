import { expect, test } from '@playwright/test';

let previousMode = 'readonly';
test.afterEach(async ({ request }) => {
  await request.post('/__e2e/trading-mode', { data: { mode: previousMode } });
});

test('explains a missing leg and actual quantity limits on the launch page', async ({ page }) => {
  await page.route('**/api/onboarding/connection', async route => {
    const original = await (await route.fetch()).json();
    await route.fulfill({ json: { ...original, configured: true, activeProfileId: 'hedge-test', label: 'Synthetic hedge account' } });
  });
  await page.route('**/api/risk/margin/modes?*', route => route.fulfill({ json: { profileId: 'hedge-test',
    items: (new URL(route.request().url()).searchParams.get('symbols') ?? '').split(',').map(symbol => ({
      symbol, supportCross: true, mode: 'CROSS', checkedAt: Date.now(), reason: null })) } }));
  previousMode = (await (await page.request.get('/api/trading-mode')).json()).mode;
  let failure = { error: 'strategy_market_data_unavailable', label: 'HYPERLIQUID_FUTURE_ETH_USDC' };
  await page.route('**/api/trading/leverage/*', async route => {
    const symbol = decodeURIComponent(new URL(route.request().url()).pathname.split('/').at(-1)!);
    await route.fulfill({ json: { symbol, leverage: '1' } });
  });
  await page.route('**/api/markets/funding-overview*', route => {
    const fetchedAt = new Date().toISOString();
    return route.fulfill({ json: {
      assets: [{ asset: 'ETH', assetClass: 'CRYPTO_BLUE_CHIP', venues: ['OKX', 'HYPERLIQUID'].map(venue => ({
        venue, symbol: `${venue}_FUTURE_ETH_${venue === 'OKX' ? 'USDT' : 'USDC'}`, quote: venue === 'OKX' ? 'USDT' : 'USDC',
        fundingRate: venue === 'OKX' ? '0' : '0.0001', fundingRate8h: venue === 'OKX' ? '0' : '0.0008',
        fundingIntervalHours: venue === 'OKX' ? 8 : 1, nextFundingAt: null, openInterestValue: '10000000', lastPrice: '3862',
        bidPrice: '3861.9', askPrice: '3862.1', change24h: null, fetchedAt, bookObservedAt: fetchedAt,
      })) }],
      venueStatus: ['OKX', 'HYPERLIQUID'].map(venue => ({ venue, status: 'ok', fetchedAt, rowCount: 1 })),
      classification: { source: 'COINGECKO', marketCapLimit: 20, status: 'fresh', fetchedAt }, cacheStatus: 'fresh', fetchedAt,
    } });
  });
  const submitted: Record<string, unknown>[] = [];
  await page.route('**/api/strategies', route => {
    if (route.request().method() !== 'POST') return route.continue();
    submitted.push(route.request().postDataJSON());
    return route.fulfill({ status: 409, json: failure });
  });
  await page.goto('/funding-rates');
  const disclaimer = page.getByRole('dialog', { name: 'Risk disclaimer' });
  await disclaimer.waitFor({ state: 'visible', timeout: 1000 }).catch(() => undefined);
  if (await disclaimer.isVisible()) {
    await disclaimer.getByRole('checkbox').check();
    await disclaimer.getByRole('button', { name: /Continue in read-only mode/ }).click();
  }
  await page.request.post('/__e2e/trading-mode', { data: { mode: 'live' } });
    await page.getByRole('button', { name: 'Open hedge strategy: ETH, Long OKX, Short Hyperliquid', exact: true }).click();
    await page.request.post('/__e2e/fresh-quotes');
    await page.getByRole('textbox', { name: 'Total amount', exact: true }).fill('0.2');
    await expect(page.getByRole('textbox', { name: 'Per-order quantity', exact: true })).toHaveValue('0.1');
    await page.getByRole('button', { name: 'Execute strategy', exact: true }).click();
    await expect(page.getByRole('dialog').getByRole('heading', { name: 'Confirm strategy launch', exact: true })).toBeVisible();
    expect(submitted).toHaveLength(0);
    await page.getByRole('dialog').getByRole('button', { name: 'Run strategy This will start live automated execution.', exact: true }).click();
    await expect.poll(() => submitted.length).toBe(1);
    expect(submitted[0]).toMatchObject({ totalAmount: '0.2', perOrderQuantity: '0.1', management: { perOrderQuantity: '0.1' } });
    await expect(page.locator('.launch-notice.error')).toContainText('Hyperliquid ETH');
    await expect(page.locator('.launch-notice.error')).toContainText('Live quotes are unavailable');
    await expect(page.locator('.launch-notice.error')).not.toContainText('clip below minimum');
    failure = { error: 'managed_order_invalid_lot_size', label: JSON.stringify({ symbol: 'HYPERLIQUID_FUTURE_ETH_USDC', quantity: '0.1', step: '0.03' }) };
    await page.getByRole('button', { name: 'Execute strategy', exact: true }).click();
    await expect(page.getByRole('dialog').getByRole('heading', { name: 'Confirm strategy launch', exact: true })).toBeVisible();
    await page.getByRole('dialog').getByRole('button', { name: 'Run strategy This will start live automated execution.', exact: true }).click();
    await expect(page.locator('.launch-notice.error')).toContainText('multiple of the lot size 0.03');
    await expect(page.locator('.launch-notice.error')).not.toContainText('Live quotes are unavailable');
});
