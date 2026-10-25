import { Decimal } from 'decimal.js';
import type { MarginServiceOptions } from './margin-risk-service.js';
import type { MarginEntryCheck, MarginRiskMonitor } from './margin-risk-monitor.js';
import type { MarginSnapshot } from '@gate-crossex/shared-types';
import type { GateCrossExOrder, GateCrossExPosition, TradingCrossExGateway } from './crossex-client.js';
import { readCrossMarginEvidence } from './cross-margin-admission.js';
import { freshManagedQuote, pairedQuantities } from './managed-position-model.js';
import { managedLegs } from './managed-position-manager.js';
import { managedRiskReason, readManagedState } from './managed-position-store.js';
import { TradingRuntimeError, type CreateStrategyInput, type PlaceOrderMetadata } from './trading-runtime.js';
import { coverEntryBudget, entryConfigHash, entryCosts, entryLegUsage, entryOrders, readEntryBudget, saveEntryBudget,
  type PairedEntryBudget } from './paired-entry-ledger.js';
import { PairedEntryPool, type PairedPoolCost } from './paired-entry-pool.js';

export interface PairedOrderInput { symbol: string; side: 'BUY' | 'SELL'; quantity: string; price?: string;
  type: 'MARKET' | 'LIMIT'; timeInForce: string; reduceOnly: boolean }
export interface PairedEntryController {
  prepare(id: string, config: CreateStrategyInput, account: string | null): Promise<void>;
  assertOrder(input: PairedOrderInput, metadata: PlaceOrderMetadata, excludeOrder?: string): boolean;
  ready(id: string): boolean;
  makerReady?(id: string): boolean;
  invalidate(): void;
  assertCapitalMutation(): void;
  stop(): Promise<void>;
  abortPreparation(id: string): void;
  stream?(live: boolean): void;
  event?(event: { channel: string; payload: Record<string, unknown> }): void;
}
const eligible = (c: CreateStrategyInput) => c.kind === 'position' && c.executionMethod === 'MAKER_TAKER' && !!c.management && !c.reduceOnly;
const fail = (reason: string): never => { throw new TradingRuntimeError(reason, 409); };

/** Durable task commitments; HTTP preparation happens before a maker, never on its hedge path. */
export class PairedEntryAdmission implements PairedEntryController {
  private tail: Promise<unknown> = Promise.resolve();
  private stopped = false;
  private readonly pending = new Set<string>();
  private readonly certificates = new Map<string, { context: string; hash: string; at: number }>();
  private ordinary: () => Array<{ initial: Decimal; maintenance: Decimal; venue: string }> = () => [];
  private facts: { positions: GateCrossExPosition[]; openOrders: GateCrossExOrder[]; at: number; context: string } | null = null;
  private readonly pools: PairedEntryPool;
  constructor(private readonly o: MarginServiceOptions, private readonly monitor: MarginRiskMonitor, user: () => string | null = () => null) {
    this.pools = new PairedEntryPool(o, user);
  }
  setOrdinaryReservations(read: typeof this.ordinary): void { this.ordinary = read; }
  invalidate(): void { this.certificates.clear(); this.pools.invalidate(); }
  stream(live: boolean): void { this.pools.stream(live); }
  event(event: { channel: string; payload: Record<string, unknown> }): void {
    try { this.pools.event(event); }
    catch { this.pools.invalidate(); this.o.manager.failAll('paired_entry_event_unverified'); }
  }
  async stop(): Promise<void> { this.stopped = true; this.invalidate(); await this.tail; }
  abortPreparation(id: string): void {
    if (this.o.db.prepare('SELECT 1 FROM execution_strategies WHERE id=?').get(id) || entryOrders(this.o.db, id).length) return;
    this.o.db.prepare('DELETE FROM paired_entry_reservations WHERE strategy_id=?').run(id); this.certificates.delete(id); this.pools.abort(id);
  }
  assertCapitalMutation(): void {
    const account = this.monitor.snapshot().accountId;
    if (!account) {
      if (this.o.db.prepare(`SELECT 1 FROM paired_entry_reservations WHERE COALESCE(
        CASE WHEN json_valid(payload_json) THEN json_type(payload_json,'$.released') END, 'missing') != 'true' LIMIT 1`).get())
        fail('paired_entry_account_unavailable');
      return;
    }
    const rows = this.o.db.prepare('SELECT strategy_id FROM paired_entry_reservations WHERE account_id=?').all(account) as Array<{ strategy_id: string }>;
    if (rows.some(row => {
      const budget = readEntryBudget(this.o.db, row.strategy_id)!;
      return !budget.released && budget.legs.some(leg => entryLegUsage(leg, entryOrders(this.o.db, row.strategy_id)).outstanding.gt(0));
    })) fail('paired_entry_funds_committed');
  }
  ready(id: string): boolean {
    return this.certificateReady(id) && this.monitor.snapshot().fresh;
  }
  private readyFromSnapshot(id: string, snapshot: MarginSnapshot): boolean {
    return this.certificateReady(id) && snapshot.fresh;
  }
  private certificateReady(id: string): boolean {
    const c = this.certificates.get(id);
    return !this.stopped && !!c && c.context === this.o.context() && Date.now() - c.at < 10_000;
  }
  makerReady(id: string): boolean { return this.ready(id) && !this.o.manager.entryProgressPending?.(id); }
  observe(positions: GateCrossExPosition[], openOrders: GateCrossExOrder[]): void {
    this.facts = { positions, openOrders, at: Date.now(), context: this.o.context() };
    this.reconcile();
  }
  refreshActive(): void {
    if (this.stopped || !this.o.live()) return;
    for (const record of this.o.runtime.listStrategies()) {
      if (!eligible(record.config) || record.status !== 'RUNNING' || record.management?.phase !== 'OPENING'
        || !readEntryBudget(this.o.db, record.id) || this.pending.has(record.id)) continue;
      if (Date.now() - (this.certificates.get(record.id)?.at ?? 0) < 4000) continue;
      void this.prepare(record.id, record.config, record.accountProfileId).catch(() => { this.certificates.delete(record.id); });
    }
    this.reconcile();
  }
  prepare(id: string, config: CreateStrategyInput, account: string | null): Promise<void> {
    if (!eligible(config)) return Promise.resolve();
    if (this.stopped) return Promise.reject(new TradingRuntimeError('paired_entry_stopped', 409));
    if (this.ready(id) && this.certificates.get(id)?.hash === entryConfigHash(config)
      && Date.now() - this.certificates.get(id)!.at < 4000) return Promise.resolve();
    this.pending.add(id);
    const work = this.tail.then(() => this.prepareOnce(id, config, account)).finally(() => { this.pending.delete(id); });
    this.tail = work.catch(() => undefined); return work;
  }
  private async prepareOnce(id: string, config: CreateStrategyInput, account: string | null): Promise<void> {
    const context = this.o.context(), legs = managedLegs(config), preparedAt = Date.now(), generation = this.pools.generation;
    if (this.stopped || !account || account !== this.o.profile()?.id || !this.o.live()) fail('paired_entry_account_changed');
    await this.monitor.refresh();
    const credentials = await this.o.credentials(), gateway = this.o.gateway as TradingCrossExGateway;
    if (!credentials) fail('paired_entry_account_changed');
    const proofEnabled = this.pools.enabled && !!this.monitor.snapshot().metrics?.assets.length;
    const factsRead = proofEnabled && gateway.queryManagedState
      ? gateway.queryManagedState(credentials!, AbortSignal.timeout(4000))
      : gateway.queryPositions(credentials!).then(positions => ({ positions, openOrders: null }));
    const [cross, limits, leverages, facts, rates] = await Promise.all([
      readCrossMarginEvidence(gateway, credentials!, legs.map(l => l.symbol), AbortSignal.timeout(4000)),
      gateway.queryRiskLimits(legs.map(l => l.symbol)),
      Promise.all(legs.map(l => gateway.queryLeverages(credentials!, [l.symbol]))), factsRead,
      proofEnabled ? gateway.queryValuationRates?.([...new Set(legs.map(l => l.symbol.split('_').at(-1)!))], AbortSignal.timeout(4000))
        .catch(() => ({})) ?? {} : {},
    ]);
    if (this.stopped || context !== this.o.context() || !this.o.live() || account !== this.o.profile()?.id) fail('paired_entry_account_changed');
    const snapshot = this.monitor.snapshot();
    if (!snapshot.fresh || !snapshot.accountId || snapshot.entryBlocked || snapshot.incidentId) fail('paired_entry_account_unavailable');
    const old = readEntryBudget(this.o.db, id), baseline = pairedQuantities(facts.positions, legs);
    const prepared = legs.map((leg, index) => {
      const leverage = index === 0 ? config.leftLeverage : config.rightLeverage;
      if (cross[index].reason || !new Decimal(leverages[index][leg.symbol] ?? '0').eq(leverage)) fail('paired_entry_parameters_changed');
      const rates = limits.find(l => l.symbol === leg.symbol)?.tiers.map(t => t.maintenance_rate);
      if (!rates?.length) fail('margin_estimate_unavailable');
      const quote = this.o.markets.market(leg.symbol);
      if (!freshManagedQuote(quote, Date.now())) fail('margin_quote_unavailable');
      const price = quote!.askPrice, rate = Decimal.max(...rates!).toString();
      if (old && (old.legs[index].leverage !== leverage || old.legs[index].maintenanceRate !== rate)) fail('paired_entry_parameters_changed');
      return old?.legs[index] ?? { ...leg, target: config.totalAmount!, leverage, maintenanceRate: rate, price,
        initialBudget: entryCosts(config.totalAmount!, price, leverage, rate, true).initial.toString(), baseline: baseline[index], covered: {} };
    });
    const budget: PairedEntryBudget = { accountUser: snapshot.accountId!, released: false, legs: [prepared[0], prepared[1]] };
    if (Date.now() - preparedAt >= 10_000) fail('paired_entry_preparation_unavailable');
    const poolFacts = facts.openOrders ? { positions: facts.positions, openOrders: facts.openOrders } : null;
    this.pools.prepare(id, budget, snapshot, poolFacts, rates, preparedAt, generation, this.ordinary(), false);
    if (!this.o.live() || context !== this.o.context()) fail('paired_entry_authority_changed');
    this.o.db.transaction(() => {
      this.assertIdentity(id, config, snapshot.accountId!);
      this.assertFunds(budget, id);
      saveEntryBudget(this.o.db, id, snapshot.accountId!, config, budget);
      if (!old || old.released) this.pools.commit(id, budget.legs.map(leg => leg.symbol));
      this.pools.prepare(id, budget, snapshot, poolFacts, rates, preparedAt, generation, this.ordinary());
    })();
    this.certificates.set(id, { context, hash: entryConfigHash(config), at: preparedAt });
  }
  private assertIdentity(id: string, config: CreateStrategyInput, account: string): void {
    const row = this.o.db.prepare('SELECT account_id,config_hash FROM paired_entry_reservations WHERE strategy_id=?').get(id) as { account_id: string; config_hash: string } | undefined;
    if (row && (row.account_id !== account || row.config_hash !== entryConfigHash(config))) fail('paired_entry_approval_changed');
  }
  assertOrder(input: PairedOrderInput, metadata: PlaceOrderMetadata, excludeOrder?: string): boolean {
    try { return this.checkOrder(input, metadata, excludeOrder); }
    catch (error) {
      if (error instanceof TradingRuntimeError) throw error;
      return fail(error instanceof Error && /^(paired_entry_|margin_)/.test(error.message) ? error.message : 'paired_entry_evidence_unverified');
    }
  }
  private checkOrder(input: PairedOrderInput, metadata: PlaceOrderMetadata, excludeOrder?: string): boolean {
    if (!metadata.strategyId || input.reduceOnly) return false;
    const record = this.o.runtime.getStrategy(metadata.strategyId);
    if (!eligible(record.config)) return false;
    return this.monitor.withEntrySnapshot(check => this.checkPreparedOrder(input, metadata, record, check, excludeOrder));
  }
  private checkPreparedOrder(input: PairedOrderInput, metadata: PlaceOrderMetadata,
    record: ReturnType<MarginServiceOptions['runtime']['getStrategy']>, check: MarginEntryCheck, excludeOrder?: string): boolean {
    const id = record.id, state = readManagedState(this.o.db, id), budget = readEntryBudget(this.o.db, id);
    if (!budget || budget.released || !this.readyFromSnapshot(id, check.snapshot)) fail('paired_entry_preparation_unavailable');
    if (!this.o.live() || record.status !== 'RUNNING' || record.accountProfileId !== this.o.profile()?.id
      || state?.phase !== 'OPENING' || state.stopIntent || state.exitRequested || state.marginBatch || state.protectionIncident
      || managedRiskReason(this.o.db)) fail('paired_entry_authority_changed');
    this.assertIdentity(id, record.config, check.snapshot.accountId!);
    const index = budget!.legs.findIndex(l => l.symbol === input.symbol && l.side === input.side);
    if (index < 0 || metadata.strategyLeg !== (index === 0 ? 'left' : 'right')) fail('paired_entry_order_changed');
    const rows = entryOrders(this.o.db, id).filter(o => o.id !== excludeOrder);
    const usages = budget!.legs.map(l => entryLegUsage(l, rows)), quantity = new Decimal(input.quantity);
    if (quantity.plus(usages[index].filled).plus(usages[index].pending).gt(budget!.legs[index].target)) fail('paired_entry_quantity_exceeded');
    const maker = record.config.makerLeg === (index === 0 ? 'left' : 'right');
    if (maker && this.o.manager.entryProgressPending?.(id)) fail('managed_account_rechecking');
    if (maker ? input.type !== 'LIMIT' || input.timeInForce !== 'POC'
      : input.type !== 'MARKET' || input.timeInForce !== 'IOC'
        || quantity.gt(usages[1 - index].filled.minus(usages[index].filled).minus(usages[index].pending))) fail('paired_entry_unconfirmed_hedge');
    if (maker) this.assertFundsWithCheck(check, budget!, id);
    else this.assertHedgeFunds(check, id, index, input.quantity, excludeOrder);
    if (!this.readyFromSnapshot(id, check.snapshot)) fail('paired_entry_preparation_unavailable');
    if (!freshManagedQuote(this.o.markets.market(input.symbol), Date.now())) fail('paired_entry_market_unavailable');
    return true;
  }
  private assertHedgeFunds(check: MarginEntryCheck, id: string, index: number, quantity: string, excludeOrder?: string): void {
    const snapshot = check.snapshot, budget = readEntryBudget(this.o.db, id)!;
    if (!snapshot.fresh || !snapshot.accountId || snapshot.entryBlocked || snapshot.incidentId) fail('paired_entry_account_unavailable');
    const costs = [...this.ordinary()];
    this.currentCost(budget.legs[index], quantity);
    let taskBudgetConsumed = false;
    const rows = this.o.db.prepare('SELECT strategy_id FROM paired_entry_reservations WHERE account_id=?').all(snapshot.accountId) as Array<{ strategy_id: string }>;
    for (const row of rows) {
      const held = readEntryBudget(this.o.db, row.strategy_id)!;
      if (held.released) continue;
      const commitment = this.pools.costs(row.strategy_id, held, snapshot, excludeOrder);
      costs.push(...commitment.costs);
      if (row.strategy_id === id && commitment.symbols.has(budget.legs[index].symbol)) taskBudgetConsumed = true;
      const orders = entryOrders(this.o.db, row.strategy_id).filter(o => o.id !== excludeOrder);
      for (const leg of held.legs) {
        if (commitment.symbols.has(leg.symbol)) continue;
        const usage = entryLegUsage(leg, orders), pending = Decimal.max(0, usage.filled.plus(usage.pending).minus(usage.covered));
        if (pending.gt(0)) costs.push({ ...this.currentCost(leg, pending.toString()), venue: leg.symbol.split('_')[0] });
      }
    }
    const leg = budget.legs[index];
    if (!taskBudgetConsumed) costs.push({ ...this.currentCost(leg, quantity), venue: leg.symbol.split('_')[0] });
    this.checkCosts(costs, check);
  }
  private currentCost(leg: PairedEntryBudget['legs'][number], quantity: string) {
    const quote = this.o.markets.market(leg.symbol);
    if (!freshManagedQuote(quote, Date.now())) fail('paired_entry_market_unavailable');
    const cost = entryCosts(quantity, quote!.askPrice, leg.leverage, leg.maintenanceRate);
    if (cost.initial.gt(new Decimal(leg.initialBudget).mul(quantity).div(leg.target))) fail('paired_entry_budget_exceeded');
    return cost;
  }
  private checkCosts(costs: PairedPoolCost[], check: MarginEntryCheck): void {
    const snapshot = check.snapshot;
    const venues = snapshot.metrics?.accountMode === 'CROSS_EXCHANGE' ? [undefined] : [...new Set(costs.map(c => c.venue))];
    for (const venue of venues) {
      const unit = costs.filter(c => !venue || c.venue === venue);
      const initial = unit.reduce((s, c) => s.plus(c.initial), new Decimal(0));
      const metrics = venue ? snapshot.units?.find(u => u.exchangeType === venue)?.metrics : snapshot.metrics;
      if (metrics && (unit.reduce((sum, cost) => sum.plus(cost.creditedInitial ?? 0), new Decimal(0)).gt(metrics.initialMargin)
        || unit.reduce((sum, cost) => sum.plus(cost.creditedMaintenance ?? 0), new Decimal(0)).gt(metrics.maintenanceMargin)))
        fail('paired_entry_pool_components_inconsistent');
      if (!metrics || !new Decimal(metrics.availableMargin).isFinite() || new Decimal(metrics.availableMargin).lt(initial))
        fail('margin_available_insufficient');
      try {
        check.assertEntry(initial.toString(),
          unit.reduce((s, c) => s.plus(c.maintenance), new Decimal(0)).toString(), venue);
      } catch (error) { fail(error instanceof Error ? error.message : 'margin_estimate_unavailable'); }
    }
  }
  assertFunds(candidate?: PairedEntryBudget, exclude?: string, extraInitial = new Decimal(0), extraMaintenance = new Decimal(0), extraVenue?: string): void {
    this.monitor.withEntrySnapshot(check => this.assertFundsWithCheck(check, candidate, exclude, extraInitial, extraMaintenance, extraVenue));
  }
  private assertFundsWithCheck(check: MarginEntryCheck, candidate?: PairedEntryBudget, exclude?: string,
    extraInitial = new Decimal(0), extraMaintenance = new Decimal(0), extraVenue?: string): void {
    const snapshot = check.snapshot;
    if (!snapshot.fresh || !snapshot.accountId || snapshot.entryBlocked || snapshot.incidentId) fail('paired_entry_account_unavailable');
    const suppressed = this.pools.conflicts(exclude, candidate?.legs.map(leg => leg.symbol), extraVenue);
    const rows = this.o.db.prepare('SELECT strategy_id,payload_json FROM paired_entry_reservations WHERE account_id=?').all(snapshot.accountId) as Array<{ strategy_id: string; payload_json: string }>;
    const entries = rows.filter(r => r.strategy_id !== exclude).map(r => ({ id: r.strategy_id, budget: readEntryBudget(this.o.db, r.strategy_id)! }));
    if (candidate) entries.push({ id: exclude!, budget: candidate });
    const costs: Array<{ initial: Decimal; maintenance: Decimal; venue: string }> = [...this.ordinary()];
    for (const { id, budget } of entries) this.appendCosts(costs, id, budget, snapshot, suppressed);
    if (extraVenue) costs.push({ initial: extraInitial, maintenance: extraMaintenance, venue: extraVenue });
    this.checkCosts(costs, check);
  }
  commitOrdinaryAdmission(venue: string): void { this.pools.commit(undefined, [], venue); }
  private appendCosts(costs: Array<{ initial: Decimal; maintenance: Decimal; venue: string }>, id: string, budget: PairedEntryBudget,
    snapshot: MarginSnapshot, suppressed?: Set<string>): void {
    if (budget.released) return;
    const orders = entryOrders(this.o.db, id);
    const commitment = this.pools.costs(id, budget, snapshot, undefined, suppressed);
    costs.push(...commitment.costs);
    for (const leg of budget.legs) {
      if (commitment.symbols.has(leg.symbol)) continue;
      const quote = this.o.markets.market(leg.symbol), usage = entryLegUsage(leg, orders);
      if (usage.outstanding.isZero()) continue;
      const price = freshManagedQuote(quote, Date.now()) ? quote!.askPrice : leg.price;
      const required = entryCosts(leg.target, price, leg.leverage, leg.maintenanceRate);
      if (required.initial.gt(leg.initialBudget)) fail('paired_entry_budget_exceeded');
      costs.push({ initial: new Decimal(leg.initialBudget).mul(usage.outstanding).div(leg.target),
        maintenance: entryCosts(usage.outstanding.toString(), price, leg.leverage, leg.maintenanceRate).maintenance,
        venue: leg.symbol.split('_')[0] });
    }
  }
  private reconcile(): void {
    const facts = this.facts;
    if (!facts || facts.context !== this.o.context() || Date.now() - facts.at > 5000) return;
    const rows = (this.o.db.prepare('SELECT strategy_id,account_id FROM paired_entry_reservations').all() as Array<{ strategy_id: string; account_id:string }>)
      .filter(row => {
        try { return readEntryBudget(this.o.db,row.strategy_id)?.released !== true; }
        catch { return true; } // Only a validated released commitment may be skipped; current-account corruption still fails below.
      });
    if (!rows.length) return;
    const snapshot = this.monitor.snapshot();
    if (!snapshot.fresh || !snapshot.accountId) return;
    for (const { strategy_id: id } of rows.filter(r=>r.account_id===snapshot.accountId)) {
      const record = this.o.runtime.listStrategies().find(r => r.id === id);
      if (!record) continue;
      const orders = entryOrders(this.o.db, id), last = Math.max(0, ...orders.map(o => Date.parse(o.updated_at)));
      if (!Number.isFinite(last) || facts.at <= last || (snapshot.sampledAt ?? 0) <= last) continue;
      const budget = readEntryBudget(this.o.db, id)!;
      let quantities: [string, string];
      try { quantities = pairedQuantities(facts.positions, managedLegs(record.config)); } catch { continue; }
      if (!this.coverageReady(budget, orders, quantities, snapshot)) continue;
      if (this.canRelease(record.id, orders, budget, quantities, facts.openOrders)) {
        const covered = budget.legs.map(leg => ({ ...leg, covered: Object.fromEntries(orders
          .filter(o => o.symbol === leg.symbol && !o.reduce_only && o.side === leg.side).map(o => [o.id, o.executed_quantity])) }));
        saveEntryBudget(this.o.db, id, snapshot.accountId, record.config, { ...budget, released: true, legs: [covered[0], covered[1]] });
        this.certificates.delete(id); this.pools.discard(id); continue;
      }
      const covered = coverEntryBudget(budget, orders, budget.legs.map((l, i) => ({ symbol: l.symbol, quantity: quantities[i] })),
        facts.openOrders.map(o => ({ orderId: o.order_id, clientOrderId: o.text ?? '', symbol: o.symbol, side: o.side, quantity: o.qty, executed: o.executed_qty })));
      if (covered) saveEntryBudget(this.o.db, id, snapshot.accountId, record.config, covered);
    }
  }
  private coverageReady(budget: PairedEntryBudget, orders: ReturnType<typeof entryOrders>, quantities: [string, string], snapshot: MarginSnapshot): boolean {
    return budget.legs.every((leg, index) => {
      const metrics = snapshot.metrics?.accountMode === 'CROSS_EXCHANGE' ? snapshot.metrics
        : snapshot.units?.find(unit => unit.exchangeType === leg.symbol.split('_')[0])?.metrics;
      const last = Math.max(0, ...orders.filter(order => order.symbol === leg.symbol).map(order => Date.parse(order.updated_at)));
      const remoteAt = Number(metrics?.remoteUpdatedAt);
      return !!metrics && Number.isFinite(remoteAt) && Number.isFinite(last) && remoteAt >= last
        && remoteAt <= Date.now() + 2000 && (new Decimal(quantities[index]).isZero() || new Decimal(metrics.initialMargin).gt(0));
    });
  }
  private canRelease(id: string, orders: ReturnType<typeof entryOrders>, budget: PairedEntryBudget,
    quantities: [string, string], openOrders: GateCrossExOrder[]): boolean {
    const record = this.o.runtime.getStrategy(id), state = readManagedState(this.o.db, id);
    if (record.status === 'RUNNING' && state?.phase === 'OPENING') return false;
    if (orders.some(o => !['FILLED', 'CANCELLED', 'FAIL', 'REJECT'].includes(o.state))
      || openOrders.some(o => budget.legs.some(l => l.symbol === o.symbol))) return false;
    return budget.legs.every((leg, index) => {
      const expected = orders.filter(o => o.symbol === leg.symbol).reduce((n, o) => n.plus(
        new Decimal(o.executed_quantity).mul(o.side === leg.side ? 1 : -1)), new Decimal(leg.baseline));
      return expected.gte(0) && expected.eq(quantities[index]);
    });
  }
}
