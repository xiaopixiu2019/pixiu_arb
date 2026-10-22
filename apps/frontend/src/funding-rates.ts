export interface AverageFundingRate {
  rate: number | null;
  venueCount: number;
}

export type CurrentFundingMetric = 'Per interval' | 'APR';

/** Shared overview source: a ticker source flag does not prove funding arrived. */
export function overviewFundingRates(entry: {
  fundingRate: string | null; fundingRate8h: string | null; fundingIntervalHours: number | null;
} | undefined): { rate: number | null; rate8h: number | null } {
  const percent = (value: string | null | undefined) => {
    if (value == null || value.trim() === '') return null;
    const number = Number(value) * 100;
    return Number.isFinite(number) ? number : null;
  };
  const rate = percent(entry?.fundingRate);
  const rate8h = entry?.fundingRate8h == null
    ? fundingPercentScaledTo8h(rate, entry?.fundingIntervalHours ?? null)
    : percent(entry.fundingRate8h);
  return { rate, rate8h };
}

/** Scale a native percentage to a comparable 8h percentage. */
export function fundingPercentScaledTo8h(rate: number | null, intervalHours: number | null): number | null {
  if (rate === null || !Number.isFinite(rate) || intervalHours === null || !Number.isFinite(intervalHours) || intervalHours <= 0) {
    return null;
  }
  return rate * (8 / intervalHours);
}

/** The venue cell shows an actual payment; APR is derived from the comparable 8h rate. */
export function currentFundingMetricRate(
  nativeRate: number | null,
  rate8h: number | null,
  metric: CurrentFundingMetric,
): number | null {
  if (metric === 'Per interval') return nativeRate;
  return rate8h === null ? null : rate8h * 1095;
}

/** Average/spread calculations must use the same time basis across venues. */
export function currentFundingComparisonRate(rate8h: number | null, metric: CurrentFundingMetric): number | null {
  if (rate8h === null) return null;
  return metric === 'APR' ? rate8h * 1095 : rate8h;
}

/**
 * Build an identity for a set of funding-history symbols. Sorting prevents
 * live market reordering from restarting the same page-wide history load.
 */
export function fundingHistoryRequestKey(symbols: ReadonlyArray<string>): string {
  return [...new Set(symbols)].sort().join('|');
}

/** Keep an explicitly applied sort stable while refreshed row values arrive. */
export function applyFundingAssetOrder<T extends { asset: string }>(
  rows: ReadonlyArray<T>,
  order: ReadonlyArray<string>,
): T[] {
  const rank = new Map(order.map((asset, index) => [asset, index]));
  return [...rows].sort((left, right) => {
    const leftRank = rank.get(left.asset) ?? Number.MAX_SAFE_INTEGER;
    const rightRank = rank.get(right.asset) ?? Number.MAX_SAFE_INTEGER;
    return leftRank - rightRank || left.asset.localeCompare(right.asset);
  });
}

/** Convert an already-summed realized funding fraction to the percentage shown in the table. */
export function cumulativeFundingPercent(rate: string | null): number | null {
  if (rate === null || rate.trim() === '') return null;
  const value = Number(rate) * 100;
  return Number.isFinite(value) ? value : null;
}

/**
 * Average the normalized funding rates for selected venues where the asset is
 * tradable and a funding quote is available.
 */
export function averageAvailableFundingRate(
  rates: ReadonlyArray<number | null>,
  listed: ReadonlyArray<boolean>,
  venueIndexes: ReadonlyArray<number>,
): AverageFundingRate {
  let total = 0;
  let venueCount = 0;

  for (const index of venueIndexes) {
    const rate = rates[index];
    if (!listed[index] || rate === null || !Number.isFinite(rate)) continue;
    total += rate;
    venueCount += 1;
  }

  return {
    rate: venueCount > 0 ? total / venueCount : null,
    venueCount,
  };
}
