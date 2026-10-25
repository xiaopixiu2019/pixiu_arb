import { describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import { registerContinuousProtectionRoutes } from './continuous-protection-routes.js';
import type { ContinuousProtection } from './continuous-protection.js';
import type { MarginRiskMonitor } from './margin-risk-monitor.js';

describe('continuous protection enrollment boundary', () => {
  it('requires acknowledgement, one-use CSRF, strict scope and current account', async () => {
    const app = Fastify(), configure = vi.fn(async () => undefined);
    const protection = { configure, authority: { grant: () => null }, view: () => ({ enabled: false, state: 'DISABLED', groups: [] }) } as unknown as ContinuousProtection;
    const margin = { snapshot: () => ({ accountId: 'current' }) } as unknown as MarginRiskMonitor;
    registerContinuousProtectionRoutes(app, protection, margin, work => work());
    try {
      const read = () => app.inject('/api/risk/protection').then(r => r.json());
      const write = (payload: Record<string, unknown>) => app.inject({ method: 'PUT', url: '/api/risk/protection', headers: { 'x-gct-risk-intent': 'configure-protection' }, payload });
      const base = { accountId: 'current', revision: 0, groupIds: ['selected'], enabled: true, acknowledge: true };
      const first = await read();
      expect((await write({ ...base, csrfToken: first.csrfToken, acknowledge: false })).statusCode).toBe(403);
      expect((await write({ ...base, csrfToken: first.csrfToken, overrideLock: true })).statusCode).toBe(403);
      expect(configure).not.toHaveBeenCalled();
      expect((await write({ ...base, csrfToken: first.csrfToken })).statusCode).toBe(200);
      expect(configure).toHaveBeenCalledExactlyOnceWith('current', ['selected'], 0, true);
      expect((await write({ ...base, csrfToken: first.csrfToken })).statusCode).toBe(403);
      const next = await read();
      expect((await write({ ...base, accountId: 'changed', csrfToken: next.csrfToken })).statusCode).toBe(409);
      expect(configure).toHaveBeenCalledTimes(1);
    } finally { await app.close(); }
  });
});
