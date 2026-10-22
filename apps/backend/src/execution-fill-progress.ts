import type Database from 'better-sqlite3';
import { Decimal } from 'decimal.js';

/** Trade and order streams are alternative cumulative evidence, never additive quantities. */
export function advanceOrderFromFills(db: Database.Database, id: string): boolean {
  const order = db.prepare('SELECT quantity,executed_quantity,state,updated_at FROM execution_orders WHERE id=?').get(id) as {
    quantity: string; executed_quantity: string; state: string; updated_at: string } | undefined;
  if (!order) return false;
  const fills = db.prepare('SELECT quantity,price,created_at FROM execution_fills WHERE order_id=?').all(id) as Array<{
    quantity: string; price: string; created_at: string }>;
  const quantity = fills.reduce((sum, fill) => sum.plus(fill.quantity), new Decimal(0));
  if (!quantity.gt(order.executed_quantity)) return false;
  const amount = fills.reduce((sum, fill) => sum.plus(new Decimal(fill.quantity).mul(fill.price)), new Decimal(0));
  const open = ['PENDING_SUBMIT', 'NEW', 'OPEN', 'PARTIALLY_FILLED'].includes(order.state);
  const state = open ? quantity.eq(order.quantity) ? 'FILLED' : 'PARTIALLY_FILLED' : order.state;
  const at = new Date(Math.max(Date.parse(order.updated_at), ...fills.map(f => Date.parse(f.created_at)))).toISOString();
  db.prepare('UPDATE execution_orders SET executed_quantity=?,executed_average_price=?,state=?,updated_at=? WHERE id=?')
    .run(quantity.toString(), amount.div(quantity).toString(), state, at, id);
  return true;
}
