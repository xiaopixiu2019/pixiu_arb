import type { MarketCatalogAsset, VenueFeeRate } from './api.js';
import { effectiveFutureFeeRate, parseFeeRate } from './fee-rates.js';

export interface FeeComparisonRow {
  venue: string;
  symbol: string;
  quote: string;
  makerRate: number;
  takerRate: number;
  makerCost: number;
  takerCost: number;
  source: 'venue' | 'symbol';
}

export function normalizeTicker(value: string): string {
  return value.trim().toUpperCase().split(/[/\s_-]/)[0] ?? '';
}

export function resolveCatalogTicker(value: string, catalog: MarketCatalogAsset[] | null): string {
  const token = normalizeTicker(value);
  if (!catalog || catalog.some((entry) => entry.asset === token)) return token;
  for (const quote of ['USDT', 'USDC', 'USD']) {
    const candidate = token.endsWith(quote) ? token.slice(0, -quote.length) : '';
    if (candidate && catalog.some((entry) => entry.asset === candidate)) return candidate;
  }
  return token;
}

export function feeComparisonRows(
  ticker: string,
  notional: number,
  catalog: MarketCatalogAsset[] | null,
  fees: VenueFeeRate[],
): FeeComparisonRow[] {
  const asset = resolveCatalogTicker(ticker, catalog);
  const market = catalog?.find((entry) => entry.asset === asset);
  if (!market || !Number.isFinite(notional) || notional <= 0) return [];
  return market.venues.flatMap((venue) => {
    const fee = effectiveFutureFeeRate(fees, venue.venue, venue.symbol);
    const makerRate = parseFeeRate(fee?.makerFee);
    const takerRate = parseFeeRate(fee?.takerFee);
    if (makerRate === undefined || takerRate === undefined) return [];
    return [{
      venue: venue.venue,
      symbol: venue.symbol,
      quote: venue.quote,
      makerRate,
      takerRate,
      makerCost: notional * makerRate,
      takerCost: notional * takerRate,
      source: fee?.source ?? 'venue',
    }];
  }).sort((left, right) => left.takerRate - right.takerRate || left.venue.localeCompare(right.venue));
}
