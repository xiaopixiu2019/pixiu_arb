import type { VenueFeeRate } from './api.js';

export interface EffectiveFutureFeeRate {
  makerFee: string;
  takerFee: string;
  source: 'venue' | 'symbol';
}

/** A symbol-specific Gate CrossEx fee always overrides the venue's account-tier default. */
export function effectiveFutureFeeRate(
  fees: readonly VenueFeeRate[],
  venue: string,
  symbol: string,
): EffectiveFutureFeeRate | null {
  const venueFee = fees.find((fee) => fee.venue.toUpperCase() === venue.toUpperCase());
  if (!venueFee) return null;
  const special = venueFee.specialFees?.find((fee) => fee.symbol.toUpperCase() === symbol.toUpperCase());
  return special
    ? { makerFee: special.makerFee, takerFee: special.takerFee, source: 'symbol' }
    : { makerFee: venueFee.futureMakerFee, takerFee: venueFee.futureTakerFee, source: 'venue' };
}

export function numericFutureFeeRate(
  fees: readonly VenueFeeRate[],
  venue: string,
  symbol: string,
  kind: 'maker' | 'taker',
): number | undefined {
  const effective = effectiveFutureFeeRate(fees, venue, symbol);
  return parseFeeRate(kind === 'maker' ? effective?.makerFee : effective?.takerFee);
}

/** Missing fee evidence must not become a zero rate. Valid rebates retain their sign. */
export function parseFeeRate(value: string | undefined): number | undefined {
  if (value === undefined || !/^-?\d+(?:\.\d+)?$/.test(value)) return undefined;
  const rate = Number(value);
  return Number.isFinite(rate) ? rate : undefined;
}
