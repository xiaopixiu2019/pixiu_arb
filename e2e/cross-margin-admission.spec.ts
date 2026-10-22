import { expect, test } from '@playwright/test';
test('isolated and unverified legs explain the block without trading writes', async ({ page }) => {
  await page.request.post('/__e2e/trading-mode', { data: { mode: 'readonly' } });
  await page.addInitScript(() => window.localStorage.setItem('crossex-language', 'en'));
  await page.route('**/api/onboarding/connection', async route => {
    const original = await (await route.fetch()).json();
    await route.fulfill({ json: { ...original, configured: true, activeProfileId: 'cross-test' } });
  });
  await page.route('**/api/risk/margin/modes?*', route => route.fulfill({ json: { profileId: 'cross-test',
    items: (new URL(route.request().url()).searchParams.get('symbols') ?? '').split(',').map((symbol, i) => ({
      symbol, supportCross: i ? null : false, mode: null, checkedAt: Date.now(),
      reason: i ? 'cross_margin_capability_unknown' : 'cross_margin_unsupported' })) } }));
  const writes: string[] = [];
  page.on('request', r => { if (r.method() === 'POST' && /\/api\/(strategies|trading)/.test(r.url())) writes.push(r.url()); });
  await page.goto('/strategies/paired-position');
  const dialog = page.getByRole('dialog', { name: 'Risk disclaimer' });
  await dialog.waitFor({ state: 'visible', timeout: 1500 }).catch(() => undefined);
  if (await dialog.isVisible()) { await dialog.getByRole('checkbox').check(); await dialog.getByRole('button', { name: /Continue in read-only mode/ }).click(); }
  await expect(page.locator('.cross-margin-warning').first()).toContainText('Cross margin unsupported');
  await expect(page.locator('.cross-margin-warning').nth(1)).toContainText('not yet verified');
  await expect(page.locator('.cross-margin-invalid')).toHaveCount(2);
  expect(writes).toEqual([]);
});
