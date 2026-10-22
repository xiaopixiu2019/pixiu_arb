import { Decimal } from 'decimal.js';
import type { MarginMetrics, MarginSnapshot } from '@gate-crossex/shared-types';
import type { GateCrossExOrder, GateCrossExPosition } from './crossex-client.js';
import type { MarginServiceOptions } from './margin-risk-service.js';
import { GATE_FUTURE_CLOSE_MARGIN_RATE, MARGIN_FX_STRESS_BPS } from './margin-reduction-evidence.js';
import { acceptedEntryPending, entryCosts, entryLegUsage, entryOrders, readEntryBudget, type PairedEntryBudget } from './paired-entry-ledger.js';
import { freshManagedQuote } from './managed-position-model.js';
import { readManagedState } from './managed-position-store.js';
import { settledEntryFees } from './paired-entry-fees.js';

export type PairedPoolCost = { initial: Decimal; maintenance: Decimal; venue: string;
  creditedInitial?: Decimal; creditedMaintenance?: Decimal };
type Cost = PairedPoolCost;
type Asset = MarginMetrics['assets'][number];
type Lease = { owner: string; account: string; context: string; mode: string; pool: string;
  symbols: string[]; venue: string; fx: string; fxAt: number; balance: string };
const number = (value: unknown): Decimal | null => typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value)
  && new Decimal(value).isFinite() ? new Decimal(value) : null;

/** Same mapping already used by account reduction: USDT may be held in the shared CrossEx pool. */
function matches(symbol: string, asset: Pick<Asset, 'venue' | 'coin'>, mode: string): boolean {
  const [venue, product, , coin] = symbol.split('_');
  return product === 'FUTURE' && coin === asset.coin && (venue === asset.venue
    || mode === 'CROSS_EXCHANGE' && coin === 'USDT' && asset.venue === 'CROSSEX');
}
function touchesPool(symbol: string, asset: Pick<Asset, 'venue' | 'coin'>, mode: string): boolean {
  const [venue, , base, quote] = symbol.split('_');
  return (base === asset.coin || quote === asset.coin) && (venue === asset.venue
    || mode === 'CROSS_EXCHANGE' && asset.venue === 'CROSSEX' && ['GATE', 'BINANCE', 'BYBIT', 'OKX'].includes(venue));
}
function metricsFor(snapshot: MarginSnapshot, venue: string): MarginMetrics | null {
  return snapshot.metrics?.accountMode === 'CROSS_EXCHANGE' ? snapshot.metrics
    : snapshot.units?.find(unit => unit.exchangeType === venue)?.metrics ?? null;
}
function assetFor(metrics: MarginMetrics, pool: string): Asset | null {
  const rows = metrics.assets.filter(asset => `${asset.venue}:${asset.coin}` === pool);
  return rows.length === 1 && [rows[0].futuresInitialMargin, rows[0].futuresMaintenanceMargin,
    rows[0].borrowingInitialMargin, rows[0].borrowingMaintenanceMargin, rows[0].liability].every(v => number(v) !== null)
    ? rows[0] : null;
}

/** Ephemeral attribution, never a release of the durable task's capital responsibility. */
export class PairedEntryPool {
  private readonly leases = new Map<string, Lease>();
  private connected = false;
  private epoch = 0;
  private readonly provisional = new Map<string, { epoch: number; leases: Array<[string, Lease]> }>();
  constructor(private readonly o: MarginServiceOptions, private readonly user: () => string | null) {}
  get generation(): number { return this.epoch; }
  get enabled(): boolean { return this.connected; }
  invalidate(): void { this.epoch += 1; this.leases.clear(); this.provisional.clear(); }
  stream(live: boolean): void { if (!live || !this.connected) this.invalidate(); this.connected = live; }
  discard(id: string): void { for (const [key, lease] of this.leases) if (lease.owner === id) this.leases.delete(key); }
  abort(id: string): void {
    this.discard(id); const previous = this.provisional.get(id); this.provisional.delete(id);
    if (this.connected && previous?.epoch === this.epoch) for (const [key, lease] of previous.leases)
      if (!this.leases.has(key) && lease.context === this.o.context()) this.leases.set(key, lease);
    this.prune();
  }
  private prune(): void {
    for (const [key, lease] of this.leases) {
      const budget = readEntryBudget(this.o.db, lease.owner);
      const state = readManagedState(this.o.db, lease.owner);
      if (!budget || budget.released || state && state.phase !== 'OPENING') this.leases.delete(key);
    }
  }

  conflicts(id?: string, symbols: string[] = [], venue?: string): Set<string> {
    this.prune();
    const result = new Set<string>();
    for (const [key, lease] of this.leases) {
      if (lease.owner === id || readEntryBudget(this.o.db, lease.owner)?.released) continue;
      const [poolVenue, coin] = lease.pool.split(':');
      if (venue && (venue === lease.venue || poolVenue === 'CROSSEX' && ['BINANCE', 'OKX', 'GATE', 'BYBIT'].includes(venue))
        || symbols.some(symbol => matches(symbol, { venue: poolVenue, coin }, lease.mode)))
        result.add(key);
    }
    return result;
  }
  commit(id?: string, symbols: string[] = [], venue?: string): void {
    // New responsibility invalidates every older provisional rollback, even if no lease is currently visible.
    this.provisional.clear();
    const revoked: Array<[string, Lease]> = [];
    for (const key of this.conflicts(id, symbols, venue)) { revoked.push([key, this.leases.get(key)!]); this.leases.delete(key); }
    if (id && revoked.length) this.provisional.set(id, { epoch: this.epoch, leases: revoked });
  }

  prepare(id: string, budget: PairedEntryBudget, snapshot: MarginSnapshot,
    facts: { positions: GateCrossExPosition[]; openOrders: GateCrossExOrder[] } | null,
    rates: Record<string, string>, at: number, generation: number, ordinary: Cost[], allowNew = true): void {
    this.prune();
    if (!this.connected || !facts || !snapshot.fresh || !snapshot.accountId) return;
    for (const leg of budget.legs) {
      const venue = leg.symbol.split('_')[0], metrics = metricsFor(snapshot, venue);
      if (!metrics) continue;
      const assets = metrics.assets.filter(asset => matches(leg.symbol, asset, metrics.accountMode));
      if (assets.length !== 1) continue;
      const pool = `${assets[0].venue}:${assets[0].coin}`, key = `${snapshot.accountId}:${pool}`;
      const retained = this.leases.get(key);
      if (retained?.owner === id && retained.context === this.o.context()) {
        if (!this.ownedFacts(retained, facts)) {
          this.invalidate(); this.o.manager.failAll('paired_entry_external_responsibility'); return;
        }
        const fx = this.fx(assets[0].coin, rates);
        if (fx) this.leases.set(key, { ...retained, fx, fxAt: at });
        else this.leases.delete(key);
        continue;
      }
      const asset = assetFor(metrics, pool), fx = this.fx(assets[0].coin, rates);
      if (!allowNew || generation !== this.epoch || !asset || !fx || !this.empty(asset, facts, metrics.accountMode)
        || asset.balance === undefined || !/^-?\d+(?:\.\d+)?$/.test(asset.balance)
        || entryOrders(this.o.db, id).some(order => matches(order.symbol, asset, metrics.accountMode)
          && (!new Decimal(order.executed_quantity).isZero() || !['FAIL', 'REJECT', 'CANCELLED'].includes(order.state)))
        || ordinary.some(cost => cost.venue === venue || asset.venue === 'CROSSEX')
        || !this.soleOwner(id, snapshot.accountId, asset, metrics.accountMode)) continue;
      this.leases.set(key, { owner: id, account: snapshot.accountId, context: this.o.context(), mode: metrics.accountMode,
        pool, venue, balance: asset.balance, symbols: budget.legs.filter(l => matches(l.symbol, asset, metrics.accountMode)).map(l => l.symbol), fx, fxAt: at });
    }
  }

  private ownedFacts(lease: Lease, facts: { positions: GateCrossExPosition[]; openOrders: GateCrossExOrder[] }): boolean {
    const [venue, coin] = lease.pool.split(':'), orders = entryOrders(this.o.db, lease.owner);
    const budget = readEntryBudget(this.o.db, lease.owner)!;
    return facts.positions.filter(p => matches(p.symbol, { venue, coin }, lease.mode) && !new Decimal(p.position_qty).isZero()).every(p => {
      const leg = budget.legs.find(l => l.symbol === p.symbol);
      if (!leg) return false;
      const qty = new Decimal(p.position_qty), side = p.position_side === 'SHORT' ? 'SELL' : p.position_side === 'LONG' ? 'BUY' : qty.gt(0) ? 'BUY' : 'SELL';
      return side === leg.side && qty.abs().lte(entryLegUsage(leg, orders).filled.plus(acceptedEntryPending(leg, budget.legs.indexOf(leg), orders)));
    }) && facts.openOrders.filter(order => touchesPool(order.symbol, { venue, coin }, lease.mode)).every(order =>
      orders.some(local => local.remote_order_id === order.order_id && local.client_order_id === (order.text ?? order.client_order_id)
        && local.symbol === order.symbol && local.side === order.side && new Decimal(local.quantity).eq(order.qty)));
  }

  private fx(coin: string, rates: Record<string, string>): string | null {
    if (coin === 'USDT') return '1';
    const rate = number(rates[coin]);
    // Reuse the existing FX safety allowance; never grant parity credit without an actual quote.
    return rate?.gt(0) && rate.minus(1).abs().lte(new Decimal(MARGIN_FX_STRESS_BPS).div(10000))
      ? Decimal.min(rate, 1).mul(new Decimal(1).minus(new Decimal(MARGIN_FX_STRESS_BPS).div(10000))).toString() : null;
  }
  private empty(asset: Asset, facts: { positions: GateCrossExPosition[]; openOrders: GateCrossExOrder[] }, mode: string): boolean {
    return [asset.futuresInitialMargin, asset.futuresMaintenanceMargin, asset.borrowingInitialMargin,
      asset.borrowingMaintenanceMargin, asset.liability].every(value => number(value)?.isZero())
      && !facts.positions.some(p => matches(p.symbol, asset, mode) && !new Decimal(p.position_qty).isZero())
      && !facts.openOrders.some(order => touchesPool(order.symbol, asset, mode));
  }
  private soleOwner(id: string, account: string, asset: Asset, mode: string): boolean {
    const rows = this.o.db.prepare('SELECT strategy_id FROM paired_entry_reservations WHERE account_id=?').all(account) as Array<{ strategy_id: string }>;
    return rows.every(row => row.strategy_id === id || (() => {
      const other = readEntryBudget(this.o.db, row.strategy_id)!;
      return other.released || !other.legs.some(leg => matches(leg.symbol, asset, mode));
    })());
  }

  costs(id: string, budget: PairedEntryBudget, snapshot: MarginSnapshot, excludeOrder?: string,
    suppressed = new Set<string>()): { symbols: Set<string>; costs: Cost[] } {
    this.prune();
    const result = { symbols: new Set<string>(), costs: [] as Cost[] };
    if (!this.connected || !snapshot.fresh || snapshot.entryBlocked || snapshot.incidentId) return result;
    for (const [key, lease] of this.leases) {
      if (suppressed.has(key)) continue;
      if (lease.owner !== id || lease.account !== snapshot.accountId || lease.context !== this.o.context()
        || Date.now() - lease.fxAt > 10000 || Date.now() < lease.fxAt) continue;
      const metrics = metricsFor(snapshot, lease.venue), asset = metrics && assetFor(metrics, lease.pool);
      if (!metrics || metrics.accountMode !== lease.mode || !asset || !this.soleOwner(id, lease.account, asset, lease.mode)) continue;
      const cost = this.poolCost(lease, budget, asset, metrics.remoteUpdatedAt, excludeOrder);
      if (!cost) continue;
      result.costs.push(cost); for (const symbol of lease.symbols) result.symbols.add(symbol);
    }
    return result;
  }

  private feeAllowance(lease: Lease): Decimal {
    const budget = readEntryBudget(this.o.db, lease.owner);
    return (budget?.legs ?? []).filter(leg => lease.symbols.includes(leg.symbol))
      .reduce((sum, leg) => sum.plus(new Decimal(leg.target).mul(leg.price).mul('0.003')), new Decimal(0));
  }
  private poolCost(lease: Lease, budget: PairedEntryBudget, asset: Asset, remoteAt: string, excludeOrder?: string): Cost | null {
    const orders = entryOrders(this.o.db, lease.owner).filter(order => order.id !== excludeOrder);
    if (orders.some(order => lease.symbols.includes(order.symbol) && (order.reduce_only
      || order.failure_reason?.includes('_UNKNOWN')
      || !['NEW', 'OPEN', 'PARTIALLY_FILLED', 'PENDING_CANCEL', 'FILLED', 'CANCELLED', 'FAIL', 'REJECT'].includes(order.state)
      || !order.remote_order_id && (!new Decimal(order.executed_quantity).isZero() || !['FAIL', 'REJECT', 'CANCELLED'].includes(order.state))))) return null;
    let initial = new Decimal(0), maintenance = new Decimal(0), confirmedInitial = new Decimal(0), confirmedMaintenance = new Decimal(0);
    for (const leg of budget.legs.filter(l => lease.symbols.includes(l.symbol))) {
      const quote = this.o.markets.market(leg.symbol);
      if (!freshManagedQuote(quote, Date.now())) return null;
      const required = entryCosts(leg.target, quote!.askPrice, leg.leverage, leg.maintenanceRate);
      if (required.initial.gt(leg.initialBudget)) return null;
      initial = initial.plus(leg.initialBudget); maintenance = maintenance.plus(required.maintenance);
      const usage = entryLegUsage(leg, orders), filled = usage.filled, value = filled.mul(quote!.askPrice);
      // Accepted live quantity may already freeze order IM. Filled quantity may still have that older freeze in the official response.
      // Cancelled unfilled quantity is excluded; this monetary ceiling never authorizes an unconfirmed hedge quantity.
      confirmedInitial = confirmedInitial.plus(filled.plus(acceptedEntryPending(leg, budget.legs.indexOf(leg), orders)).mul(quote!.askPrice)
        .mul(new Decimal(1).div(leg.leverage).plus(new Decimal(GATE_FUTURE_CLOSE_MARGIN_RATE).mul(2))));
      confirmedMaintenance = confirmedMaintenance.plus(value.mul(new Decimal(leg.maintenanceRate).plus(GATE_FUTURE_CLOSE_MARGIN_RATE)));
    }
    // Full R minus current C. Do not subtract covered here; it is already part of R.
    const creditedInitial = Decimal.min(confirmedInitial, asset.futuresInitialMargin!).mul(lease.fx);
    const creditedMaintenance = Decimal.min(confirmedMaintenance, asset.futuresMaintenanceMargin!).mul(lease.fx);
    const fees = settledEntryFees(this.o.db, this.o.profile()?.id, this.user(), lease.owner, lease.symbols,
      lease.pool, lease.balance, asset.balance, remoteAt);
    if (fees.gt(this.feeAllowance(lease))) throw new Error('paired_entry_fee_budget_exceeded');
    const consumed = fees.mul(lease.fx);
    return { initial: Decimal.max(0, initial.minus(creditedInitial).minus(consumed)), maintenance: Decimal.max(0, maintenance.minus(creditedMaintenance).minus(consumed)),
      creditedInitial, creditedMaintenance, venue: lease.venue };
  }

  event(event: { channel: string; payload: Record<string, unknown> }): void {
    this.epoch += 1; this.prune();
    if (!this.connected) return;
    const p = event.payload;
    if (!this.leases.size) return;
    // Asset pushes wake the existing official monitor; they are not complete account snapshots or evidence renewals.
    if (event.channel === 'asset') return;
    if (!['order', 'usertrades', 'position', 'margin_position'].includes(event.channel)) return;
    const order = this.o.db.prepare(`SELECT id,strategy_id,symbol FROM execution_orders WHERE remote_order_id=? OR client_order_id=? LIMIT 1`)
      .get(String(p.order_id ?? ''), String(p.text ?? p.client_order_id ?? '')) as { id: string; strategy_id: string | null; symbol: string } | undefined;
    const symbol = typeof p.symbol === 'string' ? p.symbol : order?.symbol;
    for (const lease of this.leases.values()) {
      const [venue, coin] = lease.pool.split(':');
      if (symbol && !touchesPool(symbol, { venue, coin }, lease.mode)) continue;
      if (['order', 'usertrades'].includes(event.channel) && order?.strategy_id === lease.owner && symbol === order.symbol) {
        continue;
      }
      if (event.channel === 'position') {
        const position = this.explainedPosition(lease, p);
        if (position === 'confirmed') continue;
        if (position === 'pending') return;
      }
      this.invalidate(); this.o.manager.failAll('paired_entry_external_responsibility'); return;
    }
  }
  private explainedPosition(lease: Lease, p: Record<string, unknown>): 'confirmed' | 'pending' | null {
    const budget = readEntryBudget(this.o.db, lease.owner), leg = budget?.legs.find(l => l.symbol === p.symbol);
    if (!leg || typeof p.position_qty !== 'string') return null;
    const qty = new Decimal(p.position_qty), side = p.position_side === 'SHORT' ? 'SELL' : p.position_side === 'LONG' ? 'BUY' : qty.gt(0) ? 'BUY' : 'SELL';
    if (!qty.isZero() && side !== leg.side) return null;
    const orders = entryOrders(this.o.db, lease.owner), usage = entryLegUsage(leg, orders);
    return qty.abs().eq(usage.filled) ? 'confirmed' : qty.abs().gt(usage.filled)
      && qty.abs().lte(usage.filled.plus(acceptedEntryPending(leg, budget!.legs.indexOf(leg), orders))) ? 'pending' : null;
  }
}
