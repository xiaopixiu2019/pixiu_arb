import { expect, test, type Page } from '@playwright/test';

async function open(page: Page, language: 'zh' | 'en' = 'zh') {
  // Keep the shared fixture's first-launch state untouched for the onboarding suite.
  let resolveModeRead!: () => void;
  const modeRead = new Promise<void>(resolve => { resolveModeRead = resolve; });
  const sourceModes: string[] = [];
  await page.route('**/api/trading-mode', async route => {
    if (route.request().method() !== 'GET') return route.abort();
    await route.fulfill({ json: { mode: 'readonly' } }); resolveModeRead();
  });
  await page.routeWebSocket('**/ws/stream', socket => {
    const server = socket.connectToServer();
    server.onMessage(async message => {
      const frame = JSON.parse(String(message));
      if (frame.type === 'mode.update') {
        // Exercise the formerly failing ordering while both page-local transports agree.
        await modeRead;
        sourceModes.push(frame.payload.mode);
        socket.send(JSON.stringify({ ...frame, payload: { ...frame.payload, mode: 'readonly' } }));
      } else socket.send(message);
    });
  });
  await page.addInitScript(lang => window.localStorage.setItem('crossex-language', lang), language);
  await page.route('**/api/preferences', route => route.request().method() === 'GET'
    ? route.fulfill({ json: { preferences: { language } } }) : route.continue());
  await page.goto('/strategies/paired-position');
  await expect(page.locator('.position-management-settings')).toBeVisible();
  return sourceModes;
}

test('page-local readonly review preserves backend unset when the mode stream follows HTTP', async ({ page }) => {
  const sourceModes = await open(page);
  await expect.poll(() => sourceModes).toContain('unset');
  await expect(page.locator('.disclaimer-modal')).toHaveCount(0);
  expect(await (await page.request.get('/api/trading-mode')).json()).toMatchObject({ mode: 'unset' });
});

test('help ignores a completed scroll notification but closes when its anchor moves', async ({ page }) => {
  await open(page);
  const help = page.getByRole('button', { name: '持续监控与自动退出 · ?', exact: true });
  await help.scrollIntoViewIfNeeded();
  await help.focus(); await page.keyboard.press('Enter');
  await expect(page.getByRole('note')).toContainText('优先市价只减仓');
  // A queued notification from scrolling before opening must not dismiss stationary help.
  await page.evaluate(() => document.dispatchEvent(new Event('scroll')));
  await expect(page.getByRole('note')).toContainText('优先市价只减仓');
  const before = await page.evaluate(() => window.scrollY);
  await page.evaluate(() => window.scrollBy(0, window.scrollY > 0 ? -100 : 100));
  await expect.poll(() => page.evaluate(() => window.scrollY)).not.toBe(before);
  await expect(page.getByRole('note')).toHaveCount(0);
  await help.click(); await expect(page.getByRole('note')).toBeVisible();
  const viewport = page.viewportSize()!;
  await page.setViewportSize({ ...viewport, width: viewport.width - 10 });
  await expect(page.getByRole('note')).toHaveCount(0);
  await help.click(); await expect(page.getByRole('note')).toBeVisible();
  await page.getByRole('textbox', { name: '总数量', exact: true }).focus();
  await expect(page.getByRole('note')).toHaveCount(0);
  await help.click(); await expect(page.getByRole('note')).toBeVisible();
  await page.locator('.strategy-rules').click({ position: { x: 10, y: 10 } });
  await expect(page.getByRole('note')).toHaveCount(0);
});

for (const language of ['zh', 'en'] as const) {
  test(`static management guidance moves to accessible help without changing controls (${language})`, async ({ page }) => {
    await open(page, language);
    const zh = language === 'zh', settings = page.locator('.position-management-settings');
    const enabled = settings.getByRole('checkbox').first(), adopt = settings.getByRole('checkbox').nth(1);
    await expect(settings.locator(':scope > p, :scope > small, .management-exit-summary')).toHaveCount(0);
    const enabledHelp = settings.getByRole('button', { name: zh ? '持续监控与自动退出 · ?' : 'Keep monitoring and exit automatically · ?', exact: true });
    // Let Playwright finish scrolling before opening a popover that intentionally closes on scroll.
    await enabledHelp.scrollIntoViewIfNeeded();
    await enabledHelp.focus(); await page.keyboard.press('Enter');
    await expect(page.getByRole('note')).toContainText(zh ? '优先市价只减仓' : 'including a full exit');
    await expect(enabled).toBeChecked();
    await page.keyboard.press('Escape'); await expect(enabledHelp).toBeFocused();
    const adoptHelp = settings.getByRole('button', { name: zh ? /接管所选两腿.* · \?/ : /Adopt balanced holdings.* · \?/ });
    await adoptHelp.click();
    await expect(page.getByRole('note')).toContainText(zh ? '未知订单阻止启动' : 'Unknown orders block launch');
    await expect(adopt).toBeChecked(); await page.keyboard.press('Escape');
    const exitHelp = settings.getByRole('button', { name: zh ? '分批退出说明 · ?' : 'Exit settings help · ?', exact: true });
    await exitHelp.click();
    await expect(page.getByRole('note')).toContainText(zh ? '不重新建仓' : 'exit remains active until flat');
    await expect(page.getByRole('note')).toContainText(zh ? '市价回退关闭' : 'Market fallback off');
    await page.keyboard.press('Escape');
    const wait = settings.getByRole('textbox', { name: zh ? '挂单等待（秒）' : 'Maker wait (seconds)', exact: true });
    await wait.fill('1'); await expect(settings.getByRole('alert')).toBeVisible();
    await wait.fill('45'); await exitHelp.click(); await expect(page.getByRole('note')).toContainText('45s');
    await page.keyboard.press('Escape');
    for (const width of [1536, 1366, 1280, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      const a = await page.locator('.strategy-rules').boundingBox(), b = await settings.boundingBox();
      if (width >= 1280) expect(Math.abs(a!.height - b!.height)).toBeLessThan(2);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
    }
  });
}

test('the short review preserves core facts and the funding label retains its calculation explanation', async ({ page }) => {
  await page.setViewportSize({ width: 1536, height: 1000 }); await open(page);
  const funding = page.locator('.position-funding-summary > div').first();
  await expect(funding.locator('span').first()).toContainText('资金费率');
  await expect(funding).not.toContainText('资金费率优势');
  await funding.getByRole('button', { name: '资金费率 · ?', exact: true }).click();
  await expect(page.getByRole('note')).toContainText('不是单个交易所费率'); await page.keyboard.press('Escape');
  await page.getByRole('textbox', { name: '总数量', exact: true }).fill('0.10');
  const review = page.locator('.strategy-launch'), details = review.locator('details');
  await expect(details).not.toHaveAttribute('open');
  await expect(review.locator('.hedge-review-group.fees')).toBeVisible();
  await expect(review).toContainText('0.05 BTC');
  for (const width of [1625, 1536, 1366, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    if (width >= 1366) {
      const bounds = await review.boundingBox(); expect(bounds!.height).toBeLessThan(410);
      const summary = await details.boundingBox(), action = await review.locator('.start-strategy').boundingBox();
      expect(Math.abs(summary!.y + summary!.height / 2 - action!.y - action!.height / 2)).toBeLessThan(2);
    }
    await details.locator('summary').click(); await expect(details.locator('.hedge-review-notes')).toBeVisible();
    await details.locator('summary').click();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
    if (width === 1536 || width === 390) await page.screenshot({ path: `data/frontend-layout-refinement/annotation-compact-${width}.png`, fullPage: true });
  }
});
