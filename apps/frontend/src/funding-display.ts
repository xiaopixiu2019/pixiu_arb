import type { FundingMetric } from './route-shared.js';

export function formatFundingRate(rate: number, metric: FundingMetric): string {
  const digits = metric === 'APR' ? 2 : metric === 'Per interval' ? 4 : 3;
  return `${rate > 0 ? '+' : ''}${rate.toFixed(digits)}%`;
}

export function formatOpenInterest(value: number): string {
  if (value <= 0) return '—';
  if (value >= 1_000_000_000) return `$${(value / 1_000_000_000).toFixed(2)}B`;
  if (value >= 10_000_000) return `$${Math.round(value / 1_000_000)}M`;
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `$${Math.round(value / 1_000)}K`;
  return `$${Math.round(value)}`;
}

export function formatFundingInterval(hours: number | null): string | null {
  if (hours === null || !Number.isFinite(hours) || hours <= 0) return null;
  return `${Number.isInteger(hours) ? hours.toFixed(0) : hours.toFixed(1)}h`;
}
