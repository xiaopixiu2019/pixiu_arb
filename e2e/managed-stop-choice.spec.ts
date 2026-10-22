import { expect, test } from '@playwright/test';

for (const closePositions of [false, true]) {
  test(`managed Stop sends an explicit ${closePositions ? 'close' : 'keep'} choice`, async ({ page }) => {
    await page.setViewportSize({ width: closePositions ? 430 : 1440, height: 900 });
    await page.addInitScript(() => window.localStorage.setItem('crossex-language', 'zh'));
    await page.route('**/api/preferences', (route) => route.request().method() === 'GET'
      ? route.fulfill({ json: { preferences: { language: 'zh' } } }) : route.continue());
    expect((await page.request.post('/__e2e/paused-managed-strategy')).ok()).toBe(true);
    const original = (await (await page.request.get('/api/strategies')).json()).strategies.find((s: { id: string }) => s.id === 'PAIR-LAYOUT01');
    const submitted: unknown[] = [];
    await page.route('**/api/strategies/PAIR-LAYOUT01/stop', async (route) => {
      submitted.push(route.request().postDataJSON());
      await route.fulfill({ json: { ...original, status: closePositions ? 'RUNNING' : 'STOPPED', management: {
        ...original.management, phase: closePositions ? 'EXITING' : 'STOPPED', exitRequested: closePositions, stopIntent: closePositions ? 'EXIT' : 'KEEP' } } });
    });
    try {
      await page.goto('/strategies/paired-position');
      const disclaimer = page.getByRole('dialog', { name: /Risk disclaimer|风险免责声明/ });
      await disclaimer.waitFor({ state: 'visible', timeout: 1500 }).catch(() => undefined);
      if (await disclaimer.isVisible()) {
        await disclaimer.getByRole('checkbox').check();
        await disclaimer.getByRole('button', { name: /Continue in read-only mode|以只读模式继续/ }).click();
      }
      const row = page.locator('.running-row').filter({ hasText: 'PAIR-LAYOUT01' });
      await row.getByRole('button', { name: '停止', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: '停止任务', exact: true });
      const checkbox = dialog.getByRole('checkbox', { name: '同时自动平仓（包含接管旧仓与新增仓位）' });
      await expect(checkbox).not.toBeChecked();
      await expect(dialog).toContainText('自动监控、失衡保护和条件平仓全部停止');
      expect(submitted).toEqual([]);
      if (closePositions) await checkbox.check();
      await dialog.screenshot({ path: `data/managed-stop-${closePositions ? 'close-mobile' : 'keep-desktop'}.png` });
      await dialog.getByRole('button', { name: closePositions ? '停止并平仓' : '停止并保留仓位', exact: true }).click();
      await expect(dialog).not.toBeVisible();
      expect(submitted).toEqual([{ closePositions }]);
    } finally {
      await page.request.delete('/__e2e/paused-managed-strategy');
    }
  });
}
