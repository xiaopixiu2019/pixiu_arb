import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DeploymentFenceStore } from './deployment-fence-store.js';
import { CredentialOperationGate } from './credential-operation-gate.js';

const folders: string[] = [];
afterEach(() => { for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true }); });
function store() {
  const folder = mkdtempSync(join(tmpdir(), 'deployment-handoff-')); folders.push(folder);
  return new DeploymentFenceStore(join(folder, 'maintenance.json'));
}

describe('durable deployment admission', () => {
  it('retains the in-memory fence if persistence reports an uncertain failure', async () => {
    const disk = store(), gate = new CredentialOperationGate(disk);
    vi.spyOn(disk, 'save').mockImplementation(() => { throw new Error('fsync uncertain'); });
    await expect(gate.acquireDeploymentFence('persist-uncertain')).rejects.toThrow('fsync uncertain');
    await expect(gate.runAuthenticatedWrite(async () => 'sent')).rejects.toThrow('deployment_fence_active');
  });
  it('keeps writes fenced across a new process owner and requires the original lease to release', async () => {
    const disk = store();
    const old = new CredentialOperationGate(disk);
    const lease = await old.acquireDeploymentFence('durable-operation');
    const next = new CredentialOperationGate(new DeploymentFenceStore(disk.path));
    expect(next.deploymentActive).toBe(true);
    await expect(next.runAuthenticatedWrite(async () => 'sent')).rejects.toThrow('deployment_fence_active');
    expect(next.deploymentFenceStatus(lease.operationId)).toMatchObject({ leaseToken: lease.leaseToken });
    expect(() => next.releaseDeploymentFence(lease.operationId, 'wrong')).toThrow();
    next.releaseDeploymentFence(lease.operationId, lease.leaseToken);
    const released = new CredentialOperationGate(disk);
    expect(released.deploymentActive).toBe(false);
    expect(released.deploymentCompletion(lease.operationId)?.outcome).toBe('cancelled');
    expect(() => released.releaseDeploymentFence(lease.operationId, lease.leaseToken)).not.toThrow();
  });

  it('fails startup closed on corrupt maintenance evidence', () => {
    const disk = store(); writeFileSync(disk.path, '{invalid');
    expect(() => new CredentialOperationGate(disk)).toThrow();
  });

  it('persists ownership before waiting for outstanding writes', async () => {
    const disk = store(), gate = new CredentialOperationGate(disk);
    let finish!: () => void;
    const write = gate.runAuthenticatedWrite(() => new Promise<void>(resolve => { finish = resolve; }));
    await expect(gate.acquireDeploymentFence('persist-before-drain', 5,
      { originalMode: 'live', controlStamp: 'original-controls', ready: false })).rejects.toThrow('deployment_drain_timeout');
    expect(disk.load()).toMatchObject({ operationId: 'persist-before-drain',
      handoff: { originalMode: 'live', controlStamp: 'original-controls', ready: false } });
    finish(); await write;
  });
});
