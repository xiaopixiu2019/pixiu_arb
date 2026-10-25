import type Database from 'better-sqlite3';
import { Decimal } from 'decimal.js';
import type { TradingSession } from './trading-session.js';
import type { TradingRuntime, StrategyRecord } from './trading-runtime.js';
import { ProtectionAuthority, type ProtectionOrder } from './protection-authority.js';
import { managedLegs, type ManagedAccountFacts } from './managed-position-manager.js';
import { readManagedState, writeManagedState, managedHardRiskReason, managedRiskReason } from './managed-position-store.js';
import { entryHoldings } from './managed-position-adoption.js';
import { pairedQuantities } from './managed-position-model.js';
import { assertMarginSubmission } from './managed-margin-batch.js';
import type { MarginRiskMonitor } from './margin-risk-monitor.js';
import type { MarginSnapshot } from '@gate-crossex/shared-types';

interface Sources {
  profile(): string | null; version(): string; read(): Promise<ManagedAccountFacts>; stopped(): boolean;
  margin(): MarginRiskMonitor | null; publish(facts: ManagedAccountFacts): void;
  freeze(reason: string): void; evaluate(record: StrategyRecord, facts: ManagedAccountFacts, at: number): Promise<void>;
  quotes(record: StrategyRecord): void;
}
interface Observation { facts: ManagedAccountFacts; at: number; version: string; policy: number; accountId: string }

/** Shares the manager's single scheduling lane; never starts another order actor. */
export class ContinuousProtection {
  readonly authority: ProtectionAuthority;
  private confirmed: { signature: string; at: number } | null = null;
  private observation: Observation | null = null;
  private evaluating: string | null = null;
  private lastRun = 0;
  private reconciliationCursor = 0;
  private readonly completionListeners = new Set<() => void>();
  constructor(private readonly db: Database.Database, private readonly session: TradingSession,
    private readonly runtime: TradingRuntime, private readonly sources: Sources, private readonly now = Date.now) {
    this.authority = new ProtectionAuthority(db, session, sources.profile, now);
    runtime.setProtectionGuard((...args) => this.authority.validate(...args));
  }
  isEvaluating(id?: string): boolean { return this.evaluating !== null && (!id || this.evaluating === id); }
  /** Display-only invalidation: listeners read current scope, never a captured account snapshot. */
  subscribeCompletion(listener: () => void): () => void {
    this.completionListeners.add(listener);
    return () => { this.completionListeners.delete(listener); };
  }
  private notifyCompletion(): void {
    for (const listener of this.completionListeners) {
      try { listener(); } catch { /* A failed display consumer must not interrupt protection or other consumers. */ }
    }
  }
  view(): NonNullable<MarginSnapshot['continuousProtection']> {
    const enabled = this.authority.grant()?.enabled === true;
    const coverage = this.coverage();
    const persisted = new Map(this.authority.statuses().map(s => [s.strategyId, s]));
    const groups = this.records().map(record => {
      const state = readManagedState(this.db, record.id)!;
      if (this.session.liveTradingEnabled && record.status === 'RUNNING' && !managedRiskReason(this.db) && !state.verified)
        return { strategyId: record.id, state: 'RECONCILING', reason: 'protection_entry_in_progress', checkedAt: 0 };
      return this.session.liveTradingEnabled && record.status === 'RUNNING' && !managedRiskReason(this.db) && state.verified && state.checkedAt
        ? { strategyId: record.id, state: 'WATCHING', reason: null, checkedAt: Date.parse(state.checkedAt) }
        : persisted.get(record.id) ?? { strategyId: record.id, state: 'RECONCILING', reason: null, checkedAt: 0 };
    }).map(s =>
      s.reason !== 'protection_entry_in_progress' && this.now() - s.checkedAt > 5000 ? { ...s, state: 'RECONCILING', reason: 'protection_observation_stale' } : s);
    const state = !enabled ? 'DISABLED' : groups.some(g => g.state === 'BLOCKED') ? 'BLOCKED'
      : groups.some(g => g.state === 'EXECUTING') ? 'EXECUTING' : !groups.length || coverage.some(g => !g.enrolled) || groups.some(g => g.state === 'RECONCILING') ? 'RECONCILING' : 'WATCHING';
    return { enabled, state, groups, coverage };
  }
  private coverage(): NonNullable<NonNullable<MarginSnapshot['continuousProtection']>['coverage']> {
    const grant = this.authority.grant(), profile = this.sources.profile();
    return this.runtime.listStrategies().flatMap(record => {
      const state = readManagedState(this.db, record.id);
      if (!state || record.accountProfileId !== profile || ['COMPLETED', 'TRANSFERRED'].includes(state.phase)) return [];
      if (state.phase === 'STOPPED' && !this.db.prepare('SELECT 1 FROM managed_position_claims WHERE strategy_id=?').get(record.id)) return [];
      const groupId = state.groupId ?? record.id, enrolled = this.owns(record.id);
      const reason = state.stopIntent === 'KEEP' ? 'protection_keep' : this.session.current === 'readonly' ? 'protection_readonly'
        : !grant?.enabled ? 'protection_not_authorized' : !grant.groupIds.includes(groupId) ? 'protection_group_not_enrolled'
          : !enrolled ? 'protection_scope_changed' : null;
      return [{ groupId, strategyId: record.id, enrolled, reason }];
    });
  }
  needsTick(): boolean {
    if (this.now() - this.lastRun < 1000) return false;
    if (!this.authority.grant()?.enabled || this.session.current === 'readonly') return false;
    // The ordinary manager owns bounded live read recovery; do not starve or promote its soft lock.
    if (this.session.liveTradingEnabled && managedRiskReason(this.db) && !managedHardRiskReason(this.db)) return false;
    return this.session.current !== 'live' || !!managedHardRiskReason(this.db)
      || this.records().some(r => r.status === 'PAUSED');
  }
  records(): StrategyRecord[] { return this.runtime.listStrategies().filter(r => this.owns(r.id)); }
  owns(id: string): boolean {
    const grant = this.authority.grant(), state = readManagedState(this.db, id);
    if (!grant?.enabled || !state || !grant.groupIds.includes(state.groupId ?? id) || state.stopIntent === 'KEEP'
      || ['STOPPING', 'STOPPED', 'TRANSFERRED', 'COMPLETED'].includes(state.phase)) return false;
    const record = this.runtime.getStrategy(id);
    if (record.accountProfileId !== grant.profileId || !['RUNNING', 'PAUSED'].includes(record.status)) return false;
    const claims = this.db.prepare('SELECT symbol,account_id FROM managed_position_claims WHERE strategy_id=?').all(id) as Array<{ symbol: string; account_id: string }>;
    return managedLegs(record.config).every(l => claims.some(c => c.symbol === l.symbol && c.account_id === grant.profileId))
      && claims.length === 2;
  }
  ready(id?: string): boolean {
    const o = this.observation, m = this.sources.margin()?.snapshot();
    return !!o && this.now() - o.at <= 5000 && o.version === this.sources.version() && !!m?.fresh
      && o.accountId === m.accountId && o.policy === m.policy.revision && (!id || this.owns(id));
  }
  async configure(accountId: string, groupIds: string[], revision: number, enabled: boolean): Promise<void> {
    if (!enabled) { this.authority.configure(accountId, [], revision, false); this.session.set('readonly'); return; }
    const margin = this.sources.margin(); if (!margin) throw new Error('protection_margin_unavailable');
    const version = this.sources.version(), authorityEpoch = this.authority.epoch();
    await margin.refresh(); const facts = await this.sources.read();
    const snapshot = margin.snapshot(), profile = this.sources.profile();
    if (!snapshot.fresh || snapshot.accountId !== accountId || version !== this.sources.version() || authorityEpoch !== this.authority.epoch() || !profile)
      throw new Error('protection_account_changed');
    if (facts.openOrders.length || this.runtime.listOpenOrders().length) throw new Error('protection_orders_unresolved');
    for (const group of groupIds) this.validateEnrollment(group, profile, facts);
    if (groupIds.some(g => !snapshot.policy.protectedGroupIds.includes(g))) throw new Error('protection_group_not_authorized');
    this.authority.configure(accountId, groupIds, revision, true); this.confirmed = null;
    if (this.session.current !== 'live') this.session.armProtection();
  }
  private validateEnrollment(group: string, profile: string, facts: ManagedAccountFacts): void {
    const records = this.runtime.listStrategies().filter(r => r.accountProfileId === profile
      && (readManagedState(this.db, r.id)?.groupId ?? r.id) === group && !['COMPLETED', 'TRANSFERRED'].includes(r.management?.phase ?? ''));
    if (records.length !== 1) throw new Error('protection_scope_changed');
    const record = records[0], state = readManagedState(this.db, record.id);
    if (!state?.verified || state.stopIntent === 'KEEP' || ['OPENING', 'STOPPING', 'STOPPED'].includes(state.phase))
      throw new Error('protection_holdings_unverified');
    this.checkHoldings(record, facts);
    const claims = this.db.prepare('SELECT symbol,account_id FROM managed_position_claims WHERE strategy_id=?').all(record.id) as Array<{ symbol: string; account_id: string }>;
    if (claims.length !== 2 || !managedLegs(record.config).every(l => claims.some(c => c.symbol === l.symbol && c.account_id === profile)))
      throw new Error('protection_scope_changed');
  }
  private checkHoldings(record: StrategyRecord, facts: ManagedAccountFacts): void {
    const state = readManagedState(this.db, record.id)!;
    const quantities = pairedQuantities(facts.positions, managedLegs(record.config));
    const caps = !state.verified && !state.marginBatch ? entryHoldings(this.db, record.id) : [state.maxLeft, state.maxRight];
    if (caps.some(q => new Decimal(q).lt(0)) || quantities.some((q, i) => new Decimal(q).gt(caps[i])))
      throw new Error('protection_holdings_unverified');
  }
  private signature(facts: ManagedAccountFacts): string {
    const grant = this.authority.grant();
    return JSON.stringify([grant, facts.positions.map(p => [p.symbol, p.position_side, p.position_qty]).sort(),
      facts.openOrders.map(o => [o.order_id, o.state, o.executed_qty]).sort(),
      this.runtime.listOpenOrders().map(o => [o.id, o.state, o.executedQuantity]).sort()]);
  }
  async run(): Promise<void> {
    if (this.now() - this.lastRun < 1000) return;
    this.lastRun = this.now(); this.observation = null;
    const records = this.records().filter(r => !this.session.liveTradingEnabled || !!managedRiskReason(this.db) || r.status === 'PAUSED');
    if (!records.length) return;
    try { await this.inspect(records); }
    catch (error) {
      this.confirmed = null;
      for (const r of records) this.authority.status(r.id, 'RECONCILING', error instanceof Error ? error.message : 'protection_read_failed');
    } finally { this.evaluating = null; this.observation = null; this.notifyCompletion(); }
  }
  private async inspect(records: StrategyRecord[]): Promise<void> {
    const grant = this.authority.grant()!;
    // A normal read does not invalidate or renew the previous verified observation.
    // view() still expires it at five seconds; changed facts and failures invalidate below.
    for (const r of records) this.sources.quotes(r);
    await this.reconcileOrders(records);
    const version = this.sources.version();
    await this.sources.margin()?.refresh();
    const facts = await this.sources.read(), margin = this.sources.margin(), m = margin?.snapshot();
    if (this.sources.stopped() || version !== this.sources.version() || !m?.fresh || m.accountId !== grant.accountId
      || !this.authority.grant()?.enabled || this.authority.grant()?.revision !== grant.revision) throw new Error('protection_evidence_changed');
    this.sources.publish(facts);
    if (this.session.liveTradingEnabled && managedRiskReason(this.db) && !managedHardRiskReason(this.db)) {
      this.confirmed = null; return;
    }
    if (this.session.current === 'unset') {
      for (const r of records) this.authority.status(r.id,'RECONCILING');
      this.session.protect();
      this.sources.freeze('continuous_protection_review'); this.confirmed = null; return;
    }
    const signature = this.signature(facts);
    if (!this.confirmed || this.confirmed.signature !== signature) {
      for (const r of records) this.authority.status(r.id,'RECONCILING');
      this.confirmed = { signature, at: this.now() }; return;
    }
    if (this.now() - this.confirmed.at < 1000) return;
    this.observation = { facts, at: this.now(), version, policy: m.policy.revision, accountId: grant.accountId };
    margin?.reconcileProtection?.();
    for (const record of records) {
      if (!this.ready()) return;
      await this.evaluateGroup(record, facts);
    }
  }
  private async reconcileOrders(records: StrategyRecord[]): Promise<void> {
    const ids = new Set(records.map(r => r.id));
    const orders = this.runtime.listOpenOrders().filter(o => o.strategyId && ids.has(o.strategyId));
    const selected = Array.from({ length: Math.min(2, orders.length) }, (_, i) => orders[(this.reconciliationCursor + i) % orders.length]);
    this.reconciliationCursor = orders.length ? (this.reconciliationCursor + selected.length) % orders.length : 0;
    for (const order of selected) {
      try {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try { await Promise.race([this.runtime.refreshOrderFromRemote(order.id), new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('protection_order_read_timeout')), 3000);
        })]); } finally { if (timer) clearTimeout(timer); }
      }
      catch { this.authority.status(order.strategyId!, 'RECONCILING', 'protection_order_unresolved'); }
    }
  }
  private async evaluateGroup(record: StrategyRecord, facts: ManagedAccountFacts): Promise<void> {
    try {
      this.checkHoldings(record, facts);
      if (await this.cancelConfirmedMaker(record, facts)) {
        this.authority.status(record.id, 'RECONCILING', 'protection_cancellation_pending'); return;
      }
      this.assertOrders(record, facts);
      if (!this.prepareEntryHoldings(record, facts)) return;
      this.evaluating = record.id;
      await this.sources.evaluate(record, facts, this.observation!.at);
      const state = readManagedState(this.db, record.id)!;
      const settling = state.positionSettlementSince || state.marginBatch?.settlementSince;
      this.authority.status(record.id, settling ? 'RECONCILING' : this.runtime.listOpenOrders(record.id).length || state.marginBatch ? 'EXECUTING' : 'WATCHING',
        settling ? state.reason ?? 'protection_settlement_pending' : null);
    } catch (error) {
      this.authority.status(record.id, 'BLOCKED', error instanceof Error ? error.message : 'protection_evaluation_failed');
    } finally { this.evaluating = null; }
  }
  private prepareEntryHoldings(record: StrategyRecord, facts: ManagedAccountFacts): boolean {
    const state = readManagedState(this.db, record.id)!;
    if (state.verified || state.marginBatch) return true;
    const caps = entryHoldings(this.db, record.id), quantities = pairedQuantities(facts.positions, managedLegs(record.config));
    if (quantities.every(q => new Decimal(q).isZero())) {
      this.authority.status(record.id, 'RECONCILING', 'protection_holdings_pending'); return false;
    }
    // Only confirmed ledger responsibility, never the unfilled strategy target.
    writeManagedState(this.db, record.id, { ...state, maxLeft: caps[0], maxRight: caps[1] });
    return true;
  }
  private async cancelConfirmedMaker(record: StrategyRecord, facts: ManagedAccountFacts): Promise<boolean> {
    const order = this.runtime.listOpenOrders(record.id).find(o => o.type === 'LIMIT' && !!o.remoteOrderId
      && ['NEW', 'OPEN', 'PARTIALLY_FILLED'].includes(o.state) && !o.failureReason);
    if (!order || !facts.openOrders.some(o => o.order_id === order.remoteOrderId && o.symbol === order.symbol
      && o.side === order.side && new Decimal(o.qty).eq(order.quantity))) return false;
    const grant = this.authority.grant()!, observation = this.observation!;
    const authorize = () => {
      const current = this.authority.grant(), margin = this.sources.margin()?.snapshot();
      if (!current?.enabled || current.revision !== grant.revision || current.profileId !== grant.profileId
        || !this.owns(record.id) || this.session.current === 'readonly' || this.sources.stopped()
        || this.now() - observation.at > 5000 || !margin?.fresh || margin.accountId !== grant.accountId)
        throw new Error('protection_cancellation_authority_changed');
    };
    authorize();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([this.runtime.cancelOrder(order.id, authorize), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('protection_cancellation_pending')), 3000);
    })]); } finally { if (timer) clearTimeout(timer); }
    return true;
  }
  private assertOrders(record: StrategyRecord, facts: ManagedAccountFacts, exclude?: string): void {
    const legs = managedLegs(record.config);
    const local = this.runtime.listOpenOrders(record.id).filter(o => o.id !== exclude);
    const remote = facts.openOrders.filter(o => legs.some(l => l.symbol === o.symbol));
    if (local.length || remote.length) throw new Error('protection_order_unresolved');
    // Terminal rows with an unknown outcome still require an explicit remote reconciliation.
    const ambiguous = this.db.prepare("SELECT 1 FROM execution_orders WHERE strategy_id=? AND state='PENDING_SUBMIT' AND id!=? LIMIT 1")
      .get(record.id, exclude ?? '');
    if (ambiguous) throw new Error('protection_order_unresolved');
  }
  permit(record: StrategyRecord, index: number, quantity: Decimal, input: ProtectionOrder): object {
    const observation = this.observation;
    if (!observation || !this.isEvaluating(record.id)) throw new Error('protection_evidence_missing');
    const validate = (exclude?: string) => {
      if (!this.ready(record.id) || this.observation !== observation || !this.owns(record.id)) throw new Error('protection_evidence_changed');
      this.assertOrders(record, observation.facts, exclude);
      const state = readManagedState(this.db, record.id)!, q = pairedQuantities(observation.facts.positions, managedLegs(record.config));
      if (state.marginBatch) {
        assertMarginSubmission(this.db, record.id, state.marginBatch, index, quantity, exclude);
        if (index === state.marginBatch.firstLeg) this.sources.margin()!.assertFirstLeg(record.id, state.marginBatch.id!);
      } else if (!quantity.eq(new Decimal(q[index]).minus(q[1 - index])) || quantity.lte(0)) throw new Error('protection_difference_changed');
      const originalPairing = state.marginBatch && index !== state.marginBatch.firstLeg;
      if (!originalPairing && !this.sources.margin()!.snapshot().policy.protectedGroupIds.includes(state.groupId ?? record.id))
        throw new Error('protection_authority_revoked');
    };
    validate(); return this.authority.issue(input, record.id, validate, observation.at + 5000);
  }
}
