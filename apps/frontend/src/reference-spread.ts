import { canonicalMarketAsset, type ReferenceQuote } from '@gate-crossex/shared-types';
import type { LiveMarket } from './api.js';
import { STRATEGY_MARKET_FRESHNESS_MS, STRATEGY_MARKET_MAX_TRANSPORT_LAG_MS, STRATEGY_FUTURE_QUOTE_TOLERANCE_MS } from './market-freshness.js';

export const REFERENCE_QUOTE_MAX_AGE_MS = 45_000;

/** Quote validity is separate from connection readiness: a reconnect does not erase a fresh book. */
export function streamedReferenceQuotes(markets: readonly Pick<LiveMarket, 'symbol' | 'source' | 'bidPrice' | 'askPrice' | 'updatedAt' | 'receivedAt'>[], symbols: readonly string[], now: number): ReferenceQuote[] {
  return symbols.flatMap((symbol) => {
    const leg = markets.find((entry) => entry.symbol === symbol);
    if (!leg || leg.source !== 'gate_crossex_websocket') return [];
    const sourceAt = Date.parse(leg.updatedAt), receivedAt = Date.parse(leg.receivedAt);
    const age = now - sourceAt, lag = receivedAt - sourceAt;
    if (!Number.isFinite(age) || !Number.isFinite(lag) || age > STRATEGY_MARKET_FRESHNESS_MS
      || age < -STRATEGY_FUTURE_QUOTE_TOLERANCE_MS || lag > STRATEGY_MARKET_MAX_TRANSPORT_LAG_MS
      || lag < -STRATEGY_FUTURE_QUOTE_TOLERANCE_MS) return [];
    return [{ symbol, status: 'ok' as const, bidPrice: leg.bidPrice, askPrice: leg.askPrice, bookObservedAt: leg.updatedAt, fetchedAt: leg.receivedAt }];
  });
}

export function referenceLeg(asset: string, entries: readonly ReferenceQuote[], symbol: string, now = Date.now()) {
  const leg = entries.find((entry) => entry.symbol === symbol);
  const match = /^([A-Z0-9]+)_FUTURE_([A-Z0-9]+)_(USDT|USDC|USD)$/.exec(symbol);
  if (!leg || !match || canonicalMarketAsset(match[1], 'FUTURE', match[2]) !== asset) return null;
  const bid = Number(leg.bidPrice), ask = Number(leg.askPrice);
  const observed = Date.parse(leg.bookObservedAt ?? ''), fetched = Date.parse(leg.fetchedAt);
  if (leg.status !== 'ok' || !Number.isFinite(bid) || !Number.isFinite(ask) || bid <= 0 || ask <= 0 || bid > ask
    || !Number.isFinite(observed) || !Number.isFinite(fetched)
    || now - observed > REFERENCE_QUOTE_MAX_AGE_MS || observed > now + 5_000
    || now - fetched > REFERENCE_QUOTE_MAX_AGE_MS || fetched > now + 5_000) return null;
  return { bid, ask, observed };
}

/** Entry reference: sell the short leg at its bid, buy the long leg at its ask. */
export function referenceSpread(asset: string, entries: readonly ReferenceQuote[], longSymbol: string, shortSymbol: string, now = Date.now()) {
  const long = referenceLeg(asset, entries, longSymbol, now);
  const short = referenceLeg(asset, entries, shortSymbol, now);
  if (longSymbol === shortSymbol || !long || !short) return { bps: null, reason: 'Best bid/ask unavailable or stale' };
  if (Math.abs(long.observed - short.observed) > 30_000) return { bps: null, reason: 'Quote sampling times differ too much' };
  return { bps: (short.bid - long.ask) / long.ask * 10_000, reason: 'Best bid/ask reference · excludes fees and slippage' };
}

export function selectReferencePair(asset: string, streamed: readonly ReferenceQuote[], rest: readonly ReferenceQuote[], left: string, right: string, now: number) {
  const streamBooksValid = streamed.length > 0 && referenceLeg(asset, streamed, left, now) !== null && referenceLeg(asset, streamed, right, now) !== null;
  return { entries: streamBooksValid ? streamed : rest, streamBooksValid };
}
