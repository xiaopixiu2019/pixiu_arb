import { expect, test, type Page } from '@playwright/test';

async function open(page: Page) {
  await page.goto('/strategies/paired-position');
  const disclaimer = page.getByRole('dialog', { name: 'Risk disclaimer' });
  await disclaimer.waitFor({ state: 'visible', timeout: 1500 }).catch(() => undefined);
  if (await disclaimer.isVisible()) {
    await disclaimer.getByRole('checkbox').check();
    await disclaimer.getByRole('button', { name: /Continue in read-only mode/ }).click();
  }
  await page.request.post('/__e2e/trading-mode', { data: { mode: 'live' } });
  await expect(page.locator('button.start-strategy')).not.toHaveText('Live trading locked');
}

test.beforeEach(async ({ page }) => {
  await page.request.post('/__e2e/trading-mode', { data: { mode: 'readonly' } });
  await page.addInitScript(() => localStorage.setItem('crossex-language', 'en'));
  await page.route('**/api/preferences', route => route.request().method() === 'GET'
    ? route.fulfill({ json: { preferences: { language: 'en' } } }) : route.continue());
  await page.route('**/api/trading/leverage/*', route => route.fulfill({ json: {
    symbol: new URL(route.request().url()).pathname.split('/').at(-1), leverage: '5',
  } }));
  await page.route('**/api/onboarding/connection', async route => {
    const body = await (await route.fetch()).json();
    await route.fulfill({ json: { ...body, configured: true, activeProfileId: 'hedge-safety-test', label: 'Synthetic hedge account' } });
  });
  await page.route('**/api/risk/margin/modes?*', route => route.fulfill({ json: { profileId: 'hedge-safety-test',
    items: (new URL(route.request().url()).searchParams.get('symbols') ?? '').split(',').map(symbol => ({
      symbol, supportCross: true, mode: 'CROSS', checkedAt: Date.now(), reason: null })) } }));
  // The shared server refresh endpoint publishes ETH only; this suite explicitly owns fresh BTC books.
  await page.route('**/api/markets/reference-quotes?*', route => {
    const fetchedAt = new Date().toISOString();
    const symbols = (new URL(route.request().url()).searchParams.get('symbols') ?? '').split(',');
    return route.fulfill({ json: { fetchedAt, entries: symbols.map(symbol => ({
      symbol, status: 'ok', bidPrice: '100000', askPrice: '100001', bookObservedAt: fetchedAt, fetchedAt,
    })) } });
  });
});
async function fillEntry(page: Page) {
  await page.request.post('/__e2e/fresh-quotes');
  await page.getByRole('textbox', { name: 'Total amount', exact: true }).fill('0.002');
}

test('applies an explicit legal leverage and submits only its confirmed value', async ({ page }) => {
  let applied = '8'; const writes: unknown[] = [], submissions: Record<string, unknown>[] = [];
  await page.route('**/api/trading/leverage/OKX_FUTURE_BTC_USDT', async route => {
    if (route.request().method() === 'POST') { writes.push(route.request().postDataJSON()); applied = route.request().postDataJSON().leverage; }
    await route.fulfill({ json: { symbol: 'OKX_FUTURE_BTC_USDT', leverage: applied } });
  });
  await page.route('**/api/crossex/instruments/OKX_FUTURE_BTC_USDT/risk-limits', async route => {
    const body = await (await route.fetch()).json();
    body.item.tiers = body.item.tiers.map((tier: object) => ({ ...tier, leverageMax: '6' }));
    await route.fulfill({ json: body });
  });
  await page.route('**/api/strategies', route => {
    if (route.request().method() !== 'POST') return route.continue();
    submissions.push(route.request().postDataJSON());
    return route.fulfill({ status: 409, json: { error: 'synthetic_launch_observed' } });
  });
  await open(page); await fillEntry(page);
  await expect(page.locator('button.start-strategy')).toBeDisabled();
  await page.getByRole('button', { name: 'Exchange B leverage: 8×' }).click();
  const editor = page.getByRole('dialog', { name: 'Adjust leverage' });
  await expect(editor.getByRole('spinbutton', { name: 'Leverage' })).toHaveValue('6');
  await expect(editor.getByRole('spinbutton', { name: 'Leverage' })).toBeFocused();
  await editor.getByRole('button', { name: 'Apply leverage', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Exchange B leverage: 6×' })).toBeVisible();
  expect(writes).toEqual([{ leverage: '6' }]);
  await expect(page.locator('button.start-strategy')).toHaveText('Execute strategy');
  await page.getByRole('button', { name: 'Execute strategy', exact: true }).click();
  const confirm = page.getByRole('dialog', { name: 'Confirm strategy launch' });
  await expect(confirm).toContainText('5× / 6×');
  await confirm.getByRole('button', { name: /Run strategy/ }).click();
  await expect.poll(() => submissions.length).toBe(1);
  expect(submissions[0]).toMatchObject({ leftLeverage: '5', rightLeverage: '6', asset: 'BTC' });
});

test('requires a read after an uncertain apply, never automatically repeats the write', async ({ page }) => {
  let writes = 0;
  await page.route('**/api/trading/leverage/OKX_FUTURE_BTC_USDT', route => {
    if (route.request().method() === 'POST') { writes += 1; return route.fulfill({ status: 502, json: { error: 'leverage_unavailable' } }); }
    return route.fulfill({ json: { symbol: 'OKX_FUTURE_BTC_USDT', leverage: writes ? '4' : '5' } });
  });
  await open(page); await fillEntry(page);
  await page.getByRole('button', { name: 'Exchange B leverage: 5×' }).click();
  const dialog = page.getByRole('dialog', { name: 'Adjust leverage' });
  await dialog.getByRole('spinbutton', { name: 'Leverage' }).fill('4');
  await dialog.getByRole('button', { name: 'Apply leverage', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('unverified');
  await expect(dialog.getByRole('button', { name: 'Apply leverage', exact: true })).toBeDisabled();
  await expect(page.locator('button.start-strategy')).toBeDisabled();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Exchange B leverage: 5×' })).toBeFocused();
  await page.getByRole('button', { name: 'Recheck leverage' }).click();
  await expect(page.getByRole('button', { name: 'Exchange B leverage: 4×' })).toBeVisible();
  expect(writes).toBe(1);
});

test('keeps reduce-only usable when leverage reads fail and omits leverage from its payload', async ({ page }) => {
  await page.route('**/api/trading/leverage/*', route => route.fulfill({ status: 503, json: { error: 'leverage_unavailable' } }));
  const submissions: Record<string, unknown>[] = [];
  await page.route('**/api/strategies', route => {
    if (route.request().method() !== 'POST') return route.continue();
    submissions.push(route.request().postDataJSON());
    return route.fulfill({ status: 409, json: { error: 'synthetic_reduce_observed' } });
  });
  await open(page); await fillEntry(page);
  await page.getByRole('checkbox', { name: 'Reduce only', exact: true }).check();
  await page.getByRole('button', { name: 'Execute strategy', exact: true }).click();
  await page.getByRole('dialog', { name: 'Confirm strategy launch' }).getByRole('button', { name: /Run strategy/ }).click();
  await expect.poll(() => submissions.length).toBe(1);
  expect(submissions[0]).toMatchObject({ reduceOnly: true });
  expect(submissions[0]).not.toHaveProperty('leftLeverage');
  expect(submissions[0]).not.toHaveProperty('rightLeverage');
  expect(submissions[0]).not.toHaveProperty('management');
});
test.afterEach(async ({ page }) => { await page.request.post('/__e2e/trading-mode', { data: { mode: 'readonly' } }); });

for (const riskFirst of [true, false]) {
  test(`shows the real over-limit leverage, independent of response order (${riskFirst})`, async ({ page }) => {
    await page.route('**/api/trading/leverage/OKX_FUTURE_BTC_USDT', async route => {
      if (riskFirst) await new Promise(resolve => setTimeout(resolve, 150));
      await route.fulfill({ json: { symbol: 'OKX_FUTURE_BTC_USDT', leverage: '8' } });
    });
    await page.route('**/api/crossex/instruments/OKX_FUTURE_BTC_USDT/risk-limits', async route => {
      const response = await route.fetch(); const body = await response.json();
      if (!riskFirst) await new Promise(resolve => setTimeout(resolve, 150));
      body.item.tiers = body.item.tiers.map((tier: object) => ({ ...tier, leverageMax: '6' }));
      await route.fulfill({ json: body });
    });
    await open(page);
    await expect(page.getByRole('button', { name: 'Exchange B leverage: 8×', exact: true })).toBeVisible();
    await expect(page.locator('.hedge-review-group').filter({ hasText: 'Leverage & execution' })).toContainText('8×');
    await expect(page.getByRole('alert').filter({ hasText: /8.*6/ })).toBeVisible();
  });
}

test('keeps both leverage panels within the viewport', async ({ page }) => {
  await open(page);
  for (const size of [{ width: 1424, height: 691 }, { width: 1024, height: 600 }, { width: 375, height: 300 }]) {
    await page.setViewportSize(size);
    for (const leg of ['A', 'B']) {
      await page.getByRole('button', { name: `Exchange ${leg} leverage: 5×`, exact: true }).click();
      const dialog = page.getByRole('dialog', { name: 'Adjust leverage' });
      await expect(dialog).toBeVisible();
      const box = (await dialog.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(12);
      expect(box.x + box.width).toBeLessThanOrEqual(size.width - 12);
      expect(box.y).toBeGreaterThanOrEqual(12);
      expect(box.y + box.height).toBeLessThanOrEqual(size.height - 12);
      await expect(dialog.getByRole('button', { name: 'Apply leverage', exact: true })).toBeEnabled();
      // Keyboard interaction can reach the footer even when the short viewport requires internal scrolling.
      await dialog.getByRole('button', { name: 'Apply leverage', exact: true }).focus();
      await page.keyboard.press('Tab');
      await expect(dialog.getByRole('button', { name: 'Close', exact: true })).toBeFocused();
      await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    }
  }
});

test('does not offer a fictitious venue contract or replace the selected asset', async ({ page }) => {
  await page.route('**/api/markets/catalog', async route => {
    const body = await (await route.fetch()).json();
    body.assets = body.assets.map((asset: { asset: string; venues: Array<{ venue: string }> }) => asset.asset === 'BTC'
      ? { ...asset, venues: asset.venues.filter(venue => venue.venue !== 'KRAKEN') } : asset);
    await route.fulfill({ json: body });
  });
  await open(page);
  await page.getByRole('button', { name: 'Exchange A: Binance', exact: true }).click();
  const kraken = page.getByRole('menuitemradio').filter({ hasText: 'Kraken' });
  await expect(kraken).toBeDisabled();
  await expect(kraken).toContainText('Not listed');
  await page.getByRole('menuitemradio').filter({ hasText: 'Bybit' }).click();
  await expect(page.getByRole('combobox', { name: 'Search asset' })).toHaveAttribute('placeholder', 'BTCUSDT PERP');
});

test('retains an unavailable contract on catalog arrival instead of falling back to AAVE', async ({ page }) => {
  await page.route('**/api/markets/catalog', async route => {
    const body = await (await route.fetch()).json();
    body.assets = body.assets.filter((asset: { asset: string }) => asset.asset !== 'BTC');
    await route.fulfill({ json: body });
  });
  await open(page); await fillEntry(page);
  await expect(page.getByRole('alert').filter({ hasText: 'BTC is unavailable' })).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Search asset' })).toHaveAttribute('placeholder', 'BTCUSDT PERP');
  await expect(page.locator('button.start-strategy')).toBeDisabled();
});

test('ignores an old leverage read after switching venues', async ({ page }) => {
  let release!: () => void; const waiting = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/trading/leverage/OKX_FUTURE_BTC_USDT', async route => {
    await waiting; await route.fulfill({ json: { symbol: 'OKX_FUTURE_BTC_USDT', leverage: '8' } });
  });
  try {
    await open(page);
    await page.getByRole('button', { name: 'Exchange B: OKX', exact: true }).click();
    await page.getByRole('menuitemradio').filter({ hasText: 'Bybit' }).click();
    await expect(page.getByRole('button', { name: 'Exchange B leverage: 5×' })).toBeVisible();
    const oldResponse = page.waitForResponse(response => response.url().endsWith('/api/trading/leverage/OKX_FUTURE_BTC_USDT'));
    release();
    await (await oldResponse).finished();
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(page.getByRole('button', { name: 'Exchange B: Bybit', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Exchange B leverage: 5×' })).toBeVisible();
  } finally { release(); }
});

test('reconciles a pending apply after switching away and back without a second write', async ({ page }) => {
  let release!: () => void; const waiting = new Promise<void>(resolve => { release = resolve; });
  let current = '5', writes = 0;
  await page.route('**/api/trading/leverage/OKX_FUTURE_BTC_USDT', async route => {
    if (route.request().method() === 'POST') { writes += 1; await waiting; current = '4'; }
    await route.fulfill({ json: { symbol: 'OKX_FUTURE_BTC_USDT', leverage: current } });
  });
  try {
    await open(page);
    await page.getByRole('button', { name: 'Exchange B leverage: 5×' }).click();
    const editor = page.getByRole('dialog', { name: 'Adjust leverage' });
    await editor.getByRole('spinbutton', { name: 'Leverage' }).fill('4');
    await editor.getByRole('button', { name: 'Apply leverage', exact: true }).click();
    await expect.poll(() => writes).toBe(1);
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Exchange B: OKX', exact: true }).click();
    await page.getByRole('menuitemradio').filter({ hasText: 'Bybit' }).click();
    await expect(page.getByRole('button', { name: 'Exchange B leverage: 5×' })).toBeVisible();
    await page.getByRole('button', { name: 'Exchange B: Bybit', exact: true }).click();
    await page.getByRole('menuitemradio').filter({ hasText: 'OKX' }).click();
    release();
    await expect(page.getByRole('button', { name: 'Exchange B leverage: 4×' })).toBeVisible();
    expect(writes).toBe(1);
  } finally { release(); }
});

test('a trading-mode change invalidates an already opened confirmation permanently', async ({ page }) => {
  await open(page); await fillEntry(page);
  await page.getByRole('button', { name: 'Execute strategy', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Confirm strategy launch' })).toBeVisible();
  await page.request.post('/__e2e/trading-mode', { data: { mode: 'readonly' } });
  await expect(page.getByRole('dialog', { name: 'Confirm strategy launch' })).toHaveCount(0);
  await page.request.post('/__e2e/trading-mode', { data: { mode: 'live' } });
  await expect(page.getByRole('button', { name: 'Execute strategy', exact: true })).toBeEnabled();
  await expect(page.getByRole('dialog', { name: 'Confirm strategy launch' })).toHaveCount(0);
});

test('stale risk tiers do not establish launch eligibility', async ({ page }) => {
  await page.route('**/api/crossex/instruments/OKX_FUTURE_BTC_USDT/risk-limits', async route => {
    const body = await (await route.fetch()).json();
    await route.fulfill({ json: { ...body, cacheStatus: 'stale', upstreamStatus: 'unavailable' } });
  });
  await open(page); await fillEntry(page);
  await expect(page.getByRole('button', { name: 'Exchange B leverage: —' })).toBeVisible();
  await expect(page.getByRole('alert').filter({ hasText: 'Leverage is unverified' })).toBeVisible();
  await expect(page.locator('button.start-strategy')).toBeDisabled();
});

test('price-difference strategies do not acquire new authenticated leverage reads', async ({ page }) => {
  const reads: string[] = [];
  page.on('request', request => { if (request.url().includes('/api/trading/leverage/')) reads.push(request.url()); });
  await page.goto('/strategies/price-difference');
  await expect(page.getByRole('combobox', { name: 'Search asset' })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Order quantity' })).toBeVisible();
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  expect(reads).toEqual([]);
});
