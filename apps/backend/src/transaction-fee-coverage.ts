import { Decimal } from 'decimal.js';
import type { FeeBookRow } from './transaction-fee-model.js';
import type { PendingFeeOrder, StoredFeeTrade } from './transaction-fee-store.js';
import { feeOrderKey } from './transaction-fee-model.js';

export interface PendingFeeEvidence extends PendingFeeOrder { coin: string; fromAt: number }

/** Fills prove coverage, not money: charges and rebates must be present in the canonical ledger. */
export function pendingFeeEvidence(rows: FeeBookRow[], trades: StoredFeeTrade[], orders: PendingFeeOrder[]): PendingFeeEvidence[] {
  const fillsByOrder = new Map<string, StoredFeeTrade[]>(), booksByOrder = new Map<string, FeeBookRow[]>();
  for (const trade of trades) { const key = feeOrderKey(trade.exchange_type, trade.order_id), group = fillsByOrder.get(key) ?? []; group.push(trade); fillsByOrder.set(key, group); }
  for (const row of rows) { const key = feeOrderKey(row.venue, row.order_id), group = booksByOrder.get(key) ?? []; group.push(row); booksByOrder.set(key, group); }
  return orders.flatMap((order) => {
    const key = feeOrderKey(order.venue, order.orderId);
    const fills = (fillsByOrder.get(key) ?? []).filter((t) => !t.conflict
      && (!order.symbol || t.symbol === order.symbol) && (!order.clientOrderId || t.text === order.clientOrderId));
    const books = booksByOrder.get(key) ?? [];
    const coin = fills[0]?.fee_coin || order.symbol?.split('_').at(-1) || '—';
    const quantity = fills.reduce((sum, fill) => sum.plus(fill.qty), new Decimal(0));
    const completeQuantity = order.quantity !== null && quantity.eq(order.quantity);
    const times = fills.map((t) => Number(t.create_time));
    const at = fills.length && completeQuantity ? Math.max(...times) : Math.max(order.at, ...times);
    const fromAt = fills.length && completeQuantity ? Math.min(...times) : Math.min(order.fromAt ?? order.at, ...times);
    if (order.quantity === null || !order.symbol) return [{ ...order, at, fromAt, coin }];
    const missingCharge = [...new Set(fills.map((t) => t.fee_coin))].some((currency) => {
      const expected = fills.filter((t) => t.fee_coin === currency).reduce((sum, t) => sum.plus(Decimal.max(0, t.fee)), new Decimal(0));
      const actual = books.filter((r) => r.coin === currency && !r.conflict).reduce((sum, r) => sum.plus(Decimal.max(0, r.cost)), new Decimal(0));
      const expectedRebate = fills.filter((t) => t.fee_coin === currency).reduce((sum, t) => sum.plus(Decimal.min(0, t.fee).abs()), new Decimal(0));
      const actualRebate = books.filter((r) => r.coin === currency && !r.conflict).reduce((sum, r) => sum.plus(Decimal.min(0, r.cost).abs()), new Decimal(0));
      return expected.gt(actual) || expectedRebate.gt(actualRebate);
    });
    return !quantity.eq(order.quantity) || missingCharge ? [{ ...order, at, fromAt, coin }] : [];
  });
}
