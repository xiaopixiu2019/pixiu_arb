import { test, expect } from '@playwright/test';

test('preserves the requested hedge asset while the full catalog is delayed', async ({ page, request }) => {
  await request.post('/__e2e/fresh-quotes');
  let release!: () => void;
  const catalogReady = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/markets/catalog', async route => { await catalogReady; await route.continue(); });
  try {
    await page.goto('/funding-rates');
    const dialog = page.getByRole('dialog', { name: 'Risk disclaimer' });
    if (await dialog.isVisible()) {
      await dialog.getByRole('checkbox').check();
      await dialog.getByRole('button', { name: /Continue in read-only mode/ }).click();
    }
    await page.getByRole('textbox', { name: 'Search asset' }).fill('HYPE');
    await page.getByRole('button', { name: 'Open hedge strategy: HYPE, Long Bybit, Short Hyperliquid' }).click();
    await expect(page).toHaveURL(/\/strategies\/paired-position$/);
    // Deliberately retain the partial ETH-only streamed catalog for one render/effect interval.
    await page.waitForTimeout(250);
    release();
    await expect(page.locator('.strategy-leg').first().locator('.leg-top em')).toHaveText('Sell HYPEUSDC');
    await expect(page.locator('.strategy-leg').last().locator('.leg-top em')).toHaveText('Buy HYPEUSDT');
  } finally { release(); }
});
