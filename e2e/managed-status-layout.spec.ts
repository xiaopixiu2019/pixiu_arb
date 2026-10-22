import { expect, test } from '@playwright/test';

test('a paused managed strategy stays on one desktop row with readable status', async ({ page }) => {
  await page.setViewportSize({ width: 2048, height: 800 });
  await page.addInitScript(() => window.localStorage.setItem('crossex-language', 'zh'));
  await page.route('**/api/preferences', (route) => route.request().method() === 'GET'
    ? route.fulfill({ json: { preferences: { language: 'zh' } } }) : route.continue());
  const seeded = await page.request.post('/__e2e/paused-managed-strategy');
  expect(seeded.ok()).toBe(true);
  try {
    await page.request.post('/__e2e/trading-mode', { data: { mode: 'live' } });
    const strategies = await page.request.get('/api/strategies');
    expect(strategies.ok(), `${strategies.status()}: ${await strategies.text()}`).toBe(true);
    expect((await strategies.json()).strategies.some((strategy: { id: string }) => strategy.id === 'PAIR-LAYOUT01')).toBe(true);
    await page.goto('/strategies/paired-position');
    const disclaimer = page.getByRole('dialog', { name: /Risk disclaimer|风险免责声明/ });
    await disclaimer.waitFor({ state: 'visible', timeout: 1500 }).catch(() => undefined);
    if (await disclaimer.isVisible()) {
      await disclaimer.getByRole('checkbox').check();
      await disclaimer.getByRole('button', { name: /Continue in read-only mode|以只读模式继续/ }).click();
    }
    const row = page.locator('.running-row').filter({ hasText: 'PAIR-LAYOUT01' });
    await expect(row).toBeVisible();
    const summary = row.locator('.strategy-status summary');
    const heading = row.locator('.strategy-status-head');
    await expect(summary).toBeVisible();
    const measurements = await row.evaluate((element) => {
      const status = element.querySelector('.strategy-status')!;
      const heading = status.querySelector('.strategy-status-head')!;
      const summary = status.querySelector('summary')!;
      return { rowHeight: element.getBoundingClientRect().height,
        statusWidth: status.getBoundingClientRect().width,
        headingHeight: heading.getBoundingClientRect().height,
        summaryHeight: summary.getBoundingClientRect().height,
        summaryFits: summary.scrollWidth <= summary.clientWidth + 1,
        summaryWhiteSpace: getComputedStyle(summary).whiteSpace,
        summaryBelowHeading: summary.getBoundingClientRect().top >= heading.getBoundingClientRect().bottom };
    });
    expect(measurements.rowHeight).toBeLessThan(95);
    expect(measurements.statusWidth).toBeGreaterThan(200);
    expect(measurements.statusWidth).toBeLessThan(240);
    expect(measurements.headingHeight).toBeLessThan(28);
    expect(measurements.summaryHeight).toBeLessThan(28);
    expect(measurements.summaryFits).toBe(true);
    expect(measurements.summaryWhiteSpace).toBe('nowrap');
    expect(measurements.summaryBelowHeading).toBe(true);
    await expect(heading).toContainText('PAUSED');
    await expect(summary).toContainText('风险暂停 · 待人工复核');
    await page.locator('.running-strategies').screenshot({ path: 'data/managed-status-layout-desktop.png' });
    await row.screenshot({ path: 'data/managed-status-row-desktop.png' });
  } finally {
    await page.request.post('/__e2e/trading-mode', { data: { mode: 'readonly' } });
    await page.request.delete('/__e2e/paused-managed-strategy');
  }
});
