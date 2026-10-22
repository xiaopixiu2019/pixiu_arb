import type { FundingOverviewResponse } from './api.js';
import { pairedFundingYield } from '@gate-crossex/domain';
import type { PositionTableRow } from './strategy-positions.js';

export interface PositionFundingYield {
  aprPercent: number; expected8h: number; annualizedFunding: number; grossNotional: number;
  initialMargin: number; effectiveLeverage: number; oldestQuoteAt: string;
}
export function calculatePositionFundingYield(positions: readonly PositionTableRow[], overview: FundingOverviewResponse | null,
  rates?: Record<string, string>, now = Date.now()): PositionFundingYield | null {
  if (!overview || overview.cacheStatus !== 'fresh' || positions.length === 0) return null;
  const legs = positions.map(position => {
    const quote = overview.assets.flatMap(a => a.venues).find(q => q.symbol === position.symbol);
    const validVenue = overview.venueStatus.some(v => v.venue === position.venue.toUpperCase() && v.status === 'ok');
    return { quantity: String(position.quantity), value: String(position.value), initialMargin: String(position.initialMargin),
      fx: rates?.[position.quote] ?? (position.quote === 'USDT' ? '1' : 'NaN'),
      rate8h: validVenue && quote?.fundingRate8h != null ? quote.fundingRate8h : 'NaN', fetchedAt: Date.parse(quote?.fetchedAt ?? '') };
  });
  const value = pairedFundingYield(legs, now);
  return value ? { aprPercent: Number(value.aprPercent), expected8h: Number(value.expected8h),
    annualizedFunding: Number(value.annualizedFunding), grossNotional: Number(value.grossNotional),
    initialMargin: Number(value.initialMargin), effectiveLeverage: Number(value.effectiveLeverage), oldestQuoteAt: value.oldestQuoteAt } : null;
}
export function calculatePortfolioFundingYield(positions: readonly PositionTableRow[], overview: FundingOverviewResponse | null,
  marginBalance: number | null | undefined, rates?: Record<string, string>, now = Date.now()): PositionFundingYield | null {
  const value = calculatePositionFundingYield(positions, overview, rates, now);
  if (!value || marginBalance == null || !Number.isFinite(marginBalance) || marginBalance <= 0) return null;
  return { ...value, aprPercent: value.annualizedFunding / marginBalance * 100, initialMargin: marginBalance,
    effectiveLeverage: value.grossNotional / marginBalance };
}
