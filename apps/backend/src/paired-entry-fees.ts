import { createHash } from 'node:crypto';
import { Decimal } from 'decimal.js';
import type Database from 'better-sqlite3';
import { resolveFeeBooks } from './transaction-fee-identity.js';
import { pendingFeeEvidence } from './transaction-fee-coverage.js';
import type { FeeBinding, FeeBookRow } from './transaction-fee-model.js';
import type { PendingFeeOrder, StoredFeeTrade } from './transaction-fee-store.js';
import { entryOrders } from './paired-entry-ledger.js';

/** Consume only canonical charges already reflected in the exact official cash pool. No HTTP. */
export function settledEntryFees(db: Database.Database, profile: string | undefined, user: string | null,
  owner: string, symbols: string[], pool: string, before: string, current: string | undefined, remoteAt: string): Decimal {
  const none = new Decimal(0);
  if (!profile || !user || current === undefined || !/^-?\d+(?:\.\d+)?$/.test(current)) return none;
  const outflow = new Decimal(before).minus(current); if (!outflow.gt(0)) return none;
  const key = createHash('sha256').update(`${profile}:${user}`).digest('hex');
  const epoch = db.prepare('SELECT profile_id,book_reason,trade_reason FROM fee_epochs WHERE account_key=?').get(key) as
    { profile_id: string; book_reason: string | null; trade_reason: string | null } | undefined;
  if (!epoch || epoch.profile_id !== profile || epoch.book_reason || epoch.trade_reason) return none;
  const orders = entryOrders(db, owner).filter(order => symbols.includes(order.symbol) && !order.reduce_only && new Decimal(order.executed_quantity).gt(0));
  if (!orders.length || orders.some(order => !order.remote_order_id || !['FILLED', 'CANCELLED', 'PARTIALLY_FILLED'].includes(order.state))) return none;
  const rows = db.prepare(`SELECT DISTINCT b.* FROM fee_book b JOIN execution_orders e ON e.remote_order_id=b.order_id
    WHERE b.account_key=? AND e.strategy_id=?`).all(key, owner) as FeeBookRow[];
  const trades = (db.prepare(`SELECT DISTINCT t.payload,t.conflict FROM fee_trades t JOIN execution_orders e
    ON e.remote_order_id=t.order_id AND e.venue=t.venue WHERE t.account_key=? AND e.strategy_id=?`).all(key, owner) as
    Array<{ payload: string; conflict: number }>).map(row => ({ ...JSON.parse(row.payload), conflict: row.conflict })) as StoredFeeTrade[];
  const bindings = db.prepare(`SELECT b.*,c.symbol,c.quantity,c.order_at FROM fee_order_bindings b LEFT JOIN fee_binding_coverage c
    ON c.account_key=b.account_key AND c.venue=b.venue AND c.order_id=b.order_id
    WHERE b.account_key=? AND b.task_id=?`).all(key, owner) as FeeBinding[];
  const selected = orders.map(order => ({ taskId: owner, venue: order.symbol.split('_')[0], orderId: order.remote_order_id!,
    quantity: order.executed_quantity, symbol: order.symbol, clientOrderId: order.client_order_id, at: Date.parse(order.updated_at) })) satisfies PendingFeeOrder[];
  const resolved = resolveFeeBooks(rows, bindings, trades).filter(row => selected.some(order => order.venue === row.venue && order.orderId === row.order_id));
  if (pendingFeeEvidence(resolved, trades, selected).length || resolved.some(row => row.conflict)) return none;
  const [venue, coin] = pool.split(':');
  const charged = resolved.filter(row => {
    const raw = JSON.parse(row.payload) as { exchange_type: string; coin: string };
    return raw.exchange_type === venue && raw.coin === coin;
  });
  if (!charged.length || charged.some(row => row.cost.startsWith('-') || row.at > Number(remoteAt))) return none;
  const actual = charged.reduce((sum, row) => sum.plus(row.cost), none);
  const expected = trades.filter(trade => !trade.conflict && trade.fee_coin === coin
    && selected.some(order => order.venue === trade.exchange_type && order.orderId === trade.order_id
      && order.symbol === trade.symbol && order.clientOrderId === trade.text))
    .reduce((sum, trade) => sum.plus(Decimal.max(0, trade.fee)), none);
  // Exact cash movement plus complete order/trade/book identity; neither a timestamp nor fee_coin alone releases money.
  return actual.eq(expected) && actual.eq(outflow) && charged.some(row => new Decimal(JSON.parse(row.payload).balance).eq(current)) ? actual : none;
}
