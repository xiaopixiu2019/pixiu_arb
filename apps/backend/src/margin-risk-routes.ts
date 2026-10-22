import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { MarginRiskMonitor } from './margin-risk-monitor.js';
import { OneTimeCsrfTokens } from './csrf.js';

export function registerMarginRiskRoutes(app: FastifyInstance, monitor: MarginRiskMonitor): void {
  const tokens = new OneTimeCsrfTokens();
  app.get('/api/risk/margin/modes', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const parsed = z.object({ symbols: z.string().max(240).transform(s => s.split(','))
      .pipe(z.array(z.string().regex(/^[A-Z0-9]+_FUTURE_[A-Z0-9]+_[A-Z0-9]+$/)).min(1).max(2)) }).safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_margin_symbols' });
    try { return await monitor.sources.modes?.(parsed.data.symbols) ?? reply.code(503).send({ error: 'margin_modes_unavailable' }); }
    catch { return reply.code(409).send({ error: 'margin_modes_unavailable' }); }
  });
  app.get('/api/risk/margin', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (!monitor.snapshot().fresh) await monitor.refresh();
    return monitor.snapshot();
  });
  app.get('/api/risk/margin/policy', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return { policy: monitor.snapshot().policy, accountId: monitor.snapshot().accountId, csrfToken: tokens.issue() };
  });
  app.put('/api/risk/margin/policy', async (request, reply) => {
    const parsed = z.object({ policy: z.unknown(), accountId: z.string(), csrfToken: z.string().min(20) }).safeParse(request.body);
    if (request.headers['x-gct-risk-intent'] !== 'configure-margin' || !parsed.success || !tokens.consume(parsed.data.csrfToken))
      return reply.code(403).send({ error: 'invalid_risk_configuration_intent' });
    if (parsed.data.accountId !== monitor.snapshot().accountId) return reply.code(409).send({ error: 'margin_account_changed' });
    try { return monitor.savePolicy(parsed.data.policy); }
    catch (error) { return reply.code(409).send({ error: error instanceof z.ZodError ? 'invalid_margin_policy' : error instanceof Error ? error.message : 'margin_configuration_failed' }); }
  });
  app.post('/api/risk/margin/resume-entry', async (request, reply) => {
    const parsed = z.object({ accountId: z.string(), csrfToken: z.string().min(20) }).safeParse(request.body);
    if (request.headers['x-gct-risk-intent'] !== 'resume-entry' || !parsed.success || !tokens.consume(parsed.data.csrfToken))
      return reply.code(403).send({ error: 'invalid_risk_configuration_intent' });
    if (parsed.data.accountId !== monitor.snapshot().accountId) return reply.code(409).send({ error: 'margin_account_changed' });
    try {
      await monitor.refresh();
      if (parsed.data.accountId !== monitor.snapshot().accountId) return reply.code(409).send({ error: 'margin_account_changed' });
      monitor.resumeEntries(); return monitor.snapshot();
    }
    catch { return reply.code(409).send({ error: 'margin_recovery_not_confirmed' }); }
  });
  app.get('/api/risk/margin/history', async (request, reply) => {
    const query = z.object({ hours: z.coerce.number().refine((n) => [1, 24, 168, 720].includes(n)).default(24),
      accountId: z.string().min(1).max(128), unit: z.string().regex(/^[A-Z]+$/).optional() }).safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: 'invalid_margin_history_range' });
    const key = monitor.snapshot().accountId;
    if (!key || key !== query.data.accountId) return reply.code(409).send({ error: 'margin_account_changed' });
    if (query.data.unit && !monitor.snapshot().units?.some((u) => u.exchangeType === query.data.unit))
      return reply.code(400).send({ error: 'margin_unit_unknown' });
    reply.header('Cache-Control', 'no-store');
    return { ...monitor.store.history(query.data.unit ? `${key}:${query.data.unit}` : key, query.data.hours), accountId: key };
  });
  app.get('/api/risk/margin/events', async (request, reply) => {
    const query = z.object({ accountId: z.string().min(1).max(128), before: z.coerce.number().int().positive().optional(),
      hours: z.coerce.number().refine((n) => [1, 24, 168, 720].includes(n)).optional() }).safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: 'invalid_risk_event_cursor' });
    const key = monitor.snapshot().accountId; reply.header('Cache-Control', 'no-store');
    if (!key || key !== query.data.accountId) return reply.code(409).send({ error: 'margin_account_changed' });
    const limit = query.data.hours ? 2000 : 100;
    const events = monitor.store.events(key, query.data.before, query.data.hours ? Date.now() - query.data.hours * 3600000 : 0, limit);
    return { accountId: key, events, hasMore: events.length === limit };
  });
}
