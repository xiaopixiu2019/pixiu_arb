import { test, expect, type WebSocketRoute } from '@playwright/test';
test('running PnL updates, survives failed reads and revises late bills without trading writes', async ({ page }) => {
  await page.request.post('/__e2e/trading-mode', { data: { mode: 'readonly' } });
  await page.request.post('/__e2e/paused-managed-strategy');
  const original = await (await page.request.get('/api/strategies')).json();
  const task = original.strategies.find((s: { id: string }) => s.id === 'PAIR-LAYOUT01');
  let failed = false, amount = '-0.15198', requests = 0, context = 'generation-1';
  let socket: WebSocketRoute | undefined;
  const connection=await (await page.request.get('/api/onboarding/connection')).json();
  await page.route('**/api/onboarding/connection',r=>r.fulfill({json:{...connection,financialContext:context}}));
  await page.routeWebSocket('**/ws/stream',ws=>{socket=ws;ws.connectToServer();});
  await page.addInitScript(() => localStorage.setItem('crossex-language', 'en'));
  await page.route('**/api/preferences', r => r.request().method() === 'GET' ? r.fulfill({ json: { preferences: { language: 'en' } } }) : r.continue());
  await page.route('**/api/strategies', r => r.fulfill({ json: { strategies: [{ ...task, status: 'RUNNING' }] } }));
  await page.route('**/api/crossex/task-performance', r => {
    requests += 1;
    if (failed) return r.fulfill({ status: 503, json: { error: 'synthetic_unavailable' } });
    const component = { amount: '0', native: {}, count: 0 };
    return r.fulfill({ json: { profileId: 'gate-crossex-default', contextToken: context, checkedAt: 1000, stale: false, reason: null, unallocated: component, tasks: [{
      taskId: task.id, currency: 'USDT', amount: null, status: 'open', reasons: [], checkedAt: 1000, native: {}, price: component, funding: component, fees: component, other: component,
      trading: { amount, confirmed: '-0.15198', unrealized: '0', status: 'estimated', scope: 'task', groupId: task.id, members: [task.id], reasons: ['late_funding_attribution_pending'],
        checkedAt: 1000, ledgerThrough: 1000, valuationAt: 1000, stale: false, adjustment: '-0.01593', maxError: '0.02093', maxErrorPct: '12.47' },
    }] } });
  });
  const writes: string[] = []; page.on('request', r => { if (r.method() !== 'GET' && /\/api\/(strategies|trading|crossex\/transfers)/.test(r.url())) writes.push(r.url()); });
  try {
    await page.goto('/strategies/paired-position');
    const disclaimer = page.getByRole('dialog', { name: /Risk disclaimer/ });
    await disclaimer.waitFor({ state: 'visible', timeout: 1500 }).catch(() => undefined);
    if (await disclaimer.isVisible()) { await disclaimer.getByRole('checkbox').check(); await disclaimer.getByRole('button', { name: /Continue in read-only/ }).click(); }
    const cell = page.locator('.strategy-realized-pnl'); await expect(cell).toContainText('≈ -0.15');
    failed = true; await expect(cell).toContainText('delayed', { timeout: 10000 }); await expect(cell).toContainText('≈ -0.15');
    failed = false; amount = '-0.16791'; await expect(cell).toContainText('≈ -0.17', { timeout: 10000 });
    await cell.locator('summary').click(); await expect(cell).toContainText('exceeds 5%');
    await page.screenshot({path:'data/task-pnl-implementation-20261018/dynamic-pnl.png',fullPage:true});
    await expect(cell).not.toContainText('delayed'); expect(requests).toBeGreaterThanOrEqual(3); expect(writes).toEqual([]);
    failed=true;context='generation-2';await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
    await expect(cell).not.toContainText('≈ -0.17');
    failed=false;amount='0.30';await expect(cell).toContainText('≈ +0.30',{timeout:10000});
    failed=true;expect(socket).toBeDefined();socket!.send(JSON.stringify({type:'portfolio.cleared',payload:null}));
    await expect(cell).not.toContainText('≈ +0.30');expect(writes).toEqual([]);
  } finally { await page.request.delete('/__e2e/paused-managed-strategy'); }
});
