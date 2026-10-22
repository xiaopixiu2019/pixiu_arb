import { expect, test, type Page } from '@playwright/test';

async function open(page: Page) {
  await page.request.post('/__e2e/trading-mode', { data: { mode: 'readonly' } });
  await page.addInitScript(() => window.localStorage.setItem('crossex-language', 'zh'));
  await page.route('**/api/preferences', route => route.request().method() === 'GET'
    ? route.fulfill({ json: { preferences: { language: 'zh' } } }) : route.continue());
  await page.goto('/strategies/paired-position');
  await expect(page.locator('.hedge-funding-panel')).toBeVisible();
}

test('one compact funding panel retains every metric, period and chart without boxed alerts', async ({ page }) => {
  await open(page);
  const funding = page.getByRole('region', { name: '资金费率分析', exact: true });
  await expect(funding.locator('.position-funding-summary > div')).toHaveCount(5);
  for (const width of [1920, 1536, 1366, 1280, 1024, 768, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    for (const metric of await funding.locator('.position-funding-summary > div').all()) await expect(metric).toBeVisible();
    for (const name of ['24H', '7D', '30D']) {
      await funding.getByRole('button', { name, exact: true }).click();
      await expect(funding.getByRole('button', { name, exact: true })).toHaveAttribute('aria-pressed', 'true');
      await expect(funding.locator('.premium-history-head h2')).toContainText(name);
    }
    for (const leg of await page.locator('.strategy-leg').all()) {
      await expect(leg).toHaveCSS('outline-style', 'none');
      await expect(leg).toHaveCSS('border-top-width', '2px');
      await expect(leg).toHaveCSS('border-left-width', '0px');
      await expect(leg).toHaveCSS('border-bottom-width', '0px');
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
    if (width >= 1280) {
      const market = await page.locator('.strategy-market-panel').boundingBox(), panel = await funding.boundingBox();
      expect(Math.abs(market!.y - panel!.y)).toBeLessThan(2);
      expect(market!.x + market!.width).toBeLessThan(panel!.x);
      expect(panel!.height).toBeLessThan(460);
    }
    if (width === 1536 || width === 390) await page.screenshot({ path: `data/frontend-layout-refinement/market-polish-${width}.png`, fullPage: true });
  }
});

test('only supplementary review details collapse and invalid settings stay visible outside', async ({ page }) => {
  await open(page);
  const details = page.locator('.hedge-review-details'), warning = page.locator('.hedge-review-warning');
  await expect(details).not.toHaveAttribute('open');
  await expect(details.locator('.hedge-review-group')).toHaveCount(2);
  await expect(details.locator('.hedge-review-notes')).not.toBeVisible();
  await expect(page.locator('.hedge-review-group.fees')).toBeVisible();
  await expect(warning).toBeVisible();
  const total = page.getByRole('textbox', { name: '总数量', exact: true });
  await total.fill('0.10'); await expect(warning).toHaveCount(0);
  await details.locator('summary').click();
  await expect(details.locator('.hedge-review-notes')).toBeVisible();
  await expect(details).toContainText('0.05 BTC');
  await total.fill('0.20'); await expect(details).toHaveAttribute('open', '');
  await expect(details).toContainText('0.1 BTC');
  await details.locator('summary').click();
  await page.getByRole('textbox', { name: '挂单等待（秒）', exact: true }).fill('1');
  await expect(warning).toBeVisible(); await expect(details).not.toHaveAttribute('open');
  await page.getByRole('textbox', { name: '挂单等待（秒）', exact: true }).fill('45');
  await expect(warning).toHaveCount(0);
  await details.locator('summary').click(); await expect(details).toContainText('45s');
  await expect(page.getByRole('textbox', { name: '每笔订单数量', exact: true })).toHaveValue('0.1');
});
