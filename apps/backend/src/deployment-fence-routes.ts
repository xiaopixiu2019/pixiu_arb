import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { CredentialOperationBusyError, type CredentialOperationGate, type DeploymentFenceReceipt } from './credential-operation-gate.js';
import { DeploymentHandoff, type DeploymentRuntime } from './deployment-handoff.js';

const OperationIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/);
const IntentHeader = 'manage-deployment-fence';

function publicReceipt(receipt: DeploymentFenceReceipt, unknownWrites: number) {
  return {
    operationId: receipt.operationId,
    generation: receipt.generation,
    newWritesBlocked: receipt.newWritesBlocked,
    inflightWrites: receipt.inflightWrites,
    unknownWrites,
    restartSafe: receipt.restartSafe && receipt.inflightWrites === 0 && unknownWrites === 0,
  };
}

export function registerDeploymentFenceRoutes(
  app: FastifyInstance,
  gate: CredentialOperationGate,
  unresolvedWrites: () => number,
  runtime: DeploymentRuntime,
): void {
  const handoff = new DeploymentHandoff(gate, runtime);
  app.get('/api/ops/deployment/capabilities', async () => ({
    schema: 2, fence: true, operationScoped: true, ...handoff.identity(),
  }));

  app.post('/api/ops/deployment/fence', async (request, reply) => {
    if (request.headers['x-gct-deployment-intent'] !== IntentHeader) {
      return reply.code(403).send({ error: 'missing_deployment_intent' });
    }
    const parsed = z.object({ operationId: OperationIdSchema, acknowledge: z.literal(true),
      targetRevision: z.string().regex(/^[a-f0-9]{40}$/).optional(), leaseToken: z.string().uuid().optional() }).strict().safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_deployment_fence' });
    try {
      const existing = gate.deploymentFenceStatus(parsed.data.operationId);
      const receipt = await handoff.prepare(parsed.data.operationId, parsed.data.targetRevision, parsed.data.leaseToken);
      let unknownWrites: number;
      try {
        unknownWrites = unresolvedWrites();
      } catch (error) {
        if (!existing) gate.releaseDeploymentFence(receipt.operationId, receipt.leaseToken);
        throw error;
      }
      if (unknownWrites > 0) {
        return reply.code(409).send({ error: 'deployment_writes_unresolved', ...receipt, unknownWrites, restartSafe: false });
      }
      return receipt;
    } catch (error) {
      if (error instanceof CredentialOperationBusyError) return reply.code(409).send({ error: 'deployment_fence_busy' });
      if (error instanceof Error && /^deployment_[a-z_]+$/.test(error.message)) return reply.code(409).send({ error: error.message });
      throw error;
    }
  });

  app.get('/api/ops/deployment/fence/:operationId', async (request, reply) => {
    const parsed = z.object({ operationId: OperationIdSchema }).safeParse(request.params);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_deployment_operation' });
    const receipt = handoff.status(parsed.data.operationId);
    if (!receipt) {
      const completed = gate.deploymentCompletion(parsed.data.operationId);
      if (completed) return { operationId: parsed.data.operationId, outcome: completed.outcome,
        completedAt: completed.completedAt, runtime: completed.runtime, newWritesBlocked: gate.deploymentActive,
        ...handoff.identity(), mode: runtime.mode() };
      return reply.code(404).send({ error: 'deployment_fence_not_found' });
    }
    return { ...publicReceipt(receipt, unresolvedWrites()), ...handoff.identity() };
  });

  app.post('/api/ops/deployment/unfence', async (request, reply) => {
    if (request.headers['x-gct-deployment-intent'] !== IntentHeader) {
      return reply.code(403).send({ error: 'missing_deployment_intent' });
    }
    const parsed = z.object({ operationId: OperationIdSchema, leaseToken: z.string().uuid() }).strict().safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_deployment_unfence' });
    try {
      handoff.cancel(parsed.data.operationId, parsed.data.leaseToken);
      return { released: true, operationId: parsed.data.operationId };
    } catch (error) {
      if (error instanceof Error && /^deployment_[a-z_]+$/.test(error.message)) {
        return reply.code(409).send({ error: error.message });
      }
      throw error;
    }
  });

  app.post('/api/ops/deployment/takeover', async (request, reply) => {
    if (request.headers['x-gct-deployment-intent'] !== IntentHeader) return reply.code(403).send({ error: 'missing_deployment_intent' });
    const parsed = z.object({ operationId: OperationIdSchema, leaseToken: z.string().uuid() }).strict().safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_deployment_takeover' });
    try {
      await handoff.takeover(parsed.data.operationId, parsed.data.leaseToken);
      return { ok: true, operationId: parsed.data.operationId, mode: runtime.mode() };
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      if (/^deployment_[a-z_]+$/.test(message)) return reply.code(409).send({ error: message });
      throw error;
    }
  });
}
