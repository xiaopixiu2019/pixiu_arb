import { z } from 'zod';
import { ContinuousProtectionResponseSchema, MarginSnapshotSchema, MarginPolicySchema, MarginRiskEventSchema, TelegramStatusSchema, type MarginPolicy } from '@gate-crossex/shared-types';

async function read<T>(path: string, schema: z.ZodType<T>, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { ...init, signal: AbortSignal.timeout(15000),
    headers: { 'Content-Type': 'application/json', ...init?.headers } });
  const payload: unknown = await response.json();
  if (!response.ok) {
    const error = z.object({ error: z.string() }).safeParse(payload);
    throw new Error(error.success ? error.data.error : 'risk_request_failed');
  }
  return schema.parse(payload);
}
export const riskApi = {
  protection: () => read('/api/risk/protection', ContinuousProtectionResponseSchema),
  saveProtection: async (accountId: string, revision: number, groupIds: string[], enabled: boolean) => {
    const current = await riskApi.protection();
    if (current.accountId !== accountId || (current.authorization?.revision ?? 0) !== revision) throw new Error('protection_configuration_changed');
    return read('/api/risk/protection', ContinuousProtectionResponseSchema, { method: 'PUT',
      headers: { 'x-gct-risk-intent': 'configure-protection' },
      body: JSON.stringify({ accountId, revision, groupIds, enabled, acknowledge: true, csrfToken: current.csrfToken }) });
  },
  modes: (symbols: string[]) => read(`/api/risk/margin/modes?symbols=${encodeURIComponent(symbols.join(','))}`,
    z.object({ profileId: z.string().nullable(), items: z.array(z.object({ symbol: z.string(), supportCross: z.boolean().nullable(),
      mode: z.enum(['CROSS', 'ISOLATED']).nullable(), checkedAt: z.number(), reason: z.string().nullable() })) })),
  snapshot: () => read('/api/risk/margin', MarginSnapshotSchema),
  events: async (accountId: string, before?: number) => {
    const query = new URLSearchParams({ accountId }); if (before) query.set('before', String(before));
    const data = await read(`/api/risk/margin/events?${query}`, z.object({ accountId: z.string(), events: z.array(MarginRiskEventSchema), hasMore: z.boolean() }));
    if (data.accountId !== accountId) throw new Error('margin_account_changed'); return data;
  },
  policy: () => read('/api/risk/margin/policy', z.object({ policy: MarginPolicySchema, accountId: z.string().nullable(), csrfToken: z.string() })),
  save: async (policy: MarginPolicy, accountId: string | null) => {
    const { csrfToken, accountId: current } = await riskApi.policy();
    if (!accountId || current !== accountId) throw new Error('margin_account_changed');
    return read('/api/risk/margin/policy', MarginSnapshotSchema, { method: 'PUT', headers: { 'x-gct-risk-intent': 'configure-margin' }, body: JSON.stringify({ policy, accountId, csrfToken }) });
  },
  resume: async (accountId: string | null) => {
    const { csrfToken, accountId: current } = await riskApi.policy();
    if (!accountId || current !== accountId) throw new Error('margin_account_changed');
    return read('/api/risk/margin/resume-entry', MarginSnapshotSchema, { method: 'POST', headers: { 'x-gct-risk-intent': 'resume-entry' }, body: JSON.stringify({ csrfToken, accountId }) });
  },
  telegram: () => read('/api/notifications/telegram', TelegramStatusSchema.extend({ csrfToken: z.string() })),
  testTelegram: async () => {
    const { csrfToken } = await riskApi.telegram();
    return read('/api/notifications/telegram/test', TelegramStatusSchema, { method: 'POST', headers: { 'x-gct-notification-intent': 'test' }, body: JSON.stringify({ csrfToken }) });
  },
  removeTelegram: async () => {
    const { csrfToken } = await riskApi.telegram();
    return read('/api/notifications/telegram', TelegramStatusSchema, { method: 'DELETE', headers: { 'x-gct-notification-intent': 'remove' }, body: JSON.stringify({ csrfToken, confirm: true }) });
  },
};
