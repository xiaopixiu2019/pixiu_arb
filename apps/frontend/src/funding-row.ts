import type { ReferenceQuote } from '@gate-crossex/shared-types';
import type { FundingAssetClass } from './api.js';
import type { FundingPriceSnapshot } from './funding-price-spread.js';

export interface FundingPairRow {
  asset: string;
  name: string;
  icon: string;
  assetClass: FundingAssetClass;
  /** Native percent per venue settlement, aligned with the configured exchanges. */
  rates: Array<number | null>;
  /** Comparable 8h percent, aligned with the configured exchanges. */
  rates8h: Array<number | null>;
  intervalHours: Array<number | null>;
  symbols: Array<string | null>;
  listed: boolean[];
  oiValues: Array<number | null>;
  oi: number;
  avgOi: number;
  oiVenues: number;
  priceSnapshot?: FundingPriceSnapshot;
  referenceQuotes?: readonly ReferenceQuote[];
}

/** Pin membership as well as rank. Removed instruments must never retain stale actionable data. */
export function retainFundingRows(applied: readonly FundingPairRow[], live: readonly FundingPairRow[]): FundingPairRow[] {
  const current = new Map(live.map((row) => [row.asset, row]));
  return applied.map((row) => current.get(row.asset) ?? {
    ...row,
    rates: row.rates.map(() => null), rates8h: row.rates8h.map(() => null),
    intervalHours: row.intervalHours.map(() => null), symbols: row.symbols.map(() => null),
    listed: row.listed.map(() => false), oiValues: row.oiValues.map(() => null),
    oi: 0, avgOi: 0, oiVenues: 0, priceSnapshot: undefined, referenceQuotes: [],
  });
}

export function fundingOpenInterest(
  item: FundingPairRow,
  visibleExchanges: readonly { index: number }[],
): Pick<FundingPairRow, 'oi' | 'avgOi' | 'oiVenues'> {
  const values = visibleExchanges.flatMap(({ index }) => {
    const value = item.oiValues[index];
    return value !== null && Number.isFinite(value) && value > 0 ? [value] : [];
  });
  const oi = values.reduce((sum, value) => sum + value, 0);
  return { oi, avgOi: values.length > 0 ? oi / values.length : 0, oiVenues: values.length };
}
