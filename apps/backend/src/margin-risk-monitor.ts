import { marginReadFault } from './margin-read-fault.js';
import { createHash, randomUUID } from 'node:crypto';
import { Decimal } from 'decimal.js';
import { DEFAULT_MARGIN_POLICY, MarginPolicySchema, type MarginMetrics, type MarginSnapshot } from '@gate-crossex/shared-types';
import { GateApiError, type GateCrossExAccount, type GateCrossExPosition } from './crossex-client.js';
import type { StrategyRecord } from './trading-runtime.js';
import { marginBelow, marginMetrics, marginRecovered, projectedMarginAllowed } from './margin-risk-model.js';
import { MarginRiskStore, type CostReservation, type MarginIncident } from './margin-risk-store.js';
import { rankMarginCandidates } from './margin-reduction-plan.js';
import type { ManagedMarginBatch } from './managed-position-store.js';
export interface MarginProposal { quantity: string; target: string | null; apr: string | null; firstLeg: 0 | 1; initial: string; maintenance: string;
  parametersId?: string; parametersValidUntil?: number; feeRules?: Array<{ symbol: string; pool: string; bookVenue?: string }>;
  approximate?: boolean; costPerUnit?: string; feePerUnit?: string; firstImpact?: { cost: string; initial: string; maintenance: string }; executionLegs?: CostReservation['legs'] }

export interface MarginAccountRead { profileId: string; label: string; userId: string; account: GateCrossExAccount;
  units?: GateCrossExAccount[]; unavailableUnits?: string[]; fatalUnavailableUnits?: boolean }
export interface MarginLaunchAuthorization { accountId: string; context: string; revision: number }
export interface MarginEntryCheck {
  readonly snapshot: MarginSnapshot;
  assertEntry(initial?: string, maintenance?: string, venue?: string): void;
}
export interface MarginMonitorSources {
  context(): string; account(signal: AbortSignal): Promise<MarginAccountRead>;
  live(): boolean; groups(): MarginSnapshot['groups']; uncovered(): string[];
  protectionReady?(strategyId?: string): boolean;
  protectionEnabled?(strategyId: string): boolean;
  continuousProtection?(): MarginSnapshot['continuousProtection'];
  reviewReady?(): boolean;
  normalRecoveryAuthority?(): string | null;
  settlementReady?(quantities: Record<string, string>, proof?: { approximate?: boolean; batchId?: string; parametersId?: string; feeRules?: Array<{ symbol: string; pool: string; bookVenue?: string }> }): boolean;
  proposal?(record: StrategyRecord, positions: GateCrossExPosition[], metrics: MarginMetrics, policy: MarginSnapshot['policy']): MarginProposal | null;
  proposalFailure?(strategyId: string): string | null;
  costProof?(item: CostReservation): { amount: string; settled: boolean; exceeded: boolean } | null;
  onUnexplainedCost?(): void;
  parametersId?(): string | null;
  valuation?(): NonNullable<MarginSnapshot['valuation']> | null;
  modes?(symbols: string[]): Promise<unknown>;
  onReadFault?(fields: Record<string, unknown>): void;
  onStop?(): Promise<void>;
  onSnapshot?(snapshot: MarginSnapshot): void; now?: () => number;
}
export class MarginRiskMonitor {
  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight: Promise<void> | null = null;
  private controller: AbortController | null = null;
  private latest: { key: string; profileId: string; label: string; context: string; userId: string; at: number; metrics: MarginMetrics;
    units: NonNullable<MarginSnapshot['units']> } | null = null;
  private valid = false;
  private failure: string | null = null;
  private fatalReadFailure = false;
  readFailureRequiresReview(): boolean { return this.fatalReadFailure; }
  private lastState = '';
  private lastPrunedAt = 0;
  private lastStartedAt = 0;
  private stopped = false;
  private readEpoch = 0;
  private readonly now: () => number;
  private readonly listeners = new Set<(snapshot: MarginSnapshot) => void>();
  // Deliberately process-local: persisted/legacy incidents never acquire automatic permission on restart.
  private normalRecovery: { incidentId: string; authority: string; revision: number } | null = null;
  invalidateNormalRecovery(): void { this.normalRecovery = null; }
  constructor(readonly store: MarginRiskStore, readonly sources: MarginMonitorSources) { this.now = sources.now ?? Date.now; }
  start(): void {
    this.stopped = false;
    this.timer ??= setInterval(() => { void this.refresh(); }, 2000); this.timer.unref?.(); void this.refresh();
  }
  async stop(): Promise<void> {
    this.stopped = true; this.invalidateNormalRecovery();
    if (this.timer) clearInterval(this.timer); this.timer = null; this.controller?.abort(); await this.inFlight;
    await this.sources.onStop?.();
  }
  subscribe(listener: (snapshot: MarginSnapshot) => void): () => void {
    this.listeners.add(listener); return () => this.listeners.delete(listener);
  }
  wake(): void { if (!this.stopped && this.now() - this.lastStartedAt >= 1000) void this.refresh(); }
  refresh(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.inFlight) return this.inFlight;
    this.lastStartedAt = this.now();
    this.inFlight = this.read().finally(() => { this.inFlight = null; }); return this.inFlight;
  }
  private async read(): Promise<void> {
    const context = this.sources.context(), epoch = this.readEpoch, controller = new AbortController(); this.controller = controller;
    const requestedAt = this.now();
    const timer = setTimeout(() => controller.abort(), 4000);
    try {
      const result = await Promise.race([this.sources.account(controller.signal), new Promise<never>((_, reject) => {
        controller.signal.addEventListener('abort', () => reject(new Error('margin_read_timeout')), { once: true });
      })]);
      if (context !== this.sources.context() || controller.signal.aborted || epoch !== this.readEpoch) return;
      if (!result.userId || !result.profileId) throw new Error('margin_account_identity_unavailable');
      if (this.latest?.context === context && (result.userId !== this.latest.userId || result.account.account_mode !== this.latest.metrics.accountMode)) throw new Error('margin_account_identity_changed');
      const key = createHash('sha256').update(`${result.profileId}:${result.userId}:${result.account.account_mode}:${result.account.account_mode === 'CROSS_EXCHANGE' ? 'CROSSEX' : 'all'}`).digest('hex');
      const policy = this.store.incident(key)?.policy ?? this.store.policy(key);
      const units = (result.units ?? [result.account]).map((a) => ({ exchangeType: a.exchange_type, metrics: marginMetrics(a, policy) }));
      for (const unit of units) {
        const previous = this.latest?.context === context ? this.latest.units.find(u => u.exchangeType === unit.exchangeType)?.metrics : null;
        if (previous && new Decimal(unit.metrics.remoteUpdatedAt).lt(previous.remoteUpdatedAt)) throw new Error('margin_account_version_regressed');
      }
      const values = units.map((u) => u.metrics);
      values.sort((a, b) => Number(a.initialPct ?? Infinity) - Number(b.initialPct ?? Infinity));
      const metrics = values[0];
      this.latest = { key, profileId: result.profileId, label: result.label, context, userId: result.userId, at: requestedAt, metrics,
        units: [...units, ...(result.unavailableUnits ?? []).map((exchangeType) => ({ exchangeType, metrics: null }))] };
      this.valid = !result.unavailableUnits?.length; this.failure = this.valid ? null : 'margin_unit_unavailable'; this.fatalReadFailure = result.fatalUnavailableUnits === true;
      for (const unit of this.latest.units) this.store.sample(`${key}:${unit.exchangeType}`, this.now(), unit.metrics);
      this.store.sample(key, this.now(), metrics); this.reconcileCosts(); this.evaluate();
    } catch (error) {
      if (context !== this.sources.context() || epoch !== this.readEpoch) return;
      const fault = marginReadFault(error);
      try { this.sources.onReadFault?.({ reason: fault.reason, fatal: fault.fatal,
        ...(error instanceof GateApiError ? { status: error.statusCode, label: error.label, ...error.context } : {}) }); } catch { /* diagnostics do not change risk decisions */ }
      this.valid = false; this.failure = fault.reason; this.fatalReadFailure = fault.fatal;
      if (this.latest?.context === context) {
        const incident = this.store.incident(this.latest.key);
        if (incident) this.store.saveIncident(this.latest.key, { ...incident, recovery: null });
      }
      if (this.latest?.context === context) this.store.sample(this.latest.key, this.now(), null);
    } finally { clearTimeout(timer); if (this.controller === controller) this.controller = null; this.emit(); }
    if (this.now() - this.lastPrunedAt > 3_600_000) { this.store.prune(this.now()); this.lastPrunedAt = this.now(); }
  }
  private evaluate(): void {
    const latest = this.latest!;
    let incident = this.store.incident(latest.key);
    const policy = incident?.policy ?? this.store.policy(latest.key);
    if (incident?.batch && this.sources.groups().some((g) => g.strategyId === incident!.batch!.strategyId
      && ['STOPPED', 'STOPPING', 'TRANSFERRED', 'RISK_PAUSED'].includes(g.phase) && !this.sources.protectionEnabled?.(g.strategyId))) {
      this.blockIncident('margin_group_not_active'); incident = this.store.incident(latest.key);
    }
    if (!incident && latest.units.some((u) => u.metrics && marginBelow(u.metrics, policy, 'reduce'))) {
      incident = this.beginIncident(latest.key, policy);
    }
    if (!incident) return;
    if (this.normalRecovery && (this.normalRecovery.incidentId !== incident.id || !this.sources.live()
      || this.normalRecovery.authority !== this.sources.normalRecoveryAuthority?.()
      || this.normalRecovery.revision !== this.store.policy(latest.key).revision || incident.blocked)) this.invalidateNormalRecovery();
    const mmr = latest.units.some(u => u.metrics?.maintenancePct !== null && u.metrics && new Decimal(u.metrics.maintenancePct!).lt(policy.maintenance.reduce));
    incident = { ...incident, cause: incident.cause === 'MMR' || mmr ? 'MMR' : 'IMR' };
    const settled = !incident.settlement || latest.at > incident.settlement.completedAt
      && new Decimal(latest.metrics.remoteUpdatedAt).gte(incident.settlement.remoteAfter)
      && this.sources.settlementReady?.(incident.settlement.quantities, incident.settlement) === true;
    if (incident.settlement && !incident.settlement.counted && !settled && this.now() - incident.settlement.completedAt > 25000 && !incident.blocked) {
      this.blockIncident(incident.settlement.approximate ? 'margin_account_settlement_unverified' : 'margin_borrowing_settlement_unverified'); incident = this.store.incident(latest.key)!;
    }
    if (incident.settlement?.approximate) {
      const proof = incident.settlement;
      const confirmed = settled && proof.firstObservedAt !== undefined && latest.at - proof.firstObservedAt >= 2000;
      if (confirmed && !proof.counted && proof.strategyId) incident = { ...incident, completedBatches: { ...incident.completedBatches,
        [proof.strategyId]: (incident.completedBatches?.[proof.strategyId] ?? 0) + 1 } };
      incident = { ...incident, settlement: { ...proof, firstObservedAt: settled ? proof.firstObservedAt ?? latest.at : undefined,
        counted: proof.counted || confirmed, verified: confirmed || proof.verified && settled } };
    }
    const reviewable = ['margin_borrowing_settlement_unverified', 'margin_account_settlement_unverified'].includes(incident.blocked ?? '') && settled;
    const healthy = this.valid && settled && !incident.batch && (!incident.blocked || reviewable) && this.sources.reviewReady?.() === true
      && latest.units.every(u => u.metrics && this.recovered(u.metrics, incident!.policy));
    const priorRecovery = healthy ? incident.recovery ?? { firstAt: latest.at, confirmations: 1 } : null;
    const recovery = priorRecovery && latest.at - priorRecovery.firstAt >= 2000 ? { ...priorRecovery, confirmations: 2 } : priorRecovery;
    this.store.saveIncident(latest.key, { ...incident, recovery });
    if (recovery?.confirmations === 2 && !incident.blocked) this.finishRecovery(latest.key, incident);
  }
  private beginIncident(key: string, policy: MarginSnapshot['policy']): MarginIncident {
    const monitoring = this.sources.groups().some(g => g.eligible && ['MONITORING', 'BALANCING'].includes(g.phase));
    const authority = monitoring && !this.store.latched(key) && this.sources.live() ? this.sources.normalRecoveryAuthority?.() : null;
    const incident = this.store.startIncident(key, this.now());
    this.normalRecovery = authority ? { incidentId: incident.id, authority, revision: policy.revision } : null;
    return incident;
  }
  private finishRecovery(key: string, incident: MarginIncident): void {
    const automatic = this.normalRecovery?.incidentId === incident.id;
    this.store.transaction(() => {
      if (automatic) this.store.latch(key, false);
      this.store.event(key, automatic ? 'entry_auto_recovered' : 'recovered', automatic
        ? 'Normal margin episode reconciled; its entry hold released; remaining holdings continue monitoring'
        : 'Both recovery thresholds reached; new entry remains locked until explicit review', incident.policy.revision, this.now());
      this.store.saveIncident(key, null);
    });
    this.invalidateNormalRecovery();
  }
  private withReserve(metrics: MarginMetrics, exclude?: string): MarginMetrics {
    const reserve = this.latest ? this.store.pendingCosts(this.latest.key).filter(r => r.batchId !== exclude).reduce((s, r) => s.plus(r.amount), new Decimal(0)).toString() : '0';
    const balance = new Decimal(metrics.marginBalance).minus(reserve);
    return { ...metrics, marginBalance: balance.toString(),
      initialPct: new Decimal(metrics.initialMargin).isZero() ? null : balance.div(metrics.initialMargin).mul(100).toString(),
      maintenancePct: new Decimal(metrics.maintenanceMargin).isZero() ? null : balance.div(metrics.maintenanceMargin).mul(100).toString() };
  }
  private recovered(metrics: MarginMetrics, policy: MarginSnapshot['policy']): boolean {
    return marginRecovered(metrics, policy) && marginRecovered(this.withReserve(metrics), policy);
  }
  private reconcileCosts(): void {
    const latest = this.latest; if (!latest) return;
    for (const item of this.store.pendingCosts(latest.key)) {
      if (item.completedAt === undefined || latest.at <= item.completedAt || !item.quantities ||
        new Decimal(latest.metrics.remoteUpdatedAt).lt(item.remoteAfter ?? '0') ||
        this.sources.settlementReady?.(item.quantities, { approximate: true, batchId: item.batchId }) !== true) continue;
      const proof = this.sources.costProof?.(item); if (!proof) continue;
      if (proof.exceeded) {
        if (this.store.incident(latest.key)?.blocked === 'margin_execution_cost_exceeded') {
          if (proof.settled) this.store.updateCost(latest.key, item, this.now());
          continue;
        }
        if (!this.store.incident(latest.key)) this.store.startIncident(latest.key, this.now());
        this.blockIncident('margin_execution_cost_exceeded'); this.sources.onUnexplainedCost?.();
        if (proof.settled) this.store.updateCost(latest.key, item, this.now());
        continue;
      }
      this.store.updateCost(latest.key, { ...item, amount: proof.amount }, proof.settled ? this.now() : undefined);
    }
  }
  snapshot(): MarginSnapshot {
    const latest = this.latest?.context === this.sources.context() ? this.latest : null;
    const policy = latest ? this.store.policy(latest.key) : { ...DEFAULT_MARGIN_POLICY };
    const incident = latest ? this.store.incident(latest.key) : null;
    const effectivePolicy = incident?.policy ?? policy;
    const rebased = (metrics: MarginMetrics): MarginMetrics => ({ ...metrics,
      initialHeadroom: new Decimal(metrics.marginBalance).minus(new Decimal(metrics.initialMargin).mul(effectivePolicy.initial.warn).div(100)).toString(),
      maintenanceHeadroom: new Decimal(metrics.marginBalance).minus(new Decimal(metrics.maintenanceMargin).mul(effectivePolicy.maintenance.warn).div(100)).toString() });
    const fresh = Boolean(latest && this.valid && this.now() - latest.at <= 5000);
    const latched = latest ? this.store.latched(latest.key) : false;
    const warning = latest ? latest.units.some((u) => u.metrics && marginBelow(u.metrics, effectivePolicy, 'warn')) : false;
    const groups = this.sources.groups().map((g) => ({ ...g, authorized: effectivePolicy.protectedGroupIds.includes(g.id) && policy.protectedGroupIds.includes(g.id) }));
    const scopeMissing = incident && !incident.batch && !groups.some((g) => g.eligible && g.authorized);
    const reason = !fresh ? this.failure ?? 'margin_data_stale' : incident?.blocked
      ?? (incident?.plan?.quantity === '0' && incident.plan.reason && incident.plan.reason !== 'margin_reduction_not_needed'
        ? incident.plan.reason : scopeMissing ? 'margin_no_authorized_groups' : null);
    return { accountId: latest?.key ?? null, accountLabel: latest?.label ?? '', sampledAt: latest?.at ?? null,
      ageMs: latest ? this.now() - latest.at : null, fresh, metrics: latest ? rebased(latest.metrics) : null, policy, effectivePolicy,
      status: !fresh ? 'unavailable' : reason ? 'blocked' : incident ? 'reducing' : warning ? 'warning' : latched ? 'recovered' : 'clear',
      reason, entryBlocked: !fresh || warning || latched, liveEnabled: this.sources.live(), incidentId: incident?.id ?? null,
      groups, uncoveredSymbols: this.sources.uncovered(), units: latest?.units.map((u) => ({ ...u, metrics: u.metrics ? rebased(u.metrics) : null })) ?? [],
      valuation: this.sources.valuation?.() ?? null,
      costAccounting: { pendingBatches: latest ? this.store.pendingCosts(latest.key).length : 0, reserved: latest ? this.store.reservedCost(latest.key) : '0' },
      continuousProtection: this.sources.continuousProtection?.(),
      protection: incident ? { cause: incident.cause ?? 'IMR', stage: incident.blocked ? 'blocked' : incident.batch ? 'pairing' : incident.recovery ? 'confirming_recovery' : incident.settlement ? 'settlement_pending' : 'planning',
        confirmations: incident.recovery?.confirmations ?? 0, batchId: incident.batch?.id ?? null, strategyId: incident.batch?.strategyId ?? null,
        plannedQuantity: incident.plan?.quantity ?? null, targetQuantity: incident.plan?.target ?? null, apr: incident.plan?.apr ?? null,
        fallback: incident.plan?.fallback ?? false, reason: incident.blocked ?? incident.plan?.reason ?? null } : null };
  }
  private emit(): void {
    const snapshot = this.snapshot();
    if (snapshot.accountId && `${snapshot.status}:${snapshot.reason}` !== this.lastState) {
      this.store.event(snapshot.accountId, snapshot.status, snapshot.reason ?? snapshot.status, snapshot.effectivePolicy.revision, this.now());
      this.lastState = `${snapshot.status}:${snapshot.reason}`;
    }
    this.sources.onSnapshot?.(snapshot); for (const listener of this.listeners) listener(snapshot);
  }
  savePolicy(raw: unknown): MarginSnapshot {
    const policy = MarginPolicySchema.parse(raw), snapshot = this.snapshot();
    if (!snapshot.accountId || !snapshot.fresh) throw new Error('margin_data_stale');
    const eligible = new Set(snapshot.groups.filter((g) => g.eligible).map((g) => g.id));
    if (policy.protectedGroupIds.some((id) => !eligible.has(id) && !snapshot.policy.protectedGroupIds.includes(id))) throw new Error('margin_group_not_eligible');
    this.store.savePolicy(snapshot.accountId, policy); this.evaluate(); this.emit(); return this.snapshot();
  }
  captureLaunchAuthorization(profileId: string): MarginLaunchAuthorization {
    const snapshot = this.snapshot();
    if (this.stopped || !this.sources.live()) throw new Error('margin_launch_permission_unavailable');
    if (!snapshot.fresh || !snapshot.accountId) throw new Error('margin_data_stale');
    if (this.latest?.profileId !== profileId) throw new Error('margin_account_changed');
    if (snapshot.entryBlocked || snapshot.incidentId) throw new Error('margin_entry_blocked');
    return { accountId: snapshot.accountId, context: this.sources.context(), revision: snapshot.policy.revision };
  }
  /** Called only inside the new managed-task creation transaction, before its actor is attached. */
  authorizeLaunchedGroup(profileId: string, strategyId: string, groupId: string, expected: MarginLaunchAuthorization): void {
    const current = this.captureLaunchAuthorization(profileId), snapshot = this.snapshot();
    if (current.accountId !== expected.accountId || current.context !== expected.context) throw new Error('margin_account_changed');
    if (current.revision !== expected.revision) throw new Error('margin_policy_conflict');
    if (!snapshot.groups.some(g => g.id === groupId && g.strategyId === strategyId && g.phase === 'OPENING'))
      throw new Error('margin_launch_group_invalid');
    const policy = snapshot.policy;
    if (policy.protectedGroupIds.includes(groupId)) return;
    if (policy.protectedGroupIds.length >= 100) throw new Error('margin_protection_scope_full');
    this.store.savePolicy(current.accountId, { ...policy, protectedGroupIds: [...policy.protectedGroupIds, groupId] });
    this.store.event(current.accountId, 'group_authorized_on_launch',
      `Managed task ${strategyId} authorized group ${groupId} at launch`, policy.revision + 1, this.now());
    // The normal snapshot loop publishes after the caller's transaction commits; no callbacks here.
  }
  resumeEntries(): void {
    const snapshot = this.snapshot();
    const incident = snapshot.accountId ? this.store.incident(snapshot.accountId) : null;
    const reconciled = incident?.settlement && ['margin_borrowing_settlement_unverified', 'margin_account_settlement_unverified'].includes(incident.blocked ?? '') && incident.recovery?.confirmations === 2
      && this.latest!.at > incident.settlement.completedAt && new Decimal(snapshot.metrics?.remoteUpdatedAt ?? '0').gte(incident.settlement.remoteAfter)
      && this.sources.settlementReady?.(incident.settlement.quantities, incident.settlement) === true;
    if (!snapshot.fresh || !snapshot.accountId || !snapshot.metrics
      || (incident && (incident.batch || incident.settlement && !reconciled || !incident.blocked || !this.sources.reviewReady?.()
        || !snapshot.units?.every(u => u.metrics && this.recovered(u.metrics, incident.policy))))
      || !this.recovered(snapshot.metrics, snapshot.policy)) throw new Error('margin_recovery_not_confirmed');
    if (!snapshot.units?.every((u) => u.metrics && this.recovered(u.metrics, snapshot.policy))) throw new Error('margin_recovery_not_confirmed');
    if (incident) this.store.saveIncident(snapshot.accountId, null);
    this.store.latch(snapshot.accountId, false);
    this.store.event(snapshot.accountId, 'entry_reviewed', 'User explicitly cleared the margin entry lock', snapshot.policy.revision, this.now());
    this.emit();
  }
  assertEntry(initial = '0', maintenance = '0', venue?: string): void {
    this.assertEntrySnapshot(this.snapshot(), initial, maintenance, venue);
  }
  /** Local to this synchronous call. All existing callers/check boundaries remain independent. */
  withEntrySnapshot<T>(run: (check: MarginEntryCheck) => T): T {
    const latest = this.latest, context = this.sources.context(), live = this.sources.live();
    const snapshot = this.snapshot(), version = this.store.changeVersion();
    let active = true;
    const current = () => {
      if (!active) throw new Error('margin_check_expired');
      if (latest !== this.latest || context !== this.sources.context() || live !== this.sources.live()
        || version !== this.store.changeVersion()) throw new Error('margin_check_changed');
      const age = snapshot.sampledAt === null ? Infinity : this.now() - snapshot.sampledAt;
      if (!this.valid || !snapshot.fresh || age < 0 || age > 5000) throw new Error('margin_data_stale');
    };
    try {
      const result = run({ snapshot, assertEntry: (initial = '0', maintenance = '0', venue?: string) => {
        current(); this.assertEntrySnapshot(snapshot, initial, maintenance, venue);
      } });
      if (result && typeof (result as { then?: unknown }).then === 'function') {
        // Reject the call immediately; contain any later rejection from the forbidden continuation.
        void Promise.resolve(result).catch(() => undefined);
        throw new Error('margin_check_async');
      }
      current(); return result;
    } finally { active = false; }
  }
  private assertEntrySnapshot(s: MarginSnapshot, initial: string, maintenance: string, venue?: string): void {
    if (!s.fresh || !s.metrics) throw new Error('margin_data_stale');
    if (s.entryBlocked) throw new Error('margin_entry_blocked');
    const metrics = s.metrics.accountMode === 'CROSS_EXCHANGE' ? s.metrics : s.units?.find((u) => u.exchangeType === venue)?.metrics;
    if (!metrics) throw new Error('margin_unit_estimate_unavailable');
    if (!projectedMarginAllowed(this.withReserve(metrics), s.effectivePolicy, initial, maintenance)) throw new Error('margin_projected_below_warning');
  }
  blockIncident(reason: string): void {
    this.invalidateNormalRecovery();
    const s = this.snapshot(); if (!s.accountId) return;
    const incident = this.store.incident(s.accountId); if (!incident || incident.blocked === reason) return;
    this.store.saveIncident(s.accountId, { ...incident, blocked: reason });
    this.store.event(s.accountId, 'protection_blocked', reason, incident.policy.revision, this.now()); this.emit();
  }
  /** Revalidation removes an execution obstruction, never the ordinary entry/review latch. */
  reconcileProtection(): void {
    const s = this.snapshot();
    if (!s.accountId || !s.fresh || !this.sources.protectionReady?.() || !this.sources.reviewReady?.()) return;
    const incident = this.store.incident(s.accountId);
    if (!incident?.blocked || incident.batch) return;
    const costs = this.store.pendingCosts(s.accountId);
    if (costs.some(item => this.sources.costProof?.(item)?.exceeded
      || !new Decimal(item.amount).isFinite() || new Decimal(item.amount).lt(0)
      || new Decimal(item.amount).gt(item.originalAmount))) return;
    // Delayed fee detail retains its reserve in withReserve(); it is not an unknown order.
    if (incident.settlement && this.sources.settlementReady?.(incident.settlement.quantities, incident.settlement) !== true) return;
    this.store.event(s.accountId, 'protection_revalidated', incident.blocked, incident.policy.revision, this.now());
    this.store.saveIncident(s.accountId, { ...incident, blocked: null, recovery: null });
  }
  batchComplete(strategyId: string, remaining: string, remoteAfter = '0', quantities: Record<string, string> = {}): void {
    const s = this.snapshot(); if (!s.accountId) return;
    const incident = this.store.incident(s.accountId); if (!incident?.batch || incident.batch.strategyId !== strategyId) return;
    if (new Decimal(remaining).gte(incident.batch.before)) { this.blockIncident('margin_reduction_not_effective'); return; }
    this.store.saveIncident(s.accountId, { ...incident, batch: null, recovery: null,
      settlement: { remoteAfter, quantities, completedAt: this.now(),
        ...(incident.plan?.parametersId ? { batchId: incident.batch.id, parametersId: incident.plan.parametersId, feeRules: incident.plan.feeRules, approximate: incident.plan.approximate, strategyId } : {}) } });
    const cost = this.store.pendingCosts(s.accountId).find(r => r.batchId === incident.batch!.id);
    if (cost) this.store.updateCost(s.accountId, { ...cost, completedAt: this.now(), remoteAfter, quantities });
    this.store.event(s.accountId, 'batch_completed', `${strategyId}: balanced remaining quantity ${remaining}`, incident.policy.revision, this.now());
    // Ratios read before the completed batch must not finish an incident or authorize the next batch.
    this.valid = false; this.readEpoch += 1; this.controller?.abort();
    void (this.inFlight ?? Promise.resolve()).then(() => this.refresh());
  }
  planBatch(record: StrategyRecord, positions: GateCrossExPosition[], records: StrategyRecord[], lot: string, marketMax: string | null): string | null {
    // A healthy monitoring tick has no reduction work. Avoid building every group's capacity just to discover that.
    const latest=this.latest?.context===this.sources.context()?this.latest:null;
    if (!latest || !this.store.incident(latest.key)) return null;
    const s = this.snapshot();
    if (!s.fresh || !s.accountId || !s.metrics || (!this.sources.live() && !this.sources.protectionReady?.(record.id)) || s.metrics.accountMode !== 'CROSS_EXCHANGE') return null;
    const incident = this.store.incident(s.accountId); if (!incident || incident.blocked || incident.batch || incident.recovery) return null;
    if (incident.settlement && (incident.settlement.approximate && !incident.settlement.verified || this.latest!.at <= incident.settlement.completedAt
      || new Decimal(s.metrics.remoteUpdatedAt).lt(incident.settlement.remoteAfter)
      || this.sources.settlementReady?.(incident.settlement.quantities, incident.settlement) !== true)) return null;
    if (marginRecovered(s.metrics, incident.policy)) return null;
    const eligible = records.filter((r) => s.groups.some((g) => g.strategyId === r.id && g.eligible && g.authorized));
    const candidates = eligible.flatMap(r => {
      const plan = r.management?.leftQuantity ? this.sources.proposal?.(r, positions, this.withReserve(s.metrics!), incident.policy) : null;
      return plan ? [{ ...plan, id: r.management?.groupId ?? r.id, strategyId: r.id }] : [];
    });
    const chosen = rankMarginCandidates(candidates, incident.cause ?? 'IMR')[0];
    if (!chosen) {
      const failure = eligible.length === 1 ? this.sources.proposalFailure?.(eligible[0].id) : null;
      this.store.saveIncident(s.accountId, { ...incident, plan: { target: null, quantity: '0', apr: null, fallback: false, reason: failure ?? 'margin_no_executable_plan' } });
      return null;
    }
    if (chosen?.strategyId !== record.id || !record.management?.leftQuantity) return null;
    const before = record.management.leftQuantity, baseline = incident.baselines[record.id] ?? before;
    const quantity = Decimal.min(chosen.quantity, record.config.management!.perOrderQuantity,
      before, marketMax ?? before).div(lot).floor().mul(lot);
    if (quantity.lte(0) || !quantity.eq(chosen.quantity)) return null;
    const batchId = randomUUID();
    if (chosen.approximate && chosen.costPerUnit && chosen.executionLegs) {
      const amount = quantity.mul(chosen.costPerUnit).toString();
      this.store.reserveCost(s.accountId, { batchId, amount, originalAmount: amount, quantity: quantity.toString(), legs: chosen.executionLegs }, this.now());
    }
    this.store.saveIncident(s.accountId, { ...incident, baselines: { ...incident.baselines, [record.id]: baseline },
      settlement: null, recovery: null,
      plan: { target: chosen.target, quantity: quantity.toString(), apr: chosen.apr, fallback: incident.cause === 'MMR' && chosen.apr === null,
        reason: incident.cause === 'MMR' && chosen.apr === null ? 'margin_yield_unavailable_fallback' : null,
        parametersId: chosen.parametersId, parametersValidUntil: chosen.parametersValidUntil, feeRules: chosen.feeRules,
        approximate: chosen.approximate, firstImpact: chosen.firstImpact, costPerUnit: chosen.costPerUnit, feePerUnit: chosen.feePerUnit, executionLegs: chosen.executionLegs },
      batch: { id: batchId, firstLeg: chosen.firstLeg, strategyId: record.id, before, target: new Decimal(before).minus(quantity).toString(), at: this.now() } });
    this.store.event(s.accountId, 'batch_started', `${record.id}: reduce paired quantity ${quantity}`, incident.policy.revision, this.now());
    return quantity.toString();
  }
  preparedBatch(strategyId: string): ManagedMarginBatch {
    const key = this.snapshot().accountId!, incident = this.store.incident(key), batch = incident?.batch;
    if (!batch?.id || batch.firstLeg === undefined || batch.strategyId !== strategyId) throw new Error('margin_batch_missing');
    return { version: 2, id: batch.id, accountKey: key, incidentId: incident!.id, before: batch.before,
      quantity: new Decimal(batch.before).minus(batch.target).toString(), firstLeg: batch.firstLeg, startedAt: batch.at };
  }
  assertFirstLeg(strategyId: string, id: string): void {
    const s = this.snapshot(), incident = s.accountId ? this.store.incident(s.accountId) : null;
    if (incident?.plan?.parametersId && !incident.plan.approximate && (this.sources.parametersId?.() !== incident.plan.parametersId ||
      !incident.plan.parametersValidUntil || this.now() >= incident.plan.parametersValidUntil)) throw new Error('margin_projection_evidence_changed');
    if (incident?.plan?.approximate && this.now() >= (incident.plan.parametersValidUntil ?? 0)) throw new Error('margin_projection_evidence_changed');
    if (incident?.plan?.firstImpact && s.metrics) {
      const metrics = this.withReserve(s.metrics, id), impact = incident.plan.firstImpact;
      if (['initial', 'maintenance'].some(k => {
        const before = new Decimal(k === 'initial' ? metrics.initialMargin : metrics.maintenanceMargin).minus(metrics.marginBalance);
        const after = before.plus(k === 'initial' ? impact.initial : impact.maintenance).plus(impact.cost);
        return before.lt(0) ? after.gt(0) : after.gte(before);
      })) throw new Error('margin_projection_no_safe_improvement');
    }
    if (!s.fresh || incident?.batch?.id !== id || !s.groups.some(g => g.strategyId === strategyId && g.authorized && g.eligible))
      throw new Error('margin_protection_authority_changed');
  }
}
