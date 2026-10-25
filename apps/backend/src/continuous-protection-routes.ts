import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { OneTimeCsrfTokens } from './csrf.js';
import type { ContinuousProtection } from './continuous-protection.js';
import type { MarginRiskMonitor } from './margin-risk-monitor.js';

export function registerContinuousProtectionRoutes(app: FastifyInstance, protection: ContinuousProtection,
  margin: MarginRiskMonitor, authenticated: <T>(work: () => Promise<T>) => Promise<T>): void {
  const tokens = new OneTimeCsrfTokens();
  const view = () => ({ accountId: margin.snapshot().accountId, authorization: protection.authority.grant(),
    protection: protection.view(), csrfToken: tokens.issue() });
  app.get('/api/risk/protection', async (_request, reply) => { reply.header('Cache-Control', 'no-store'); return view(); });
  app.put('/api/risk/protection', async (request, reply) => {
    const parsed = z.object({ accountId: z.string().min(1), revision: z.number().int().nonnegative(), enabled: z.boolean(),
      groupIds: z.array(z.string().min(1).max(120)).max(100), acknowledge: z.literal(true), csrfToken: z.string().min(20) }).strict().safeParse(request.body);
    if (request.headers['x-gct-risk-intent'] !== 'configure-protection' || !parsed.success || !tokens.consume(parsed.data.csrfToken))
      return reply.code(403).send({ error: 'invalid_protection_intent' });
    const data = parsed.data, current = margin.snapshot();
    if (data.accountId !== current.accountId && (data.enabled || data.accountId !== protection.authority.grant()?.accountId))
      return reply.code(409).send({ error: 'protection_account_changed' });
    try {
      const work = () => protection.configure(data.accountId, data.groupIds, data.revision, data.enabled);
      if (data.enabled) await authenticated(work); else await work();
      return view();
    } catch (error) {
      const reason = error instanceof Error && /^(protection_|margin_)[a-z_]+$/.test(error.message) ? error.message : 'protection_configuration_failed';
      return reply.code(409).send({ error: reason });
    }
  });
}
