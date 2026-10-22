import type { FastifyInstance } from 'fastify';
import type { TaskPerformanceService } from './task-performance-service.js';
export function registerTaskPerformanceRoutes(app:FastifyInstance,service:TaskPerformanceService):void {
  app.get('/api/crossex/task-performance',async(request,reply)=>{
    reply.header('Cache-Control','no-store');
    if(request.headers['x-gct-read-intent']!=='task-performance')return reply.code(403).send({error:'missing_read_intent'});
    if(Object.keys(request.query as object).length)return reply.code(400).send({error:'invalid_task_performance_query'});
    return service.summary();
  });
}
