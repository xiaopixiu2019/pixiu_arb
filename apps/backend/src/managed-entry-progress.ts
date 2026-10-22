import type Database from 'better-sqlite3';
import { Decimal } from 'decimal.js';
import type { StrategyRecord, TradingRuntime } from './trading-runtime.js';
import { managedLegs } from './managed-position-manager.js';
import { ownsManagedExecution } from './managed-execution-proof.js';
import { entryHoldings } from './managed-position-adoption.js';
import { acceptedEntryPending, entryOrders } from './paired-entry-ledger.js';
import { MANAGED_RECOVERY_WINDOW_MS, managedRiskReason, readManagedState } from './managed-position-store.js';

/** A position can precede its order fill. This remembers the discrepancy, never an executable fill. */
export class ManagedEntryProgress {
  private readonly pending = new Map<string, { account: string; firstAt: number; quantities: Map<number, Decimal> }>();
  constructor(private readonly db: Database.Database, private readonly runtime: TradingRuntime,
    private readonly account: () => string | null, private readonly now: () => number) {}
  clear(): void { this.pending.clear(); }
  has(id: string): boolean { return this.pending.has(id); }
  deadline(): number | null {
    const values = [...this.pending.values()].map(value => value.firstAt + MANAGED_RECOVERY_WINDOW_MS);
    return values.length ? Math.min(...values) : null;
  }
  private bounds(record: StrategyRecord, requireReady = true): { baseline: Decimal[]; expected: Decimal[]; maximum: Decimal[] } | null {
    const state = readManagedState(this.db, record.id), legs = managedLegs(record.config);
    // `verified` denotes post-entry holdings. Launch authority is the committed adoption baseline plus both claims.
    if (state?.phase !== 'OPENING' || !state.adoptedAt || state.adoptedLeft === undefined || state.adoptedRight === undefined
      || state.exitRequested || state.stopIntent || managedRiskReason(this.db)
      || record.config.executionMethod !== 'MAKER_TAKER' || requireReady && !this.runtime.pairedEntryReady(record.id)
      || !ownsManagedExecution(this.db, record, state, this.account(), legs)) return null;
    const expected = entryHoldings(this.db, record.id).map(q => new Decimal(q));
    const baseline = [state.adoptedLeft ?? '0', state.adoptedRight ?? '0'].map(q => new Decimal(q));
    const orders = entryOrders(this.db, record.id);
    const maximum = legs.map((leg, index) => expected[index].plus(acceptedEntryPending(leg, index, orders)));
    if (maximum.some((q, i) => q.gt(baseline[i].plus(record.config.totalAmount!)))) throw new Error('managed_entry_progress_invalid');
    return { baseline, expected, maximum };
  }
  position(payload: Record<string, unknown>): boolean {
    if (typeof payload.symbol !== 'string' || typeof payload.position_qty !== 'string') return false;
    const claim = this.db.prepare('SELECT strategy_id FROM managed_position_claims WHERE symbol=? AND account_id=?')
      .get(payload.symbol, this.account()) as { strategy_id: string } | undefined;
    if (!claim) return false;
    const record = this.runtime.getStrategy(claim.strategy_id), legs = managedLegs(record.config), index = legs.findIndex(leg => leg.symbol === payload.symbol);
    const quantity = new Decimal(payload.position_qty);
    if (!quantity.isFinite() || index < 0) return false;
    const side = payload.position_side === 'SHORT' ? 'SELL' : payload.position_side === 'LONG' ? 'BUY' : quantity.gt(0) ? 'BUY' : 'SELL';
    if (!quantity.isZero() && side !== legs[index].side) return false;
    const bounds = this.bounds(record); if (!bounds) return false;
    return this.mark(record, index, quantity.abs(), bounds);
  }
  facts(record: StrategyRecord, quantities: [string, string]): boolean {
    const bounds = this.bounds(record); if (!bounds) return false;
    const values = quantities.map(q => new Decimal(q));
    // A lower REST snapshot cannot clear a newer position observation waiting for a fill.
    if (values.some((q, i) => !q.isFinite() || q.lt(bounds.baseline[i]) || q.gt(bounds.maximum[i]))) {
      if (this.has(record.id)) throw new Error('managed_entry_progress_unexplained');
      return false;
    }
    values.forEach((q, i) => this.mark(record, i, q, bounds));
    return this.has(record.id);
  }
  private mark(record: StrategyRecord, index: number, quantity: Decimal, bounds: { expected: Decimal[]; maximum: Decimal[] }): boolean {
    if (!quantity.gt(bounds.expected[index]) || quantity.gt(bounds.maximum[index])) return false;
    const previous = this.pending.get(record.id), quantities = new Map(previous?.quantities);
    quantities.set(index, Decimal.max(quantity, quantities.get(index) ?? 0));
    this.pending.set(record.id, { account: record.accountProfileId!, firstAt: previous?.firstAt ?? this.now(), quantities });
    return true;
  }
  confirm(): void {
    for (const [id, progress] of this.pending) {
      if (this.now() >= progress.firstAt + MANAGED_RECOVERY_WINDOW_MS) throw new Error('managed_entry_progress_expired');
      const record = this.runtime.getStrategy(id), state = readManagedState(this.db, id);
      if (record.status !== 'RUNNING' || state?.phase !== 'OPENING' || progress.account !== this.account()) { this.pending.delete(id); continue; }
      const expected = entryHoldings(this.db, id).map(q => new Decimal(q));
      const remaining = new Map([...progress.quantities].filter(([index, q]) => expected[index].lt(q)));
      if (!remaining.size) { this.pending.delete(id); continue; }
      const bounds = this.bounds(record, false);
      if (bounds && [...remaining].some(([index, q]) => q.gt(bounds.maximum[index]))) throw new Error('managed_entry_progress_unconfirmed');
      this.pending.set(id, { ...progress, quantities: remaining });
    }
  }
}
