import { expect, test } from '@playwright/test';

for (const [action, label] of [['OPENING', '继续建仓'], ['MONITORING', '恢复监控'], ['EXITING', '继续平仓']] as const) {
  test(`managed resume binds the visible ${action} intent and preserves a rejected task`, async ({ page }) => {
    await page.addInitScript(() => window.localStorage.setItem('crossex-language', 'zh'));
    await page.route('**/api/preferences', route => route.request().method() === 'GET'
      ? route.fulfill({ json: { preferences: { language: 'zh' } } }) : route.continue());
    expect((await page.request.post('/__e2e/paused-managed-strategy')).ok()).toBe(true);
    await page.request.post('/__e2e/trading-mode', { data: { mode: 'live' } });
    const original = (await (await page.request.get('/api/strategies')).json()).strategies
      .find((s: { id: string }) => s.id === 'PAIR-LAYOUT01');
    await page.route('**/api/strategies', route => route.fulfill({ json: { strategies: [{ ...original,
      management: { ...original.management, resumeAction: action, exitRequested: action === 'EXITING' } }] } }));
    const requests: unknown[] = [];
    await page.route('**/api/strategies/PAIR-LAYOUT01/resume', route => {
      requests.push(route.request().postDataJSON());
      return route.fulfill({ status: 409, json: { error: 'managed_resume_action_changed' } });
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
      await row.getByRole('button', { name: label, exact: true }).click();
      await expect(page.getByText(/恢复后的执行方向已变化/)).toBeVisible();
      expect(requests).toEqual([{ expectedAction: action }]);
      await expect(row).toContainText('PAUSED');
      await expect(row.getByRole('button', { name: label, exact: true })).toBeEnabled();
    } finally {
      await page.request.post('/__e2e/trading-mode', { data: { mode: 'readonly' } });
      await page.request.delete('/__e2e/paused-managed-strategy');
    }
  });
}
