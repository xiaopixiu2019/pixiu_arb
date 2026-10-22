import type { ExecutionOrder } from './api.js';

type OrderPriceFields = Pick<ExecutionOrder, 'executedAveragePrice' | 'price'>;

function positivePrice(value: string | null): value is string {
  if (value === null || value.trim() === '') return false;
  const numericValue = Number(value);
  return Number.isFinite(numericValue) && numericValue > 0;
}

/**
 * Uses a real execution average when available, then falls back to the submitted
 * limit price. Exchanges commonly report an average of "0" before an order fills.
 */
export function orderDisplayPrice(order: OrderPriceFields, marketLabel: string): string {
  if (positivePrice(order.executedAveragePrice)) return order.executedAveragePrice;
  if (positivePrice(order.price)) return order.price;
  return marketLabel;
}
