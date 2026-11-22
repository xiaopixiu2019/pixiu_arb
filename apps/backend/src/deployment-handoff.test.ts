import { describe, expect, it } from 'vitest';
import { CredentialOperationGate } from './credential-operation-gate.js';
import { DeploymentHandoff } from './deployment-handoff.js';
import { randomUUID } from 'node:crypto';

describe('application-owned deployment handoff', () => {
  it('revalidates an interrupted unready source lease after the same revision restarts', async () => {
    const gate = new CredentialOperationGate();
    const base = { controlStamp: () => 'same', activate: async () => {}, revision: () => 'a'.repeat(40) };
    const source = new DeploymentHandoff(gate, { ...base, mode: () => 'live',
      settle: async () => { throw Error('source_crashed_during_prepare'); } });
    await expect(source.prepare('source-prepare-restart', 'b'.repeat(40))).rejects.toThrow('source_crashed');
    const lease = gate.deploymentFenceStatus('source-prepare-restart')!;
    const candidate = new DeploymentHandoff(gate, { ...base, revision: () => 'b'.repeat(40),
      mode: () => 'unset', settle: async () => {} });
    await expect(candidate.prepare(lease.operationId, 'b'.repeat(40), lease.leaseToken)).rejects.toThrow('deployment_source_changed');
    const restarted = new DeploymentHandoff(gate, { ...base, mode: () => 'unset', settle: async () => {} });
    const ready = await restarted.prepare(lease.operationId, 'b'.repeat(40), lease.leaseToken);
    expect(ready).toMatchObject({ restartSafe: true, handoff: { originalMode: 'live', sourceBootId: restarted.bootId } });
    restarted.cancel(lease.operationId, lease.leaseToken);
  });
  it.each(['a', 'b'])('retains source preparation after failed takeover so a fresh %s boot can recover', async revision => {
    const gate = new CredentialOperationGate();
    const base = { controlStamp: () => 'same', settle: async () => {}, activate: async () => {} };
    const source = new DeploymentHandoff(gate, { ...base, mode: () => 'live', revision: () => 'a'.repeat(40) });
    const lease = await source.prepare('retry-takeover-'+revision, 'b'.repeat(40));
    const failing = new DeploymentHandoff(gate, { ...base, mode: () => 'unset', revision: () => 'b'.repeat(40),
      settle: async () => { throw new Error('transient_read'); } });
    await expect(failing.takeover(lease.operationId, lease.leaseToken)).rejects.toThrow('transient_read');
    expect(failing.status(lease.operationId)?.restartSafe).toBe(true);
    let mode = 'unset';
    const recovered = new DeploymentHandoff(gate, { ...base, mode: () => mode, revision: () => revision.repeat(40),
      activate: async (original, guard) => { await guard.verify(); guard.commit(); mode = original; } });
    await recovered.takeover(lease.operationId, lease.leaseToken);
    expect(mode).toBe('live'); expect(gate.deploymentActive).toBe(false);
  });
  it('only lets the original source boot cancel before switching', async () => {
    const gate = new CredentialOperationGate();
    const runtime = { mode: () => 'live', controlStamp: () => 'same', settle: async () => {}, activate: async () => {} };
    const source = new DeploymentHandoff(gate, runtime);
    const lease = await source.prepare('source-only-cancellation');
    const candidate = new DeploymentHandoff(gate, runtime);
    expect(() => candidate.cancel(lease.operationId, lease.leaseToken)).toThrow('deployment_source_changed');
    expect(gate.deploymentActive).toBe(true);
    source.cancel(lease.operationId, lease.leaseToken);
    expect(() => source.cancel(lease.operationId, lease.leaseToken)).not.toThrow();
  });
  it('binds concurrent prepare requests to the same target and client token', async () => {
    const gate = new CredentialOperationGate();
    let finish!: () => void;
    const barrier = new Promise<void>(resolve => { finish = resolve; });
    const handoff = new DeploymentHandoff(gate, { mode: () => 'live', controlStamp: () => 'same',
      settle: async () => { await barrier; }, activate: async () => {} });
    const token = randomUUID();
    const first = handoff.prepare('concurrent-prepare', 'a'.repeat(40), token);
    await expect(handoff.prepare('concurrent-prepare', 'b'.repeat(40), token)).rejects.toThrow('deployment_request_changed');
    await expect(handoff.prepare('concurrent-prepare', 'a'.repeat(40), randomUUID())).rejects.toThrow('deployment_request_changed');
    finish(); expect((await first).leaseToken).toBe(token);
  });

  it('does not replay a completed takeover on a later process boot', async () => {
    const gate = new CredentialOperationGate();
    const runtime = { mode: () => 'live', controlStamp: () => 'same', settle: async () => {}, activate: async () => {} };
    const source = new DeploymentHandoff(gate, runtime);
    const lease = await source.prepare('old-completion-boot');
    await source.takeover(lease.operationId, lease.leaseToken);
    const restarted = new DeploymentHandoff(gate, runtime);
    await expect(restarted.takeover(lease.operationId, lease.leaseToken)).rejects.toThrow('deployment_completion_stale');
  });

  it('bounds the first takeover control read and retains the fence until it actually ends', async () => {
    const gate = new CredentialOperationGate();
    let stall = false, finish!: () => void;
    const barrier = new Promise<void>(resolve => { finish = resolve; });
    const handoff = new DeploymentHandoff(gate, { mode: () => 'live',
      controlStamp: async () => { if (stall) await barrier; return 'same'; },
      settle: async () => {}, activate: async () => {} }, 10);
    const lease = await handoff.prepare('bounded-control-read'); stall = true;
    await expect(handoff.takeover(lease.operationId, lease.leaseToken)).rejects.toThrow('deployment_handoff_timeout');
    expect(() => handoff.cancel(lease.operationId, lease.leaseToken)).toThrow('deployment_writes_inflight');
    finish(); await new Promise(resolve => setTimeout(resolve, 10));
    expect(gate.deploymentCompletion(lease.operationId)).toBeUndefined();
    handoff.cancel(lease.operationId, lease.leaseToken);
  });
  it('honors readonly selected between async verification and synchronous activation', async () => {
    const gate = new CredentialOperationGate();
    let mode = 'live', revision = 0;
    const handoff = new DeploymentHandoff(gate, {
      mode: () => mode, controlStamp: async () => 'same-credential',
      localControlStamp: () => `${mode}:${revision}`, settle: async () => {},
      activate: async (original, guard) => {
        await guard.verify();
        mode = 'readonly'; revision += 1;
        guard.commit(); mode = original;
      },
    });
    const lease = await handoff.prepare('readonly-race-operation');
    await expect(handoff.takeover(lease.operationId, lease.leaseToken)).rejects.toThrow('deployment_controls_changed');
    expect(mode).toBe('readonly'); expect(gate.deploymentActive).toBe(true);
  });
  it('returns a bounded timeout without releasing unresolved work or publishing late readiness', async () => {
    const gate = new CredentialOperationGate();
    let finish!: () => void;
    const barrier = new Promise<void>(resolve => { finish = resolve; });
    const handoff = new DeploymentHandoff(gate, { mode: () => 'live', controlStamp: () => 'same',
      settle: async () => { await barrier; }, activate: async () => {} }, 5);
    await expect(handoff.prepare('bounded-settlement')).rejects.toThrow('deployment_handoff_timeout');
    const lease = gate.deploymentFenceStatus('bounded-settlement')!;
    expect(() => handoff.cancel(lease.operationId, lease.leaseToken)).toThrow('deployment_writes_inflight');
    finish(); await new Promise(resolve => setTimeout(resolve, 10));
    expect(handoff.status('bounded-settlement')).toMatchObject({ restartSafe: false });
    handoff.cancel(lease.operationId, lease.leaseToken);
  });
  it('rejects cancellation and a second takeover while activation is in progress', async () => {
    const gate = new CredentialOperationGate();
    let finish!: () => void;
    const barrier = new Promise<void>(resolve => { finish = resolve; });
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const handoff = new DeploymentHandoff(gate, { mode: () => 'live', controlStamp: () => 'same',
      settle: async () => {}, activate: async () => { entered(); await barrier; } });
    const lease = await handoff.prepare('concurrent-takeover');
    const taking = handoff.takeover(lease.operationId, lease.leaseToken); await started;
    expect(handoff.status(lease.operationId)).toMatchObject({ restartSafe: false });
    expect(() => handoff.cancel(lease.operationId, lease.leaseToken)).toThrow('deployment_handoff_in_progress');
    await expect(handoff.takeover(lease.operationId, lease.leaseToken)).rejects.toThrow('deployment_handoff_in_progress');
    finish(); await taking;
    expect(gate.deploymentActive).toBe(false);
  });
  it('holds writes until validated takeover and preserves the original mode', async () => {
    const gate = new CredentialOperationGate();
    let mode = 'live', checks = 0;
    const handoff = new DeploymentHandoff(gate, {
      mode: () => mode, controlStamp: () => 'controls',
      settle: async () => { checks += 1; }, activate: async original => { mode = original; },
    });
    const ready = await handoff.prepare('handoff-fixture');
    expect(ready.restartSafe).toBe(true);
    expect(checks).toBe(1);
    await expect(gate.runAuthenticatedWrite(async () => {})).rejects.toThrow('deployment_fence_active');
    mode = 'unset';
    await handoff.takeover(ready.operationId, ready.leaseToken);
    expect(mode).toBe('live'); expect(gate.deploymentActive).toBe(false);
    const checked = checks;
    await handoff.takeover(ready.operationId, ready.leaseToken);
    expect(checks).toBe(checked);
    expect(gate.deploymentCompletion(ready.operationId)?.outcome).toBe('committed');
  });
  it('does not restore old live authority after user control changes', async () => {
    const gate = new CredentialOperationGate();
    let stamp = 'original', activated = false;
    const handoff = new DeploymentHandoff(gate, { mode: () => 'live', controlStamp: () => stamp,
      settle: async () => {}, activate: async () => { activated = true; } });
    const ready = await handoff.prepare('changed-controls');
    stamp = 'user-readonly';
    await expect(handoff.takeover(ready.operationId, ready.leaseToken)).rejects.toThrow('deployment_controls_changed');
    expect(activated).toBe(false); expect(gate.deploymentActive).toBe(true);
  });
  it('does not publish readiness when application settlement fails', async () => {
    const gate = new CredentialOperationGate();
    const handoff = new DeploymentHandoff(gate, { mode: () => 'live', controlStamp: () => 'same',
      settle: async () => { throw new Error('open_remote_order'); }, activate: async () => {} });
    await expect(handoff.prepare('unsettled-handoff')).rejects.toThrow('open_remote_order');
    expect(handoff.status('unsettled-handoff')).toMatchObject({ restartSafe: false });
  });
});
