import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { DeploymentFenceStore, DeploymentLease, DeploymentCompletion } from './deployment-fence-store.js';

export class CredentialOperationBusyError extends Error {
  constructor(reason = 'credential_operation_in_progress') {
    super(reason);
    this.name = 'CredentialOperationBusyError';
  }
}

export interface DeploymentFenceReceipt {
  operationId: string;
  leaseToken: string;
  generation: number;
  newWritesBlocked: true;
  inflightWrites: number;
  unknownWrites: 0;
  restartSafe: boolean;
  handoff?: DeploymentLease['handoff'];
}

type ExclusiveOperation =
  | { kind: 'credential'; owner: symbol }
  | ({ kind: 'deployment' } & DeploymentLease);

/**
 * Keeps authenticated account writes and credential mutation in separate phases.
 *
 * A credential mutation closes the write side synchronously, waits for writes that already
 * started, then holds exclusive access until the active credential pointer and caches are stable.
 * Writes arriving after the close are rejected instead of queued so strategy actors cannot become
 * part of a credential-switch quiesce cycle while that cycle is already waiting for them.
 */
export class CredentialOperationGate {
  private exclusiveOperation: ExclusiveOperation | null = null;
  private authenticatedWrites = 0;
  private authenticatedReads = 0;
  private deploymentGeneration = 0;
  private readonly idleWaiters = new Set<() => void>();
  private readonly exclusiveContext = new AsyncLocalStorage<symbol>();
  private readonly writeContext = new AsyncLocalStorage<{ active: boolean }>();
  private completion?: DeploymentCompletion;

  constructor(private readonly store?: DeploymentFenceStore) {
    const saved = store?.load();
    this.completion = store?.completion();
    if (saved) {
      this.exclusiveOperation = { kind: 'deployment', ...saved };
      this.deploymentGeneration = saved.generation;
    }
  }

  get deploymentActive(): boolean { return this.exclusiveOperation?.kind === 'deployment'; }
  get admittedWrite(): boolean { return this.writeContext.getStore()?.active === true; }
  deploymentCompletion(operationId: string): DeploymentCompletion | undefined {
    return this.completion?.lease.operationId === operationId ? this.completion : undefined;
  }

  async runAuthenticatedWrite<T>(work: () => Promise<T>): Promise<T> {
    const credentialOwner = this.exclusiveOperation?.kind === 'credential'
      && this.exclusiveContext.getStore() === this.exclusiveOperation.owner;
    const admitted = this.writeContext.getStore()?.active === true;
    if (this.exclusiveOperation && !credentialOwner && !admitted) {
      const reason = this.exclusiveOperation.kind === 'deployment'
        ? 'deployment_fence_active'
        : 'credential_operation_in_progress';
      throw new CredentialOperationBusyError(reason);
    }
    const ticket = { active: true };
    this.authenticatedWrites += 1;
    try {
      return await this.writeContext.run(ticket, work);
    } finally {
      ticket.active = false;
      this.authenticatedWrites -= 1;
      this.notifyIdle();
    }
  }

  async acquireCredentialMutation(): Promise<() => void> {
    if (this.exclusiveOperation) throw new CredentialOperationBusyError();
    this.exclusiveOperation = { kind: 'credential', owner: Symbol('credential-lease') };
    await this.waitForIdle(undefined, true);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.exclusiveOperation = null;
    };
  }

  async runCredentialMutationWork<T>(work: () => Promise<T>): Promise<T> {
    if (this.exclusiveOperation?.kind !== 'credential') throw new CredentialOperationBusyError();
    return this.exclusiveContext.run(this.exclusiveOperation.owner, work);
  }

  async runAuthenticatedRead<T>(work: () => Promise<T>): Promise<T> {
    if (this.exclusiveOperation?.kind === 'credential'
      && this.exclusiveContext.getStore() !== this.exclusiveOperation.owner
      && !this.admittedWrite) throw new CredentialOperationBusyError();
    this.authenticatedReads += 1;
    try { return await work(); }
    finally { this.authenticatedReads -= 1; this.notifyIdle(); }
  }

  async acquireDeploymentFence(operationId: string, drainTimeoutMs = 10_000,
    handoff?: DeploymentLease['handoff'], leaseToken?: string): Promise<DeploymentFenceReceipt> {
    if (leaseToken !== undefined && !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(leaseToken)) throw new Error('deployment_fence_token_invalid');
    if (!Number.isInteger(drainTimeoutMs) || drainTimeoutMs < 1 || drainTimeoutMs > 30_000) {
      throw new Error('deployment_drain_timeout_invalid');
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/.test(operationId)) {
      throw new Error('deployment_operation_id_invalid');
    }
    if (this.completion?.lease.operationId === operationId) throw new Error('deployment_operation_completed');
    const active = this.exclusiveOperation;
    if (active?.kind === 'deployment' && active.operationId === operationId) {
      if (leaseToken && active.leaseToken !== leaseToken) throw new Error('deployment_fence_token_invalid');
      await this.waitForIdle(drainTimeoutMs);
      if (this.exclusiveOperation !== active) throw new Error('deployment_fence_changed');
      return this.deploymentReceipt(active);
    }
    if (active) throw new CredentialOperationBusyError();
    const deployment: Extract<ExclusiveOperation, { kind: 'deployment' }> = {
      kind: 'deployment', operationId, leaseToken: leaseToken ?? randomUUID(), generation: ++this.deploymentGeneration,
      ...(handoff ? { handoff } : {}),
    };
    this.exclusiveOperation = deployment;
    this.store?.save({ operationId, leaseToken: deployment.leaseToken, generation: deployment.generation,
      ...(handoff ? { handoff } : {}) });
    await this.waitForIdle(drainTimeoutMs);
    if (this.exclusiveOperation !== deployment) throw new Error('deployment_fence_changed');
    return this.deploymentReceipt(deployment);
  }

  deploymentFenceStatus(operationId: string): DeploymentFenceReceipt | null {
    const active = this.exclusiveOperation;
    if (active?.kind !== 'deployment' || active.operationId !== operationId) return null;
    return this.deploymentReceipt(active);
  }

  releaseDeploymentFence(operationId: string, leaseToken: string, outcome: 'cancelled' | 'committed' = 'cancelled',
    runtime?: DeploymentCompletion['runtime']): void {
    const active = this.exclusiveOperation;
    if (!active && this.completion?.lease.operationId === operationId
      && this.completion.lease.leaseToken === leaseToken && this.completion.outcome === outcome) return;
    if (active?.kind !== 'deployment' || active.operationId !== operationId || active.leaseToken !== leaseToken) {
      throw new Error('deployment_fence_token_invalid');
    }
    if (this.authenticatedWrites > 0) throw new Error('deployment_writes_inflight');
    const completion: DeploymentCompletion = { outcome, completedAt: Date.now(), ...(runtime ? { runtime } : {}),
      lease: { operationId, leaseToken, generation: active.generation, ...(active.handoff ? { handoff: active.handoff } : {}) } };
    this.store?.save(null, completion);
    this.completion = completion;
    this.exclusiveOperation = null;
  }

  updateDeploymentHandoff(operationId: string, leaseToken: string, handoff: NonNullable<DeploymentLease['handoff']>): void {
    const active = this.exclusiveOperation;
    if (active?.kind !== 'deployment' || active.operationId !== operationId || active.leaseToken !== leaseToken) {
      throw new Error('deployment_fence_token_invalid');
    }
    const next = { ...active, handoff };
    this.store?.save({ operationId, leaseToken, generation: next.generation, handoff });
    this.exclusiveOperation = next;
  }

  async runDeploymentWork<T>(operationId: string, leaseToken: string, work: () => Promise<T>): Promise<T> {
    const active = this.exclusiveOperation;
    if (active?.kind !== 'deployment' || active.operationId !== operationId || active.leaseToken !== leaseToken) {
      throw new Error('deployment_fence_token_invalid');
    }
    const ticket = { active: true };
    try { return await this.writeContext.run(ticket, () => this.runAuthenticatedWrite(work)); }
    finally { ticket.active = false; }
  }

  private notifyIdle(): void {
    for (const check of [...this.idleWaiters]) check();
  }

  private async waitForIdle(timeoutMs?: number, includeReads = false): Promise<void> {
    const idle = () => this.authenticatedWrites === 0 && (!includeReads || this.authenticatedReads === 0);
    if (idle()) return;
    await new Promise<void>((resolve, reject) => {
      const check = () => {
        if (!idle()) return;
        if (timer !== undefined) clearTimeout(timer);
        this.idleWaiters.delete(check); resolve();
      };
      const timer = timeoutMs === undefined ? undefined : setTimeout(() => {
        this.idleWaiters.delete(check); reject(new Error('deployment_drain_timeout'));
      }, timeoutMs);
      this.idleWaiters.add(check);
    });
  }

  private deploymentReceipt(
    operation: Extract<ExclusiveOperation, { kind: 'deployment' }>,
  ): DeploymentFenceReceipt {
    return {
      operationId: operation.operationId,
      leaseToken: operation.leaseToken,
      generation: operation.generation,
      newWritesBlocked: true,
      inflightWrites: this.authenticatedWrites,
      unknownWrites: 0,
      restartSafe: this.authenticatedWrites === 0,
      ...(operation.handoff ? { handoff: operation.handoff } : {}),
    };
  }
}
