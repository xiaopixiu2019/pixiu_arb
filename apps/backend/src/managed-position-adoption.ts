import type Database from 'better-sqlite3';
import { Decimal } from 'decimal.js';
import type { GateCrossExPosition } from './crossex-client.js';
import { TradingRuntimeError, type TradingRuntime, type CreateStrategyInput } from './trading-runtime.js';
import { initialManagedState, readManagedState, writeManagedState, type ManagedState } from './managed-position-store.js';
import { pairedQuantities, type ManagedLeg } from './managed-position-model.js';
import type { ManagedAccountFacts } from './managed-position-manager.js';

interface Reservation { account: string; legs: [ManagedLeg, ManagedLeg]; donor: string | null; state?: ManagedState }
const reject = (code: string): never => { throw new TradingRuntimeError(code, 409); };

/** CrossEx positions and order qty use the same base-asset unit as the paired executor.
 * Each task uses exact native contracts, not portfolio display groups or USD notionals. */
export function entryHoldings(db: Database.Database, id: string): [string, string] {
  const state = readManagedState(db, id)!;
  const rows = db.prepare('SELECT strategy_leg leg, executed_quantity quantity, reduce_only FROM execution_orders WHERE strategy_id = ?')
    .all(id) as Array<{ leg: string; quantity: string; reduce_only: number }>;
  // The strategy ledger is kept for legacy fixtures and persisted old tasks without order rows.
  const record = db.prepare('SELECT filled_left, filled_right FROM execution_strategies WHERE id = ?').get(id) as { filled_left: string; filled_right: string };
  return ['left', 'right'].map((leg, i) => {
    const fills = rows.length ? rows.filter((r) => r.leg === leg).reduce((sum, r) =>
      r.reduce_only ? sum.minus(r.quantity) : sum.plus(r.quantity), new Decimal(0))
      : new Decimal(i === 0 ? record.filled_left : record.filled_right);
    return new Decimal(i === 0 ? state.adoptedLeft ?? '0' : state.adoptedRight ?? '0').plus(fills).toString();
  }) as [string, string];
}

function baseline(positions: GateCrossExPosition[], legs: ManagedLeg[]) {
  return legs.map((leg) => {
    const position = positions.find((p) => p.symbol === leg.symbol && !new Decimal(p.position_qty).isZero());
    return { symbol: leg.symbol, quantity: position?.position_qty ?? '0',
      entryPrice: position?.entry_price ?? null, unrealizedPnl: position?.upnl ?? null };
  });
}

export class ManagedAdoption {
  private readonly pending = new Map<string, Reservation>();
  constructor(private readonly db: Database.Database, private readonly runtime: TradingRuntime,
    private readonly legsFor: (config: CreateStrategyInput) => [ManagedLeg, ManagedLeg]) {
    // A process cannot resume an uncommitted launch. Original owners remain intact.
    db.prepare('DELETE FROM managed_position_reservations').run();
  }

  reserve(id: string, config: CreateStrategyInput, account: string): void {
    const legs = this.legsFor(config), adopt = config.management?.adoptExisting === true;
    const owners = new Set(legs.flatMap((leg) => (this.db.prepare('SELECT strategy_id FROM managed_position_claims WHERE symbol = ?')
      .all(leg.symbol) as Array<{ strategy_id: string }>).map((r) => r.strategy_id)));
    if (owners.size > 1 || owners.size && !adopt) reject('managed_position_owned');
    const donor = [...owners][0] ?? null;
    if (donor) this.validateDonor(donor, account, legs);
    const conflicts = this.runtime.listStrategies().some((s) => s.id !== donor && !['COMPLETED', 'STOPPED'].includes(s.status)
      && (s.config.closePlan?.targets ?? this.legsFor(s.config)).some((l) => legs.some((leg) => leg.symbol === l.symbol)));
    if (conflicts) reject('managed_position_owned');
    if (!adopt && this.runtime.listOpenOrders().some((o) => legs.some((l) => l.symbol === o.symbol))) reject('managed_position_owned');
    this.db.transaction(() => {
      for (const leg of legs) {
        if (this.db.prepare('SELECT 1 FROM managed_position_reservations WHERE symbol = ?').get(leg.symbol)) reject('managed_position_owned');
        this.db.prepare('INSERT INTO managed_position_reservations VALUES (?, ?, ?, ?)').run(leg.symbol, account, id, donor);
      }
    })();
    this.pending.set(id, { account, legs, donor });
  }

  private validateDonor(id: string, account: string, legs: ManagedLeg[]): void {
    const record = this.runtime.getStrategy(id), state = readManagedState(this.db, id);
    if (!state || record.accountProfileId !== account || state.exitRequested
      || !['MONITORING', 'STOPPED'].includes(state.phase) || !['RUNNING', 'STOPPED'].includes(record.status)) reject('managed_position_owned');
    const prior = this.legsFor(record.config);
    if (!legs.every((leg) => prior.some((old) => leg.symbol === old.symbol && leg.side === old.side))) reject('managed_group_direction_conflict');
    const count = this.db.prepare('SELECT count(*) n FROM managed_position_claims WHERE strategy_id = ?').get(id) as { n: number };
    if (count.n !== 2) reject('managed_position_owned');
  }

  orderIds(id: string, facts: ManagedAccountFacts): string[] {
    this.assertReservation(id);
    const pending = this.pending.get(id)!;
    const local = this.runtime.listOpenOrders().filter((o) => pending.legs.some((l) => l.symbol === o.symbol));
    const remote = facts.openOrders.filter((o) => pending.legs.some((l) => l.symbol === o.symbol));
    const matches = (r: typeof remote[number], l: typeof local[number]) => r.order_id === l.remoteOrderId || r.text === l.clientOrderId;
    if (remote.some((r) => !local.some((l) => matches(r, l)))) reject('managed_adoption_unknown_order');
    if (local.some((l) => l.state.startsWith('PENDING') || !remote.some((r) => matches(r, l)))) reject('managed_adoption_unknown_order');
    if (local.some((l) => l.strategyId && l.strategyId !== pending.donor
      && !['STOPPED', 'COMPLETED'].includes(this.runtime.getStrategy(l.strategyId).status))) reject('managed_position_owned');
    return local.map((o) => o.id);
  }

  capture(id: string, config: CreateStrategyInput, facts: ManagedAccountFacts): void {
    this.assertReservation(id);
    const pending = this.pending.get(id)!;
    if (pending.donor) this.validateDonor(pending.donor, pending.account, pending.legs);
    if (facts.openOrders.some((o) => pending.legs.some((l) => l.symbol === o.symbol))
      || this.runtime.listOpenOrders().some((o) => pending.legs.some((l) => l.symbol === o.symbol))) reject('managed_adoption_unresolved_orders');
    const quantities = pairedQuantities(facts.positions, pending.legs);
    if (!config.management?.adoptExisting && quantities.some((q) => new Decimal(q).gt(0))) reject('managed_existing_position');
    if (!new Decimal(quantities[0]).eq(quantities[1])) reject('managed_adoption_unbalanced');
    const donor = pending.donor ? readManagedState(this.db, pending.donor)! : null;
    if (donor && quantities.some((q, i) => new Decimal(q).gt(i === 0 ? donor.maxLeft : donor.maxRight))) reject('managed_position_increased');
    if (pending.state && quantities.some((q, i) => !new Decimal(q).eq(i === 0 ? pending.state!.adoptedLeft! : pending.state!.adoptedRight!)))
      reject('managed_adoption_changed');
    this.pending.set(id, { ...pending, state: { ...initialManagedState(), groupId: donor?.groupId ?? pending.donor ?? id,
      adoptedLeft: quantities[0], adoptedRight: quantities[1], adoptedAt: new Date().toISOString(),
      adoptionBaseline: baseline(facts.positions, pending.legs), leftQuantity: quantities[0], rightQuantity: quantities[1],
      maxLeft: quantities[0], maxRight: quantities[1], checkedAt: new Date().toISOString() } });
  }

  initialize(id: string, account: string): void {
    const pending = this.pending.get(id);
    if (!pending?.state || pending.account !== account) throw new TradingRuntimeError('managed_adoption_not_prepared', 409);
    this.db.transaction(() => {
      if (pending.donor) {
        this.validateDonor(pending.donor, account, pending.legs);
        const old = readManagedState(this.db, pending.donor)!;
        if (new Decimal(pending.state!.adoptedLeft!).gt(old.maxLeft) || new Decimal(pending.state!.adoptedRight!).gt(old.maxRight)) reject('managed_adoption_changed');
        writeManagedState(this.db, pending.donor, { ...old, phase: 'TRANSFERRED', transferredTo: id, conditionSince: null });
        this.db.prepare("UPDATE execution_strategies SET status = 'STOPPED', stopped_at = ?, updated_at = ? WHERE id = ?")
          .run(new Date().toISOString(), new Date().toISOString(), pending.donor);
      }
      this.db.prepare('INSERT INTO managed_positions VALUES (?, ?, ?, ?)')
        .run(id, account, JSON.stringify(pending.state), new Date().toISOString());
      for (const leg of pending.legs) this.db.prepare(`INSERT INTO managed_position_claims VALUES (?, ?, ?)
        ON CONFLICT(account_id, symbol) DO UPDATE SET strategy_id = excluded.strategy_id`).run(account, leg.symbol, id);
      this.db.prepare('DELETE FROM managed_position_reservations WHERE strategy_id = ?').run(id);
    })();
    this.pending.delete(id);
  }

  abort(id: string): void {
    this.db.prepare('DELETE FROM managed_position_reservations WHERE strategy_id = ?').run(id);
    this.pending.delete(id);
  }
  assertReservation(id: string): void {
    const rows = this.db.prepare('SELECT count(*) n FROM managed_position_reservations WHERE strategy_id = ?').get(id) as { n: number };
    if (!this.pending.has(id) || rows.n !== 2) reject('managed_adoption_interrupted');
  }
  abortOwner(owner: string): void {
    const rows = this.db.prepare('SELECT DISTINCT strategy_id FROM managed_position_reservations WHERE previous_owner = ?').all(owner) as Array<{ strategy_id: string }>;
    for (const row of rows) this.abort(row.strategy_id);
  }
  reservedOwner(id: string): boolean {
    return Boolean(this.db.prepare('SELECT 1 FROM managed_position_reservations WHERE previous_owner = ?').get(id));
  }
}
