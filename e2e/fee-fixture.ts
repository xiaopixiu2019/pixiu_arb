import { expect, type Page } from '@playwright/test';
import type { FeeDetail, FeeSummary } from '@gate-crossex/shared-types';

export async function installFeeFixture(page: Page) {
  const at = Date.now(), metric = (amount: string) => ({ amount, status: 'ready' as const, pending: 0, reason: null });
  const summary: FeeSummary = { profileId: 'gate-crossex-default', currency: 'USDT', since: at - 30 * 86400000, checkedAt: at,
    total: metric('128.46'), today: metric('6.24'), yesterday: metric('8.72'), assigned: metric('121.82'), unassigned: metric('6.64'),
    tasks: [{ taskId: 'PAIR-LAYOUT01', metric: metric('24.36'), count: 26 }] };
  await page.route('**/api/crossex/transaction-fees', (route) => route.fulfill({ json: summary }));
  await page.route('**/api/crossex/transaction-fees/details*', (route) => {
    const url = new URL(route.request().url()), current = Number(url.searchParams.get('page') ?? 1);
    const detail: FeeDetail = { profileId: summary.profileId, taskId: url.searchParams.get('taskId'), since: summary.since, checkedAt: at,
      metric: metric('24.36'), entry: '18.24', exit: '0', adjustment: '6.12', unknown: '0', rebates: '0', page: current, pageSize: 25, totalEntries: 26, totalFills: 26,
      venues: [{ venue: 'DERIBIT', coin: 'USDC', native: '12.18', converted: '12.16', count: 13, pending: 0 }, { venue: 'BYBIT', coin: 'USDT', native: '12.2', converted: '12.2', count: 13, pending: 0 }],
      entries: [{ id: `ledger-${current}`, at, venue: 'BYBIT', orderId: 'order-proof', taskId: 'PAIR-LAYOUT01', coin: 'USDT', native: '12.2', converted: '12.2', rate: '1', phase: 'entry', reason: null }],
      fills: [{ id: `fill-${current}`, at, venue: 'BYBIT', orderId: 'order-proof', symbol: 'BYBIT_FUTURE_BTC_USDT', quantity: '1', fee: '12.2', coin: 'USDT', role: 'TAKER', phase: 'entry' }] };
    return route.fulfill({ json: detail });
  });
}

export async function verifyFeeInteractions(page: Page) {
  await expect(page.locator('.running-strategies')).toContainText('24.36');
  await page.getByRole('button', { name: /View task fee details|查看任务手续费明细/ }).first().click();
  await expect(page.locator('.task-fee-details')).toContainText('18.24');
  await expect(page.locator('.task-fee-details')).toContainText('12.18 USDC');
  await page.getByRole('button', { name: /Original fills →|原始成交 →/ }).click();
  const dialog = page.getByRole('dialog', { name: /Fee statement|费用账单/ });
  await expect(dialog).toContainText('fill-1');
  await dialog.getByRole('button', { name: /Next|下一页/, exact: true }).click();
  await expect(dialog).toContainText('fill-2');
  await dialog.getByRole('button', { name: /Ledger fees|账本费用/, exact: true }).click();
  await expect(dialog).toContainText('ledger-1');
  await page.keyboard.press('Escape'); await expect(dialog).toHaveCount(0);
}
