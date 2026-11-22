import { Decimal } from 'decimal.js';

/** The venue cancelled the unfilled remainder of this IOC. Its cumulative fills still stand. */
export function expiredEntryIoc(order: { state: string; type: string; timeInForce: string;
  reduceOnly: boolean; remoteOrderId: string | null; failureReason: string | null; quantity: string; executedQuantity: string }): boolean {
  if (order.state !== 'CANCELLED' || order.type !== 'MARKET' || order.timeInForce !== 'IOC' || order.reduceOnly
    || !order.remoteOrderId || order.failureReason !== 'ioc_order_failed_because_it_would_not_be_executed') return false;
  const filled = new Decimal(order.executedQuantity), requested = new Decimal(order.quantity);
  return requested.isFinite() && filled.isFinite() && filled.gte(0) && filled.lt(requested);
}
