import { expect, test } from '@playwright/test';

test('paired funding stays scoped and a failed history read recovers without reload', async ({ page }) => {
  await page.clock.install();
  await page.addInitScript(() => window.localStorage.setItem('crossex-language', 'en'));
  await page.route('**/api/preferences', (route) => route.request().method() === 'GET'
    ? route.fulfill({ json: { preferences: { language: 'en' } } }) : route.continue());
  const overviewUrls: string[] = [];
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === '/api/markets/funding-overview') overviewUrls.push(request.url());
  });
  let historyAttempts = 0;
  await page.route('**/api/markets/funding-history/series', async (route) => {
    historyAttempts += 1;
    if (historyAttempts === 1 || historyAttempts === 3) await route.fulfill({ status: 503, json: { error: 'synthetic_read_timeout' } });
    else await route.continue();
  });
  await page.goto('/strategies/paired-position');
  const disclaimer = page.getByRole('dialog', { name: 'Risk disclaimer' });
  await disclaimer.waitFor({ state: 'visible', timeout: 1500 }).catch(() => undefined);
  if (await disclaimer.isVisible()) {
    await disclaimer.getByRole('checkbox').check();
    await disclaimer.getByRole('button', { name: /Continue in read-only mode/ }).click();
  }
  const panel = page.locator('.strategy-funding-history');
  await expect(panel).toContainText('retrying automatically');
  await page.clock.fastForward(5100);
  await expect.poll(() => historyAttempts, { timeout: 10000 }).toBe(2);
  await expect(panel.locator('canvas').first()).toBeVisible();
  expect(overviewUrls.length).toBeGreaterThan(0);
  for (const url of overviewUrls) {
    expect(new URL(url).searchParams.get('symbols')?.split(',').sort()).toEqual(['BINANCE_FUTURE_BTC_USDT', 'OKX_FUTURE_BTC_USDT']);
  }
  const result = await page.request.get(new URL(overviewUrls[0]).pathname + new URL(overviewUrls[0]).search);
  expect(result.ok()).toBe(true);
  const json = await result.json();
  expect(json.assets.flatMap((a: { venues: { symbol: string }[] }) => a.venues.map((v) => v.symbol)).sort())
    .toEqual(['BINANCE_FUTURE_BTC_USDT', 'OKX_FUTURE_BTC_USDT']);
  expect((await result.body()).byteLength).toBeLessThan(10000);
  await page.clock.fastForward(60_100);
  await expect(panel).toContainText('Showing last loaded history');
  await expect(panel.locator('canvas').first()).toBeVisible();
  await page.clock.fastForward(5100);
  await expect.poll(() => historyAttempts).toBe(4);
  await expect(panel).not.toContainText('Showing last loaded history');
});
