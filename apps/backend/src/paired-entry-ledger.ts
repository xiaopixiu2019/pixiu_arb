import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { Decimal } from 'decimal.js';
import { z } from 'zod';
import type { CreateStrategyInput } from './trading-runtime.js';

const decimal = z.string().regex(/^\d+(?:\.\d+)?$/);
const legSchema = z.object({ symbol: z.string(), side: z.enum(['BUY', 'SELL']), target: decimal,
  leverage: decimal, maintenanceRate: decimal, price: decimal, initialBudget: decimal,
  baseline: decimal, covered: z.record(z.string(), decimal) });
export const PairedEntryBudgetSchema = z.object({ accountUser: z.string(), released: z.boolean().default(false), legs: z.tuple([legSchema, legSchema]) });
export type PairedEntryBudget = z.input<typeof PairedEntryBudgetSchema>;
export type PairedEntryLeg = PairedEntryBudget['legs'][number];
export interface EntryOrder {
  id: string; remote_order_id: string | null; client_order_id: string; symbol: string; side: string;
  quantity: string; executed_quantity: string; state: string; reduce_only: number; updated_at: string;
  failure_reason?: string | null;
  strategy_leg?: string | null;
}
const active = new Set(['PENDING_SUBMIT', 'PENDING_CANCEL', 'NEW', 'OPEN', 'PARTIALLY_FILLED']);
export const entryConfigHash = (config: CreateStrategyInput): string => createHash('sha256').update(JSON.stringify(config)).digest('hex');
export function entryCosts(quantity: string, price: string, leverage: string, maintenanceRate: string, padded = false) {
  const notional = new Decimal(quantity).mul(price), fees = notional.mul('0.003');
  return { initial: notional.div(leverage).plus(fees).mul(padded ? '1.10' : 1),
    maintenance: notional.mul(maintenanceRate).plus(fees) };
}
export function entryOrders(db: Database.Database, strategyId: string): EntryOrder[] {
  return db.prepare(`SELECT id,remote_order_id,client_order_id,symbol,side,quantity,executed_quantity,state,reduce_only,updated_at,failure_reason,strategy_leg
    FROM execution_orders WHERE strategy_id=?`).all(strategyId) as EntryOrder[];
}
export function acceptedEntryPending(leg: { symbol: string; side: string }, index: number, orders: EntryOrder[]): Decimal {
  return orders.filter(order => order.symbol === leg.symbol && order.side === leg.side && order.strategy_leg === (index === 0 ? 'left' : 'right')
    && !order.reduce_only && order.remote_order_id && !order.failure_reason
    && ['NEW', 'OPEN', 'PARTIALLY_FILLED', 'PENDING_CANCEL'].includes(order.state)).reduce((sum, order) => {
    const quantity = new Decimal(order.quantity), filled = new Decimal(order.executed_quantity);
    if (![quantity, filled].every(q => q.isFinite() && q.gte(0)) || filled.gt(quantity)) throw new Error('paired_entry_order_quantity_invalid');
    return sum.plus(quantity.minus(filled));
  }, new Decimal(0));
}
export function entryLegUsage(leg: PairedEntryLeg, orders: EntryOrder[]) {
  const rows = orders.filter(o => o.symbol === leg.symbol && !o.reduce_only && o.side === leg.side);
  const filled = rows.reduce((n, o) => n.plus(o.executed_quantity), new Decimal(0));
  const pending = rows.reduce((n, o) => n.plus(active.has(o.state) ? new Decimal(o.quantity).minus(o.executed_quantity) : 0), new Decimal(0));
  const covered = rows.reduce((n, o) => n.plus(Decimal.min(leg.covered[o.id] ?? '0',
    active.has(o.state) ? o.quantity : o.executed_quantity)), new Decimal(0));
  if (filled.plus(pending).gt(leg.target)) throw new Error('paired_entry_quantity_exceeded');
  return { filled, pending, covered, outstanding: Decimal.max(0, new Decimal(leg.target).minus(covered)) };
}
export function readEntryBudget(db: Database.Database, id: string): PairedEntryBudget | null {
  const row = db.prepare('SELECT payload_json FROM paired_entry_reservations WHERE strategy_id=?').get(id) as { payload_json: string } | undefined;
  return row ? PairedEntryBudgetSchema.parse(JSON.parse(row.payload_json)) : null;
}
export function saveEntryBudget(db: Database.Database, id: string, account: string, config: CreateStrategyInput, budget: PairedEntryBudget): void {
  const parsed = PairedEntryBudgetSchema.parse(budget), now = new Date().toISOString();
  db.prepare(`INSERT INTO paired_entry_reservations VALUES (?,?,?,?,?,?)
    ON CONFLICT(strategy_id) DO UPDATE SET payload_json=excluded.payload_json,updated_at=excluded.updated_at`)
    .run(id, account, entryConfigHash(config), JSON.stringify(parsed), now, now);
}

/** A new account timestamp alone is never coverage proof. Both positions and exact open orders must agree. */
export function coverEntryBudget(budget: PairedEntryBudget, orders: EntryOrder[], positions: Array<{ symbol: string; quantity: string }>,
  open: Array<{ orderId: string; clientOrderId: string; symbol: string; side: string; quantity: string; executed: string }>): PairedEntryBudget | null {
  if (orders.some(o => !['NEW', 'OPEN', 'PARTIALLY_FILLED', 'FILLED', 'CANCELLED', 'FAIL', 'REJECT'].includes(o.state))) return null;
  const legs = budget.legs.map(leg => {
    const rows = orders.filter(o => o.symbol === leg.symbol && !o.reduce_only && o.side === leg.side);
    const actual = positions.filter(p => p.symbol === leg.symbol);
    const expected = rows.reduce((n, o) => n.plus(o.executed_quantity), new Decimal(leg.baseline));
    if (actual.length > 1 || !new Decimal(actual[0]?.quantity ?? '0').eq(expected)) return null;
    const localOpen = rows.filter(o => active.has(o.state)), remoteOpen = open.filter(o => o.symbol === leg.symbol);
    if (localOpen.length !== remoteOpen.length || localOpen.some(o => !remoteOpen.some(r => r.orderId === o.remote_order_id
      && r.clientOrderId === o.client_order_id && r.side === o.side && new Decimal(r.quantity).eq(o.quantity)
      && new Decimal(r.executed).eq(o.executed_quantity)))) return null;
    return { ...leg, covered: Object.fromEntries(rows.map(o => [o.id, active.has(o.state) ? o.quantity : o.executed_quantity])) };
  });
  return legs[0] && legs[1] ? { ...budget, legs: [legs[0], legs[1]] } : null;
}
