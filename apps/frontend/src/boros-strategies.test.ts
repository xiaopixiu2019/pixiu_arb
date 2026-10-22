import { describe, expect, it } from 'vitest';
import type { BorosStrategy, CrossExInstrument } from './api.js';
import {
  borosCrossExSymbols,
  borosFixedAprPct,
  borosFixedAprPctAtLeverages,
  borosFixedRoiPct,
  borosReturnEstimate,
  borosStrategyIsCrossExReady,
  borosMarketMaxLeverages,
  borosVenueId,
  quantityMatchesInstrument,
} from './boros-strategies.js';

const strategy: BorosStrategy = {
  id: 'ETH-2-1790294400-OKX-Hyperliquid',
  longMarket: {
    marketId: 185, address: '0x6bb121533f78d8d0c8a847b0ab399e0399966563', tokenId: 2,
    name: 'ETHUSDT', assetSymbol: 'ETH', maturity: 1790294400, state: 'Normal', impliedApr: 0.0225,
    maxLeverage: 2.1, maxPerpLeverage: 100, ammId: 0, platformName: 'OKX',
  },
  shortMarket: {
    marketId: 102, address: '0xd035309b604d6e252d29ce1d61e9a1e0a0553918', tokenId: 2,
    name: 'ETHUSDC', assetSymbol: 'ETH', maturity: 1790294400, state: 'Normal', impliedApr: 0.0628,
    maxLeverage: 2.1, maxPerpLeverage: 25, ammId: 1020, platformName: 'Hyperliquid',
  },
  daysToMaturity: 50,
  impliedAprSpread: 0.0403,
  maxPerpLeverage: 10,
  aprTimesMaxLeverage: 0.1487,
};

function instrument(symbol: string): CrossExInstrument {
  return {
    symbol, exchangeType: symbol.split('_')[0] ?? '', businessType: 'FUTURE', state: 'live',
    minSize: '0.001', minNotional: '5', lotSize: '0.001', tickSize: '0.1', maxNumOrders: '100',
    maxMarketSize: '100', maxLimitSize: '100', contractSize: null, liquidationFee: '0.005',
    defaultLeverage: '5', delistTime: '0',
  };
}

describe('Boros strategy helpers', () => {
  it('retains a signed Maker rebate in the perpetual open/close budget', () => {
    const result = borosReturnEstimate({ strategy, longLeverage: 10, shortLeverage: 10,
      longNotionalUsd: 10000, shortNotionalUsd: 10000, longPerpTakerFeeRate: -0.0001,
      longPerpCloseFeeRate: 0.0005, shortPerpTakerFeeRate: 0.0005, includeEntranceFees: false });
    expect(result?.longPerpTradingFeeUsd).toBe(4);
    expect(result?.longPerpTakerFeeRate).toBe(-0.0001);
    const missingClose = borosReturnEstimate({ strategy, longLeverage: 10, shortLeverage: 10,
      longNotionalUsd: 10000, shortNotionalUsd: 10000, longPerpTakerFeeRate: -0.0001,
      shortPerpTakerFeeRate: 0.0005, includeEntranceFees: false });
    expect(missingClose?.longPerpCloseFeeRate).toBe(0.0005);
    expect(missingClose?.longPerpTradingFeeUsd).toBe(4);
  });
  it('maps supported Boros platforms to CrossEx symbols', () => {
    expect(borosVenueId('Lighter')).toBeNull();
    expect(borosCrossExSymbols(strategy, null)).toEqual({
      longVenueId: 'okx',
      shortVenueId: 'hyperliquid',
      longSymbol: 'OKX_FUTURE_ETH_USDT',
      shortSymbol: 'HYPERLIQUID_FUTURE_ETH_USDC',
    });
  });

  it('requires both live CrossEx contracts', () => {
    expect(borosStrategyIsCrossExReady(strategy, null, [
      instrument('OKX_FUTURE_ETH_USDT'),
      instrument('HYPERLIQUID_FUTURE_ETH_USDC'),
    ])).toBe(true);
    expect(borosStrategyIsCrossExReady(strategy, null, [instrument('OKX_FUTURE_ETH_USDT')])).toBe(false);
  });

  it('derives APR/term ROI and checks lot-size alignment', () => {
    expect(borosFixedAprPct(strategy)).toBeCloseTo(14.87);
    expect(borosMarketMaxLeverages(strategy)).toEqual({ longLeverage: 100, shortLeverage: 25 });
    expect(borosFixedAprPctAtLeverages(strategy, 25, 20)).toBeGreaterThan(14.87);
    expect(borosFixedRoiPct(strategy)).toBeCloseTo(2.036986, 5);
    const eth = instrument('OKX_FUTURE_ETH_USDT');
    expect(quantityMatchesInstrument('0.125', eth)).toBe(true);
    expect(quantityMatchesInstrument('0.0005', eth)).toBe(false);
    expect(quantityMatchesInstrument('0.1255', eth)).toBe(false);
  });

  it('recalculates return on capital for independent perp leverage and itemizes every expected fee', () => {
    const atMax = borosReturnEstimate({
      strategy,
      longLeverage: 10,
      shortLeverage: 10,
      longNotionalUsd: 10_000,
      shortNotionalUsd: 10_000,
      longPerpTakerFeeRate: 0.0005,
      shortPerpTakerFeeRate: 0.0005,
    });
    const lowerLongLeverage = borosReturnEstimate({
      strategy,
      longLeverage: 5,
      shortLeverage: 10,
      longNotionalUsd: 10_000,
      shortNotionalUsd: 10_000,
      longPerpTakerFeeRate: 0.0005,
      shortPerpTakerFeeRate: 0.0005,
    });
    const makerOpenLong = borosReturnEstimate({
      strategy,
      longLeverage: 10,
      shortLeverage: 10,
      longNotionalUsd: 10_000,
      shortNotionalUsd: 10_000,
      longPerpTakerFeeRate: 0.0001,
      longPerpCloseFeeRate: 0.0005,
      shortPerpTakerFeeRate: 0.0005,
      shortPerpCloseFeeRate: 0.0005,
    });

    expect(atMax).not.toBeNull();
    expect(atMax?.grossProfitUsd).toBeCloseTo(55.20548, 4);
    expect(atMax?.borosOpeningFeeUsd).toBeCloseTo(1.36986, 4);
    expect(atMax?.borosSettlementFeeUsd).toBeCloseTo(2.73973, 4);
    expect(atMax?.longPerpTradingFeeUsd).toBe(10);
    expect(atMax?.shortPerpTradingFeeUsd).toBe(10);
    expect(makerOpenLong?.longPerpTradingFeeUsd).toBeCloseTo(6);
    expect(makerOpenLong?.shortPerpTradingFeeUsd).toBe(10);
    expect(atMax?.entranceFeeUsd).toBe(2);
    expect(atMax?.netProfitUsd).toBeLessThan(atMax?.grossProfitUsd ?? 0);
    expect(lowerLongLeverage?.capitalUsd).toBeGreaterThan(atMax?.capitalUsd ?? 0);
    expect(lowerLongLeverage?.netApr).toBeLessThan(atMax?.netApr ?? 0);
  });

  it('uses Boros rate floors, live maturity, time floors, and kIM for each margin leg', () => {
    const withLiveMarginParameters: BorosStrategy = {
      ...strategy,
      longMarket: {
        ...strategy.longMarket,
        initialMarginFactor: 0.47619047619047616,
        marginRateFloor: 0.06,
        marginTimeFloorSeconds: 864_000,
        timeToMaturitySeconds: 4_204_800,
      },
      shortMarket: {
        ...strategy.shortMarket,
        initialMarginFactor: 0.47619047619047616,
        marginRateFloor: 0.08,
        marginTimeFloorSeconds: 432_000,
        timeToMaturitySeconds: 4_194_000,
      },
    };
    const estimate = borosReturnEstimate({
      strategy: withLiveMarginParameters,
      longLeverage: 25,
      shortLeverage: 40,
      longNotionalUsd: 10_000,
      shortNotionalUsd: 10_000,
      includeEntranceFees: false,
    });

    const longTermYears = 4_204_800 / (365 * 24 * 60 * 60);
    const shortTermYears = 4_194_000 / (365 * 24 * 60 * 60);
    expect(estimate?.longBorosMarginRatio).toBeCloseTo(0.06 * longTermYears * 0.47619047619047616, 10);
    expect(estimate?.shortBorosMarginRatio).toBeCloseTo(0.08 * shortTermYears * 0.47619047619047616, 10);
    expect(estimate?.longBorosMarginUsd).toBeCloseTo(38.095238, 5);
    expect(estimate?.shortBorosMarginUsd).toBeCloseTo(50.663188, 5);
    expect(estimate?.borosMarginUsd).toBeCloseTo((estimate?.longBorosMarginUsd ?? 0) + (estimate?.shortBorosMarginUsd ?? 0), 10);
  });
});
