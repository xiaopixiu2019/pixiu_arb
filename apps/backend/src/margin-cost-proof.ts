import { Decimal } from 'decimal.js';
import type Database from 'better-sqlite3';
import type { CostReservation } from './margin-risk-store.js';
import { marginFeesSettled } from './margin-fee-settlement.js';
import { createHash } from 'node:crypto';
function recordedFees(db: Database.Database, item: CostReservation, profile: string, user: string): Decimal {
  const key = createHash('sha256').update(`${profile}:${user}`).digest('hex');
  const trades = db.prepare(`SELECT DISTINCT t.venue,t.id,t.payload,t.conflict FROM fee_trades t
    JOIN execution_orders e ON e.venue=t.venue AND e.remote_order_id=t.order_id
    JOIN execution_strategies s ON s.id=e.strategy_id WHERE t.account_key=? AND s.credential_profile_id=? AND e.strategy_clip=?
    AND json_extract(t.payload,'$.symbol')=e.symbol AND json_extract(t.payload,'$.text')=e.client_order_id`)
    .all(key, profile, `margin:${item.batchId}`) as Array<{ payload: string; conflict: number }>;
  return trades.reduce((sum, row) => {
    const t = JSON.parse(row.payload) as { fee: string; fee_coin: string; symbol: string }, fee = new Decimal(t.fee);
    if (row.conflict || !fee.isFinite() || !['USD', 'USDT', 'USDC'].includes(t.fee_coin)) throw new Error('margin_fee_unverified');
    const fx = t.fee_coin === 'USDT' ? '1' : item.legs.find(l => l.symbol === t.symbol)?.fx ?? '1';
    return sum.plus(Decimal.max(0, fee).mul(fx));
  }, new Decimal(0));
}
export function marginCostProof(db: Database.Database, item: CostReservation, profile: string, user: string):
  { amount: string; settled: boolean; exceeded: boolean } | null {
  try {
    const rows = db.prepare(`SELECT e.symbol,e.side,e.state,e.executed_quantity AS quantity,e.executed_average_price AS price
      FROM execution_orders e JOIN execution_strategies s ON s.id=e.strategy_id WHERE s.credential_profile_id=? AND e.strategy_clip=?`)
      .all(profile, `margin:${item.batchId}`) as Array<{ symbol: string; side: string; state: string; quantity: string; price: string | null }>;
    if (!rows.length || rows.some(r => !['FILLED', 'CANCELLED', 'REJECTED'].includes(r.state))) return null;
    let fees = new Decimal(0), slippage = new Decimal(0);
    for (const r of rows) {
      const q = new Decimal(r.quantity); if (!q.isFinite() || q.lt(0)) return null; if (q.isZero()) continue;
      const leg = item.legs.find(l => l.symbol === r.symbol && l.side === r.side);
      const price = new Decimal(r.price ?? 'NaN'); if (!leg || !price.isFinite() || price.lte(0)) return null;
      fees = fees.plus(q.mul(price).mul(leg.feeRate).mul('1.02').mul(leg.fx ?? '1'));
      slippage = slippage.plus(Decimal.max(0, r.side === 'BUY' ? price.minus(leg.mark) : new Decimal(leg.mark).minus(price)).mul(q).mul(leg.fx ?? '1'));
    }
    fees = Decimal.max(fees, recordedFees(db, item, profile, user));
    const exceeded = fees.plus(slippage).gt(new Decimal(item.originalAmount).plus('0.01'));
    return { amount: Decimal.min(item.originalAmount, fees).toString(), settled: marginFeesSettled(db, profile, user, item.batchId), exceeded };
  } catch { return null; }
}
