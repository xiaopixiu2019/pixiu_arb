import type { CredentialOperationGate, DeploymentFenceReceipt } from './credential-operation-gate.js';
import type { TradingMode } from './trading-session.js';
import { randomUUID } from 'node:crypto';

export interface DeploymentRuntime {
  mode(): string;
  revision?(): string;
  controlStamp(): string | Promise<string>;
  localControlStamp?(): string;
  settle(signal: AbortSignal): Promise<void>;
  activate(mode: TradingMode, guard: { verify(): Promise<void>; commit(): void }): Promise<void>;
}

/** The application owns settlement; deployers receive only an operation-bound result. */
export class DeploymentHandoff {
  readonly bootId = randomUUID();
  private readonly pending = new Map<string, { targetRevision: string; leaseToken?: string; work: Promise<DeploymentFenceReceipt> }>();
  private readonly takingOver = new Set<string>();
  constructor(private readonly gate: CredentialOperationGate, private readonly runtime: DeploymentRuntime,
    private readonly deadlineMs = 30_000) {}

  identity(): { bootId: string; revision: string } {
    return { bootId: this.bootId, revision: this.runtime.revision?.() ?? 'development' };
  }

  prepare(operationId: string, targetRevision = this.identity().revision, leaseToken?: string): Promise<DeploymentFenceReceipt> {
    if (this.takingOver.has(operationId)) return Promise.reject(new Error('deployment_handoff_in_progress'));
    const current = this.pending.get(operationId);
    if (current) {
      if (current.targetRevision !== targetRevision || current.leaseToken !== leaseToken) {
        return Promise.reject(new Error('deployment_request_changed'));
      }
      return current.work;
    }
    const work = this.withDeadline(signal => this.prepareOnce(operationId, targetRevision, signal, leaseToken))
      .finally(() => { this.pending.delete(operationId); });
    this.pending.set(operationId, { targetRevision, leaseToken, work }); return work;
  }

  private async prepareOnce(operationId: string, targetRevision: string, signal: AbortSignal, token?: string): Promise<DeploymentFenceReceipt> {
    const initialStamp = await this.runtime.controlStamp();
    signal.throwIfAborted();
    const originalMode = this.runtime.mode();
    if (!['unset', 'readonly', 'live', 'protect_only'].includes(originalMode)) throw new Error('deployment_mode_invalid');
    const existing = this.gate.deploymentFenceStatus(operationId);
    if (existing && (!existing.handoff?.sourceBootId || !existing.handoff.sourceRevision
      || !existing.handoff.targetRevision)) throw new Error('deployment_handoff_evidence_incomplete');
    if (existing?.handoff && existing.handoff.sourceRevision !== this.identity().revision) throw new Error('deployment_source_changed');
    if (existing?.handoff?.targetRevision && existing.handoff.targetRevision !== targetRevision) throw new Error('deployment_target_changed');
    const context = existing?.handoff ?? { originalMode: originalMode as TradingMode, controlStamp: initialStamp,
      ready: false, sourceBootId: this.bootId, sourceRevision: this.identity().revision, targetRevision };
    const lease = await this.gate.acquireDeploymentFence(operationId, 10_000, context, token);
    if (lease.handoff?.ready && lease.handoff.sourceBootId === this.bootId) {
      await this.assertControl(lease); return { ...lease, restartSafe: true };
    }
    const handoff = { ...lease.handoff!, sourceBootId: this.bootId, ready: false };
    await this.assertControl({ ...lease, handoff });
    this.gate.updateDeploymentHandoff(operationId, lease.leaseToken, handoff);
    await this.gate.runDeploymentWork(operationId, lease.leaseToken, () => this.runtime.settle(signal));
    await this.assertControl({ ...lease, handoff });
    signal.throwIfAborted();
    this.gate.updateDeploymentHandoff(operationId, lease.leaseToken, { ...handoff, ready: true });
    return { ...this.gate.deploymentFenceStatus(operationId)!, restartSafe: true };
  }

  status(operationId: string): DeploymentFenceReceipt | null {
    const lease = this.gate.deploymentFenceStatus(operationId);
    return lease ? { ...lease, restartSafe: lease.inflightWrites === 0 && lease.handoff?.ready === true } : null;
  }

  async takeover(operationId: string, token: string): Promise<void> {
    const completed = this.gate.deploymentCompletion(operationId);
    if (completed?.outcome === 'committed' && completed.lease.leaseToken === token) {
      if (completed.runtime?.bootId !== this.bootId) throw new Error('deployment_completion_stale');
      return;
    }
    if (this.pending.has(operationId) || this.takingOver.has(operationId)) throw new Error('deployment_handoff_in_progress');
    const lease = this.status(operationId);
    if (!lease || lease.leaseToken !== token || !lease.restartSafe || !lease.handoff) throw new Error('deployment_takeover_unverified');
    if (![lease.handoff.sourceRevision, lease.handoff.targetRevision].includes(this.identity().revision)) throw new Error('deployment_target_unverified');
    this.takingOver.add(operationId);
    try {
      const localStamp = this.runtime.localControlStamp?.() ?? this.runtime.mode();
      const assertLocal = () => {
        if (localStamp !== (this.runtime.localControlStamp?.() ?? this.runtime.mode())) throw new Error('deployment_controls_changed');
      };
      await this.withDeadline(signal => this.gate.runDeploymentWork(operationId, token, async () => {
        await this.assertControl(lease); signal.throwIfAborted();
        // Source preparation is durable. In-flight work, not erasing that proof,
        // blocks concurrent takeover and restart while this attempt is running.
        await this.runtime.settle(signal); await this.assertControl(lease); signal.throwIfAborted();
        await this.runtime.activate(lease.handoff!.originalMode, {
          verify: async () => { await this.assertControl(lease); signal.throwIfAborted(); assertLocal(); },
          commit: () => { signal.throwIfAborted(); assertLocal(); },
        });
      }));
      this.gate.releaseDeploymentFence(operationId, token, 'committed', this.identity());
    } finally { this.takingOver.delete(operationId); }
  }

  cancel(operationId: string, token: string): void {
    if (this.pending.has(operationId) || this.takingOver.has(operationId)) throw new Error('deployment_handoff_in_progress');
    const completed = this.gate.deploymentCompletion(operationId);
    if (completed?.outcome === 'cancelled' && completed.lease.leaseToken === token && completed.runtime?.bootId === this.bootId) return;
    const lease = this.gate.deploymentFenceStatus(operationId);
    if (lease?.handoff?.sourceBootId !== this.bootId) throw new Error('deployment_source_changed');
    this.gate.releaseDeploymentFence(operationId, token, 'cancelled', this.identity());
  }

  private async assertControl(lease: DeploymentFenceReceipt): Promise<void> {
    if (lease.handoff?.controlStamp !== await this.runtime.controlStamp()) throw new Error('deployment_controls_changed');
  }

  private async withDeadline<T>(work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    let timer!: ReturnType<typeof setTimeout>;
    const expired = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        const error = new Error('deployment_handoff_timeout'); controller.abort(error); reject(error);
      }, this.deadlineMs);
    });
    try {
      // The gate still counts accepted work after the HTTP deadline; cancellation cannot release it.
      const result = await Promise.race([work(controller.signal), expired]); controller.signal.throwIfAborted(); return result;
    } finally { clearTimeout(timer); }
  }
}
