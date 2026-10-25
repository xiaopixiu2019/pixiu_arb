import type Database from 'better-sqlite3';
import { ContinuousProtection } from './continuous-protection.js';
import { confirmedExitQuantity, ordinaryManagedOrder, ownsManagedExecution, projectedExitHoldings } from './managed-execution-proof.js';
import { randomUUID } from 'node:crypto';
import { Decimal } from 'decimal.js';
import { hyperliquidLimitPrice, isHyperliquidFuture } from './hyperliquid-limit-price.js';
import type { GateCrossExOrder, GateCrossExPosition } from './crossex-client.js';
import type { MarketSource } from './strategy-engine.js';
import type { TradingSession } from './trading-session.js';
import { TradingRuntimeError, isTerminalOrderState, type TradingRuntime, type CreateStrategyInput, type StrategyRecord } from './trading-runtime.js';
import { managedHardRiskReason, managedRiskBlock, managedRiskReason,
  MANAGED_ACCOUNT_RECHECKING, MANAGED_RECOVERY_WINDOW_MS, readManagedState, writeManagedState, type ManagedState } from './managed-position-store.js';
import { managedExitSignal, freshManagedQuote, pairedQuantities, reductionPlan, type ManagedLeg } from './managed-position-model.js';
import { nativeMarketAsset } from './market-asset-aliases.js';
import { quoteUnavailableReason } from './quote-recovery.js';
import { managedOrderSizeIssue, managedConstraintsValid, isManagedQuantityIssue, type ManagedSizeIssue } from './managed-position-validation.js';
import { ManagedAdoption, entryHoldings } from './managed-position-adoption.js';
import type { ProtectionLaunchAuthorization } from './protection-authority.js';
import { ManagedReadFailure, recoveryHoldings, recoveryOrder, type ControlledCancellation } from './managed-account-recovery.js';
import { managedResumeAction, verifyResumableEntry, type ManagedResumeAction } from './managed-position-resume.js';
import { ManagedEntryProgress } from './managed-entry-progress.js';
import type { MarginRiskMonitor, MarginLaunchAuthorization } from './margin-risk-monitor.js';
import { assertMarginHoldings, assertMarginSubmission, marginBatchFills, managedReductionTotals, managedActionPriority, observedHoldings, knownMarginOrder, knownMarginPosition } from './managed-margin-batch.js';

export interface ManagedAccountFacts { positions: GateCrossExPosition[]; openOrders: GateCrossExOrder[] }
export interface ManagedSources {
  activeAccount(): string | null;
  account(signal: AbortSignal): Promise<ManagedAccountFacts>;
  funding(symbol: string): { rate8h: string; fetchedAt: number } | null;
  refreshFunding(): Promise<void>;
  riskPause(): void;
  now?: () => number;
  context?: () => string;
}
export function managedLegs(config: CreateStrategyInput): [ManagedLeg, ManagedLeg] {
  const symbol = (venue: string, asset: string) => `${venue}_FUTURE_${nativeMarketAsset(venue, 'FUTURE', asset)}_${venue === 'KRAKEN' ? 'USD' : ['DERIBIT', 'HYPERLIQUID'].includes(venue) ? 'USDC' : 'USDT'}`;
  return [{ symbol: symbol(config.leftVenue, config.asset), side: config.leftSide },
    { symbol: symbol(config.rightVenue, config.kind === 'premium' ? config.hedgeAsset ?? config.asset : config.asset), side: config.rightSide }];
}
const opposite = (side: 'BUY' | 'SELL'): 'BUY' | 'SELL' => side === 'BUY' ? 'SELL' : 'BUY';
const ACCOUNT_READ_TIMEOUT_MS = 8_000;

/** Owns post-entry decisions; never adds exposure and never awaits a fill in the scheduling loop. */
export class ManagedPositionManager {
  readonly protection: ContinuousProtection;
  private marginMonitor: MarginRiskMonitor | null = null;
  private readonly launchAuthorizations = new Map<string, MarginLaunchAuthorization & { controlContext: string; protection: ProtectionLaunchAuthorization }>();
  setMarginMonitor(monitor: MarginRiskMonitor): void { this.marginMonitor = monitor; }
  normalMarginRecoveryAuthority(): string | null {
    if (this.stopped || !this.session.liveTradingEnabled || managedHardRiskReason(this.db)) return null;
    const records = this.runtime.listStrategies().filter(r => r.config.management && r.accountProfileId === this.sources.activeAccount());
    const current = records.filter(r => !['COMPLETED', 'TRANSFERRED', 'STOPPED'].includes(readManagedState(this.db, r.id)?.phase ?? ''));
    if (current.some(r => {
      const state = readManagedState(this.db, r.id);
      if (r.status !== 'RUNNING' || !state?.verified || state.stopIntent || state.exitRequested || state.protectionIncident
        || state.pauseAfterProtection || !['MONITORING', 'BALANCING'].includes(state.phase)) return true;
      const claims = this.db.prepare('SELECT symbol FROM managed_position_claims WHERE strategy_id=? AND account_id=?')
        .all(r.id, r.accountProfileId) as Array<{ symbol: string }>;
      return claims.length !== 2 || !managedLegs(r.config).every(l => claims.some(c => c.symbol === l.symbol));
    })) return null;
    const controls = records.map(r => { const s = readManagedState(this.db, r.id);
      return [r.id, r.config, s?.stopIntent, s?.exitRequested, s?.phase === 'TRANSFERRED']; }).sort((a, b) => String(a[0]).localeCompare(String(b[0])));
    return JSON.stringify([this.readContext(), this.protection.authority.epoch(), this.protection.authority.grant(), controls]);
  }
  private marginFacts: ((facts: ManagedAccountFacts) => void) | null = null;
  setMarginFacts(listener: (facts: ManagedAccountFacts) => void): void { this.marginFacts = listener; }
  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight: Promise<void> | null = null;
  private readonly fastPairing = new Map<string, Promise<void>>();
  private stopped = false;
  private revision = 0;
  private pendingWake = false;
  private readingAccount = false;
  private invalidatedSince: number | null = null;
  private lastWake = 0;
  private wakeTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly unsubscribers: Array<() => void> = [];
  private readonly now: () => number;
  private readonly entryProgress: ManagedEntryProgress;
  entryProgressPending(id: string): boolean { return this.entryProgress.has(id); }
  private readonly positionEvents = new Map<string, { at: number; quantity: string }>();
  private readonly orderEvents = new Map<string, string>();
  private readFailures = 0;
  private controlEpoch = 0;
  private readonly readControllers = new Set<AbortController>();
  private abortReads(): void { for (const controller of this.readControllers) controller.abort(); }
  private recoveryTimer: ReturnType<typeof setTimeout> | null = null;
  private recoveryKey: string | null = null;
  private recoverySequence = 0;
  private nextReadAt = 0;
  private recoveryOrders: Promise<void> | null = null;
  private entryRecovery: { cancel(id: string): void; evidence(id: string, orderId: string): ControlledCancellation | null; recovered?(account: string | null): void } | null = null;
  setEntryRecoveryController(controller: NonNullable<ManagedPositionManager['entryRecovery']>): void { this.entryRecovery = controller; }
  private readContext(): string { return `${this.sources.context?.() ?? this.sources.activeAccount()}:${this.controlEpoch}`; }
  private resetConfirmations(): void { this.recoverySignature = null; this.recoveryConfirmations = 0; this.marginRecoveryAt = null; }
  private recoveryDeadline(): number | null {
    const row = this.db.prepare('SELECT reason,created_at FROM managed_risk_lock WHERE singleton=1').get() as { reason: string; created_at: string } | undefined;
    const deadlines = [row?.reason === MANAGED_ACCOUNT_RECHECKING ? Date.parse(row.created_at) + MANAGED_RECOVERY_WINDOW_MS : null,
      this.invalidatedSince === null ? null : this.invalidatedSince + MANAGED_RECOVERY_WINDOW_MS,
      this.entryProgress.deadline()].filter((at): at is number => at !== null);
    return deadlines.length ? Math.min(...deadlines) : null;
  }
  private clearRecoveryTimer(): void { if (this.recoveryTimer) clearTimeout(this.recoveryTimer); this.recoveryTimer = null; }
  private armRecoveryTimer(): void {
    if (this.recoveryTimer || !this.session.liveTradingEnabled) return;
    const deadline = this.recoveryDeadline(); if (deadline === null) return;
    this.recoveryTimer = setTimeout(() => {
      this.recoveryTimer = null;
      if (this.stopped || !this.session.liveTradingEnabled) return;
      if (this.recoveryDeadline() === deadline && this.now() >= deadline) this.failAll('managed_account_recovery_expired');
      else this.armRecoveryTimer();
    }, Math.max(1, deadline - this.now()));
    this.recoveryTimer.unref?.();
  }
  private recoverySignature: string | null = null;
  private recoveryConfirmations = 0;
  private marginRecoveryAt: number | null = null;
  private readonly adoption: ManagedAdoption;
  private haltEntry: ((id: string) => Promise<void>) | null = null;
  private readonly openingMismatch = new Map<string, string>();
  setEntryController(halt: (id: string) => Promise<void>): void { this.haltEntry = halt; }
  holdForMarginRead(): void {
    if (managedHardRiskReason(this.db)) return;
    for (const record of this.active()) {
      const state = readManagedState(this.db, record.id)!;
      this.save(record.id, { ...state, marginReadPending: true });
    }
    this.recheck('margin_read_unavailable', true);
  }
  async haltOpeningForMargin(id: string): Promise<void> {
    const state = readManagedState(this.db, id);
    if (!state || state.phase !== 'OPENING' || state.stopIntent) return;
    this.save(id, { ...state, phase: 'VERIFYING', reason: 'margin_entry_blocked' });
    if (!this.haltEntry) throw new Error('managed_entry_controller_unavailable');
    await this.haltEntry(id);
    const caps = entryHoldings(this.db, id);
    this.save(id, { ...readManagedState(this.db, id)!, maxLeft: caps[0], maxRight: caps[1], after: this.now() });
  }

  constructor(private readonly db: Database.Database, private readonly session: TradingSession,
    private readonly runtime: TradingRuntime, private readonly markets: MarketSource, private readonly sources: ManagedSources) {
    this.now = sources.now ?? Date.now;
    this.entryProgress = new ManagedEntryProgress(db, runtime, sources.activeAccount, this.now);
    this.adoption = new ManagedAdoption(db, runtime, managedLegs);
    this.protection = new ContinuousProtection(db, session, runtime, {
      profile: sources.activeAccount, version: () => `${this.readContext()}:${this.revision}`,
      stopped: () => this.stopped, read: () => this.facts(true), margin: () => this.marginMonitor,
      publish: facts => this.marginFacts?.(facts), freeze: reason => this.failAll(reason),
      evaluate: (record, facts, at) => this.evaluate(record, facts, at),
      quotes: record => { for (const leg of managedLegs(record.config)) this.markets.ensureMarket?.(leg.symbol); },
    }, this.now);
    this.unsubscribers.push(session.subscribe(() => {
      this.marginMonitor?.invalidateNormalRecovery();
      this.controlEpoch += 1; this.revision += 1; this.abortReads(); this.resetConfirmations(); this.clearRecoveryTimer();
      this.entryProgress.clear();
      if (!managedRiskReason(this.db)) this.invalidatedSince = null;
      if (session.liveTradingEnabled) this.armRecoveryTimer();
    }));
    this.unsubscribers.push(runtime.onOrderUpdate((order) => {
      if (order.state === 'PENDING_SUBMIT' && order.failureReason === 'ORDER_SUBMISSION_UNKNOWN'
        || order.state === 'PENDING_CANCEL' && order.failureReason === 'ORDER_CANCELLATION_UNKNOWN') {
        this.failAll('managed_order_unresolved'); return;
      }
      try { this.entryProgress.confirm(); } catch (error) { this.failAll(error instanceof Error ? error.message : 'managed_entry_progress_invalid'); return; }
      const signature = `${order.state}:${order.executedQuantity}`;
      if (!this.claimed(order.symbol) || this.orderEvents.get(order.id) === signature) return;
      this.orderEvents.set(order.id, signature);
      const state = order.strategyId ? readManagedState(this.db, order.strategyId) : null;
      if (state?.phase === 'RISK_PAUSED' && isTerminalOrderState(order.state)) {
        this.save(order.strategyId!, { ...state,
          makerOrderId: state.makerOrderId === order.id ? null : state.makerOrderId,
          pendingOrderId: state.pendingOrderId === order.id ? null : state.pendingOrderId });
      }
      const normal = this.isNormalEntryQuote(order) || this.isOrdinaryExecution(order) || this.isKnownMarginExecution(order);
      this.wake(!normal);
      if (normal && order.reduceOnly && new Decimal(order.executedQuantity).gt(0) && order.strategyId) this.pairConfirmedExit(order.strategyId);
    }));
    this.unsubscribers.push(runtime.onFill((fill) => {
      if (!this.claimed(fill.symbol)) return;
      const order = this.runtime.getOrder(fill.orderId);
      const normal = this.isOrdinaryExecution(order) || this.isCoveredMonitoringFill(order) || this.isKnownMarginExecution(order);
      this.wake(!normal);
      if (normal && order.reduceOnly && order.strategyId) this.pairConfirmedExit(order.strategyId);
    }));
    db.prepare(`DELETE FROM managed_position_claims WHERE strategy_id NOT IN (SELECT id FROM execution_strategies)
      AND strategy_id NOT IN (SELECT strategy_id FROM execution_orders WHERE strategy_id IS NOT NULL)`).run();
    // Dwell never crosses process downtime; persisted exit intent and claims do.
    for (const row of db.prepare('SELECT strategy_id FROM managed_positions').all() as Array<{ strategy_id: string }>) {
      const state = readManagedState(db, row.strategy_id)!;
      writeManagedState(db, row.strategy_id, { ...state, conditionSince: null });
      if (state.phase === 'STOPPING') db.prepare("UPDATE execution_strategies SET status = 'PAUSED' WHERE id = ?").run(row.strategy_id);
    }
  }

  start(): void { this.stopped = false; this.timer ??= setInterval(() => { void this.tick(); }, 2000); this.timer.unref?.(); }
  async stop(): Promise<void> {
    this.stopped = true; this.controlEpoch += 1; this.abortReads(); this.clearRecoveryTimer();
    if (this.timer) clearInterval(this.timer);
    if (this.wakeTimer) clearTimeout(this.wakeTimer);
    this.timer = null; this.wakeTimer = null;
    for (const unsubscribe of this.unsubscribers) unsubscribe();
    await this.inFlight; await this.recoveryOrders; await Promise.all(this.fastPairing.values());
  }
  async waitForIdle(): Promise<void> { await Promise.all([this.inFlight, ...this.fastPairing.values()]); }
  async validateForActivation(): Promise<void> {
    if (this.recoveryDeadline() !== null && this.now() >= this.recoveryDeadline()!) {
      this.failAll('managed_account_recovery_expired');
      throw new TradingRuntimeError('managed_account_recovery_expired', 409);
    }
    const opening = this.active().filter((record) => readManagedState(this.db, record.id)?.phase === 'OPENING');
    if (!opening.length) return;
    try {
      const facts = await this.factsForAction();
      for (const record of opening) {
        if (record.accountProfileId !== this.sources.activeAccount()) throw new Error('managed_account_changed');
        const legs = managedLegs(record.config), actual = pairedQuantities(facts.positions, legs), expected = entryHoldings(this.db, record.id);
        if (facts.openOrders.some((o) => legs.some((l) => l.symbol === o.symbol)) || this.runtime.listOpenOrders(record.id).length)
          throw new Error('managed_restart_unresolved_orders');
        if (actual.some((q, i) => !new Decimal(q).eq(expected[i])) || !new Decimal(actual[0]).eq(actual[1]))
          throw new Error('managed_restart_position_mismatch');
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'managed_restart_reconcile_failed';
      this.failAll(reason); throw new TradingRuntimeError(reason, 409);
    }
  }
  notifyPosition(payload: Record<string, unknown>): void {
    if (typeof payload.symbol !== 'string' || typeof payload.position_qty !== 'string') return;
    if (!this.claimed(payload.symbol)) return;
    const at = Number(payload.update_time);
    const previous = this.positionEvents.get(payload.symbol);
    if (previous && Number.isFinite(at) && at <= previous.at) return;
    this.positionEvents.set(payload.symbol, { at, quantity: payload.position_qty });
    try { if (this.entryProgress.position(payload)) { this.armRecoveryTimer(); this.wake(false); return; } }
    catch (error) { this.failAll(error instanceof Error ? error.message : 'managed_entry_progress_invalid'); return; }
    if (previous?.quantity !== payload.position_qty) this.wake(!this.isExplainedPosition(payload));
  }
  private isExplainedPosition(payload: Record<string, unknown>): boolean {
    try {
      const claim = this.db.prepare('SELECT strategy_id FROM managed_position_claims WHERE symbol=? AND account_id=?')
        .get(payload.symbol, this.sources.activeAccount()) as { strategy_id: string } | undefined;
      if (!claim) return false;
      const record = this.runtime.getStrategy(claim.strategy_id), state = readManagedState(this.db, record.id), legs = managedLegs(record.config);
      if (knownMarginPosition(this.db, record, state, this.sources.activeAccount(), legs, payload)) return true;
      if (!ownsManagedExecution(this.db, record, state, this.sources.activeAccount(), legs)) return false;
      const index = legs.findIndex(l => l.symbol === payload.symbol);
      const expected = state!.phase === 'OPENING' && this.runtime.pairedEntryReady(record.id)
        ? entryHoldings(this.db, record.id) : projectedExitHoldings(this.db, record.id, state!);
      if (!expected || index < 0) return false;
      let quantity = new Decimal(String(payload.position_qty));
      if (payload.position_side === 'SHORT') quantity = quantity.abs().neg();
      if (payload.position_side === 'LONG') quantity = quantity.abs();
      return quantity.abs().eq(expected[index]) && (quantity.isZero() || (quantity.gt(0) ? 'BUY' : 'SELL') === legs[index].side);
    } catch { return false; }
  }
  private isNormalEntryQuote(order: ReturnType<TradingRuntime['getOrder']>): boolean {
    if (!order.strategyId || !order.remoteOrderId || order.type !== 'LIMIT' || order.timeInForce !== 'POC'
      || order.reduceOnly
      || !['NEW', 'OPEN', 'PENDING_CANCEL', 'CANCELLED'].includes(order.state)) return false;
    let record: StrategyRecord;
    try {
      if (!new Decimal(order.executedQuantity).isZero()) return false;
      record = this.runtime.getStrategy(order.strategyId);
    } catch { return false; } // Invalid execution or unknown ownership stays conservative.
    const state = readManagedState(this.db, order.strategyId);
    return record.status === 'RUNNING' && Boolean(record.config.management) && record.accountProfileId === this.sources.activeAccount()
      && state?.phase === 'OPENING' && !state.stopIntent && !state.exitRequested
      && !state.marginBatch && !state.protectionIncident && !state.positionSettlementSince
      && managedLegs(record.config).some(leg => leg.symbol === order.symbol && leg.side === order.side)
      && Boolean(this.db.prepare('SELECT 1 FROM managed_position_claims WHERE symbol = ? AND strategy_id = ? AND account_id = ?')
        .get(order.symbol, order.strategyId, record.accountProfileId));
  }
  private isOrdinaryExecution(order: ReturnType<TradingRuntime['getOrder']>): boolean {
    if (!order.strategyId) return false;
    try {
      const record = this.runtime.getStrategy(order.strategyId);
      return ordinaryManagedOrder(this.db, record, readManagedState(this.db, record.id), order,
        this.sources.activeAccount(), managedLegs(record.config), this.runtime.pairedEntryReady(record.id));
    } catch { return false; }
  }
  private isKnownMarginExecution(order: ReturnType<TradingRuntime['getOrder']>): boolean {
    if (!order.strategyId) return false;
    const record = this.runtime.getStrategy(order.strategyId);
    return knownMarginOrder(this.db, record, readManagedState(this.db, record.id), this.sources.activeAccount(), managedLegs(record.config), order);
  }
  private isCoveredMonitoringFill(order: ReturnType<TradingRuntime['getOrder']>): boolean {
    if (!order.strategyId || order.state !== 'FILLED' || order.failureReason
      || this.orderEvents.get(order.id) !== `${order.state}:${order.executedQuantity}`) return false;
    const record = this.runtime.getStrategy(order.strategyId), state = readManagedState(this.db, record.id);
    if (state?.phase !== 'MONITORING' || !state.verified || !ownsManagedExecution(this.db, record, state,
      this.sources.activeAccount(), managedLegs(record.config))) return false;
    const expected = entryHoldings(this.db, record.id);
    return new Decimal(state.leftQuantity ?? '-1').eq(expected[0]) && new Decimal(state.rightQuantity ?? '-1').eq(expected[1]);
  }
  private pairConfirmedExit(id: string): void {
    if (this.fastPairing.has(id) || this.stopped || !this.session.liveTradingEnabled || managedRiskReason(this.db)) return;
    const work = Promise.resolve().then(async () => {
      const record = this.runtime.getStrategy(id), state = readManagedState(this.db, id);
      if (!ownsManagedExecution(this.db, record, state, this.sources.activeAccount(), managedLegs(record.config))) return;
      if (this.marginMonitor && (!this.marginMonitor.snapshot().fresh || this.marginMonitor.snapshot().incidentId)) return;
      if (this.runtime.listOpenOrders(id).some(o => o.type === 'MARKET')) return;
      const quantities = projectedExitHoldings(this.db, id, state!);
      if (!quantities || new Decimal(quantities[0]).eq(quantities[1])) return;
      if (managedLegs(record.config).some(l => !freshManagedQuote(this.markets.market(l.symbol), this.now()))) {
        if (state!.makerOrderId) await this.cancelMaker(record, state!);
        return;
      }
      await this.balance(record, state!, quantities);
    }).catch(error => {
      if (this.session.liveTradingEnabled) this.failAll(error instanceof Error ? error.message : 'managed_pairing_failed');
    }).finally(() => { this.fastPairing.delete(id); });
    this.fastPairing.set(id, work);
  }
  private wake(risk = true): void {
    this.revision += 1;
    this.pendingWake = true;
    if (this.readingAccount && this.session.liveTradingEnabled) {
      this.invalidatedSince ??= this.now();
      if (risk) this.recheck('managed_account_snapshot_invalidated');
      this.armRecoveryTimer();
    }
    if (this.stopped || this.wakeTimer) return;
    this.wakeTimer = setTimeout(() => { this.wakeTimer = null; this.lastWake = this.now(); void this.tick(); }, Math.max(0, 100 - (this.now() - this.lastWake), this.nextReadAt - this.now()));
    this.wakeTimer.unref?.();
  }
  async tick(): Promise<void> {
    if (!this.stopped && this.protection.needsTick()) {
      if (this.inFlight) return this.inFlight;
      this.inFlight = this.protection.run().finally(() => {
        this.inFlight = null;
        if (!this.stopped && this.session.liveTradingEnabled && !managedRiskReason(this.db)) this.wake(false);
      });
      return this.inFlight;
    }
    if (this.stopped || !this.session.liveTradingEnabled || managedHardRiskReason(this.db)) return;
    try {
      this.entryProgress.confirm(); this.checkRecheckDeadline(); this.armRecoveryTimer();
      this.observeDuringRecovery(); this.maintainRecoveryOrders();
    } catch (error) { this.failAll(error instanceof Error ? error.message : 'managed_monitor_failed'); return; }
    if (this.inFlight) return this.inFlight;
    if (managedRiskReason(this.db) === MANAGED_ACCOUNT_RECHECKING && this.now() < this.nextReadAt) return;
    const context = this.readContext();
    this.pendingWake = false;
    this.inFlight = this.run().catch((error: unknown) => {
      if (this.stopped || context !== this.readContext() || !this.session.liveTradingEnabled || managedHardRiskReason(this.db)) return;
      if (error instanceof TradingRuntimeError && error.code === 'managed_task_stopped') return;
      if (error instanceof ManagedReadFailure) {
        if (error.fault.fatal) this.failAll(error.fault.code);
        else this.recheck(error.fault.code, true);
        this.logReadFault(error);
      } else this.failAll(error instanceof TradingRuntimeError && error.label
        ? `${error.code}:${error.label}` : error instanceof Error ? error.message : 'managed_monitor_failed');
    }).finally(() => { this.inFlight = null; if (this.pendingWake && !this.stopped) this.wake(); });
    return this.inFlight;
  }
  private logReadFault(error: ManagedReadFailure): void {
    const lock = this.db.prepare('SELECT created_at FROM managed_risk_lock WHERE singleton=1').get() as { created_at: string } | undefined;
    this.db.prepare('INSERT INTO audit_events (id,created_at,type,correlation_id,payload_json) VALUES (?,?,?,?,?)')
      .run(randomUUID(), new Date(this.now()).toISOString(), 'managed_account_read_fault', lock?.created_at ?? null, JSON.stringify(error.fault));
    for (const record of this.active()) this.log(record.id, 'Account read unavailable', JSON.stringify(error.fault));
  }
  private observeDuringRecovery(): void {
    if (managedRiskReason(this.db) !== MANAGED_ACCOUNT_RECHECKING) return;
    void this.sources.refreshFunding().catch(() => undefined);
    for (const record of this.active()) {
      const state = readManagedState(this.db, record.id)!;
      if (state.stopIntent || !['OPENING', 'MONITORING', 'EXITING', 'BALANCING'].includes(state.phase)) continue;
      for (const leg of managedLegs(record.config)) this.markets.ensureMarket?.(leg.symbol);
      this.observe(record, state, managedLegs(record.config), true);
    }
  }
  private cancellationEvidence(id: string, orderId: string): ControlledCancellation | null {
    const state = readManagedState(this.db, id);
    if (state?.makerOrderId === orderId && state.cancelRequestedAt !== null) return {
      startedAt: state.cancelRequestedAt, deadline: state.cancelRequestedAt + 5000 };
    return this.entryRecovery?.evidence(id, orderId) ?? null;
  }
  private maintainRecoveryOrders(): void {
    if (this.recoveryOrders || managedRiskReason(this.db) !== MANAGED_ACCOUNT_RECHECKING) return;
    const context = this.readContext();
    const valid = () => !this.stopped && this.session.liveTradingEnabled && context === this.readContext()
      && managedRiskReason(this.db) === MANAGED_ACCOUNT_RECHECKING;
    const work = async () => {
      for (const record of this.active()) {
        if (!valid()) return;
        const state = readManagedState(this.db, record.id)!;
        if (state.stopIntent) continue;
        if (state.phase === 'OPENING') {
          const open = this.runtime.listOpenOrders(record.id);
          if (open.some(order => order.type === 'LIMIT' && !isTerminalOrderState(order.state))) {
            if (!this.entryRecovery) throw new Error('managed_entry_controller_unavailable');
            this.entryRecovery.cancel(record.id);
          }
        }
        if (state.makerOrderId) {
          try { await this.cancelMaker(record, state, valid); }
          catch (error) {
            if (error instanceof Error && error.message === 'managed_cancel_unresolved') throw error;
            const fault = new ManagedReadFailure(error).fault; if (fault.fatal) throw new Error(fault.code, { cause: error });
            // A cancellation response is not replayed; its persisted intent is queried on the next pass.
          }
        }
        if (!valid()) return;
        if (state.pendingOrderId) {
          const pending = this.runtime.getOrder(state.pendingOrderId);
          if (!isTerminalOrderState(pending.state) && (pending.state === 'PENDING_SUBMIT' || !pending.remoteOrderId || this.now() - Date.parse(pending.createdAt) > 5000)) throw new Error('managed_order_unresolved');
          try { await this.bounded(this.runtime.refreshOrderFromRemote(state.pendingOrderId), 'managed_order_read_pending'); }
          catch (error) {
            const fault = new ManagedReadFailure(error).fault;
            if (fault.fatal || fault.status === 404) throw new Error('managed_order_unresolved', { cause: error });
            // Other read failures retain the original order and its original five-second deadline.
          }
        }
      }
    };
    this.recoveryOrders = work().catch((error: unknown) => {
      if (valid()) this.failAll(error instanceof Error ? error.message : 'managed_recovery_unresolved_orders');
    }).finally(() => { this.recoveryOrders = null; });
  }
  private claimed(symbol: string): boolean { return Boolean(this.db.prepare('SELECT 1 FROM managed_position_claims WHERE symbol = ?').get(symbol)); }
  private async bounded<T>(work: Promise<T>, reason: string, controller?: AbortController, timeoutMs = 3000): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([work, new Promise<never>((_, reject) => {
        timer = setTimeout(() => { controller?.abort(); reject(new Error(reason)); }, timeoutMs);
      })]);
    } finally { if (timer) clearTimeout(timer); }
  }
  private async facts(protectionRead = false): Promise<ManagedAccountFacts> {
    const controller = new AbortController(); this.readControllers.add(controller);
    const remaining = protectionRead ? null : this.recoveryDeadline();
    const timeout = Math.min(ACCOUNT_READ_TIMEOUT_MS, remaining === null ? ACCOUNT_READ_TIMEOUT_MS : Math.max(1, remaining - this.now()));
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const cancelled = new Promise<never>((_, reject) => {
        controller.signal.addEventListener('abort', () => reject(new Error('managed_account_timeout')), { once: true });
        timer = setTimeout(() => controller.abort(), timeout);
      });
      return await Promise.race([cancelled, this.sources.account(controller.signal)]);
    } catch (error) { throw new ManagedReadFailure(error); }
    finally { if (timer) clearTimeout(timer); this.readControllers.delete(controller); }
  }
  private async factsForAction(): Promise<ManagedAccountFacts> {
    const context = this.readContext(), risk = managedRiskReason(this.db);
    try { return await this.facts(); }
    catch (error) {
      if (context !== this.readContext() || risk !== managedRiskReason(this.db)) throw new TradingRuntimeError('managed_review_changed', 409);
      if (error instanceof ManagedReadFailure) throw new TradingRuntimeError(error.fault.code, error.fault.fatal ? 403 : 503);
      throw error;
    }
  }
  private recheck(reason: string, failed = false): void {
    const current = managedRiskReason(this.db);
    if (current && current !== MANAGED_ACCOUNT_RECHECKING) return;
    if (!current) this.db.prepare('INSERT INTO managed_risk_lock VALUES (1, ?, ?)')
      .run(MANAGED_ACCOUNT_RECHECKING, new Date(this.now()).toISOString());
    if (!current) { this.recoveryKey = `${++this.recoverySequence}:${this.now()}`; this.resetConfirmations(); }
    if (failed) { this.readFailures += 1; this.nextReadAt = this.now() + 2000; }
    this.recoverySignature = null; this.recoveryConfirmations = 0;
    for (const record of this.active()) {
      const state = readManagedState(this.db, record.id);
      if (!state) continue;
      if (!current) this.log(record.id, 'Account recheck started', reason);
      if (['OPENING', 'MONITORING', 'EXITING', 'BALANCING'].includes(state.phase)) this.observe(record, state, managedLegs(record.config), true);
      const currentState = readManagedState(this.db, record.id)!;
      this.save(record.id, { ...currentState, reason: MANAGED_ACCOUNT_RECHECKING });
    }
    const row = this.db.prepare('SELECT created_at FROM managed_risk_lock WHERE singleton = 1')
      .get() as { created_at: string };
    if (this.now() - Date.parse(row.created_at) >= MANAGED_RECOVERY_WINDOW_MS) this.failAll('managed_account_recovery_expired');
    else { this.armRecoveryTimer(); this.maintainRecoveryOrders(); }
  }
  private checkRecheckDeadline(): void {
    if (this.invalidatedSince !== null && this.now() - this.invalidatedSince >= MANAGED_RECOVERY_WINDOW_MS)
      throw new Error('managed_account_recovery_expired');
    const lock = this.db.prepare('SELECT reason, created_at FROM managed_risk_lock WHERE singleton = 1')
      .get() as { reason: string; created_at: string } | undefined;
    if (lock?.reason === MANAGED_ACCOUNT_RECHECKING && this.now() - Date.parse(lock.created_at) >= MANAGED_RECOVERY_WINDOW_MS)
      throw new Error('managed_account_recovery_expired');
  }
  private confirmRecovery(facts: ManagedAccountFacts, account: string | null): boolean {
    const lock = this.db.prepare('SELECT created_at FROM managed_risk_lock WHERE singleton = 1')
      .get() as { created_at: string } | undefined;
    if (!lock || this.now() - Date.parse(lock.created_at) >= MANAGED_RECOVERY_WINDOW_MS)
      throw new Error('managed_account_recovery_expired');
    const records = this.active(); let waiting = false;
    if (records.some(record => readManagedState(this.db, record.id)?.marginReadPending)) {
      const margin = this.marginMonitor?.snapshot();
      if (!margin?.fresh || margin.entryBlocked || margin.sampledAt == null) { this.resetConfirmations(); return false; }
      if (margin.sampledAt === this.marginRecoveryAt) return false;
      this.marginRecoveryAt = margin.sampledAt;
    }
    const symbols = new Set(records.flatMap((record) => managedLegs(record.config).map((leg) => leg.symbol)));
    for (const record of records) {
      if (record.accountProfileId !== account) throw new Error('managed_account_changed');
      const state = readManagedState(this.db, record.id)!;
      const claims = this.db.prepare('SELECT symbol FROM managed_position_claims WHERE account_id=? AND strategy_id=?').all(account, record.id) as Array<{ symbol: string }>;
      if (claims.length !== 2 || !managedLegs(record.config).every(leg => claims.some(c => c.symbol === leg.symbol))) throw new Error('managed_group_released');
      const verdict = recoveryHoldings(this.db, record, state, pairedQuantities(facts.positions, managedLegs(record.config)));
      if (verdict.kind === 'fault') throw new Error(verdict.reason);
      waiting ||= verdict.kind === 'wait';
    }
    const remoteOrders = facts.openOrders.filter((order) => symbols.has(order.symbol));
    const localOrders = this.runtime.listOpenOrders().filter((order) => symbols.has(order.symbol));
    const matches = (remote: GateCrossExOrder, local: ReturnType<TradingRuntime['listOpenOrders']>[number]) =>
      remote.order_id === local.remoteOrderId || remote.text === local.clientOrderId;
    if (remoteOrders.some(remote => !localOrders.some(local => matches(remote, local)))) throw new Error('managed_recovery_unresolved_orders');
    for (const local of localOrders) {
      if (!local.strategyId || !local.remoteOrderId || local.state === 'PENDING_SUBMIT') throw new Error('managed_recovery_unresolved_orders');
      const record = records.find(r => r.id === local.strategyId);
      if (!record) throw new Error('managed_recovery_unresolved_orders');
      const state = readManagedState(this.db, record.id)!;
      const cancel = this.cancellationEvidence(record.id, local.id);
      if (local.state === 'PENDING_CANCEL' && !cancel) throw new Error('managed_recovery_unresolved_orders');
      if (cancel) {
        if (this.now() >= cancel.deadline) throw new Error('managed_cancel_unresolved');
        waiting = true;
      }
      const remote = remoteOrders.find(order => matches(order, local));
      if (!remote) {
        if (cancel || state.pendingOrderId === local.id) { waiting = true; continue; }
        throw new Error('managed_recovery_unresolved_orders');
      }
      const verdict = recoveryOrder(remote, local);
      if (verdict.kind === 'fault') throw new Error(verdict.reason);
      waiting ||= verdict.kind === 'wait';
    }
    if (waiting) { this.resetConfirmations(); return false; }
    const signature = JSON.stringify({
      positions: facts.positions.filter((position) => symbols.has(position.symbol))
        .map((position) => [position.symbol, position.position_side, new Decimal(position.position_qty).toString()]).sort(),
      orders: remoteOrders.map((order) => [order.order_id, order.text, order.state, order.executed_qty]).sort(),
    });
    this.recoveryConfirmations = signature === this.recoverySignature ? this.recoveryConfirmations + 1 : 1;
    this.recoverySignature = signature;
    if (this.recoveryConfirmations < 2) return false;
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM managed_risk_lock WHERE reason = ?').run(MANAGED_ACCOUNT_RECHECKING);
      for (const record of records) {
        const state = readManagedState(this.db, record.id)!;
        writeManagedState(this.db, record.id, { ...state, marginReadPending: false, reason: state.reason === MANAGED_ACCOUNT_RECHECKING ? null : state.reason });
      }
    })();
    this.readFailures = 0; this.resetConfirmations(); this.clearRecoveryTimer(); this.recoveryKey = null; this.nextReadAt = 0;
    for (const record of records) this.log(record.id, 'Account monitoring recovered', 'Two matching fresh position and order snapshots');
    this.entryRecovery?.recovered?.(account);
    return true;
  }
  private active(): StrategyRecord[] {
    return this.runtime.listStrategies().filter((s) => s.config.management && s.status === 'RUNNING');
  }
  private async run(): Promise<void> {
    const records = this.active().filter((s) => !['STOPPING', 'STOPPED', 'TRANSFERRED'].includes(readManagedState(this.db, s.id)!.phase));
    if (!records.length) return;
    this.checkRecheckDeadline();
    void this.sources.refreshFunding().catch(() => { /* missing funding disables and resets the economic trigger */ });
    const revision = this.revision, started = this.now(), account = this.sources.activeAccount(), context = this.readContext(), recoveryKey = this.recoveryKey;
    let facts: ManagedAccountFacts; this.readingAccount = true;
    try { facts = await this.facts(); } finally { this.readingAccount = false; }
    if (!this.session.liveTradingEnabled || managedHardRiskReason(this.db) || context !== this.readContext() || recoveryKey !== this.recoveryKey) return;
    this.checkRecheckDeadline(); this.readFailures = 0;
    if (account !== this.sources.activeAccount()) throw new Error('managed_account_changed');
    if (revision !== this.revision) {
      if (managedRiskReason(this.db) === MANAGED_ACCOUNT_RECHECKING) this.recheck('managed_account_snapshot_invalidated');
      return;
    }
    if (managedRiskReason(this.db) === MANAGED_ACCOUNT_RECHECKING) {
      this.nextReadAt = 0;
      if (!this.confirmRecovery(facts, account)) return;
    }
    this.invalidatedSince = null;
    this.marginFacts?.(facts);
    const priorities = new Map(records.map(r => [r.id, managedActionPriority(this.db, r.id, readManagedState(this.db, r.id)!, pairedQuantities(facts.positions, managedLegs(r.config)))]));
    const ordered = [...records].sort((a, b) => priorities.get(a.id)! - priorities.get(b.id)!);
    for (const record of ordered) {
      if (record.accountProfileId !== account) throw new Error('managed_account_changed');
      const marginOwner = this.marginMonitor?.snapshot().protection?.strategyId;
      if (marginOwner && record.id !== marginOwner) continue;
      // Persisted managed groups bypass entry actors on restart. Register their public quotes
      // independently of browser watches so economic protection can recover after a cold boot.
      for (const leg of managedLegs(record.config)) {
        if (!this.markets.market(leg.symbol)) this.markets.ensureMarket?.(leg.symbol);
      }
      await this.evaluate(record, facts, started);
      if (managedRiskReason(this.db) || revision !== this.revision) return;
    }
  }

  async reserve(id: string, config: CreateStrategyInput, accountId: string, prepareQuotes?: () => Promise<void>): Promise<void> {
    if (!this.session.liveTradingEnabled) throw new TradingRuntimeError('live_trading_locked', 403);
    const controlContext = this.readContext();
    const riskBlock = managedRiskBlock(this.db);
    if (riskBlock) throw new TradingRuntimeError(riskBlock, 409);
    const legs = managedLegs(config);
    this.adoption.reserve(id, config, accountId);
    this.revision += 1;
    let cancelledOldOrders = false;
    try {
      const protection = this.protection.authority.captureLaunchAuthorization(accountId);
      if (this.marginMonitor) {
        if (!this.marginMonitor.snapshot().fresh) await this.marginMonitor.refresh();
        if (controlContext !== this.readContext()) throw new Error('margin_launch_context_changed');
        this.launchAuthorizations.set(id, { ...this.marginMonitor.captureLaunchAuthorization(accountId), controlContext, protection });
      }
      // Hold ownership during the bounded quote wait, then read current account facts. No
      // leverage or order mutation is allowed before this read-only preparation completes.
      await prepareQuotes?.();
      if (controlContext !== this.readContext()) throw new Error('margin_launch_context_changed');
      if (!this.session.liveTradingEnabled) throw new TradingRuntimeError('live_trading_locked', 403);
      let facts = await this.factsForAction();
      if (!this.session.liveTradingEnabled) throw new TradingRuntimeError('live_trading_locked', 403);
      if (this.sources.activeAccount() !== accountId) throw new Error('managed_account_changed');
      for (const leg of legs) {
        this.requireSize(leg, new Decimal(config.management!.perOrderQuantity));
      }
      if (config.management?.adoptExisting) {
        const ids = this.adoption.orderIds(id, facts);
        if (ids.length) {
          cancelledOldOrders = true;
          try {
            const settled = await this.bounded(this.runtime.quiesceOpenOrders({ orderIds: ids, timeoutMs: 3000 }), 'managed_adoption_unresolved_orders');
            if (settled.unresolved.length) throw new Error('managed_adoption_unresolved_orders');
          } catch { this.failAll('managed_adoption_unresolved_orders'); throw new TradingRuntimeError('managed_adoption_unresolved_orders', 409); }
          facts = await this.factsForAction();
        }
      }
      this.checkLaunchAccount(accountId);
      this.adoption.capture(id, config, facts);
    } catch (error) {
      this.abortReservation(id);
      if (cancelledOldOrders) this.failAll('managed_adoption_reconcile_failed');
      if (error instanceof Error && !(error instanceof TradingRuntimeError) && /^(managed_|margin_|protection_)/.test(error.message)) throw new TradingRuntimeError(error.message, 409);
      throw error;
    }
  }
  private checkLaunchAccount(account: string): void {
    if (!this.session.liveTradingEnabled || managedRiskReason(this.db)) throw new TradingRuntimeError('live_trading_locked', 403);
    if (this.sources.activeAccount() !== account) throw new TradingRuntimeError('managed_account_changed', 409);
  }
  async recheckReservation(id: string, config: CreateStrategyInput, account: string): Promise<void> {
    if (this.marginMonitor && !this.marginMonitor.snapshot().fresh) await this.marginMonitor.refresh();
    const facts = await this.factsForAction();
    this.checkLaunchAccount(account);
    this.adoption.capture(id, config, facts);
  }
  assertReservation(id: string): void { this.adoption.assertReservation(id); }
  abortReservation(id: string): void {
    this.launchAuthorizations.delete(id);
    this.adoption.abort(id);
  }
  initialize(id: string, account: string): void {
    this.db.transaction(() => {
      this.adoption.initialize(id, account);
      try {
        if (this.marginMonitor) {
          const expected = this.launchAuthorizations.get(id);
          if (!expected) throw new Error('margin_launch_authorization_missing');
          if (expected.controlContext !== this.readContext()) throw new Error('margin_launch_context_changed');
          const groupId = readManagedState(this.db, id)!.groupId ?? id;
          this.marginMonitor.authorizeLaunchedGroup(account, id, groupId, expected);
          this.protection.authority.authorizeLaunchedGroup(expected.accountId, groupId, expected.protection);
        }
      }
      catch (error) {
        if (error instanceof Error && /^(margin_|protection_)/.test(error.message)) throw new TradingRuntimeError(error.message, 409);
        throw error;
      }
    })();
    this.launchAuthorizations.delete(id);
  }
  handles(id: string): boolean { const state = readManagedState(this.db, id); return Boolean(state && state.phase !== 'OPENING'); }
  handoff(id: string, quantity: string): void {
    const state = readManagedState(this.db, id)!;
    if (state.stopIntent || state.phase !== 'OPENING') return;
    const caps = entryHoldings(this.db, id);
    this.save(id, { ...state, phase: 'VERIFYING', openingQuantity: quantity, maxLeft: caps[0], maxRight: caps[1], after: this.now() });
    this.log(id, 'Entry completed', 'Verifying actual positions before monitoring');
    this.wake();
  }
  requestExit(id: string): void {
    this.marginMonitor?.invalidateNormalRecovery();
    if (!this.session.liveTradingEnabled || managedRiskReason(this.db)) throw new TradingRuntimeError('managed_review_required', 409);
    const state = readManagedState(this.db, id)!;
    const record = this.runtime.getStrategy(id);
    // A partially opened task may be stopped before handoff; bound ownership by executed quantities.
    this.save(id, { ...state, phase: 'EXITING', exitRequested: true, reason: 'manual_exit', conditionSince: null,
      signalReason: null, signalMissingSince: null,
      maxLeft: state.phase === 'OPENING' ? entryHoldings(this.db, record.id)[0] : state.maxLeft,
      maxRight: state.phase === 'OPENING' ? entryHoldings(this.db, record.id)[1] : state.maxRight, verified: true, after: this.now() });
    this.log(id, 'Exit requested', 'Stop and exit; new entries permanently disabled');
    this.wake();
  }
  beginStop(id: string, closePositions: boolean): void {
    this.marginMonitor?.invalidateNormalRecovery();
    const state = readManagedState(this.db, id)!;
    if (this.runtime.getStrategy(id).accountProfileId !== this.sources.activeAccount()) throw new TradingRuntimeError('managed_account_changed', 409);
    if (state.phase === 'TRANSFERRED') throw new TradingRuntimeError('managed_group_transferred', 409);
    this.adoption.abortOwner(id);
    const intent = closePositions ? 'EXIT' : 'KEEP';
    const caps = state.phase === 'OPENING' ? entryHoldings(this.db, id) : [state.maxLeft, state.maxRight];
    this.revision += 1;
    writeManagedState(this.db, id, { ...state, phase: 'STOPPING', stopIntent: intent,
      stopFromOpening: state.phase === 'OPENING' || state.stopFromOpening === true,
      exitRequested: closePositions, maxLeft: caps[0], maxRight: caps[1], conditionSince: null });
    this.log(id, 'Stop requested', closePositions ? 'Exit all adopted and new holdings after order reconciliation' : 'Keep all holdings; stop automation after order reconciliation');
  }
  async finishStop(id: string): Promise<void> {
    const state = readManagedState(this.db, id)!, record = this.runtime.getStrategy(id);
    if (state.phase !== 'STOPPING') throw new TradingRuntimeError('managed_stop_not_requested', 409);
    try {
      const facts = await this.factsForAction();
      if (this.sources.activeAccount() !== record.accountProfileId) throw new Error('managed_account_changed');
      const legs = managedLegs(record.config), quantities = pairedQuantities(facts.positions, legs);
      if (this.runtime.listOpenOrders(id).length || facts.openOrders.some((o) => legs.some((l) => l.symbol === o.symbol))) throw new Error('managed_stop_unresolved_orders');
      if (state.positionSettlementSince && observedHoldings(state, managedReductionTotals(this.db, id), quantities) === 'pending') throw new Error('managed_positions_settlement_pending');
      const caps = state.stopFromOpening ? entryHoldings(this.db, id) : [state.maxLeft, state.maxRight];
      if (quantities.some((q, i) => new Decimal(q).gt(caps[i]))) throw new Error('managed_position_increased');
      const keep = state.stopIntent === 'KEEP';
      const flat = quantities.every((q) => new Decimal(q).isZero());
      if (!keep && (!this.session.liveTradingEnabled || managedRiskReason(this.db))) throw new Error('managed_review_required');
      this.db.transaction(() => {
      writeManagedState(this.db, id, { ...state, phase: flat ? 'COMPLETED' : keep ? 'STOPPED' : 'EXITING', verified: true,
        leftQuantity: quantities[0], rightQuantity: quantities[1], maxLeft: quantities[0], maxRight: quantities[1],
        checkedAt: new Date(this.now()).toISOString(), reason: keep ? 'manual_stop_keep' : 'manual_exit', stopFromOpening: false,
        signalReason: null, signalMissingSince: null,
        positionSettlementSince: undefined,
        makerOrderId: null, pendingOrderId: null, pendingOrderIds: [], after: this.now() });
      this.db.prepare('UPDATE execution_strategies SET status = ?, open_position = ?, stopped_at = ? WHERE id = ?')
        .run(flat ? 'COMPLETED' : keep ? 'STOPPED' : 'RUNNING', Decimal.min(...quantities).toString(), keep || flat ? new Date().toISOString() : null, id);
      if (flat) this.db.prepare('DELETE FROM managed_position_claims WHERE strategy_id = ?').run(id);
      })();
      if (keep && !new Decimal(quantities[0]).eq(quantities[1])) this.failAll('managed_stopped_unbalanced');
      this.runtime.emitStrategyUpdate(this.runtime.getStrategy(id));
    } catch (error) {
      this.failAll(error instanceof Error ? error.message : 'managed_stop_reconcile_failed');
      throw new TradingRuntimeError('managed_stop_reconcile_failed', 409);
    }
  }

  private async evaluateOpening(record: StrategyRecord, facts: ManagedAccountFacts, state: ManagedState): Promise<void> {
    const legs = managedLegs(record.config), quantities = pairedQuantities(facts.positions, legs);
    const expected = entryHoldings(this.db, record.id);
    if (this.entryProgress.facts(record, quantities)) {
      this.openingMismatch.delete(record.id); this.armRecoveryTimer();
      this.save(record.id, { ...state, leftQuantity: quantities[0], rightQuantity: quantities[1], maxLeft: expected[0], maxRight: expected[1],
        checkedAt: new Date(this.now()).toISOString() }); return;
    }
    const differs = quantities.some((q, i) => !new Decimal(q).eq(expected[i]));
    const signature = JSON.stringify([quantities, expected]);
    const confirmed = differs && this.openingMismatch.get(record.id) === signature;
    if (differs) this.openingMismatch.set(record.id, signature); else this.openingMismatch.delete(record.id);
    this.save(record.id, { ...state, leftQuantity: quantities[0], rightQuantity: quantities[1],
      maxLeft: expected[0], maxRight: expected[1], checkedAt: new Date(this.now()).toISOString() });
    if (quantities.some((q) => new Decimal(q).gt(0))) this.observe(record, readManagedState(this.db, record.id)!, legs);
    if (!confirmed && !readManagedState(this.db, record.id)!.exitRequested) return;
    if (!this.haltEntry) throw new Error('managed_entry_controller_unavailable');
    // Block new submissions before waiting for the entry actor and its known orders.
    const latest = readManagedState(this.db, record.id)!;
    this.save(record.id, { ...latest, phase: 'VERIFYING', pauseAfterProtection: confirmed });
    await this.haltEntry(record.id);
    const caps = entryHoldings(this.db, record.id);
    this.save(record.id, { ...readManagedState(this.db, record.id)!, maxLeft: caps[0], maxRight: caps[1], after: this.now() });
  }
  async resume(id: string, accountId: string, expectedAction?: ManagedResumeAction): Promise<StrategyRecord> {
    const riskAtStart = managedRiskReason(this.db);
    const record = this.runtime.getStrategy(id), state = readManagedState(this.db, id)!;
    if (state.phase === 'TRANSFERRED') throw new TradingRuntimeError('managed_group_transferred', 409);
    const claims = this.db.prepare('SELECT symbol FROM managed_position_claims WHERE strategy_id = ? AND account_id = ?').all(id, accountId) as Array<{ symbol: string }>;
    if (claims.length !== 2 || !managedLegs(record.config).every((l) => claims.some((c) => c.symbol === l.symbol))) throw new TradingRuntimeError('managed_group_released', 409);
    if (!['PAUSED', 'STOPPED'].includes(record.status)) throw new TradingRuntimeError('strategy_not_paused', 409);
    if (record.accountProfileId !== accountId) throw new TradingRuntimeError('strategy_account_not_active', 409);
    if (this.runtime.listOpenOrders().length) throw new TradingRuntimeError('strategy_resume_unresolved_orders', 409);
    const revision = this.revision;
    const facts = await this.factsForAction(), legs = managedLegs(record.config);
    if (this.runtime.getStrategy(id).status !== record.status || this.adoption.reservedOwner(id)) throw new TradingRuntimeError('strategy_not_paused', 409);
    const latestState = readManagedState(this.db, id)!;
    const latestClaims = this.db.prepare('SELECT symbol FROM managed_position_claims WHERE strategy_id = ? AND account_id = ?').all(id, accountId) as Array<{ symbol: string }>;
    if (latestState.phase === 'TRANSFERRED' || latestClaims.length !== 2 || !legs.every((leg) => latestClaims.some((claim) => claim.symbol === leg.symbol)))
      throw new TradingRuntimeError('managed_group_released', 409);
    if (this.revision !== revision || managedRiskReason(this.db) !== riskAtStart || latestState.reason !== state.reason
      || latestState.exitRequested !== state.exitRequested || latestState.stopIntent !== state.stopIntent
      || latestState.verified !== state.verified || latestState.phase !== state.phase)
      throw new TradingRuntimeError('managed_review_changed', 409);
    if (latestState.stopIntent !== state.stopIntent || latestState.phase === 'STOPPING' && state.phase !== 'STOPPING') throw new TradingRuntimeError('managed_stop_in_progress', 409);
    if (!this.session.liveTradingEnabled || accountId !== this.sources.activeAccount()) throw new TradingRuntimeError('live_trading_locked', 403);
    for (const managed of this.runtime.listStrategies().filter((s) => s.config.management
      && Boolean(this.db.prepare('SELECT 1 FROM managed_position_claims WHERE strategy_id = ?').get(s.id)))) {
      const owned = readManagedState(this.db, managed.id)!, ownedLegs = managedLegs(managed.config);
      if (this.runtime.listOpenOrders(managed.id).length || facts.openOrders.some((o) => ownedLegs.some((l) => l.symbol === o.symbol))) throw new TradingRuntimeError('strategy_resume_unresolved_orders', 409);
      const q = pairedQuantities(facts.positions, ownedLegs);
      const caps = owned.verified || owned.phase !== 'OPENING' && owned.openingQuantity !== '0'
        ? [owned.maxLeft, owned.maxRight] : entryHoldings(this.db, managed.id);
      if (q.some((n, i) => new Decimal(n).gt(caps[i]))) throw new TradingRuntimeError('managed_position_increased', 409);
      if (managed.id !== id && !new Decimal(q[0]).eq(q[1])) throw new TradingRuntimeError('managed_other_task_unbalanced', 409);
    }
    const quantities = pairedQuantities(facts.positions, legs);
    const current = readManagedState(this.db, id)!;
    if (current.positionSettlementSince && observedHoldings(current, managedReductionTotals(this.db, id), quantities) === 'pending')
      throw new TradingRuntimeError('managed_positions_settlement_pending', 409);
    const latestRecord = this.runtime.getStrategy(id);
    if (JSON.stringify(latestRecord.config) !== JSON.stringify(record.config)) throw new TradingRuntimeError('managed_review_changed', 409);
    if (!current.verified && !current.stopIntent && !current.exitRequested) verifyResumableEntry(this.db, latestRecord, current, quantities, legs);
    const action = managedResumeAction(latestRecord, current), opening = action === 'OPENING';
    if (expectedAction && expectedAction !== action) throw new TradingRuntimeError('managed_resume_action_changed', 409);
    const resumed: ManagedState = { ...current, phase: action,
      stopIntent: null, stopFromOpening: false, pauseAfterProtection: false,
      protectionIncident: null, observedReductions: managedReductionTotals(this.db, id), leftQuantity: quantities[0], rightQuantity: quantities[1],
      positionSettlementSince: undefined,
      exitRequested: action === 'EXITING', verified: !opening, maxLeft: quantities[0], maxRight: quantities[1],
      pendingOrderId: null, makerOrderId: null, pendingOrderIds: [], cancelRequestedAt: null, conditionSince: null, reason: null };
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM managed_risk_lock').run();
      this.db.prepare("UPDATE execution_strategies SET status = 'RUNNING', stopped_at = NULL WHERE id = ? AND status IN ('PAUSED', 'STOPPED')").run(id);
      writeManagedState(this.db, id, resumed);
    })();
    this.runtime.emitStrategyUpdate(this.runtime.getStrategy(id));
    this.openingMismatch.delete(id);
    this.log(id, 'Risk reviewed', 'Explicit resume after fresh account and order reconciliation');
    return this.runtime.getStrategy(id);
  }

  failAll(reason: string): void {
    this.marginMonitor?.invalidateNormalRecovery();
    this.abortReads(); this.clearRecoveryTimer();
    this.marginMonitor?.blockIncident(reason);
    const current = managedRiskReason(this.db);
    if (current && current !== MANAGED_ACCOUNT_RECHECKING) return;
    if (current) this.db.prepare('UPDATE managed_risk_lock SET reason = ? WHERE singleton = 1').run(reason);
    else this.db.prepare('INSERT INTO managed_risk_lock VALUES (1, ?, ?)').run(reason, new Date(this.now()).toISOString());
    const incident = this.db.prepare('SELECT created_at FROM managed_risk_lock WHERE singleton=1').get() as { created_at: string };
    this.db.prepare('INSERT INTO audit_events (id,created_at,type,correlation_id,payload_json) VALUES (?,?,?,?,?)')
      .run(randomUUID(), new Date(this.now()).toISOString(), 'managed_account_hard_pause', incident.created_at, JSON.stringify({ reason }));
    const records = this.active();
    this.db.prepare("UPDATE execution_strategies SET status = 'PAUSED' WHERE status = 'RUNNING'").run();
    for (const record of records) {
      const state = readManagedState(this.db, record.id);
      if (state) this.save(record.id, { ...state, phase: 'RISK_PAUSED', reason, conditionSince: null });
      this.runtime.addStrategyLog(record.id, 'error', 'Managed risk pause', reason, '—', 'Global pause; reconcile before explicit resume');
    }
    this.session.pause();
    this.sources.riskPause();
  }
  private save(id: string, state: ManagedState): void {
    const current = readManagedState(this.db, id);
    if (current?.stopIntent === 'KEEP' && state.stopIntent !== 'KEEP') return;
    if (current && ['STOPPING', 'STOPPED', 'TRANSFERRED'].includes(current.phase) && state.phase !== current.phase) return;
    const exitRequested = state.exitRequested || current?.exitRequested === true;
    if (this.protection.isEvaluating(id) && current && this.runtime.getStrategy(id).status === 'PAUSED') {
      state = { ...state, phase: current.phase, conditionSince: current.conditionSince };
    }
    writeManagedState(this.db, id, { ...state, exitRequested,
      phase: exitRequested && state.phase === 'MONITORING' && managedRiskReason(this.db) !== MANAGED_ACCOUNT_RECHECKING ? 'EXITING' : state.phase,
      pendingOrderIds: this.runtime.listOpenOrders(id).map((o) => o.id) });
    if (state.leftQuantity !== null && state.rightQuantity !== null) {
      this.db.prepare('UPDATE execution_strategies SET open_position = ? WHERE id = ?')
        .run(Decimal.min(state.leftQuantity, state.rightQuantity).toString(), id);
    }
    this.runtime.emitStrategyUpdate(this.runtime.getStrategy(id));
  }
  private log(id: string, event: string, reason: string): void { this.runtime.addStrategyLog(id, 'info', event, reason, '—', 'Managed paired position'); }

  private async evaluate(record: StrategyRecord, facts: ManagedAccountFacts, started: number): Promise<void> {
    if (this.fastPairing.has(record.id)) return;
    let state = readManagedState(this.db, record.id)!;
    if (started < state.after || ['COMPLETED', 'STOPPING', 'STOPPED', 'TRANSFERRED'].includes(state.phase)) return;
    const legs = managedLegs(record.config);
    const ownOrders = this.db.prepare('SELECT remote_order_id, client_order_id, state FROM execution_orders WHERE strategy_id = ?')
      .all(record.id) as Array<{ remote_order_id: string | null; client_order_id: string; state: string }>;
    const foreign = facts.openOrders.some((o) => legs.some((l) => l.symbol === o.symbol)
      && !ownOrders.some((known) => known.remote_order_id === o.order_id || known.client_order_id === o.text));
    if (foreign) throw new Error('managed_foreign_order');
    const contradictory = facts.openOrders.some((o) => legs.some((l) => l.symbol === o.symbol)
      && ownOrders.some((known) => (known.remote_order_id === o.order_id || known.client_order_id === o.text) && isTerminalOrderState(known.state)));
    if (contradictory) throw new Error('managed_order_state_conflict');
    if (state.phase === 'OPENING' && !this.protection.isEvaluating(record.id)) { await this.evaluateOpening(record, facts, state); return; }
    if (await this.settlePending(record, state)) return;
    state = readManagedState(this.db, record.id)!;
    if (['STOPPING', 'STOPPED', 'TRANSFERRED', 'COMPLETED'].includes(state.phase)) return;
    const quantities = pairedQuantities(facts.positions, legs);
    if (new Decimal(quantities[0]).gt(state.maxLeft) || new Decimal(quantities[1]).gt(state.maxRight)) throw new Error('managed_position_increased');
    const reductions = managedReductionTotals(this.db, record.id);
    if (state.marginBatch) {
      try { assertMarginHoldings(this.db, record.id, state.marginBatch, quantities); }
      catch (error) {
        if (!(error instanceof Error) || error.message !== 'margin_positions_settlement_pending') throw error;
        const since = state.marginBatch.settlementSince ?? this.now();
        if (this.now() - since >= MANAGED_RECOVERY_WINDOW_MS) throw new Error('margin_positions_settlement_expired', { cause: error });
        this.save(record.id, { ...state, reason: error.message, marginBatch: { ...state.marginBatch, settlementSince: since } }); return;
      }
      state = { ...state, reason: state.reason === 'margin_positions_settlement_pending' ? null : state.reason,
        marginBatch: { ...state.marginBatch, settlementSince: undefined } };
    }
    else if (observedHoldings(state, reductions, quantities) === 'pending') {
      const since = state.positionSettlementSince ?? this.now();
      if (this.now() - since >= MANAGED_RECOVERY_WINDOW_MS) throw new Error('managed_positions_settlement_expired');
      this.save(record.id, { ...state, positionSettlementSince: since, reason: 'managed_positions_settlement_pending' });
      if (state.makerOrderId && !isTerminalOrderState(this.runtime.getOrder(state.makerOrderId).state))
        await this.cancelMaker(record, readManagedState(this.db, record.id)!);
      this.revision += 1; return;
    } else if (observedHoldings(state, reductions, quantities) === 'external') {
      state = { ...state, protectionIncident: state.protectionIncident ?? { reason: 'managed_external_reduction',
        before: [state.leftQuantity!, state.rightQuantity!], at: this.now() }, pauseAfterProtection: true };
    }
    state = { ...state, verified: true, leftQuantity: quantities[0], rightQuantity: quantities[1],
      positionSettlementSince: undefined, reason: state.reason === 'managed_positions_settlement_pending' ? null : state.reason,
      observedReductions: reductions,
      maxLeft: quantities[0], maxRight: quantities[1], checkedAt: new Date(this.now()).toISOString() };
    this.save(record.id, state);
    const open = this.runtime.listOpenOrders(record.id);
    if (quantities.every((q) => new Decimal(q).isZero())) {
      if (open.length) { await this.cancelMaker(record, state); return; }
      if (facts.openOrders.some((o) => legs.some((l) => l.symbol === o.symbol))) return;
      if (state.marginBatch) this.completeMarginBatch(record, state, quantities);
      if (state.protectionIncident) { if (!this.protection.isEvaluating(record.id)) this.failAll(state.protectionIncident.reason); return; }
      this.complete(record, readManagedState(this.db, record.id)!); return;
    }
    if (open.some((o) => o.id !== state.makerOrderId)) throw new Error('managed_unexpected_order');
    // Also cover a partial fill: balance() is selected before exit(). Cancel remaining maker
    // exposure and reconcile terminal fills before using a new account snapshot to protect it.
    if (state.makerOrderId && legs.some((leg) => !freshManagedQuote(this.markets.market(leg.symbol), this.now()))) {
      await this.cancelMaker(record, state); return;
    }
    if (!new Decimal(quantities[0]).eq(quantities[1])) {
      this.adoption.abortOwner(record.id);
      await this.balance(record, state, quantities); return;
    }
    if (state.marginBatch) {
      if (new Decimal(quantities[0]).gte(state.marginBatch.before)) throw new Error('margin_reduction_not_effective');
      this.completeMarginBatch(record, state, quantities); return;
    }
    if (state.pauseAfterProtection && !this.protection.isEvaluating(record.id)) { this.failAll(state.protectionIncident?.reason ?? 'managed_entry_exposure_changed'); return; }
    if (this.marginMonitor?.snapshot().incidentId) {
      const snapshot = this.marginMonitor.snapshot();
      const covered = snapshot.groups?.some(g => g.strategyId === record.id && g.eligible && g.authorized);
      if (covered && state.makerOrderId) { await this.cancelMaker(record, state); return; }
      if (await this.reduceForMargin(record, state, facts)) return;
      if (snapshot.groups?.some(g => g.eligible && g.authorized) || snapshot.protection?.stage === 'settlement_pending'
        || snapshot.protection?.stage === 'confirming_recovery' || !state.exitRequested) return;
    }
    if (this.protection.isEvaluating(record.id)) { await this.reduceForMargin(record, state, facts); return; }
    if (state.exitRequested) { this.adoption.abortOwner(record.id); await this.exit(record, state, quantities); return; }
    if (await this.reduceForMargin(record, state, facts)) return;
    this.observe(record, state, legs);
    if (readManagedState(this.db, record.id)?.exitRequested) this.adoption.abortOwner(record.id);
  }

  private async reduceForMargin(record: StrategyRecord, state: ManagedState, facts: ManagedAccountFacts): Promise<boolean> {
    if (!this.marginMonitor || !this.protection.isEvaluating(record.id) && (!this.session.liveTradingEnabled || managedRiskReason(this.db))) return false;
    const legs = managedLegs(record.config), constraints = legs.map((l) => this.constraints(l.symbol));
    if (legs.some((leg) => facts.positions.find((p) => p.symbol === leg.symbol)?.margin_mode !== 'CROSS')) return false;
    // LCM of decimal lot sizes gives a quantity both venues can represent exactly.
    const scale = Math.max(...constraints.map((c) => new Decimal(c.lot_size).decimalPlaces()));
    const factor = new Decimal(10).pow(scale);
    const a = BigInt(new Decimal(constraints[0].lot_size).mul(factor).toFixed(0));
    const b = BigInt(new Decimal(constraints[1].lot_size).mul(factor).toFixed(0));
    let x = a, y = b; while (y !== 0n) { const remainder = x % y; x = y; y = remainder; }
    const lot = new Decimal((a / x * b).toString()).div(factor).toString();
    const limits = legs.map((leg) => this.db.prepare('SELECT max_market_size FROM crossex_instruments WHERE symbol = ?').get(leg.symbol) as { max_market_size: string | null });
    const max = Decimal.min(...limits.map((l) => l.max_market_size ?? state.leftQuantity!)).toString();
    const quantity = this.db.transaction(() => {
      const proposed = this.marginMonitor!.planBatch({ ...record, management: state }, facts.positions,
        this.protection.isEvaluating(record.id) ? this.protection.records() : this.active(), lot, max);
      if (!proposed) return null;
      for (const leg of legs) this.requireSize(leg, new Decimal(proposed));
      const batch = this.marginMonitor!.preparedBatch(record.id);
      this.save(record.id, { ...state, marginBatch: batch }); return proposed;
    })();
    if (!quantity) return false;
    await this.submit(record, readManagedState(this.db, record.id)!.marginBatch!.firstLeg!, new Decimal(quantity), false, 'paired-first-leg', 'adjustment'); return true;
  }

  private completeMarginBatch(record: StrategyRecord, state: ManagedState, quantities: [string, string]): void {
    const batch = state.marginBatch!, evidence = marginBatchFills(this.db, record.id, batch);
    if (!evidence.terminal || evidence.rows.some(r => !r.remoteAt)) throw new Error('margin_settlement_evidence_missing');
    const remoteAfter = Decimal.max(...evidence.rows.map(r => r.remoteAt!)).toString();
    this.db.transaction(() => {
      this.save(record.id, { ...state, marginBatch: null, phase: 'MONITORING' });
      this.marginMonitor?.batchComplete(record.id, quantities[0], remoteAfter,
        Object.fromEntries(managedLegs(record.config).map((l, i) => [l.symbol, quantities[i]])));
    })();
  }

  private async settlePending(record: StrategyRecord, state: ManagedState): Promise<boolean> {
    if (!state.pendingOrderId) return false;
    const order = this.runtime.getOrder(state.pendingOrderId);
    if (!isTerminalOrderState(order.state)) {
      if (this.now() - Date.parse(order.createdAt) > 5000) throw new Error('managed_order_unresolved');
      await this.bounded(this.runtime.refreshOrderFromRemote(order.id), 'managed_order_unresolved'); return true;
    }
    if (new Decimal(order.executedQuantity).lte(0)) throw new Error('managed_reduction_failed');
    this.save(record.id, { ...state, pendingOrderId: null, after: this.now() });
    return true; // require a new position snapshot after terminal fill evidence
  }
  private constraints(symbol: string): { lot_size: string; min_size: string; min_notional: string | null; tick_size: string } {
    const row = this.db.prepare('SELECT lot_size, min_size, min_notional, tick_size FROM crossex_instruments WHERE symbol = ?').get(symbol) as { lot_size: string; min_size: string; min_notional: string | null; tick_size: string } | undefined;
    if (!row || !managedConstraintsValid(row) || !Number.isFinite(Number(row.tick_size)) || Number(row.tick_size) <= 0) {
      throw new TradingRuntimeError('managed_constraints_unavailable', 409, JSON.stringify({ symbol }));
    }
    return row;
  }
  private async balance(record: StrategyRecord, state: ManagedState, quantities: [string, string]): Promise<void> {
    const legs = managedLegs(record.config), constraints = legs.map((l) => this.constraints(l.symbol));
    const plan = reductionPlan(...quantities, constraints[0].lot_size, constraints[1].lot_size)!;
    // A confirmed partial maker fill is immediately matched on the opposite leg. Only cancel
    // first when an external change requires trimming the same leg as the resting maker.
    if (state.makerOrderId && plan.leg === record.config.management!.makerLeg
      && !(await this.cancelMaker(record, state))) return;
    const index = plan.leg === 'left' ? 0 : 1;
    const exact = new Decimal(quantities[0]).minus(quantities[1]).abs();
    if (state.exitRequested && !state.marginBatch && !state.protectionIncident
      && (!new Decimal(plan.quantity).eq(exact) || this.sizeIssue(legs[index], exact))) {
      if (state.makerOrderId && !isTerminalOrderState(this.runtime.getOrder(state.makerOrderId).state)) {
        this.save(record.id, { ...state, reason: 'managed_pairing_below_minimum' }); return;
      }
      throw new Error('managed_partial_untradeable');
    }
    if ((state.marginBatch || state.protectionIncident) && !new Decimal(plan.quantity).eq(exact)) throw new Error('margin_partial_untradeable');
    // Enlarge only the reduction (never the position) if an exact trim is below venue minimums.
    if (state.marginBatch && new Decimal(plan.quantity).gt(state.marginBatch.quantity)) throw new Error('margin_batch_quantity_exceeded');
    if (state.marginBatch && this.sizeIssue(legs[index], new Decimal(plan.quantity))) throw new Error('margin_partial_untradeable');
    if (state.protectionIncident) this.requireSize(legs[index], exact);
    const quantity = state.marginBatch || state.protectionIncident || state.exitRequested ? new Decimal(plan.quantity)
      : this.reductionQuantity(legs[index], new Decimal(plan.quantity), new Decimal(quantities[index]));
    this.save(record.id, { ...readManagedState(this.db, record.id)!, phase: 'BALANCING', conditionSince: null });
    await this.submit(record, index, quantity, false, 'existing-imbalance', (state.exitRequested || state.phase === 'EXITING') && !state.marginBatch ? 'exit' : 'adjustment');
  }
  private sizeIssue(leg: ManagedLeg, quantity: Decimal): ManagedSizeIssue | null {
    return managedOrderSizeIssue(leg, quantity, this.constraints(leg.symbol), this.markets.market(leg.symbol), this.now());
  }
  private sizeFailure(issue: ManagedSizeIssue): TradingRuntimeError {
    return new TradingRuntimeError(issue.code, isManagedQuantityIssue(issue) ? 400 : 409, JSON.stringify(issue));
  }
  private requireSize(leg: ManagedLeg, quantity: Decimal, limitPrice?: string): void {
    const issue = this.sizeIssue(leg, quantity);
    if (issue) throw this.sizeFailure(issue);
    if (limitPrice !== undefined) {
      const minimum = new Decimal(this.constraints(leg.symbol).min_notional ?? '0');
      const notional = quantity.mul(limitPrice);
      if (notional.lt(minimum)) throw this.sizeFailure({ code: 'managed_order_below_minimum_notional',
        symbol: leg.symbol, quantity: quantity.toString(), minimum: minimum.toString(), notional: notional.toString() });
    }
  }
  private reductionQuantity(leg: ManagedLeg, requested: Decimal, available: Decimal): Decimal {
    const issue = this.sizeIssue(leg, requested);
    if (!issue) return requested;
    if (!isManagedQuantityIssue(issue)) throw this.sizeFailure(issue);
    this.requireSize(leg, available);
    return available;
  }
  private observe(record: StrategyRecord, state: ManagedState, legs: ManagedLeg[], signalOnly = false): void {
    const quotes = legs.map((l) => this.markets.market(l.symbol)), funding = legs.map((l) => this.sources.funding(l.symbol));
    const signal =
      managedExitSignal(record.config.management!, legs, quotes, funding, state, this.now());
    const { spread, apr, signalReason, signalMissingSince, fundingCheckedAt } = signal;
    const eligible = !signalOnly || state.phase !== 'OPENING' || entryHoldings(this.db, record.id).some(q => new Decimal(q).gt(0));
    const conditionSince = eligible ? signal.conditionSince : null, trigger = eligible && signal.trigger;
    if (signalReason !== (state.signalReason ?? null)) this.log(record.id, signalReason ? 'Exit signal unavailable' : 'Exit signal recovered',
      JSON.stringify({ reason: signalReason, quotes: legs.map((leg, i) => ({ symbol: leg.symbol,
        updatedAt: quotes[i]?.updatedAt ?? null, receivedAt: quotes[i]?.receivedAt ?? null,
        source: quotes[i]?.source ?? null, unavailableReason: quoteUnavailableReason(quotes[i] ?? undefined, this.now()) })) }));
    if (signalReason !== (state.signalReason ?? null)) {
      const startedAt = state.signalMissingSince ?? signalMissingSince ?? this.now();
      this.db.prepare('INSERT INTO audit_events (id,created_at,type,correlation_id,payload_json) VALUES (?,?,?,?,?)')
        .run(randomUUID(), new Date(this.now()).toISOString(), signalReason ? 'managed_signal_unavailable' : 'managed_signal_recovered',
          `signal:${record.id}:${startedAt}`, JSON.stringify({ strategyId: record.id, asset: record.config.asset, startedAt,
            endedAt: signalReason ? null : this.now(), reason: signalReason, sources: quotes.map(q => q?.source ?? null) }));
    }
    const latest = readManagedState(this.db, record.id)!;
    const preservePhase = signalOnly;
    this.save(record.id, { ...latest, phase: preservePhase ? latest.phase : state.phase === 'OPENING' ? 'OPENING' : trigger ? 'EXITING' : 'MONITORING', spreadBps: spread, fundingAprPct: apr,
      fundingCheckedAt,
      conditionSince, exitRequested: trigger, signalReason, signalMissingSince,
      reason: signalOnly ? latest.reason : trigger ? 'threshold_exit' : signalReason });
    if (trigger && !latest.exitRequested) this.log(record.id, 'Exit condition confirmed', `${spread} bps / ${apr}% APR; exit is latched`);
  }
  private async cancelMaker(record: StrategyRecord, state: ManagedState, authorize?: () => boolean): Promise<boolean> {
    if (!state.makerOrderId) return true;
    const order = this.runtime.getOrder(state.makerOrderId);
    if (!isTerminalOrderState(order.state)) {
      const cancelRequestedAt = state.cancelRequestedAt ?? this.now();
      this.save(record.id, { ...state, cancelRequestedAt });
      if (this.now() - cancelRequestedAt > 5000) throw new Error('managed_cancel_unresolved');
      if (order.state === 'PENDING_CANCEL') await this.bounded(this.runtime.refreshOrderFromRemote(order.id), 'managed_cancel_unresolved');
      else await this.bounded(this.runtime.cancelOrder(order.id, () => { if (authorize && !authorize()) throw new TradingRuntimeError('managed_review_changed', 409); }), 'managed_cancel_unresolved');
      return false;
    }
    this.save(record.id, { ...state, makerOrderId: null, makerStartedAt: null, cancelRequestedAt: null, after: this.now() });
    return false; // cancel/fill race: never use the pre-cancel position snapshot
  }
  private async exit(record: StrategyRecord, state: ManagedState, quantities: [string, string]): Promise<void> {
    const config = record.config.management!;
    if (state.makerOrderId) {
      const order = this.runtime.getOrder(state.makerOrderId);
      if (isTerminalOrderState(order.state)) { await this.cancelMaker(record, state); return; }
      if (this.now() - (state.makerStartedAt ?? this.now()) >= config.makerWaitSeconds * 1000) {
        this.save(record.id, { ...state, fallback: config.marketFallback });
        await this.cancelMaker(record, readManagedState(this.db, record.id)!);
      } else await this.bounded(this.runtime.refreshOrderFromRemote(order.id), 'managed_order_unresolved');
      return;
    }
    if (this.now() < state.nextBatchAt) return;
    const legs = managedLegs(record.config), index = config.makerLeg === 'left' ? 0 : 1, leg = legs[index];
    const missing = legs.find((item) => !freshManagedQuote(this.markets.market(item.symbol), this.now()));
    if (missing) {
      this.save(record.id, { ...state, reason: `managed_exit_quote_unavailable:${missing.symbol}` });
      return;
    }
    if (state.reason?.startsWith('managed_exit_quote_unavailable:')) this.save(record.id, { ...state, reason: 'exit_in_progress' });
    const lot = this.constraints(leg.symbol).lot_size;
    const planned = Decimal.min(config.perOrderQuantity, quantities[index]).div(lot).floor().mul(lot);
    let quantity = this.reductionQuantity(leg, planned, new Decimal(quantities[index]));
    const remainder = new Decimal(quantities[index]).minus(quantity);
    if (remainder.gt(0) && !this.reductionQuantity(leg, remainder, new Decimal(quantities[index])).eq(remainder)) {
      quantity = new Decimal(quantities[index]);
    }
    await this.submit(record, index, quantity, !state.fallback, 'paired-first-leg');
  }
  private async submit(record: StrategyRecord, index: number, quantity: Decimal, maker: boolean,
    purpose: 'paired-first-leg' | 'existing-imbalance', feePhase: 'exit' | 'adjustment' = purpose === 'existing-imbalance' ? 'adjustment' : 'exit'): Promise<void> {
    const protecting = this.protection.isEvaluating(record.id);
    if (!protecting && (!this.session.liveTradingEnabled || managedRiskReason(this.db))) return;
    if (purpose === 'paired-first-leg' && this.fastPairing.has(record.id)) return;
    const control = this.controlEpoch, context = this.readContext();
    const leg = managedLegs(record.config)[index], side = opposite(leg.side);
    const quote = this.markets.market(leg.symbol);
    if (!freshManagedQuote(quote, this.now())) throw this.sizeFailure({ code: 'managed_market_data_unavailable',
      symbol: leg.symbol, quantity: quantity.toString() });
    const tick = this.constraints(leg.symbol).tick_size;
    const batch = readManagedState(this.db, record.id)?.marginBatch;
    const quotePrice = side === 'BUY' ? quote!.bidPrice : quote!.askPrice;
    const price = !maker ? undefined : isHyperliquidFuture(leg.symbol)
      ? hyperliquidLimitPrice(quotePrice, tick, side)
      : new Decimal(quotePrice).div(tick).toDecimalPlaces(0, side === 'BUY' ? Decimal.ROUND_FLOOR : Decimal.ROUND_CEIL).mul(tick).toString();
    const pairing = (excludeOrderId?: string): boolean => purpose === 'existing-imbalance' && !batch
      && confirmedExitQuantity(this.db, this.runtime.getStrategy(record.id), readManagedState(this.db, record.id),
        this.sources.activeAccount(), managedLegs(record.config), index, quantity, excludeOrderId);
    const wasPairing = pairing();
    const authorize = (excludeOrderId?: string): void => {
        const latestRecord = this.runtime.getStrategy(record.id), latestState = readManagedState(this.db, record.id);
        if (control !== this.controlEpoch || context !== this.readContext() || (!protecting && !this.session.liveTradingEnabled)
          || (!protecting && latestRecord.status !== 'RUNNING') || latestRecord.accountProfileId !== this.sources.activeAccount()
          || latestState?.stopIntent === 'KEEP')
          throw new TradingRuntimeError('managed_review_changed', 409);
        if (batch) {
          assertMarginSubmission(this.db, record.id, batch, index, quantity, excludeOrderId);
          if (purpose === 'paired-first-leg') this.marginMonitor!.assertFirstLeg(record.id, batch.id!);
        }
        const required = purpose === 'paired-first-leg' ? managedLegs(record.config) : [leg];
        for (const item of required) if (!freshManagedQuote(this.markets.market(item.symbol), this.now())) {
          throw this.sizeFailure({ code: 'managed_market_data_unavailable', symbol: item.symbol, quantity: quantity.toString() });
        }
        this.requireSize(leg, quantity, isHyperliquidFuture(leg.symbol) ? price : undefined);
        if (wasPairing && (!pairing(excludeOrderId)
          || this.marginMonitor && (!this.marginMonitor.snapshot().fresh || !!this.marginMonitor.snapshot().incidentId)))
          throw new TradingRuntimeError('managed_pairing_evidence_changed', 409);
    };
    if (!protecting) this.revision += 1;
    const protectionPermit = protecting ? this.protection.permit(record, index, quantity,
      { symbol: leg.symbol, side, type: 'MARKET', quantity: quantity.toString(), reduceOnly: true }) : undefined;
    const order = await this.bounded(this.runtime.createOrder({ symbol: leg.symbol, side, type: maker ? 'LIMIT' : 'MARKET',
      timeInForce: maker ? 'POC' : 'IOC', quantity: quantity.toString(), reduceOnly: true, ...(price ? { price } : {}) },
    { feePhase, strategyId: record.id, strategyLeg: index === 0 ? 'left' : 'right', strategyClip: batch?.id ? `margin:${batch.id}` : `managed-${this.now()}`,
      ...(protectionPermit ? { protectionPermit } : {}),
      confirmedPairing: pairing, beforeSubmit: () => authorize(), beforeDispatch: authorize }), 'managed_submission_unknown');
    const state = readManagedState(this.db, record.id)!;
    this.save(record.id, { ...state, phase: maker ? 'EXITING' : 'BALANCING',
      ...(maker ? { makerOrderId: order.id, makerStartedAt: this.now() } : { pendingOrderId: order.id }),
      nextBatchAt: this.now() + record.config.management!.intervalSeconds * 1000, after: this.now() });
    this.log(record.id, maker ? 'Exit maker submitted' : 'Protective reduction submitted', `${side} ${quantity} ${leg.symbol}; reduce-only`);
  }
  private complete(record: StrategyRecord, state: ManagedState): void {
    this.adoption.abortOwner(record.id);
    this.db.transaction(() => {
      writeManagedState(this.db, record.id, { ...state, phase: 'COMPLETED', reason: 'positions_flat', conditionSince: null,
        signalReason: null, signalMissingSince: null });
      this.db.prepare('DELETE FROM managed_position_claims WHERE strategy_id = ?').run(record.id);
      this.db.prepare("UPDATE execution_strategies SET status = 'COMPLETED', open_position = '0', progress = 100, stopped_at = ?, updated_at = ? WHERE id = ?")
        .run(new Date().toISOString(), new Date().toISOString(), record.id);
    })();
    this.log(record.id, 'Managed task completed', 'Fresh account positions zero; all task orders terminal');
    this.runtime.emitStrategyUpdate(this.runtime.getStrategy(record.id));
  }
}
