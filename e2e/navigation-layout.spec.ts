import { expect, test } from '@playwright/test';

test('balances navigation with the brand and keeps secondary tools usable across viewports', async ({ page }) => {
  await page.request.post('/__e2e/trading-mode', { data: { mode: 'readonly' } });
  await page.addInitScript(() => window.localStorage.setItem('crossex-language', 'zh'));
  await page.route('**/api/preferences', (route) => route.request().method() === 'GET'
    ? route.fulfill({ json: { preferences: { language: 'zh' } } }) : route.continue());
  await page.goto('/portfolio');
  const nav = page.getByRole('navigation'), more = nav.getByRole('button', { name: '更多', exact: true });
  await expect(more).toBeVisible();
  await expect(nav.locator(':scope > button').filter({ hasText: 'Boros by Pendle' })).toHaveCount(0);
  for (const width of [1536, 1440, 1024, 768, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await more.scrollIntoViewIfNeeded(); await more.click();
    const menu = page.getByRole('menu', { name: '更多工具' });
    await expect(menu.getByRole('menuitem', { name: /Boros by Pendle/ })).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: /SK 海力士溢价机器人/ })).toBeVisible();
    const bounds = await menu.boundingBox();
    expect(bounds!.x).toBeGreaterThanOrEqual(0); expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
    await page.keyboard.press('Escape');
    const viewport = await page.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth }));
    expect(viewport.scrollWidth).toBe(viewport.width);
    if (width === 1440 || width === 390) await page.screenshot({ path: `data/deployments/fees-ui-20261003/layout-${width}.png`, fullPage: true });
  }
});

test('premium deep links and More navigation preserve the robot route and active state', async ({ page }) => {
  await page.request.post('/__e2e/trading-mode', { data: { mode: 'readonly' } });
  await page.goto('/strategies/sk-hynix-premium');
  const disclaimer = page.getByRole('dialog', { name: 'Risk disclaimer' });
  await disclaimer.waitFor({ state: 'visible', timeout: 1000 }).catch(() => undefined);
  if (await disclaimer.isVisible()) { await disclaimer.getByRole('checkbox').check(); await disclaimer.getByRole('button', { name: /Continue in read-only mode/ }).click(); }
  const more = page.getByRole('navigation').getByRole('button', { name: 'More', exact: true });
  await expect(more).toHaveClass(/active/);
  await expect(page.getByRole('heading', { name: /SK hynix premium bot/ })).toBeVisible();
  await more.click(); await expect(page.getByRole('menuitem', { name: /SK hynix premium bot/ })).toHaveClass('selected');
  await page.getByRole('menuitem', { name: /SK hynix premium bot/ }).click();
  await expect(page).toHaveURL(/strategies\/sk-hynix-premium$/); await expect(more).toBeFocused();
  await page.reload(); await expect(more).toHaveClass(/active/);
});
