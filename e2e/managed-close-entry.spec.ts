import { expect, test, type Page, type WebSocketRoute } from '@playwright/test';
import { StrategyRecordSchema, type AuthenticatedPortfolioSnapshot, type ManagedCloseTarget } from '@gate-crossex/shared-types';
import { managedCloseChecks } from './support/managed-close-checks.mjs';

const profileId = 'gate-crossex-default';
const symbols = ['KRAKEN_FUTURE_WLFI_USD', 'DERIBIT_FUTURE_WLFI_USDC'];
const strategy = StrategyRecordSchema.parse({ id: 'PAIR-C105E001', kind: 'position', status: 'RUNNING',
  accountProfileId: profileId, accountLabel: 'Synthetic', config: { kind: 'position', asset: 'WLFI', entryBps: '0',
    leftVenue: 'KRAKEN', rightVenue: 'DERIBIT', leftSide: 'SELL', rightSide: 'BUY', totalAmount: '10000',
    perOrderQuantity: '1000', reduceOnly: false, executionMethod: 'TAKER_TAKER', management: { perOrderQuantity: '1000',
      durationSeconds: 2, intervalSeconds: 0, makerWaitSeconds: 5 } }, progress: 100, filledQuantity: '10000',
  filledLeft: '10000', filledRight: '10000', openPosition: '10000', realizedPnl: '0',
  createdAt: '2026-10-18T00:00:00Z', updatedAt: '2026-10-18T00:00:00Z', stoppedAt: null,
  management: { phase: 'MONITORING', leftQuantity: '10000', rightQuantity: '10000', checkedAt: '2026-10-18T00:00:00Z',
    spreadBps: null, fundingAprPct: null, fundingCheckedAt: null, conditionSince: null, exitRequested: false, reason: null, pendingOrderIds: [] },
});
const target: ManagedCloseTarget = { strategy, scope: { accountProfileId: profileId,
  legs: symbols.map((symbol, i) => ({ symbol, side: i ? 'BUY' : 'SELL' })) } };

test.afterEach(async ({ page }) => {
  await page.request.post('/__e2e/trading-mode', { data: { mode: 'readonly' } });
});

async function setup(page: Page, targets = [target], mode = 'live', emptyPositions = false,
  positionSymbols = symbols, records = [strategy]) {
  await page.request.post('/__e2e/trading-mode', { data: { mode } });
  await page.addInitScript(() => window.localStorage.setItem('crossex-language', 'en'));
  await page.route('**/api/preferences', route => route.request().method() === 'GET'
    ? route.fulfill({ json: { preferences: { language: 'en' } } }) : route.continue());
  await page.route('**/api/onboarding/connection', async route => {
    const original = await (await route.fetch()).json();
    await route.fulfill({ json: { ...original, configured: true, activeProfileId: profileId } });
  });
  const now = new Date().toISOString();
  const portfolio: AuthenticatedPortfolioSnapshot = { dataStatus: 'fresh', remoteStatus: 'healthy',
    reconciliation: { id: 'synthetic', createdAt: now, status: 'clean', previousFetchedAt: null, currentFetchedAt: now, issues: [] },
    snapshot: { source: 'gate_crossex_authenticated_rest', fetchedAt: now,
      account: { availableMargin: '1000', marginBalance: '2000', initialMargin: '100', maintenanceMargin: '10',
        initialMarginRate: '5', maintenanceMarginRate: '200', positionMode: 'SINGLE', accountMode: 'CROSS_EXCHANGE', exchangeType: 'CROSSEX', remoteUpdatedAt: now },
      balances: [], marginPositions: [], openOrders: [], recentFills: [], futuresPositions: emptyPositions ? [] : positionSymbols.map((symbol, i) => ({
        positionId: `synthetic-${i}`, symbol, positionSide: i % 2 ? 'LONG' : 'SHORT', quantity: i % 2 ? '10000' : '-10000',
        initialMargin: '50', maintenanceMargin: '5', value: '500', unrealizedPnl: '0', unrealizedPnlRate: '0', entryPrice: '0.05',
        markPrice: '0.05', leverage: '1', maxLeverage: '20', riskLimit: '1', fee: '0', fundingFee: '0', fundingTime: now,
        createdAt: now, updatedAt: now, realizedPnl: '0', marginMode: 'CROSS', liquidationPrice: null, liquidationPriceCheckedAt: null,
      })) } };
  await page.route('**/api/crossex/portfolio-snapshot', route => route.fulfill({ json: portfolio }));
  const snapshot = { mode: 'live', orders: [], fills: [], balances: [], positions: emptyPositions ? [] : positionSymbols.map((symbol, i) => ({
    position_id: `synthetic-${i}`, symbol, venue: i % 2 ? 'DERIBIT' : 'KRAKEN', quantity: i % 2 ? '10000' : '-10000',
    entry_price: '0.05', mark_price: '0.05', realized_pnl: '0', updated_at: now,
  })) };
  await page.route('**/api/trading/snapshot', route => route.fulfill({ json: snapshot }));
  await page.route('**/api/crossex/positions-snapshot', route => route.fulfill({ json: snapshot }));
  await page.route('**/api/strategies/close-targets', route => route.fulfill({ json: { targets } }));
  const writes: string[] = [];
  await page.route('**/api/trading/orders', async route => {
    if (route.request().method() === 'POST') writes.push('ordinary-order');
    await route.fulfill({ status: 500, json: { error: 'forbidden_test_path' } });
  });
  await page.route('**/api/strategies', async route => {
    if (route.request().method() === 'POST') writes.push('new-strategy');
    await route.fulfill({ json: { strategies: records } });
  });
  return writes;
}

async function open(page: Page, path: string) {
  await page.goto(path);
  const disclaimer = page.getByRole('dialog', { name: 'Risk disclaimer' });
  await disclaimer.waitFor({ state: 'visible', timeout: 1500 }).catch(() => undefined);
  if (await disclaimer.isVisible()) {
    await disclaimer.getByRole('checkbox').check();
    await disclaimer.getByRole('button', { name: 'Continue in read-only mode' }).click();
  }
  if (path.startsWith('/strategies')) await page.getByRole('tab', { name: /^Positions/ }).click();
}

test('deployment read-only profile verifies all three real routes and never submits Stop', async ({ page, baseURL }) => {
  const writes = await setup(page);
  let stopWrites = 0;
  await page.route('**/api/strategies/*/stop', async route => { stopWrites++; await route.abort(); });
  await open(page, '/portfolio');
  let documents = 0, apiReads = 0;
  page.on('request', request => {
    if (request.resourceType() === 'document') documents++;
    if (new URL(request.url()).pathname.startsWith('/api/')) apiReads++;
  });
  const result = await managedCloseChecks({ newPage: async () => page }, baseURL!, {
    mode: 'live', accountId: profileId, positions: symbols.map((s,i)=>[s,'NONE',i?'10000':'-10000']),
    tasks: [{ id: strategy.id, status: 'RUNNING', phase: 'MONITORING' }],
    claims: symbols.map(s => [strategy.id, s]),
  });
  expect(result.ok).toBe(true);
  expect(result.pages.map(p => p.route)).toEqual(['/portfolio', '/strategies/paired-position', '/']);
  expect(result.pages.map(p => p.checkedTaskIds)).toEqual([[strategy.id], [strategy.id], [strategy.id]]);
  expect(stopWrites).toBe(0); expect(writes).toEqual([]);
  expect(documents).toBe(1); expect(apiReads).toBeLessThan(56);
});

test('deployment profile verifies empty holdings without pretending close interaction was tested', async ({ page, baseURL }) => {
  await setup(page, [], 'readonly', true);
  const empty = { mode: 'readonly', orders: [], fills: [], balances: [], positions: [] };
  await page.route('**/api/trading/snapshot', route => route.fulfill({ json: empty }));
  await page.route('**/api/crossex/positions-snapshot', route => route.fulfill({ json: empty }));
  await page.route('**/api/strategies', route => route.fulfill({ json: { strategies: [] } }));
  await open(page, '/portfolio');
  const result = await managedCloseChecks({ newPage: async () => page }, baseURL!, { mode: 'readonly', tasks: [], claims: [], positions: [] });
  expect(result.ok).toBe(true); expect(result.closeInteraction).toBe('notApplicable');
  expect(result.pages.map(p => p.emptyPositions)).toEqual([true, true, true]);
});

test('deployment profile rejects disabled close controls instead of passing zero coverage', async ({ page, baseURL }) => {
  await setup(page, []);
  await open(page, '/portfolio');
  await expect(managedCloseChecks({ newPage: async () => page }, baseURL!, {
    mode: 'live', accountId: profileId, positions: symbols.map((s,i)=>[s,'NONE',i?'10000':'-10000']),
    tasks: [{ id: strategy.id, status: 'RUNNING', phase: 'MONITORING' }],
    claims: symbols.map(s => [strategy.id, s]),
  })).rejects.toThrow();
});

test('deployment profile covers a second positions page and a retained KEEP group', async ({ page, baseURL }) => {
  test.setTimeout(60000);
  const targets: ManagedCloseTarget[] = Array.from({ length: 11 }, (_, i) => ({
    strategy: { ...strategy, id: `PAIR-TEST${String(i).padStart(4, '0')}`, status: i === 10 ? 'STOPPED' : 'RUNNING',
      config: { ...strategy.config, asset: `TEST${i}` },
      management: { ...strategy.management!, phase: i === 10 ? 'STOPPED' : 'MONITORING' } },
    scope: { accountProfileId: profileId, legs: [
      { symbol: `KRAKEN_FUTURE_TEST${i}_USD`, side: 'SELL' }, { symbol: `DERIBIT_FUTURE_TEST${i}_USDC`, side: 'BUY' }] },
  }));
  const records = targets.map(t => t.strategy), allSymbols = targets.flatMap(t => t.scope.legs.map(l => l.symbol));
  const writes = await setup(page, targets, 'live', false, allSymbols, records);
  let stopWrites = 0;
  await page.route('**/api/strategies/*/stop', async route => { stopWrites++; await route.abort(); });
  await open(page, '/portfolio');
  const result = await managedCloseChecks({ newPage: async () => page }, baseURL!, {
    mode: 'live', accountId: profileId, tasks: records.map(t => ({ id: t.id, status: t.status, phase: t.management!.phase })),
    positions: allSymbols.map((s,i) => [s, 'NONE', i % 2 ? '10000' : '-10000']),
    claims: targets.flatMap(t => t.scope.legs.map(l => [t.strategy.id, l.symbol])),
  });
  expect(result.pages.map(p => p.checkedTaskIds.length)).toEqual([11, 11, 11]);
  expect(stopWrites).toBe(0); expect(writes).toEqual([]);
});

for (const path of ['/portfolio', '/strategies/paired-position', '/']) {
  test(`close all reuses owned Stop on ${path} without single-leg or new-order paths`, async ({ page }) => {
    const writes = await setup(page);
    const submissions: unknown[] = [];
    await page.route('**/api/strategies/PAIR-C105E001/stop', async route => {
      submissions.push(route.request().postDataJSON());
      await new Promise(resolve => setTimeout(resolve, 200));
      await route.fulfill({ json: { ...strategy, management: { ...strategy.management, phase: 'EXITING', exitRequested: true, stopIntent: 'EXIT' } } });
    });
    await open(page, path);
    await expect(page.getByRole('button', { name: 'Close position', exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: 'Positions · WLFI', exact: true }).click();
    await expect(page.locator('.position-leg button.close-position-action')).toHaveCount(0);
    await page.getByRole('button', { name: 'Close all', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Stop task' });
    await expect(dialog.getByRole('checkbox')).toBeChecked();
    await expect(dialog.getByRole('checkbox')).toBeDisabled();
    expect(submissions).toEqual([]);
    await dialog.getByRole('button', { name: 'Stop and close positions', exact: true }).dblclick();
    await expect(dialog).toHaveCount(0);
    expect(submissions).toEqual([{ closePositions: true, expectedCloseScope: target.scope }]);
    expect(writes).toEqual([]);
    await expect(page.getByText('Exit accepted.', { exact: false })).toBeVisible();
  });
}

test('ambiguous/unowned groups cannot fall back to ordinary orders', async ({ page }) => {
  const writes = await setup(page, []);
  await open(page, '/portfolio');
  await expect(page.getByRole('button', { name: 'Close all', exact: true })).toBeDisabled();
  await expect(page.getByText('No unique managed task owns this pair')).toBeVisible();
  expect(writes).toEqual([]);
});

test('ownership changes retain the confirmation and do not retry or report completion', async ({ page }) => {
  const writes = await setup(page);
  let submissions = 0;
  await page.route('**/api/strategies/PAIR-C105E001/stop', async route => {
    submissions++;
    await route.fulfill({ status: 409, json: { error: 'managed_close_target_changed' } });
  });
  await open(page, '/portfolio');
  await page.getByRole('button', { name: 'Close all', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Stop task' });
  await dialog.getByRole('button', { name: 'Stop and close positions', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('Account or ownership changed');
  await expect(dialog.getByRole('button', { name: 'Stop and close positions', exact: true })).toBeDisabled();
  expect(submissions).toBe(1);
  expect(writes).toEqual([]);
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).first().click();
  await expect(page.getByRole('button', { name: 'Review required', exact: true })).toBeDisabled();
});

test('a late ownership poll cannot re-enable an accepted exit', async ({ page }) => {
  const writes = await setup(page);
  let calls = 0, release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/strategies/close-targets', async route => {
    calls++;
    if (calls > 1) await held;
    await route.fulfill({ json: { targets: [target] } });
  });
  let submitted = 0;
  await page.route('**/api/strategies/PAIR-C105E001/stop', async route => {
    submitted++;
    await route.fulfill({ json: { ...strategy, management: { ...strategy.management, phase: 'EXITING', exitRequested: true } } });
  });
  try {
    await open(page, '/portfolio');
    await page.getByRole('button', { name: 'Close all', exact: true }).click();
    await expect.poll(() => calls).toBeGreaterThan(1);
    await page.getByRole('button', { name: 'Stop and close positions', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Stop task' })).toHaveCount(0);
    const late = page.waitForResponse('**/api/strategies/close-targets');
    release();
    await late;
    await expect(page.getByRole('button', { name: 'Exiting', exact: true })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Close all', exact: true })).toHaveCount(0);
    expect(submitted).toBe(1); expect(writes).toEqual([]);
  } finally { release(); }
});

for (const outcome of ['empty', 'failed'] as const) test(`accepted exit survives ${outcome} targets while old holdings remain`, async ({ page }) => {
  const writes = await setup(page); let changed = false, submissions = 0;
  await page.route('**/api/strategies/close-targets', route => changed && outcome === 'failed'
    ? route.fulfill({ status: 503, json: { error: 'synthetic unavailable' } })
    : route.fulfill({ json: { targets: changed ? [] : [target] } }));
  await page.route('**/api/strategies/PAIR-C105E001/stop', async route => {
    submissions++;
    await route.fulfill({ json: { ...strategy, management: { ...strategy.management, phase: 'EXITING', exitRequested: true } } });
  });
  await open(page, '/portfolio'); await page.getByRole('button', { name: 'Close all', exact: true }).click();
  await page.getByRole('button', { name: 'Stop and close positions', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Exiting', exact: true })).toBeDisabled();
  changed = true;
  await page.waitForResponse(async response => response.url().endsWith('/api/strategies/close-targets')
    && (outcome === 'failed' ? response.status() === 503 : (await response.json()).targets.length === 0));
  await expect(page.getByText('No unique managed task owns this pair')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Exiting', exact: true })).toBeDisabled();
  await expect(page.getByText('Exit accepted; awaiting verification')).toBeVisible();
  expect(submissions).toBe(1); expect(writes).toEqual([]);
});

test('authoritative flat completion cannot regress after a late Stop acknowledgement or old ownership poll', async ({ page }) => {
  const writes = await setup(page); let stream!: WebSocketRoute, release!: () => void, submitted = false;
  const held = new Promise<void>(resolve => { release = resolve; });
  await page.routeWebSocket('**/ws/stream', socket => { stream = socket; socket.connectToServer(); });
  await page.route('**/api/strategies/PAIR-C105E001/stop', async route => {
    submitted = true; await held;
    await route.fulfill({ json: { ...strategy, management: { ...strategy.management, phase: 'EXITING', exitRequested: true } } });
  });
  try {
    await open(page, '/portfolio'); await page.getByRole('button', { name: 'Close all', exact: true }).click();
    await page.getByRole('button', { name: 'Stop and close positions', exact: true }).click();
    await expect.poll(() => submitted).toBe(true);
    const completed = { ...strategy, status: 'COMPLETED', management: { ...strategy.management, phase: 'COMPLETED',
      exitRequested: true, leftQuantity: '0', rightQuantity: '0', checkedAt: new Date().toISOString() } };
    stream.send(JSON.stringify({ type: 'strategy.update', payload: completed }));
    await expect(page.getByRole('button', { name: 'Completed', exact: true })).toBeDisabled();
    await expect(page.getByRole('dialog', { name: 'Stop task' })).toHaveCount(0);
    const ack = page.waitForResponse('**/api/strategies/PAIR-C105E001/stop'); release(); await ack;
    stream.send(JSON.stringify({ type: 'strategy.update', payload: strategy }));
    await page.waitForResponse('**/api/strategies/close-targets');
    await expect(page.getByRole('button', { name: 'Completed', exact: true })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Close all', exact: true })).toHaveCount(0);
    expect(writes).toEqual([]);
  } finally { release(); }
});

test('a remaining single leg shows submitted progress without exposing a single-leg close action', async ({ page }) => {
  const writes = await setup(page); let portfolio!: AuthenticatedPortfolioSnapshot;
  page.on('response', async response => {
    if (response.url().endsWith('/api/crossex/portfolio-snapshot') && !portfolio) portfolio = await response.json();
  });
  await page.route('**/api/strategies/PAIR-C105E001/stop', route => route.fulfill({ json: {
    ...strategy, management: { ...strategy.management, phase: 'EXITING', exitRequested: true } } }));
  await open(page, '/portfolio'); await page.getByRole('button', { name: 'Close all', exact: true }).click();
  await page.getByRole('button', { name: 'Stop and close positions', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Exiting', exact: true })).toBeDisabled();
  await expect.poll(() => Boolean(portfolio)).toBe(true);
  await page.route('**/api/crossex/portfolio-snapshot', route => route.fulfill({ json: { ...portfolio,
    snapshot: { ...portfolio.snapshot, futuresPositions: portfolio.snapshot.futuresPositions.slice(1) } } }));
  const refreshed = page.waitForResponse('**/api/crossex/portfolio-snapshot');
  await page.locator('.portfolio-status').getByRole('button', { name: 'Refresh', exact: true }).click(); await refreshed;
  await expect(page.locator('.positions-table tbody tr')).toHaveCount(1);
  await expect(page.locator('.positions-table').getByRole('status')).toContainText('Exiting');
  await expect(page.locator('.positions-table button.close-position-action')).toHaveCount(0);
  expect(writes).toEqual([]);
});

test('the initial ownership read shows loading instead of inventing an unowned pair', async ({ page }) => {
  await setup(page); let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/strategies/close-targets', async route => { await held; await route.fulfill({ json: { targets: [target] } }); });
  try {
    await open(page, '/portfolio');
    await expect(page.getByText('Checking ownership')).toBeVisible();
    await expect(page.getByText('No unique managed task owns this pair')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Close all', exact: true })).toBeDisabled();
    release(); await expect(page.getByRole('button', { name: 'Close all', exact: true })).toBeEnabled();
  } finally { release(); }
});

test('an accepted exit shows review after control is transferred even when targets disappear', async ({ page }) => {
  const writes = await setup(page); let stream!: WebSocketRoute;
  await page.routeWebSocket('**/ws/stream', socket => { stream = socket; socket.connectToServer(); });
  await page.route('**/api/strategies/PAIR-C105E001/stop', route => route.fulfill({ json: {
    ...strategy, management: { ...strategy.management, phase: 'EXITING', exitRequested: true } } }));
  await open(page, '/portfolio'); await page.getByRole('button', { name: 'Close all', exact: true }).click();
  await page.getByRole('button', { name: 'Stop and close positions', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Exiting', exact: true })).toBeDisabled();
  stream.send(JSON.stringify({ type: 'strategy.update', payload: { ...strategy, status: 'STOPPED',
    management: { ...strategy.management, phase: 'TRANSFERRED', stopIntent: 'KEEP' } } }));
  await page.route('**/api/strategies/close-targets', route => route.fulfill({ json: { targets: [] } }));
  await expect(page.getByRole('button', { name: 'Review required', exact: true })).toBeDisabled();
  expect(writes).toEqual([]);
});

test('a risk event before a late Stop acknowledgement keeps the notice under review', async ({ page }) => {
  await setup(page); let stream!: WebSocketRoute, release!: () => void, submitted = false;
  const held = new Promise<void>(resolve => { release = resolve; });
  await page.routeWebSocket('**/ws/stream', socket => { stream = socket; socket.connectToServer(); });
  await page.route('**/api/strategies/PAIR-C105E001/stop', async route => {
    submitted = true; await held;
    await route.fulfill({ json: { ...strategy, management: { ...strategy.management, phase: 'EXITING', exitRequested: true } } });
  });
  try {
    await open(page, '/portfolio'); await page.getByRole('button', { name: 'Close all', exact: true }).click();
    await page.getByRole('button', { name: 'Stop and close positions', exact: true }).click();
    await expect.poll(() => submitted).toBe(true);
    stream.send(JSON.stringify({ type: 'strategy.update', payload: { ...strategy, status: 'PAUSED',
      management: { ...strategy.management, phase: 'RISK_PAUSED' } } }));
    await expect(page.getByRole('button', { name: 'Review required', exact: true })).toBeDisabled();
    release(); await expect(page.getByRole('dialog', { name: 'Stop task' })).toHaveCount(0);
    await expect(page.getByText('Task state changed.', { exact: false })).toBeVisible();
    await expect(page.getByText('Exit accepted. Closing', { exact: false })).toHaveCount(0);
  } finally { release(); }
});

test('completion of one pair leaves another pair confirmation open', async ({ page }) => {
  const otherSymbols = symbols.map(s => s.replace('WLFI', 'BTC'));
  const other = { ...strategy, id: 'PAIR-C105E002', config: { ...strategy.config, asset: 'BTC' } };
  const otherTarget = { strategy: other, scope: { ...target.scope, legs: target.scope.legs.map((leg, i) => ({ ...leg, symbol: otherSymbols[i] })) } };
  await setup(page, [target, otherTarget], 'live', false, [...symbols, ...otherSymbols], [strategy, other]);
  let stream!: WebSocketRoute;
  await page.routeWebSocket('**/ws/stream', socket => { stream = socket; socket.connectToServer(); });
  await page.route('**/api/strategies/PAIR-C105E001/stop', route => route.fulfill({ json: {
    ...strategy, management: { ...strategy.management, phase: 'EXITING', exitRequested: true } } }));
  await open(page, '/portfolio');
  await page.locator('tr').filter({ hasText: 'WLFI' }).getByRole('button', { name: 'Close all', exact: true }).click();
  await page.getByRole('button', { name: 'Stop and close positions', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Stop task' })).toHaveCount(0);
  await page.locator('tr').filter({ hasText: 'BTC' }).getByRole('button', { name: 'Close all', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Stop task' }); await expect(dialog).toContainText('BTC');
  stream.send(JSON.stringify({ type: 'strategy.update', payload: { ...strategy, status: 'COMPLETED', management: {
    ...strategy.management, phase: 'COMPLETED', exitRequested: true, leftQuantity: '0', rightQuantity: '0', checkedAt: new Date().toISOString() } } }));
  await expect(page.getByRole('button', { name: 'Completed', exact: true })).toBeDisabled();
  await expect(dialog).toBeVisible(); await expect(dialog).toContainText('BTC');
});

test('a late close response stays on its original account after a profile switch', async ({ page }) => {
  await setup(page); let release!: () => void, submitted = false, active = profileId;
  const held = new Promise<void>(resolve => { release = resolve; });
  const other = { ...strategy, id: 'PAIR-C105E002', accountProfileId: 'other-account' };
  await page.route('**/api/onboarding/connection', async route => {
    const original = await (await route.fetch()).json();
    await route.fulfill({ json: { ...original, configured: true, activeProfileId: active } });
  });
  await page.route('**/api/strategies', route => route.fulfill({ json: { strategies: active === profileId ? [strategy] : [other] } }));
  await page.route('**/api/strategies/close-targets', route => route.fulfill({ json: { targets: active === profileId ? [target]
    : [{ strategy: other, scope: { ...target.scope, accountProfileId: active } }] } }));
  await page.route('**/api/strategies/PAIR-C105E001/stop', async route => {
    submitted = true; await held;
    await route.fulfill({ json: { ...strategy, management: { ...strategy.management, phase: 'EXITING', exitRequested: true } } });
  });
  try {
    await open(page, '/portfolio'); await page.getByRole('button', { name: 'Close all', exact: true }).click();
    await page.getByRole('button', { name: 'Stop and close positions', exact: true }).click();
    await expect.poll(() => submitted).toBe(true);
    active = 'other-account'; await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(page.getByRole('button', { name: 'Close all', exact: true })).toBeEnabled();
    const response = page.waitForResponse('**/api/strategies/PAIR-C105E001/stop'); release(); await response;
    await expect(page.getByText('Exit accepted.', { exact: false })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Close all', exact: true })).toBeEnabled();
    active = profileId; await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(page.getByRole('button', { name: 'Exiting', exact: true })).toBeDisabled();
  } finally { release(); }
});

test('lost Stop response requires review even after dismissing the dialog', async ({ page }) => {
  const writes = await setup(page);
  let submitted = 0;
  await page.route('**/api/strategies/PAIR-C105E001/stop', async route => { submitted++; await route.abort('failed'); });
  await open(page, '/portfolio');
  await page.getByRole('button', { name: 'Close all', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Stop task' });
  await dialog.getByRole('button', { name: 'Stop and close positions', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('do not resubmit');
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).first().click();
  await expect(page.getByRole('button', { name: 'Review required', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: /^Open orders/ }).click();
  await page.getByRole('button', { name: /^Positions/ }).click();
  await expect(page.getByRole('button', { name: 'Review required', exact: true })).toBeDisabled();
  await page.evaluate(() => { history.pushState({}, '', '/'); window.dispatchEvent(new PopStateEvent('popstate')); });
  await expect(page.getByRole('button', { name: 'Review required', exact: true })).toBeDisabled();
  await page.evaluate(() => { history.pushState({}, '', '/portfolio'); window.dispatchEvent(new PopStateEvent('popstate')); });
  await expect(page.getByRole('button', { name: 'Review required', exact: true })).toBeDisabled();
  await page.route('**/api/strategies/close-targets', route => route.fulfill({ json: { targets: [] } }));
  await page.waitForResponse(async response => response.url().endsWith('/api/strategies/close-targets') && (await response.json()).targets.length === 0);
  await expect(page.getByRole('button', { name: 'Review required', exact: true })).toBeDisabled();
  expect(submitted).toBe(1); expect(writes).toEqual([]);
});

test('owned close in read-only mode opens the existing permission dialog without a Stop request', async ({ page }) => {
  const writes = await setup(page, [target], 'readonly');
  let stops = 0;
  await page.route('**/api/strategies/PAIR-C105E001/stop', async route => { stops++; await route.abort(); });
  await open(page, '/portfolio');
  await page.getByRole('button', { name: 'Close all', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Risk disclaimer' })).toBeVisible();
  await expect(page.getByRole('dialog', { name: 'Stop task' })).toHaveCount(0);
  expect(stops).toBe(0); expect(writes).toEqual([]);
});

test('a paused owned task explains the review requirement instead of bypassing its lock', async ({ page }) => {
  const writes = await setup(page, [{ ...target, strategy: { ...strategy, status: 'PAUSED',
    management: { ...strategy.management!, phase: 'RISK_PAUSED' } } }]);
  await open(page, '/portfolio');
  await expect(page.getByRole('button', { name: 'Review required', exact: true })).toBeDisabled();
  await expect(page.getByText('Review the paused task before closing')).toBeVisible();
  expect(writes).toEqual([]);
});
