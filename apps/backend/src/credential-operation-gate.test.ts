import { describe, expect, it, vi } from 'vitest';
import { CredentialOperationBusyError, CredentialOperationGate } from './credential-operation-gate.js';

describe('CredentialOperationGate', () => {
  it('lets an admitted operation finish nested writes after fencing begins', async () => {
    const gate = new CredentialOperationGate();
    let proceed!: () => void;
    const barrier = new Promise<void>(resolve => { proceed = resolve; });
    const write = gate.runAuthenticatedWrite(async () => {
      await barrier;
      return gate.runAuthenticatedWrite(async () => 'finished');
    });
    const fenced = gate.acquireDeploymentFence('nested-operation');
    proceed();
    await expect(write).resolves.toBe('finished');
    await expect(fenced).resolves.toMatchObject({ inflightWrites: 0 });
  });

  it('keeps account reads available during deployment but excludes credential changes', async () => {
    const gate = new CredentialOperationGate();
    const fence = await gate.acquireDeploymentFence('read-during-deploy');
    await expect(gate.runAuthenticatedRead(async () => 'facts')).resolves.toBe('facts');
    gate.releaseDeploymentFence(fence.operationId, fence.leaseToken);
    const release = await gate.acquireCredentialMutation();
    await expect(gate.runAuthenticatedRead(async () => 'facts')).rejects.toBeInstanceOf(CredentialOperationBusyError);
    release();
  });

  it('bounds drain waiting without claiming restart safety or releasing an active write', async () => {
    const gate = new CredentialOperationGate();
    let finish!: () => void;
    const write = gate.runAuthenticatedWrite(() => new Promise<void>(resolve => { finish = resolve; }));
    await expect(gate.acquireDeploymentFence('timeout-operation', 5)).rejects.toThrow('deployment_drain_timeout');
    expect(gate.deploymentFenceStatus('timeout-operation')).toMatchObject({ inflightWrites: 1, restartSafe: false });
    finish(); await write;
    await expect(gate.acquireDeploymentFence('timeout-operation', 5)).resolves.toMatchObject({ inflightWrites: 0 });
  });

  it('does not reuse an inherited credential owner after that lease is released', async () => {
    const gate = new CredentialOperationGate();
    const release = await gate.acquireCredentialMutation();
    let proceed!: () => void;
    const later = gate.runCredentialMutationWork(async () => {
      await new Promise<void>(resolve => { proceed = resolve; });
      return gate.runAuthenticatedWrite(async () => 'wrong owner');
    });
    release();
    const releaseNew = await gate.acquireCredentialMutation();
    proceed();
    await expect(later).rejects.toBeInstanceOf(CredentialOperationBusyError);
    releaseNew();
  });
  it('waits for an accepted write and rejects new writes until credential mutation releases', async () => {
    const gate = new CredentialOperationGate();
    let releaseWrite!: () => void;
    const writeBlocked = new Promise<void>((resolve) => { releaseWrite = resolve; });
    let markWriteStarted!: () => void;
    const writeStarted = new Promise<void>((resolve) => { markWriteStarted = resolve; });
    const events: string[] = [];

    const write = gate.runAuthenticatedWrite(async () => {
      events.push('write-started');
      markWriteStarted();
      await writeBlocked;
      events.push('write-finished');
    });
    await writeStarted;

    let releaseMutation: (() => void) | undefined;
    const mutation = gate.acquireCredentialMutation().then((release) => {
      events.push('mutation-acquired');
      releaseMutation = release;
    });
    await vi.waitFor(() => expect(events).toEqual(['write-started']));
    await expect(gate.runAuthenticatedWrite(async () => undefined)).rejects.toBeInstanceOf(CredentialOperationBusyError);

    releaseWrite();
    await Promise.all([write, mutation]);
    expect(events).toEqual(['write-started', 'write-finished', 'mutation-acquired']);

    releaseMutation?.();
    await expect(gate.runAuthenticatedWrite(async () => 'accepted')).resolves.toBe('accepted');
  });

  it('allows only one credential mutation at a time', async () => {
    const gate = new CredentialOperationGate();
    const release = await gate.acquireCredentialMutation();
    await expect(gate.acquireCredentialMutation()).rejects.toBeInstanceOf(CredentialOperationBusyError);
    await expect(gate.runAuthenticatedWrite(async () => 'blocked')).rejects.toBeInstanceOf(CredentialOperationBusyError);
    await expect(gate.runCredentialMutationWork(() => gate.runAuthenticatedWrite(async () => 'quiesced')))
      .resolves.toBe('quiesced');
    release();
    await expect(gate.acquireCredentialMutation()).resolves.toEqual(expect.any(Function));
  });

  it('fences new writes, drains accepted writes, and reconciles the same deployment operation', async () => {
    const gate = new CredentialOperationGate();
    let finishWrite!: () => void;
    const writeBlocked = new Promise<void>((resolve) => { finishWrite = resolve; });
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const write = gate.runAuthenticatedWrite(async () => { markStarted(); await writeBlocked; });
    await started;

    const pendingFence = gate.acquireDeploymentFence('deploy-123');
    await vi.waitFor(() => expect(gate.deploymentFenceStatus('deploy-123')).toMatchObject({
      operationId: 'deploy-123',
      newWritesBlocked: true,
      inflightWrites: 1,
      restartSafe: false,
    }));
    await expect(gate.runAuthenticatedWrite(async () => undefined)).rejects.toMatchObject({
      message: 'deployment_fence_active',
    });

    finishWrite();
    await write;
    const receipt = await pendingFence;
    expect(receipt).toMatchObject({
      operationId: 'deploy-123',
      newWritesBlocked: true,
      inflightWrites: 0,
      unknownWrites: 0,
      restartSafe: true,
    });
    await expect(gate.acquireDeploymentFence('deploy-123')).resolves.toEqual(receipt);
    await expect(gate.acquireDeploymentFence('other-deploy')).rejects.toBeInstanceOf(CredentialOperationBusyError);

    expect(() => gate.releaseDeploymentFence('deploy-123', 'wrong-token')).toThrow('deployment_fence_token_invalid');
    gate.releaseDeploymentFence('deploy-123', receipt.leaseToken);
    await expect(gate.runAuthenticatedWrite(async () => 'accepted')).resolves.toBe('accepted');
  });

  it('does not let credential mutation and deployment fencing overlap', async () => {
    const gate = new CredentialOperationGate();
    const releaseMutation = await gate.acquireCredentialMutation();
    await expect(gate.acquireDeploymentFence('deploy-credential-race')).rejects.toBeInstanceOf(CredentialOperationBusyError);
    releaseMutation();
    const fence = await gate.acquireDeploymentFence('deploy-credential-race');
    await expect(gate.acquireCredentialMutation()).rejects.toBeInstanceOf(CredentialOperationBusyError);
    gate.releaseDeploymentFence(fence.operationId, fence.leaseToken);
  });
});
