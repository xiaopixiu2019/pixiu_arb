import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { PerformanceRangeSchema } from '@gate-crossex/shared-types';
import type { AccountPerformanceService } from './performance-service.js';
export function registerPerformanceRoutes(app: FastifyInstance, service: AccountPerformanceService): void {
  app.get('/api/crossex/performance', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (request.headers['x-gct-read-intent'] !== 'account-performance') return reply.code(403).send({ error: 'missing_read_intent' });
    const query = z.object({ range: PerformanceRangeSchema.default('30d') }).strict().safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: 'invalid_performance_query' });
    return service.read(query.data.range);
  });
}
