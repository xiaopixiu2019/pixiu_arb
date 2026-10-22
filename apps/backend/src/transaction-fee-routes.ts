import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { TransactionFeeService } from './transaction-fee-service.js';
export function registerTransactionFeeRoutes(app: FastifyInstance, service: TransactionFeeService): void {
  app.get('/api/crossex/transaction-fees', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (request.headers['x-gct-read-intent'] !== 'transaction-fees') return reply.code(403).send({ error: 'missing_read_intent' });
    if (!z.object({}).strict().safeParse(request.query).success) return reply.code(400).send({ error: 'invalid_fee_query' });
    return service.summary();
  });
  app.get('/api/crossex/transaction-fees/details', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (request.headers['x-gct-read-intent'] !== 'transaction-fees') return reply.code(403).send({ error: 'missing_read_intent' });
    const parsed = z.object({ taskId: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/).optional(), page: z.coerce.number().int().min(1).max(100000).default(1) }).strict().safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_fee_query' });
    const result = await service.detail(parsed.data.taskId ?? null, parsed.data.page);
    return result ?? reply.code(404).send({ error: 'fee_detail_unavailable' });
  });
}
