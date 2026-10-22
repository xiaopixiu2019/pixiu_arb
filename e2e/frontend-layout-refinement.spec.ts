import { expect, test, type Page } from '@playwright/test';

async function openReadOnly(page: Page, path: string) {
  await page.request.post('/__e2e/trading-mode', { data: { mode: 'readonly' } });
  await page.addInitScript(() => window.localStorage.setItem('crossex-language', 'zh'));
  await page.route('**/api/preferences', route => route.request().method() === 'GET'
    ? route.fulfill({ json: { preferences: { language: 'zh' } } }) : route.continue());
  await page.goto(path);
  await expect(page.getByRole('navigation')).toBeVisible();
}

test('all funding venue columns fit a desktop and remain reachable on narrow screens', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await openReadOnly(page, '/funding-rates');
  const headings = page.locator('.exchange-heading');
  await expect(headings).toHaveCount(7);
  await expect(page.locator('.funding-table tbody tr').first()).toBeVisible();
  for (const width of [1366, 1440, 1920, 2560, 1024, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    const bounds = await page.locator('.funding-table-wrap').evaluate(el => ({ client: el.clientWidth, scroll: el.scrollWidth }));
    if (width >= 1366) expect(bounds.scroll).toBeLessThanOrEqual(bounds.client + 1);
    await expect(headings).toHaveCount(7);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
    await page.locator('.funding-table-wrap').evaluate(el => { el.scrollLeft = el.scrollWidth; });
    const last = await headings.last().boundingBox();
    expect(last!.x + last!.width).toBeLessThanOrEqual(width);
    await page.locator('.funding-table-wrap').evaluate(el => { el.scrollLeft = 0; });
    if (width === 1440 || width === 390) await page.screenshot({ path: `data/frontend-layout-refinement/funding-${width}.png`, fullPage: true });
  }
});

for (const blocked of ['left', 'right', 'both']) {
  test(`margin warnings stay above their cards and aligned with ${blocked} blocked`, async ({ page }) => {
    // Exercise the launch guard with a browser-only live-mode response; the fixture server
    // remains read-only with no credentials and no authenticated exchange gateway.
    let modeReady!: () => void;
    const httpMode = new Promise<void>(resolve => { modeReady = resolve; });
    await page.route('**/api/trading-mode', async route => {
      if (route.request().method() !== 'GET') { await route.abort(); return; }
      await route.fulfill({ json: { mode: 'live' } }); modeReady();
    });
    const serverModes: string[] = [];
    await page.routeWebSocket('**/ws/stream', socket => {
      const server = socket.connectToServer();
      server.onMessage(async message => {
        const frame = JSON.parse(String(message));
        if (frame.type === 'mode.update') {
          serverModes.push(frame.payload.mode);
          await httpMode;
          // Deliberately deliver the stream after HTTP: both browser-only channels
          // must describe live mode while the actual credential-free server stays readonly.
          await new Promise(resolve => setTimeout(resolve, 100));
          socket.send(JSON.stringify({ ...frame, payload: { ...frame.payload, mode: 'live' } }));
          return;
        }
        socket.send(message);
      });
    });
    await page.route('**/api/onboarding/connection', async route => {
      const original = await (await route.fetch()).json();
      await route.fulfill({ json: { ...original, configured: true, activeProfileId: 'layout-fixture' } });
    });
    await page.route('**/api/risk/margin/modes?*', route => route.fulfill({ json: { profileId: 'layout-fixture',
      items: (new URL(route.request().url()).searchParams.get('symbols') ?? '').split(',').map((symbol, i) => ({
        symbol, supportCross: !(blocked === 'both' || (i === 0 ? blocked === 'left' : blocked === 'right')),
        mode: 'CROSS', checkedAt: Date.now(),
        reason: blocked === 'both' || (i === 0 ? blocked === 'left' : blocked === 'right') ? 'cross_margin_unsupported' : null,
      })) } }));
    const writes: string[] = [];
    page.on('request', r => { if (r.method() !== 'GET' && /\/api\/(strategies|trading)/.test(r.url())) writes.push(r.url()); });
    await openReadOnly(page, '/strategies/paired-position');
    await expect(page.locator('.cross-margin-warning')).toHaveCount(blocked === 'both' ? 2 : 1);
    for (const width of [1920, 1440, 1024, 768, 640, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      for (const side of ['left', 'right']) {
        if (blocked !== 'both' && blocked !== side) continue;
        const warning = await page.locator('.cross-margin-warning').nth(blocked === 'both' && side === 'right' ? 1 : 0).boundingBox();
        const leg = page.locator(side === 'left' ? '.sell-leg' : '.buy-leg');
        await expect(leg).toHaveCSS('outline-style', 'none');
        await expect(leg).toHaveCSS('border-bottom-width', '0px');
        await expect(leg).toHaveCSS('border-top-width', '2px');
        const card = await leg.boundingBox();
        expect(warning!.y + warning!.height).toBeLessThan(card!.y);
        expect(Math.abs(warning!.x - card!.x)).toBeLessThan(2);
        expect(warning!.width).toBeLessThanOrEqual(card!.width + 1);
      }
      if (width >= 640) {
        const a = await page.locator('.sell-leg').boundingBox(), b = await page.locator('.buy-leg').boundingBox();
        expect(Math.abs(a!.y - b!.y)).toBeLessThan(2);
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
      await expect(page.getByLabel('退出每批数量', { exact: true })).toBeVisible();
      await expect(page.locator('.start-strategy')).toBeDisabled();
      if (width === 1440 || width === 390) await page.locator('.strategy-market-panel').screenshot({ path: `data/frontend-layout-refinement/warning-${blocked}-${width}.png` });
    }
    expect(writes).toEqual([]);
    expect(serverModes).toContain('readonly');
    expect((await (await page.request.get('/api/trading-mode')).json()).mode).toBe('readonly');
  });
}

test('the shared price-difference route retains its existing warning placement', async ({ page }) => {
  await openReadOnly(page, '/strategies/price-difference');
  await expect(page.locator('.strategy-leg .cross-margin-warning')).toHaveCount(2);
  await expect(page.locator('.strategy-leg-warning')).toHaveCount(0);
  await expect(page.locator('.management-exit-details')).toHaveCount(0);
});
