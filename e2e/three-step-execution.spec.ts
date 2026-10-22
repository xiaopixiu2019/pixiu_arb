import { expect, test, type Page } from '@playwright/test';

async function open(page: Page) {
  await page.request.post('/__e2e/trading-mode', { data: { mode: 'readonly' } });
  await page.addInitScript(() => window.localStorage.setItem('crossex-language', 'zh'));
  await page.route('**/api/preferences', route => route.request().method() === 'GET'
    ? route.fulfill({ json: { preferences: { language: 'zh' } } }) : route.continue());
  await page.goto('/strategies/paired-position');
  await expect(page.locator('.hedge-review-heading')).toBeVisible();
}

test('paired entry defaults stay scoped to its draft and preserve manual choices across route changes', async ({ page }) => {
  await open(page);
  const methods = page.getByRole('group', { name: '执行方式', exact: true });
  const maker = methods.getByRole('button', { name: /挂单.*吃单/ });
  const taker = methods.getByRole('button', { name: /吃单.*吃单/ });
  await expect(maker).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('textbox', { name: '价差低于（bps）', exact: true })).toHaveValue('-90');
  await expect(page.getByRole('textbox', { name: '净资金费率年化低于（%）', exact: true })).toHaveValue('-150');
  await expect(page.getByRole('combobox', { name: '触发关系', exact: true })).toHaveValue('OR');
  await expect(page.getByRole('textbox', { name: '持续时间（秒）', exact: true })).toHaveValue('3000');
  await taker.click(); await page.getByRole('textbox', { name: '价差低于（bps）', exact: true }).fill('-81');
  const navigate = async (path: string) => { await page.evaluate(url => {
    history.pushState({}, '', url); window.dispatchEvent(new PopStateEvent('popstate'));
  }, path); await expect(page).toHaveURL(new RegExp(path+'$')); };
  await navigate('/strategies/price-difference');
  await expect(taker).toHaveAttribute('aria-pressed', 'true'); await maker.click();
  await navigate('/strategies/paired-position');
  await expect(taker).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('textbox', { name: '价差低于（bps）', exact: true })).toHaveValue('-81');
  await navigate('/strategies/price-difference'); await expect(maker).toHaveAttribute('aria-pressed', 'true');
});

test('half-size defaults preserve manual input and never bypass a venue minimum', async ({ page }) => {
  await open(page);
  const total = page.getByRole('textbox', { name: '总数量', exact: true });
  const clip = page.getByRole('textbox', { name: '每笔订单数量', exact: true });
  const writes: string[] = [];
  page.on('request', r => { if (r.method() !== 'GET' && /\/api\/(strategies|trading)/.test(r.url())) writes.push(r.url()); });
  await expect(total).toHaveValue(''); await expect(clip).toHaveValue('');
  await total.fill('0.10'); await expect(clip).toHaveValue('0.05');
  await total.fill('0.30'); await expect(clip).toHaveValue('0.15');
  await clip.fill('0.02'); await total.fill('0.40'); await expect(clip).toHaveValue('0.02');
  await clip.fill(''); await total.fill('0.50'); await expect(clip).toHaveValue('');
  await page.getByRole('button', { name: '恢复默认', exact: true }).click();
  await expect(clip).toHaveValue('0.25');
  await total.fill(''); await expect(clip).toHaveValue('');
  await total.fill('0.001'); await expect(clip).toHaveValue('0.0005');
  await expect(page.locator('.strategy-size-check.invalid')).toContainText('0.001');
  await total.fill('0.20'); await expect(clip).toHaveValue('0.1');
  const quantityReview = page.getByRole('region', { name: '数量与入场', exact: true });
  await expect(quantityReview).toContainText('0.20 BTC'); await expect(quantityReview).toContainText('0.1 BTC');
  await page.getByRole('checkbox', { name: '只减仓', exact: true }).check();
  await expect(page.locator('.position-management-settings')).toHaveCount(0);
  await expect(page.locator('.hedge-review-notes')).toContainText('未启用持仓管理');
  await page.getByRole('checkbox', { name: '只减仓', exact: true }).uncheck();
  await expect(clip).toHaveValue('0.1');
  expect(writes).toEqual([]);
});

test('the expanded review reflects maker selection, rebates, zero and unavailable fees', async ({ page }) => {
  let available = true;
  await page.route('**/api/crossex/fees', route => route.fulfill({ json: {
    cacheStatus: 'fresh', fetchedAt: new Date().toISOString(), fees: available ? ['BINANCE', 'OKX'].map(venue => ({
      venue, spotMakerFee: '0', spotTakerFee: '0', futureMakerFee: '0.0002', futureTakerFee: '0',
      specialFees: venue === 'BINANCE' ? [{ symbol: 'BINANCE_FUTURE_BTC_USDT', makerFee: '-0.0001', takerFee: '0.0006' }] : [],
    })) : [],
  } }));
  await open(page);
  const fees = page.getByRole('region', { name: '两腿手续费率', exact: true });
  await page.getByRole('button', { name: '⚡ 吃单–吃单', exact: true }).click();
  await expect(fees).toContainText('0.0600%'); await expect(fees).toContainText('0.0000%');
  await page.getByRole('button', { name: '◫ 挂单–吃单', exact: true }).click();
  await expect(fees).toContainText('-0.0100%');
  await page.getByRole('group', { name: '选择挂单腿', exact: true }).getByRole('button').filter({ hasText: 'OKX' }).click();
  await expect(fees).toContainText('0.0600%'); await expect(fees).toContainText('0.0200%');
  await expect(page.locator('.hedge-review-details')).not.toHaveAttribute('open');
  await expect(page.locator('.hedge-review-notes')).toContainText('IMR/MMR');
  available = false; await page.reload();
  await expect(fees).toContainText('待获取'); await expect(fees).not.toContainText('0.0000%');
});

test('three large steps retain visible core review and expandable details across widths', async ({ page }) => {
  await page.setViewportSize({ width: 1536, height: 1000 });
  await open(page);
  await expect(page.locator('.hedge-step-number')).toHaveText(['01', '02', '03']);
  await expect(page.locator('.position-funding-summary')).toContainText('当前资费年化收益（不含杠杆）');
  await page.getByRole('textbox', { name: '总数量', exact: true }).fill('0.10');
  await expect(page.locator('.hedge-review-group')).toHaveCount(6);
  const firstInputs = await page.locator('.compact-fields input').all();
  expect(await firstInputs[0].getAttribute('aria-label')).toBe('总数量');
  for (const width of [1920, 1536, 1366, 1280, 1024, 768, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    const entry = await page.locator('.strategy-rules').boundingBox();
    const management = await page.locator('.position-management-settings').boundingBox();
    const review = await page.locator('.strategy-launch').boundingBox();
    if (width >= 1280) {
      expect(Math.abs(entry!.y - management!.y)).toBeLessThan(2);
      expect(entry!.x + entry!.width).toBeLessThan(management!.x);
    } else expect(management!.y).toBeGreaterThanOrEqual(entry!.y + entry!.height);
    const totalInput = await page.getByRole('textbox', { name: '总数量', exact: true }).boundingBox();
    const clipInput = await page.getByRole('textbox', { name: '每笔订单数量', exact: true }).boundingBox();
    expect(Math.abs(totalInput!.y - clipInput!.y)).toBeLessThan(2);
    expect(review!.y).toBeGreaterThanOrEqual(Math.max(entry!.y + entry!.height, management!.y + management!.height));
    for (const group of await page.locator('.hedge-review > .hedge-review-grid > .hedge-review-group').all()) await expect(group).toBeVisible();
    await expect(page.locator('.hedge-review-details .hedge-review-group').first()).not.toBeVisible();
    await page.locator('.hedge-review-details summary').click();
    for (const group of await page.locator('.hedge-review-group').all()) await expect(group).toBeVisible();
    await page.locator('.hedge-review-details summary').click();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
    expect(await page.locator('.hedge-step-number').first().evaluate(el => parseFloat(getComputedStyle(el).fontSize))).toBeGreaterThanOrEqual(38);
    for (const selector of ['.strategy-market-panel .eyebrow', '.premium-history-head h2']) {
      const before = await page.locator(selector).evaluate(el => getComputedStyle(el, '::before').content);
      expect(['none', 'normal', '""']).toContain(before);
    }
    if (width === 1536 || width === 390) await page.screenshot({ path: `data/frontend-layout-refinement/three-step-${width}.png`, fullPage: true });
  }
});
