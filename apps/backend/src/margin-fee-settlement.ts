import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { pendingFeeEvidence } from './transaction-fee-coverage.js';
import { resolveFeeBooks } from './transaction-fee-identity.js';
import type { FeeBinding, FeeBookRow } from './transaction-fee-model.js';
import type { PendingFeeOrder, StoredFeeTrade } from './transaction-fee-store.js';
import type { MarginRiskParameters } from './margin-risk-parameters.js';
import { Decimal } from 'decimal.js';

export function marginFeeCollectionReady(db: Database.Database, profileId: string, userId: string, now: number): boolean {
  try {
    const key = createHash('sha256').update(`${profileId}:${userId}`).digest('hex');
    const row = db.prepare('SELECT checked_at,book_reason,trade_reason FROM fee_epochs WHERE account_key=? AND profile_id=?')
      .get(key, profileId) as { checked_at: number | null; book_reason: string | null; trade_reason: string | null } | undefined;
    return !!row && row.checked_at !== null && now >= row.checked_at && now - row.checked_at <= 60000 && !row.book_reason && !row.trade_reason;
  } catch { return false; }
}

/** Read existing ledger coverage for this exact account and batch; missing is never zero. */
export function marginFeesSettled(db: Database.Database, profileId: string, userId: string, batchId: string, rules?: Pick<MarginRiskParameters, 'fees'>): boolean {
  try {
    const key = createHash('sha256').update(`${profileId}:${userId}`).digest('hex');
    const rows = db.prepare(`SELECT e.strategy_id AS taskId,e.venue,e.remote_order_id AS orderId,e.executed_quantity AS quantity,e.symbol,
      e.client_order_id AS clientOrderId,e.created_at,e.updated_at FROM execution_orders e JOIN execution_strategies s ON s.id=e.strategy_id
      WHERE s.credential_profile_id=? AND e.strategy_clip=? AND CAST(e.executed_quantity AS REAL)>0`)
      .all(profileId, `margin:${batchId}`) as Array<Omit<PendingFeeOrder, 'at'> & { created_at: string; updated_at: string }>;
    if (!rows.length || rows.some(r => !r.orderId || !r.quantity || !r.symbol)) return false;
    const ids = [...new Set(rows.map(r => r.orderId))], placeholders = ids.map(() => '?').join(',');
    const orders = rows.map(({ created_at, updated_at, ...r }) => ({ ...r, at: Date.parse(updated_at), fromAt: Date.parse(created_at) }));
    const trades = (db.prepare(`SELECT payload,conflict FROM fee_trades WHERE account_key=? AND order_id IN (${placeholders})`).all(key, ...ids) as
      Array<{ payload: string; conflict: number }>).map(r => ({ ...JSON.parse(r.payload), conflict: r.conflict })) as StoredFeeTrade[];
    const books = db.prepare(`SELECT * FROM fee_book WHERE account_key=? AND order_id IN (${placeholders})`).all(key, ...ids) as FeeBookRow[];
    const bindings = db.prepare(`SELECT b.*,c.symbol,c.quantity,c.order_at FROM fee_order_bindings b LEFT JOIN fee_binding_coverage c
      ON c.account_key=b.account_key AND c.venue=b.venue AND c.order_id=b.order_id WHERE b.account_key=? AND b.order_id IN (${placeholders})`)
      .all(key, ...ids) as FeeBinding[];
    const resolved = resolveFeeBooks(books, bindings, trades);
    if (rules && trades.some(t => !new Decimal(t.fee).isZero() && rules.fees.find(f => f.symbol === t.symbol)?.pool.split(':')[1] !== t.fee_coin)) return false;
    for (const row of resolved) {
      if (row.conflict) return false;
      if (!rules) continue;
      const order = orders.find(o => o.venue === row.venue && o.orderId === row.order_id), rule = rules.fees.find(f => f.symbol === order?.symbol);
      if (!rule || row.conflict) return false;
      const raw = JSON.parse(row.payload) as { exchange_type: string; coin: string };
      if (raw.exchange_type !== (rule.bookVenue ?? rule.pool.split(':')[0]) || raw.coin !== rule.pool.split(':')[1]) return false;
    }
    return pendingFeeEvidence(resolved, trades, orders).length === 0;
  } catch { return false; }
}
