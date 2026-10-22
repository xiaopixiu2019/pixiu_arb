import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

function position(
  positionId: string,
  symbol: string,
  quantity: string,
  value: string,
  initialMargin: string,
  leverage: string,
) {
  return {
    positionId, symbol, positionSide: 'NONE', initialMargin, maintenanceMargin: '10',
    quantity, value, unrealizedPnl: '0', unrealizedPnlRate: '0', entryPrice: '51.8',
    markPrice: '51.82', leverage, maxLeverage: '20', riskLimit: '1', fee: '0',
    fundingFee: '0', fundingTime: '2030-01-01T00:00:00.000Z', createdAt: '2030-01-01T00:00:00.000Z',
    updatedAt: '2030-01-01T00:00:00.000Z', realizedPnl: '0', crossExAdlRank: null, exchangeAdlRank: null,
  };
}

const portfolio = {
  dataStatus: 'fresh',
  remoteStatus: 'healthy',
  snapshot: {
    account: {
      availableMargin: '8000', marginBalance: '10000', initialMargin: '1554.6', maintenanceMargin: '20',
      initialMarginRate: '6.43', maintenanceMarginRate: '500', positionMode: 'SINGLE',
      accountMode: 'CROSS_EXCHANGE', exchangeType: '', remoteUpdatedAt: '2030-01-01T00:00:00.000Z',
    },
    balances: [],
    futuresPositions: [
      position('e2e-hype-hyperliquid', 'HYPERLIQUID_FUTURE_HYPE_USDC', '100', '5182', '1036.4', '5'),
      position('e2e-hype-bybit', 'BYBIT_FUTURE_HYPE_USDT', '-100', '5182', '518.2', '10'),
    ],
    marginPositions: [], openOrders: [], recentFills: [],
    fetchedAt: '2030-01-01T00:00:00.000Z', source: 'gate_crossex_authenticated_rest',
  },
  reconciliation: {
    id: 'reconciliation', createdAt: '2030-01-01T00:00:00.000Z', status: 'clean',
    previousFetchedAt: null, currentFetchedAt: '2030-01-01T00:00:00.000Z', issues: [],
  },
};

test('separates portfolio KPIs and shows leverage-aware funding APR in the position table', async ({ page }) => {
  await page.request.post('/__e2e/grouped-positions');
  try {
    await page.route('**/api/risk/margin', async route => {
      const original = await (await route.fetch()).json();
      await route.fulfill({ json: { ...original, valuation: { profileId: 'e2e', checkedAt: Date.now(), rates: { USDT: '1', USDC: '1' } } } });
    });
    await page.route('**/api/onboarding/connection', (route) => route.fulfill({ json: {
      configured: true, storage: 'memory_test_only', label: 'E2E',
      lastVerifiedAt: '2030-01-01T00:00:00.000Z', secureEntryPath: '/secure/credentials',
      readOnly: true, activeProfileId: 'e2e',
      profiles: [{ id: 'e2e', label: 'E2E', storage: 'memory_test_only', lastVerifiedAt: '2030-01-01T00:00:00.000Z', active: true }],
    } }));
    await page.route('**/api/crossex/portfolio-snapshot', (route) => route.fulfill({ json: portfolio }));
    await page.goto('/');
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    const riskDialog = page.getByRole('dialog', { name: 'Risk disclaimer' });
    await riskDialog.waitFor({ state: 'visible', timeout: 1_000 }).catch(() => undefined);
    if (await riskDialog.isVisible()) {
      await riskDialog.getByRole('checkbox', { name: 'I have read and understand the risks above.' }).check();
      await riskDialog.getByRole('button', { name: /Continue in read-only mode/ }).click();
    }

    const kpis = page.locator('.position-funding-kpi');
    await expect(kpis).toHaveCount(2);
    await expect(kpis.nth(0)).toContainText('All positions funding APR');
    await expect(kpis.nth(0).locator('strong')).toHaveText('-17.02%');
    await expect(kpis.nth(1)).toContainText('Estimated 8h funding');
    await expect(kpis.nth(1).locator('strong')).toHaveText('-$1.55');

    const group = page.locator('.aggregate-row').filter({ hasText: 'HYPE PERP' });
    await expect(group.locator('.funding-yield-cell strong')).toHaveText('-109.50%');
    await expect(group.locator('.funding-yield-cell small')).toHaveText('Est. 8h -$1.55');
    await group.locator('.expand-position').click();
    const legs = page.locator('.position-leg');
    await expect(legs.locator('.funding-yield-cell')).toHaveCount(2);
    await expect(legs.filter({ hasText: 'Hyperliquid' }).locator('.funding-yield-cell')).toContainText('5× · Margin $1,036.4');

    const results = await new AxeBuilder({ page })
      .include('.position-funding-overview')
      .include('.funding-yield-heading')
      .include('.funding-yield-cell')
      .analyze();
    expect(results.violations.map((violation) => ({
      id: violation.id,
      targets: violation.nodes.map((node) => node.target.join(' ')),
    }))).toEqual([]);
    await page.goto('/portfolio');
    await expect(page.locator('.performance-kpi').nth(2).locator('strong')).toHaveText('-17.02%');
    await expect(page.locator('.position-funding-kpi').first().locator('strong')).toHaveText('-17.02%');
  } finally {
    await page.request.delete('/__e2e/grouped-positions');
  }
});
