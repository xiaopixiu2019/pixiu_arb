import { describe, expect, it } from 'vitest';
import {
  applyFundingAssetOrder,
  averageAvailableFundingRate,
  cumulativeFundingPercent,
  currentFundingComparisonRate,
  currentFundingMetricRate,
  fundingPercentScaledTo8h,
  fundingHistoryRequestKey,
  overviewFundingRates,
} from './funding-rates.js';

describe('interval-aware current funding', () => {
  it('uses the same overview rate for both pages and preserves real zero rather than inventing missing rates', () => {
    expect(overviewFundingRates({ fundingRate: '0.000027786', fundingRate8h: '0.000222288', fundingIntervalHours: 1 })).toEqual({ rate: 0.0027786, rate8h: 0.0222288 });
    expect(overviewFundingRates({ fundingRate: '0', fundingRate8h: '0', fundingIntervalHours: 8 })).toEqual({ rate: 0, rate8h: 0 });
    expect(overviewFundingRates(undefined)).toEqual({ rate: null, rate8h: null });
    expect(overviewFundingRates({ fundingRate: '', fundingRate8h: 'NaN', fundingIntervalHours: 1 })).toEqual({ rate: null, rate8h: null });
    expect(overviewFundingRates({ fundingRate: '0.0001', fundingRate8h: null, fundingIntervalHours: 4 })).toEqual({ rate: 0.01, rate8h: 0.02 });
  });
  it('keeps the venue cell native while comparisons and APR use an 8h basis', () => {
    const nativeHourlyPercent = 0.001;
    const rate8hPercent = fundingPercentScaledTo8h(nativeHourlyPercent, 1);

    expect(rate8hPercent).toBe(0.008);
    expect(currentFundingMetricRate(nativeHourlyPercent, rate8hPercent, 'Per interval')).toBe(0.001);
    expect(currentFundingComparisonRate(rate8hPercent, 'Per interval')).toBe(0.008);
    expect(currentFundingMetricRate(nativeHourlyPercent, rate8hPercent, 'APR')).toBeCloseTo(8.76);
  });

  it('refuses to normalize a streamed fallback without interval metadata', () => {
    expect(fundingPercentScaledTo8h(0.001, null)).toBeNull();
    expect(fundingPercentScaledTo8h(0.001, 0)).toBeNull();
  });
});

describe('stable funding table order', () => {
  it('keeps refreshed rows in the explicitly applied order and appends new assets deterministically', () => {
    const refreshed = [
      { asset: 'SOL', value: 30 },
      { asset: 'ETH', value: 200 },
      { asset: 'BTC', value: 100 },
      { asset: 'ADA', value: 40 },
    ];

    expect(applyFundingAssetOrder(refreshed, ['BTC', 'ETH']).map((row) => row.asset))
      .toEqual(['BTC', 'ETH', 'ADA', 'SOL']);
  });
});

describe('funding history request identity', () => {
  it('stays stable across live-update array recreation and reordering', () => {
    const first = ['OKX_FUTURE_BTC_USDT', 'BINANCE_FUTURE_BTC_USDT'];
    const liveUpdate = ['BINANCE_FUTURE_BTC_USDT', 'OKX_FUTURE_BTC_USDT', 'OKX_FUTURE_BTC_USDT'];

    expect(fundingHistoryRequestKey(first)).toBe(fundingHistoryRequestKey(liveUpdate));
  });
});

describe('cumulativeFundingPercent', () => {
  it('displays the realized sum directly without projecting the latest interval', () => {
    expect(cumulativeFundingPercent('0.00123')).toBeCloseTo(0.123);
    expect(cumulativeFundingPercent('-0.0004')).toBeCloseTo(-0.04);
  });

  it('rejects missing and malformed history totals', () => {
    expect(cumulativeFundingPercent(null)).toBeNull();
    expect(cumulativeFundingPercent('not-a-rate')).toBeNull();
  });
});

describe('averageAvailableFundingRate', () => {
  it('averages positive and negative funding across selected tradable venues', () => {
    expect(averageAvailableFundingRate(
      [0.01, -0.02, 0.04],
      [true, true, true],
      [0, 1, 2],
    )).toEqual({ rate: 0.01, venueCount: 3 });
  });

  it('excludes unlisted, unselected, and missing venue rates', () => {
    expect(averageAvailableFundingRate(
      [0.01, 0.5, null, 0.03],
      [true, false, true, true],
      [0, 1, 2],
    )).toEqual({ rate: 0.01, venueCount: 1 });
  });

  it('returns no average when no selected tradable venue has funding data', () => {
    expect(averageAvailableFundingRate(
      [null, 0.02],
      [true, false],
      [0, 1],
    )).toEqual({ rate: null, venueCount: 0 });
  });
});
