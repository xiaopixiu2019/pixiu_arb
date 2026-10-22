import { expect, test } from '@playwright/test';

test('publishes the user rebate signup and routes product links to PIXIU ARB', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  let preferenceData: Record<string, unknown> = { language: 'en', theme: 'dark' };
  await page.route('**/api/preferences', async (route) => {
    if (route.request().method() === 'PATCH') preferenceData = { ...preferenceData, ...route.request().postDataJSON() };
    await route.fulfill({ json: { preferences: preferenceData } });
  });
  await page.addInitScript(() => {
    window.open = (url) => { document.body.dataset.openedProductUrl = String(url); return null; };
  });
  await page.goto('/funding-rates');
  const disclaimer = page.locator('.disclaimer-modal');
  if (await disclaimer.isVisible()) {
    await disclaimer.getByRole('checkbox', { name: 'I have read and understand the risks above.' }).check();
    await disclaimer.getByRole('button', { name: /Continue in read-only mode/ }).click();
  }
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  // The accessible dialog name changes when the user switches language.
  const preferences = page.locator('.settings-panel');
  const invite = preferences.getByRole('link', { name: 'Register on Gate · Enjoy trading-fee rebates' });
  await expect(invite).toHaveAttribute('href', 'https://www.gatesites.cc/zh/share/XIAOPXIU');
  await expect(invite).toHaveAttribute('rel', 'noopener noreferrer');
  await preferences.getByRole('button', { name: 'Source code' }).click();
  await expect(page.locator('body')).toHaveAttribute('data-opened-product-url', 'https://github.com/xiaopixiu2019/pixiu_arb');
  await expect(preferences).toContainText('Gate settles eligible rebates');
  await expect(preferences).not.toContainText(/yourquant/i);
  await expect(preferences.locator('.promotion-disclosure')).not.toContainText(/\d+\s*[%％]/);
  await preferences.getByRole('button', { name: 'Light mode', exact: true }).click();
  await expect(invite).toHaveCSS('color', 'rgb(0, 111, 133)');
  await preferences.getByRole('button', { name: '中文', exact: true }).click();
  await expect(preferences.getByRole('link', { name: '注册 Gate，享受交易手续费返佣', exact: true })).toHaveAttribute('href', 'https://www.gatesites.cc/zh/share/XIAOPXIU');
  await expect(preferences.locator('.promotion-disclosure')).not.toContainText(/\d+\s*[%％]/);
});
