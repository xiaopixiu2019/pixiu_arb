import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { CredentialOperationGate } from './credential-operation-gate.js';
import { registerDeploymentFenceRoutes } from './deployment-fence-routes.js';

const intent = { 'x-gct-deployment-intent': 'manage-deployment-fence' };
const runtime = { mode: () => 'readonly', controlStamp: () => 'same', settle: async () => {}, activate: async () => {} };

describe('deployment fence routes', () => {
  it('creates, reconciles, and releases an operation-bound write fence', async () => {
    const app = Fastify({ logger: false });
    const gate = new CredentialOperationGate();
    registerDeploymentFenceRoutes(app, gate, () => 0, runtime);

    const capabilities = await app.inject({ method: 'GET', url: '/api/ops/deployment/capabilities' });
    expect(capabilities.statusCode).toBe(200);
    expect(capabilities.json()).toMatchObject({ schema: 2, fence: true, operationScoped: true, revision: 'development' });
    expect(capabilities.json().bootId).toMatch(/^[a-f0-9-]{36}$/);

    const created = await app.inject({
      method: 'POST', url: '/api/ops/deployment/fence', headers: intent,
      payload: { operationId: 'release-12345678', acknowledge: true },
    });
    expect(created.statusCode).toBe(200);
    const receipt = created.json();
    expect(receipt).toMatchObject({
      operationId: 'release-12345678', newWritesBlocked: true,
      inflightWrites: 0, unknownWrites: 0, restartSafe: true,
    });

    const reconciled = await app.inject({ method: 'GET', url: '/api/ops/deployment/fence/release-12345678' });
    expect(reconciled.statusCode).toBe(200);
    expect(reconciled.json()).not.toHaveProperty('leaseToken');
    expect(reconciled.json()).toMatchObject({ operationId: 'release-12345678', restartSafe: true });

    const released = await app.inject({
      method: 'POST', url: '/api/ops/deployment/unfence', headers: intent,
      payload: { operationId: 'release-12345678', leaseToken: receipt.leaseToken },
    });
    expect(released.statusCode).toBe(200);
    expect(released.json()).toEqual({ released: true, operationId: 'release-12345678' });
    expect(gate.deploymentFenceStatus('release-12345678')).toBeNull();
    await app.close();
  });

  it('fails closed for unknown writes, invalid intent, and a changed operation', async () => {
    const app = Fastify({ logger: false });
    const gate = new CredentialOperationGate();
    registerDeploymentFenceRoutes(app, gate, () => 2, runtime);
    const missingIntent = await app.inject({
      method: 'POST', url: '/api/ops/deployment/fence',
      payload: { operationId: 'release-unknown1', acknowledge: true },
    });
    expect(missingIntent.statusCode).toBe(403);

    const created = await app.inject({
      method: 'POST', url: '/api/ops/deployment/fence', headers: intent,
      payload: { operationId: 'release-unknown1', acknowledge: true },
    });
    expect(created.statusCode).toBe(409);
    expect(created.json()).toMatchObject({ error: 'deployment_writes_unresolved', unknownWrites: 2 });
    expect(gate.deploymentFenceStatus('release-unknown1')).not.toBeNull();

    const changed = await app.inject({
      method: 'POST', url: '/api/ops/deployment/fence', headers: intent,
      payload: { operationId: 'release-different', acknowledge: true },
    });
    expect(changed.statusCode).toBe(409);
    expect(changed.json()).toEqual({ error: 'deployment_fence_busy' });
    await app.close();
  });

  it('releases a newly acquired fence when unresolved-write inspection itself fails', async () => {
    const app = Fastify({ logger: false });
    const gate = new CredentialOperationGate();
    registerDeploymentFenceRoutes(app, gate, () => { throw new Error('synthetic_database_failure'); }, runtime);
    const response = await app.inject({
      method: 'POST', url: '/api/ops/deployment/fence', headers: intent,
      payload: { operationId: 'release-db-failure', acknowledge: true },
    });
    expect(response.statusCode).toBe(500);
    expect(gate.deploymentFenceStatus('release-db-failure')).toBeNull();
    await app.close();
  });
});
