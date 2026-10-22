import type { BorosStrategy, CrossExInstrument, MarketCatalogAsset } from './api.js';
import type { ExchangeLogoId } from './exchange-logos.js';
import { strategyVenueSymbol } from './strategy-asset-options.js';

const BOROS_VENUES: Record<string, ExchangeLogoId> = {
  gate: 'gate',
  binance: 'binance',
  okx: 'okx',
  bybit: 'bybit',
  kraken: 'kraken',
  hyperliquid: 'hyperliquid',
  deribit: 'deribit',
};

export const DEFAULT_BOROS_TAKER_FEE_RATE = 0.0005;
export const DEFAULT_BOROS_SETTLE_FEE_RATE = 0.001;
export const DEFAULT_PERP_TAKER_FEE_RATE = 0.0005;
export const BOROS_ENTRANCE_FEE_USD_PER_MARKET = 1;
const SECONDS_PER_YEAR = 365 * 24 * 60 * 60;

export interface BorosReturnEstimateInput {
  strategy: BorosStrategy;
  longLeverage: number;
  shortLeverage: number;
  longNotionalUsd: number;
  shortNotionalUsd: number;
  longPerpTakerFeeRate?: number;
  shortPerpTakerFeeRate?: number;
  longPerpCloseFeeRate?: number;
  shortPerpCloseFeeRate?: number;
  includeEntranceFees?: boolean;
}

export interface BorosReturnEstimate {
  referenceNotionalUsd: number;
  borosMarginUsd: number;
  longBorosMarginUsd: number;
  shortBorosMarginUsd: number;
  longPerpMarginUsd: number;
  shortPerpMarginUsd: number;
  capitalUsd: number;
  grossProfitUsd: number;
  borosOpeningFeeUsd: number;
  borosSettlementFeeUsd: number;
  longPerpTradingFeeUsd: number;
  shortPerpTradingFeeUsd: number;
  entranceFeeUsd: number;
  totalFeesUsd: number;
  netProfitUsd: number;
  grossApr: number;
  netApr: number;
  grossRoi: number;
  netRoi: number;
  borosMarginRatio: number;
  longBorosMarginRatio: number;
  shortBorosMarginRatio: number;
  longBorosAppliedRate: number;
  shortBorosAppliedRate: number;
  longBorosAppliedTermYears: number;
  shortBorosAppliedTermYears: number;
  longBorosInitialMarginFactor: number;
  shortBorosInitialMarginFactor: number;
  longBorosTakerFeeRate: number;
  shortBorosTakerFeeRate: number;
  longBorosSettleFeeRate: number;
  shortBorosSettleFeeRate: number;
  longPerpTakerFeeRate: number;
  shortPerpTakerFeeRate: number;
  longPerpCloseFeeRate: number;
  shortPerpCloseFeeRate: number;
}

export function borosVenueId(platformName: string): ExchangeLogoId | null {
  return BOROS_VENUES[platformName.trim().toLowerCase()] ?? null;
}

export function borosCrossExSymbols(
  strategy: BorosStrategy,
  catalog: MarketCatalogAsset[] | null,
): { longVenueId: ExchangeLogoId; shortVenueId: ExchangeLogoId; longSymbol: string; shortSymbol: string } | null {
  const longVenueId = borosVenueId(strategy.longMarket.platformName);
  const shortVenueId = borosVenueId(strategy.shortMarket.platformName);
  if (!longVenueId || !shortVenueId) return null;
  return {
    longVenueId,
    shortVenueId,
    longSymbol: strategyVenueSymbol(catalog, longVenueId, strategy.longMarket.assetSymbol),
    shortSymbol: strategyVenueSymbol(catalog, shortVenueId, strategy.shortMarket.assetSymbol),
  };
}

export function borosStrategyIsCrossExReady(
  strategy: BorosStrategy,
  catalog: MarketCatalogAsset[] | null,
  instruments: CrossExInstrument[] | null,
): boolean {
  if (!instruments) return false;
  const symbols = borosCrossExSymbols(strategy, catalog);
  if (!symbols) return false;
  const liveSymbols = new Set(instruments.filter((instrument) => instrument.state === 'live').map((instrument) => instrument.symbol));
  return liveSymbols.has(symbols.longSymbol) && liveSymbols.has(symbols.shortSymbol);
}

export function borosFixedAprPct(strategy: BorosStrategy): number {
  return strategy.aprTimesMaxLeverage * 100;
}

export function borosMarketMaxLeverages(strategy: BorosStrategy): { longLeverage: number; shortLeverage: number } {
  return {
    longLeverage: Math.max(1, Math.floor(strategy.longMarket.maxPerpLeverage)),
    shortLeverage: Math.max(1, Math.floor(strategy.shortMarket.maxPerpLeverage)),
  };
}

export function borosFixedAprPctAtLeverages(
  strategy: BorosStrategy,
  longLeverage: number,
  shortLeverage: number,
): number {
  const estimate = borosReturnEstimate({
    strategy,
    longLeverage,
    shortLeverage,
    longNotionalUsd: 10_000,
    shortNotionalUsd: 10_000,
    includeEntranceFees: false,
  });
  return estimate ? estimate.grossApr * 100 : borosFixedAprPct(strategy);
}

export function borosFixedRoiPct(strategy: BorosStrategy): number {
  return strategy.aprTimesMaxLeverage * strategy.daysToMaturity / 365 * 100;
}

function nonnegativeRate(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) && Number(value) >= 0 ? Number(value) : fallback;
}

function signedTradingRate(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) ? value! : fallback;
}

/**
 * Estimate the fixed-rate strategy economics on the capital actually allocated.
 * Each Boros leg follows the protocol formula:
 * |notional| × max(|rate|, rate floor) × max(time to maturity, time floor) × kIM.
 */
export function borosReturnEstimate(input: BorosReturnEstimateInput): BorosReturnEstimate | null {
  const { strategy } = input;
  const longLeverage = Number(input.longLeverage);
  const shortLeverage = Number(input.shortLeverage);
  const longNotionalUsd = Number(input.longNotionalUsd);
  const shortNotionalUsd = Number(input.shortNotionalUsd);
  if (![longLeverage, shortLeverage, longNotionalUsd, shortNotionalUsd].every(Number.isFinite)
    || longLeverage <= 0 || shortLeverage <= 0 || longNotionalUsd <= 0 || shortNotionalUsd <= 0) return null;

  const fallbackTermSeconds = strategy.daysToMaturity * 24 * 60 * 60;
  const longTermYears = nonnegativeRate(strategy.longMarket.timeToMaturitySeconds, fallbackTermSeconds) / SECONDS_PER_YEAR;
  const shortTermYears = nonnegativeRate(strategy.shortMarket.timeToMaturitySeconds, fallbackTermSeconds) / SECONDS_PER_YEAR;
  const termYears = (longTermYears + shortTermYears) / 2;
  if (!Number.isFinite(termYears) || termYears <= 0) return null;
  const referenceNotionalUsd = (longNotionalUsd + shortNotionalUsd) / 2;
  const longBorosTakerFeeRate = nonnegativeRate(strategy.longMarket.takerFeeRate, DEFAULT_BOROS_TAKER_FEE_RATE);
  const shortBorosTakerFeeRate = nonnegativeRate(strategy.shortMarket.takerFeeRate, DEFAULT_BOROS_TAKER_FEE_RATE);
  const longBorosSettleFeeRate = nonnegativeRate(strategy.longMarket.settleFeeRate, DEFAULT_BOROS_SETTLE_FEE_RATE);
  const shortBorosSettleFeeRate = nonnegativeRate(strategy.shortMarket.settleFeeRate, DEFAULT_BOROS_SETTLE_FEE_RATE);
  const longPerpTakerFeeRate = signedTradingRate(input.longPerpTakerFeeRate, DEFAULT_PERP_TAKER_FEE_RATE);
  const shortPerpTakerFeeRate = signedTradingRate(input.shortPerpTakerFeeRate, DEFAULT_PERP_TAKER_FEE_RATE);
  const longPerpCloseFeeRate = signedTradingRate(input.longPerpCloseFeeRate, DEFAULT_PERP_TAKER_FEE_RATE);
  const shortPerpCloseFeeRate = signedTradingRate(input.shortPerpCloseFeeRate, DEFAULT_PERP_TAKER_FEE_RATE);

  const longBorosAppliedRate = Math.max(Math.abs(strategy.longMarket.impliedApr), strategy.longMarket.marginRateFloor ?? 0);
  const shortBorosAppliedRate = Math.max(Math.abs(strategy.shortMarket.impliedApr), strategy.shortMarket.marginRateFloor ?? 0);
  const longBorosAppliedTermYears = Math.max(longTermYears, (strategy.longMarket.marginTimeFloorSeconds ?? 0) / SECONDS_PER_YEAR);
  const shortBorosAppliedTermYears = Math.max(shortTermYears, (strategy.shortMarket.marginTimeFloorSeconds ?? 0) / SECONDS_PER_YEAR);
  const longBorosInitialMarginFactor = nonnegativeRate(strategy.longMarket.initialMarginFactor, 1 / strategy.longMarket.maxLeverage);
  const shortBorosInitialMarginFactor = nonnegativeRate(strategy.shortMarket.initialMarginFactor, 1 / strategy.shortMarket.maxLeverage);
  const longBorosMarginRatio = longBorosAppliedRate * longBorosAppliedTermYears * longBorosInitialMarginFactor;
  const shortBorosMarginRatio = shortBorosAppliedRate * shortBorosAppliedTermYears * shortBorosInitialMarginFactor;
  const longBorosMarginUsd = longNotionalUsd * longBorosMarginRatio;
  const shortBorosMarginUsd = shortNotionalUsd * shortBorosMarginRatio;
  const borosMarginUsd = longBorosMarginUsd + shortBorosMarginUsd;
  const borosMarginRatio = borosMarginUsd / referenceNotionalUsd;
  const longPerpMarginUsd = longNotionalUsd / longLeverage;
  const shortPerpMarginUsd = shortNotionalUsd / shortLeverage;
  const capitalUsd = borosMarginUsd + longPerpMarginUsd + shortPerpMarginUsd;
  const grossProfitUsd = referenceNotionalUsd * strategy.impliedAprSpread * termYears;
  const borosOpeningFeeUsd = longNotionalUsd * longBorosTakerFeeRate * longTermYears
    + shortNotionalUsd * shortBorosTakerFeeRate * shortTermYears;
  const borosSettlementFeeUsd = longNotionalUsd * longBorosSettleFeeRate * longTermYears
    + shortNotionalUsd * shortBorosSettleFeeRate * shortTermYears;
  // The fixed-rate strategy is held to maturity, so budget one taker fill to open and one to close each perp.
  const longPerpTradingFeeUsd = longNotionalUsd * (longPerpTakerFeeRate + longPerpCloseFeeRate);
  const shortPerpTradingFeeUsd = shortNotionalUsd * (shortPerpTakerFeeRate + shortPerpCloseFeeRate);
  const entranceFeeUsd = input.includeEntranceFees === false ? 0 : BOROS_ENTRANCE_FEE_USD_PER_MARKET * 2;
  const totalFeesUsd = borosOpeningFeeUsd + borosSettlementFeeUsd
    + longPerpTradingFeeUsd + shortPerpTradingFeeUsd + entranceFeeUsd;
  const netProfitUsd = grossProfitUsd - totalFeesUsd;
  const grossRoi = capitalUsd > 0 ? grossProfitUsd / capitalUsd : 0;
  const netRoi = capitalUsd > 0 ? netProfitUsd / capitalUsd : 0;

  return {
    referenceNotionalUsd, borosMarginUsd, longBorosMarginUsd, shortBorosMarginUsd,
    longPerpMarginUsd, shortPerpMarginUsd, capitalUsd,
    grossProfitUsd, borosOpeningFeeUsd, borosSettlementFeeUsd, longPerpTradingFeeUsd,
    shortPerpTradingFeeUsd, entranceFeeUsd, totalFeesUsd, netProfitUsd,
    grossApr: grossRoi / termYears, netApr: netRoi / termYears, grossRoi, netRoi,
    borosMarginRatio, longBorosMarginRatio, shortBorosMarginRatio,
    longBorosAppliedRate, shortBorosAppliedRate, longBorosAppliedTermYears, shortBorosAppliedTermYears,
    longBorosInitialMarginFactor, shortBorosInitialMarginFactor,
    longBorosTakerFeeRate, shortBorosTakerFeeRate,
    longBorosSettleFeeRate, shortBorosSettleFeeRate, longPerpTakerFeeRate, shortPerpTakerFeeRate,
    longPerpCloseFeeRate, shortPerpCloseFeeRate,
  };
}

export function quantityMatchesInstrument(quantityText: string, instrument: CrossExInstrument | undefined): boolean {
  if (!instrument) return false;
  const quantity = Number(quantityText);
  const minimum = Number(instrument.minSize);
  const step = Number(instrument.lotSize);
  if (!Number.isFinite(quantity) || quantity <= 0) return false;
  if (Number.isFinite(minimum) && minimum > 0 && quantity + 1e-12 < minimum) return false;
  if (!Number.isFinite(step) || step <= 0) return true;
  const steps = quantity / step;
  return Math.abs(steps - Math.round(steps)) <= Math.max(1, Math.abs(steps)) * 1e-10;
}
