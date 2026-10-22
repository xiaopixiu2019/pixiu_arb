import { CANDLE_INTERVAL_MILLISECONDS } from '@gate-crossex/shared-types';
import type { Candle, CandleInterval, LiveMarket, MarketSnapshot } from './api.js';

export const STRATEGY_MARKET_FRESHNESS_MS = 15_000;
export const STRATEGY_MARKET_MAX_TRANSPORT_LAG_MS = 3_000;
export const STRATEGY_FUTURE_QUOTE_TOLERANCE_MS = 2_000;

/** A fresh BBO snapshot cannot make a seed or old last-trade value safe for ticket autofill. */
export function freshTickerPrice(market: LiveMarket | null | undefined, now = Date.now()): string | null {
  if (!market || market.source !== 'gate_crossex_websocket' || market.quoteChannel?.startsWith('order_book_')) return null;
  const timestamp = market.tickerUpdatedAt ?? market.updatedAt;
  const age = now - Date.parse(timestamp);
  const lag = Date.parse(market.receivedAt) - Date.parse(timestamp);
  return Number.isFinite(age) && age >= -STRATEGY_FUTURE_QUOTE_TOLERANCE_MS && age <= STRATEGY_MARKET_FRESHNESS_MS
    && Number.isFinite(lag) && lag <= STRATEGY_MARKET_MAX_TRANSPORT_LAG_MS
    && Number.isFinite(Number(market.lastPrice)) && Number(market.lastPrice) > 0 ? market.lastPrice : null;
}

export interface FreshMarketPair {
  left: LiveMarket;
  right: LiveMarket;
}

export type MarketPairWaitReason = 'feed' | 'missing' | 'non_live' | 'stale' | 'delayed';

export type MarketPairFreshness =
  | { pair: FreshMarketPair; reason: null }
  | { pair: null; reason: MarketPairWaitReason };

/**
 * Return the last streamed prices for display, even after they stop being executable. The caller
 * must still use `assessMarketPairFreshness` for readiness and show its warning alongside these
 * values; demo placeholders are never presented as venue prices.
 */
export function lastKnownLiveMarketPair(
  snapshot: MarketSnapshot | null,
  leftSymbol: string,
  rightSymbol: string,
): FreshMarketPair | null {
  const left = snapshot?.markets.find((market) => market.symbol === leftSymbol);
  const right = snapshot?.markets.find((market) => market.symbol === rightSymbol);
  return left && right && left.source !== 'demo_seed' && right.source !== 'demo_seed'
    ? { left, right }
    : null;
}

/** Explain why a pair is not executable so the UI does not collapse every failure into one hint. */
export function assessMarketPairFreshness(
  snapshot: MarketSnapshot | null,
  leftSymbol: string,
  rightSymbol: string,
  now = Date.now(),
): MarketPairFreshness {
  if (!snapshot) return { pair: null, reason: 'feed' };
  const left = snapshot.markets.find((market) => market.symbol === leftSymbol);
  const right = snapshot.markets.find((market) => market.symbol === rightSymbol);
  if (!left || !right) return { pair: null, reason: 'missing' };
  if (snapshot.connectionState !== 'healthy' && (left.source !== 'native_venue' || right.source !== 'native_venue')) return { pair: null, reason: 'feed' };
  if (left.source === 'demo_seed' || right.source === 'demo_seed') {
    return { pair: null, reason: 'non_live' };
  }
  if ([left, right].some(q => q.source === 'native_venue' && (!q.nativeSymbol || !Number.isFinite(q.nativeValidUntil) || q.nativeValidUntil! <= now))) return { pair: null, reason: 'stale' };
  const leftUpdatedAt = Date.parse(left.updatedAt);
  const rightUpdatedAt = Date.parse(right.updatedAt);
  const leftReceivedAt = Date.parse(left.receivedAt);
  const rightReceivedAt = Date.parse(right.receivedAt);
  const usableTimestamp = (timestamp: number) => Number.isFinite(timestamp)
    && now - timestamp <= STRATEGY_MARKET_FRESHNESS_MS
    && timestamp - now <= STRATEGY_FUTURE_QUOTE_TOLERANCE_MS;
  if (!usableTimestamp(leftUpdatedAt) || !usableTimestamp(rightUpdatedAt)) {
    return { pair: null, reason: 'stale' };
  }
  const timelyDelivery = (sourceTimestamp: number, receivedTimestamp: number) =>
    Number.isFinite(receivedTimestamp)
    && receivedTimestamp - sourceTimestamp <= STRATEGY_MARKET_MAX_TRANSPORT_LAG_MS;
  if (!timelyDelivery(leftUpdatedAt, leftReceivedAt) || !timelyDelivery(rightUpdatedAt, rightReceivedAt)) {
    return { pair: null, reason: 'delayed' };
  }
  return { pair: { left, right }, reason: null };
}

/** Mirror the backend trigger guard so stale UI prices can never look actionable. */
export function freshMarketPair(
  snapshot: MarketSnapshot | null,
  leftSymbol: string,
  rightSymbol: string,
  now = Date.now(),
): FreshMarketPair | null {
  return assessMarketPairFreshness(snapshot, leftSymbol, rightSymbol, now).pair;
}

/**
 * Venue REST may return persisted candles while a refresh is running. Treat at most the previous
 * completed interval as current, with a small transport allowance, and otherwise keep loading.
 */
export function candleTailIsFresh(
  candles: Candle[],
  interval: CandleInterval,
  now = Date.now(),
): boolean {
  const latest = candles[candles.length - 1];
  if (!latest) return false;
  return candleTimestampIsFresh(latest.startTime, interval, now);
}

export function candleTimestampIsFresh(
  startTime: number,
  interval: CandleInterval,
  now = Date.now(),
): boolean {
  const intervalMs = CANDLE_INTERVAL_MILLISECONDS[interval];
  return startTime <= now + STRATEGY_FUTURE_QUOTE_TOLERANCE_MS
    && now - startTime <= intervalMs * 2 + 5_000;
}
