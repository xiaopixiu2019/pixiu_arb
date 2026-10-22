import { referenceSpread } from './reference-spread.js';
import type { FundingHistoryEntry } from './api.js';
import type { FundingPairRow } from './funding-row.js';
import { averageAvailableFundingRate, cumulativeFundingPercent, currentFundingComparisonRate, currentFundingMetricRate } from './funding-rates.js';
import { exchanges, type FundingMetric, type FundingSortKey, type SortDirection } from './route-shared.js';
export type VisibleFundingExchange = { venue: (typeof exchanges)[number]; index: number };

export function fundingMetricRate(
  item: FundingPairRow,
  venueIndex: number,
  metric: FundingMetric,
  historyBySymbol: Readonly<Record<string, FundingHistoryEntry>>,
): number | null {
  const currentRate = item.rates[venueIndex];
  if (metric === 'Per interval' || metric === 'APR') {
    return currentFundingMetricRate(currentRate, item.rates8h[venueIndex], metric);
  }
  const symbol = item.symbols[venueIndex];
  const history = symbol ? historyBySymbol[symbol] : undefined;
  if (!history || history.status !== 'ok') return null;
  const historicalRate = metric === '24h' ? history.rate24h : metric === '7d' ? history.rate7d : history.rate30d;
  return cumulativeFundingPercent(historicalRate);
}

export function fundingArb(
  item: FundingPairRow,
  visibleExchanges: readonly VisibleFundingExchange[],
  metric: FundingMetric,
  historyBySymbol: Readonly<Record<string, FundingHistoryEntry>>,
): { spread: number | null; low?: { venue: (typeof exchanges)[number]; rate: number }; high?: { venue: (typeof exchanges)[number]; rate: number } } {
  const selectedRates = visibleExchanges.flatMap(({ venue, index }) => {
    const rate = metric === 'Per interval' || metric === 'APR'
      ? currentFundingComparisonRate(item.rates8h[index], metric)
      : fundingMetricRate(item, index, metric, historyBySymbol);
    return rate === null ? [] : [{ venue, rate }];
  });
  if (selectedRates.length < 2) return { spread: null };
  const ordered = [...selectedRates].sort((a, b) => a.rate - b.rate);
  return { spread: ordered[ordered.length - 1].rate - ordered[0].rate, low: ordered[0], high: ordered[ordered.length - 1] };
}

export function averageFunding(
  item: FundingPairRow,
  visibleExchanges: readonly VisibleFundingExchange[],
  metric: FundingMetric,
  historyBySymbol: Readonly<Record<string, FundingHistoryEntry>>,
) {
  return averageAvailableFundingRate(
    item.rates.map((_rate, index) => metric === 'Per interval' || metric === 'APR'
      ? currentFundingComparisonRate(item.rates8h[index], metric)
      : fundingMetricRate(item, index, metric, historyBySymbol)),
    item.listed,
    visibleExchanges.map(({ index }) => index),
  );
}

export function pairPriceSpread(item: FundingPairRow, arb: ReturnType<typeof fundingArb>) {
  const long = item.priceSnapshot?.venues.find((leg) => leg.venue === arb.low?.venue.id.toUpperCase())?.symbol;
  const short = item.priceSnapshot?.venues.find((leg) => leg.venue === arb.high?.venue.id.toUpperCase())?.symbol;
  return long && short ? referenceSpread(item.asset, item.referenceQuotes ?? [], long, short, item.priceSnapshot?.checkedAt).bps : null;
}

export function sortedFundingOrder(
  rows: readonly FundingPairRow[],
  sortKey: FundingSortKey,
  direction: SortDirection,
  visibleExchanges: readonly VisibleFundingExchange[],
  metric: FundingMetric,
  historyBySymbol: Readonly<Record<string, FundingHistoryEntry>>,
): string[] {
  const multiplier = direction === 'asc' ? 1 : -1;
  return [...rows].sort((leftRow, rightRow) => {
    if (sortKey === 'asset') return leftRow.asset.localeCompare(rightRow.asset) * multiplier;
    if (sortKey === 'oi') return (leftRow.oi - rightRow.oi) * multiplier || leftRow.asset.localeCompare(rightRow.asset);
    const exchangeIndex = exchanges.findIndex((venue) => venue.id === sortKey);
    const left = sortKey === 'priceSpread' ? pairPriceSpread(leftRow, fundingArb(leftRow, visibleExchanges, metric, historyBySymbol))
      : sortKey === 'arb' ? fundingArb(leftRow, visibleExchanges, metric, historyBySymbol).spread
      : sortKey === 'average' ? averageFunding(leftRow, visibleExchanges, metric, historyBySymbol).rate
        : fundingMetricRate(leftRow, exchangeIndex, metric, historyBySymbol);
    const right = sortKey === 'priceSpread' ? pairPriceSpread(rightRow, fundingArb(rightRow, visibleExchanges, metric, historyBySymbol))
      : sortKey === 'arb' ? fundingArb(rightRow, visibleExchanges, metric, historyBySymbol).spread
      : sortKey === 'average' ? averageFunding(rightRow, visibleExchanges, metric, historyBySymbol).rate
        : fundingMetricRate(rightRow, exchangeIndex, metric, historyBySymbol);
    if (left === null && right === null) return leftRow.asset.localeCompare(rightRow.asset);
    if (left === null) return 1;
    if (right === null) return -1;
    return (left - right) * multiplier || leftRow.asset.localeCompare(rightRow.asset);
  }).map((row) => row.asset);
}
