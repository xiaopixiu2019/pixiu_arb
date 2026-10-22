import { canonicalMarketAsset } from '@gate-crossex/shared-types';
import type { FundingOverviewVenueEntry } from './api.js';

export interface FundingPriceSnapshot {
  venues: ReadonlyArray<Pick<FundingOverviewVenueEntry, 'venue' | 'symbol' | 'quote' | 'lastPrice' | 'fetchedAt' | 'bidPrice' | 'askPrice' | 'bookObservedAt'>>;
  healthyVenues: readonly string[];
  fresh: boolean;
  checkedAt: number;
}

// A 5-minute overview refresh plus two frontend polling intervals. Failed venue
// sweeps and mixed sampling rounds are rejected even within this age allowance.
const MAX_REFERENCE_AGE_MS = 360_000;

export function fundingPriceSpread(
  asset: string, snapshot: FundingPriceSnapshot | undefined, longVenue?: string, shortVenue?: string,
): number | null {
  if (!snapshot?.fresh || !longVenue || !shortVenue || longVenue === shortVenue) return null;
  const legs = [longVenue, shortVenue].map((venue) => snapshot.venues.find((entry) => entry.venue === venue.toUpperCase()));
  const prices: number[] = [];
  const times: number[] = [];
  for (const [index, leg] of legs.entries()) {
    if (!leg || !snapshot.healthyVenues.includes(leg.venue)) return null;
    const symbol = /^([A-Z0-9]+)_FUTURE_([A-Z0-9]+)_(USDT|USDC|USD)$/.exec(leg.symbol);
    if (!symbol || symbol[1] !== leg.venue || symbol[3] !== leg.quote
      || canonicalMarketAsset(leg.venue, 'FUTURE', symbol[2]) !== asset) return null;
    const bid = Number(leg.bidPrice);
    const ask = Number(leg.askPrice);
    if (!Number.isFinite(bid) || !Number.isFinite(ask) || bid <= 0 || ask <= 0 || bid > ask) return null;
    const price = index === 0 ? ask : bid;
    const time = Date.parse(leg.fetchedAt ?? '');
    const age = snapshot.checkedAt - time;
    const bookAge = snapshot.checkedAt - Date.parse(leg.bookObservedAt ?? '');
    if (!Number.isFinite(age) || age < 0 || age > MAX_REFERENCE_AGE_MS
      || !Number.isFinite(bookAge) || bookAge < 0 || bookAge > MAX_REFERENCE_AGE_MS) return null;
    prices.push(price);
    times.push(time);
  }
  if (times[0] !== times[1]) return null;
  // Same nominal USD/USDT/USDC convention as the paired-strategy preview;
  // a sampled best bid/ask spread, not FX-adjusted or guaranteed at order size.
  const bps = ((prices[1] - prices[0]) / prices[0]) * 10_000;
  return Number.isFinite(bps) ? bps : null;
}

export function formatPriceSpread(bps: number | null): string {
  return bps === null ? '—' : `${bps >= 0 ? '+' : ''}${bps.toFixed(2)} bps`;
}
