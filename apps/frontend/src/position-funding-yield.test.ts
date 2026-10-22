import { describe, expect, it } from 'vitest';
import type { FundingOverviewResponse } from './api.js';
import {
  calculatePortfolioFundingYield as portfolioYield,
  calculatePositionFundingYield as positionYield,
} from './position-funding-yield.js';
import type { PositionTableRow } from './strategy-positions.js';

const now = Date.parse('2026-09-07T01:31:00.000Z');
const calculatePositionFundingYield = (rows: PositionTableRow[], data: FundingOverviewResponse | null) => positionYield(rows, data, { USDT: '1', USDC: '1' }, now);
const calculatePortfolioFundingYield = (rows: PositionTableRow[], data: FundingOverviewResponse | null, margin: number) => portfolioYield(rows, data, margin, { USDT: '1', USDC: '1' }, now);

function row(overrides: Partial<PositionTableRow>): PositionTableRow {
  return {
    id: 'position', positionId: 'position', symbol: 'HYPERLIQUID_FUTURE_HYPE_USDC',
    venue: 'HYPERLIQUID', asset: 'HYPE', quote: 'USDC', side: 'Long', quantity: 100,
    value: 5_182, initialMargin: 1_036.4, entryPrice: 51.8, markPrice: 51.82,
    leverage: '5', unrealizedPnl: 0, realizedPnl: 0, fundingFee: 0,
    ...overrides,
  };
}

function overview(overrides: Partial<FundingOverviewResponse> = {}): FundingOverviewResponse {
  return {
    assets: [{
      asset: 'HYPE', assetClass: 'CRYPTO_BLUE_CHIP', venues: [
        {
          venue: 'HYPERLIQUID', symbol: 'HYPERLIQUID_FUTURE_HYPE_USDC', quote: 'USDC',
          fundingRate: '0.000025', fundingIntervalHours: 1, fundingRate8h: '0.0002',
          nextFundingAt: null, openInterestValue: '15000000', lastPrice: '51.82',
          change24h: null, fetchedAt: '2026-09-07T01:30:00.000Z',
        },
        {
          venue: 'BYBIT', symbol: 'BYBIT_FUTURE_HYPE_USDT', quote: 'USDT',
          fundingRate: '-0.0001', fundingIntervalHours: 8, fundingRate8h: '-0.0001',
          nextFundingAt: null, openInterestValue: '12000000', lastPrice: '51.82',
          change24h: null, fetchedAt: '2026-09-07T01:31:00.000Z',
        },
      ],
    }],
    venueStatus: [
      { venue: 'HYPERLIQUID', status: 'ok', fetchedAt: '2026-09-07T01:30:00.000Z', rowCount: 1 },
      { venue: 'BYBIT', status: 'ok', fetchedAt: '2026-09-07T01:31:00.000Z', rowCount: 1 },
    ],
    classification: { source: 'COINGECKO', marketCapLimit: 20, status: 'fresh', fetchedAt: '2026-09-07T00:00:00.000Z' },
    fetchedAt: '2026-09-07T01:31:00.000Z', cacheStatus: 'fresh',
    ...overrides,
  };
}

describe('position funding yield', () => {
  it('reuses the current 8h APR and weights unequal leg leverage by actual initial margin', () => {
    const result = calculatePositionFundingYield([
      row({}),
      row({
        id: 'short', positionId: 'short', symbol: 'BYBIT_FUTURE_HYPE_USDT', venue: 'BYBIT',
        quote: 'USDT', side: 'Short', quantity: -100, initialMargin: 518.2, leverage: '10',
      }),
    ], overview());

    expect(result?.expected8h).toBeCloseTo(-1.5546);
    expect(result?.aprPercent).toBeCloseTo(-109.5);
    expect(result?.initialMargin).toBeCloseTo(1_554.6);
    expect(result?.effectiveLeverage).toBeCloseTo(6.666666666666667);
    expect(result?.oldestQuoteAt).toBe('2026-09-07T01:30:00.000Z');
  });

  it('computes all simultaneous positions against account margin balance', () => {
    const rows = [
      row({}),
      row({ id: 'short', symbol: 'BYBIT_FUTURE_HYPE_USDT', venue: 'BYBIT', quantity: -100, initialMargin: 518.2 }),
    ];

    const result = calculatePortfolioFundingYield(rows, overview(), 10_000);
    expect(result?.expected8h).toBeCloseTo(-1.5546);
    expect(result?.aprPercent).toBeCloseTo(-17.02287);
    expect(result?.initialMargin).toBe(10_000);
  });

  it('treats zero funding as valid', () => {
    const zero = overview();
    zero.assets[0].venues[0].fundingRate8h = '0';
    expect(calculatePositionFundingYield([row({})], zero)).toMatchObject({ aprPercent: 0, expected8h: 0 });
  });

  it('fails closed for missing margin, stale overview, or a failed venue', () => {
    expect(calculatePositionFundingYield([row({ initialMargin: null })], overview())).toBeNull();
    expect(calculatePositionFundingYield([row({})], overview({ cacheStatus: 'stale' }))).toBeNull();
    const failed = overview();
    failed.venueStatus[0].status = 'error';
    expect(calculatePositionFundingYield([row({})], failed)).toBeNull();
  });
});
