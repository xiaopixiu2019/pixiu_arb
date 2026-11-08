import type { Page, WebSocketRoute } from '@playwright/test';
import { DEFAULT_MARGIN_POLICY, MarginSnapshotSchema, type MarginPolicy } from '../packages/shared-types/src/margin-risk.js';

export async function riskConfigFixture(page: Page) {
  let policy = structuredClone(DEFAULT_MARGIN_POLICY), effective: MarginPolicy | null = null, accountId = 'risk-config-a';
  let stream: WebSocketRoute | undefined;
  let overrides: Record<string, unknown> = {};
  const writes: { path: string; body: Record<string, unknown> }[] = [];
  const snapshot = () => MarginSnapshotSchema.parse({ accountId, accountLabel: accountId, sampledAt: Date.now(), ageMs: 0,
    fresh: true, status: 'clear', reason: null, entryBlocked: false, liveEnabled: true, incidentId: effective ? 'incident-1' : null,
    policy, effectivePolicy: effective ?? policy, uncoveredSymbols: [], groups: [
      { id: 'g-live', strategyId: 'task-live', asset: 'BTC', phase: 'MONITORING', eligible: true, authorized: policy.protectedGroupIds.includes('g-live'), reason: null },
      ...Array.from({ length: 24 }, (_, i) => ({ id: `g-old-${i}`, strategyId: `task-old-${i}`, asset: 'OLD', phase: 'COMPLETED', eligible: false,
        authorized: policy.protectedGroupIds.includes(`g-old-${i}`), reason: null })),
    ], metrics: { initialPct: '240', maintenancePct: '360', marginBalance: '2400', initialMargin: '1000', maintenanceMargin: '666.67', availableMargin: '1400',
      initialHeadroom: '1300', maintenanceHeadroom: '1066.66', accountMode: 'CROSS_EXCHANGE', exchangeType: 'CROSSEX', remoteUpdatedAt: String(Date.now()), assets: [] }, ...overrides });
  const send = () => stream?.send(JSON.stringify({ type: 'risk.margin', payload: snapshot() }));
  await page.addInitScript(() => localStorage.setItem('crossex-language', 'zh'));
  await page.route('**/api/preferences', r => r.fulfill({ json: { preferences: { language: 'zh' } } }));
  await page.route('**/api/risk/margin', r => r.fulfill({ json: snapshot() }));
  await page.routeWebSocket('**/ws/stream', socket => { stream = socket; send(); });
  await page.route('**/api/risk/margin/events*', r => r.fulfill({ json: { accountId, events: [], hasMore: false } }));
  await page.route('**/api/notifications/telegram', r => r.fulfill({ json: { configured: false, botName: null, chatId: null, testedAt: null,
    lastSentAt: null, lastError: null, retryAt: null, storage: 'env_file', csrfToken: 'synthetic-only' } }));
  await page.route('**/api/risk/protection', r => r.fulfill({ json: { accountId, authorization: null,
    protection: { enabled: false, state: 'DISABLED', groups: [] }, csrfToken: 'synthetic-only' } }));
  await page.route('**/api/risk/margin/policy', r => {
    if (r.request().method() === 'PUT') {
      const body = r.request().postDataJSON(); policy = { ...body.policy, revision: policy.revision + 1 };
      writes.push({ path: '/policy', body }); send(); return r.fulfill({ json: snapshot() });
    }
    return r.fulfill({ json: { policy, accountId, csrfToken: 'synthetic-only' } });
  });
  return { writes, snapshot, send, get policy() { return policy; },
    override(next: Record<string, unknown>) { overrides = next; send(); },
    change(next: Partial<MarginPolicy>) { policy = { ...policy, ...next }; send(); },
    effective(next: MarginPolicy) { effective = next; send(); },
    account(next: string) { accountId = next; send(); } };
}

export async function openRiskConfig(page: Page) {
  await page.goto('/risk-management');
  const dialog = page.getByRole('dialog', { name: /Risk disclaimer|风险免责声明/ });
  await dialog.waitFor({ state: 'visible', timeout: 1500 }).catch(() => undefined);
  if (await dialog.isVisible()) { await dialog.getByRole('checkbox').check(); await dialog.getByRole('button', { name: /Continue in read-only mode|以只读模式继续/ }).click(); }
  await page.getByRole('button', { name: '刷新数据', exact: true }).click();
}
