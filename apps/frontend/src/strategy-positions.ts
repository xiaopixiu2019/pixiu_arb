import type { AuthenticatedPortfolioSnapshot, TradingSnapshot } from './api.js';
import { canonicalPositionAsset, positionGroupKey, positionGroupLabel } from './position-grouping.js';
import { positionFundingFee } from './position-funding-fees.js';
import { parseNumber, symbolParts } from './route-shared.js';
import { convertedTotal } from './position-money.js';

export interface PositionTableRow {
  marginMode?: string | null;
  liquidationPrice?: string | null;
  liquidationPriceCheckedAt?: string | null;
  id: string;
  positionId: string;
  symbol: string;
  venue: string;
  asset: string;
  quote: string;
  side: 'Long' | 'Short';
  quantity: number;
  rawQuantity?: string;
  rawEntryPrice?: string;
  rawMarkPrice?: string;
  value: number;
  initialMargin?: number | null;
  entryPrice: number;
  markPrice: number;
  leverage: string | null;
  unrealizedPnl: number;
  unrealizedAvailable?: boolean;
  valueAvailable?: boolean;
  realizedPnl: number | null;
  fundingFee: number | null;
  crossExAdlRank?: string | null;
  exchangeAdlRank?: string | null;
}

export type StrategyPositionRow = PositionTableRow;

export interface StrategyPositionsView {
  status: 'unavailable' | 'stale' | 'fresh';
  rows: StrategyPositionRow[];
}

export interface PositionTableGroup {
  key: string;
  asset: string;
  label: string;
  mixedAssets: boolean;
  legs: StrategyPositionRow[];
  quantity: number;
  grossQuantity: number;
  grossNotional: number | null;
  weightedEntryPrice: number;
  weightedMarkPrice: number;
  unrealizedPnl: number | null;
  venueCount: number;
  fullyHedged: boolean;
  leverage: string | null;
}

export type StrategyPositionGroup = PositionTableGroup;

export function freshPortfolioMarginBalance(portfolio: AuthenticatedPortfolioSnapshot | null): number | null {
  if (portfolio?.dataStatus !== 'fresh' || portfolio.remoteStatus !== 'healthy') return null;
  const value = parseNumber(portfolio.snapshot.account.marginBalance);
  return value !== null && value > 0 ? value : null;
}

function portfolioRows(portfolio: AuthenticatedPortfolioSnapshot): StrategyPositionRow[] {
  return portfolio.snapshot.futuresPositions
    .map((position): StrategyPositionRow | null => {
      const quantity = parseNumber(position.quantity) ?? 0;
      if (quantity === 0) return null;
      const symbol = symbolParts(position.symbol);
      const markPrice = parseNumber(position.markPrice) ?? 0;
      const reportedValue = Math.abs(parseNumber(position.value) ?? 0);
      return {
        id: `${symbol.venue}:${position.positionId || position.symbol}`,
        positionId: position.positionId,
        symbol: position.symbol,
        venue: symbol.venue,
        asset: symbol.asset,
        quote: symbol.quote,
        side: position.positionSide.toUpperCase() === 'SHORT' || quantity < 0 ? 'Short' : 'Long',
        quantity, rawQuantity: position.quantity, rawEntryPrice: position.entryPrice, rawMarkPrice: position.markPrice,
        value: reportedValue > 0 ? reportedValue : Math.abs(quantity * markPrice),
        initialMargin: parseNumber(position.initialMargin),
        entryPrice: parseNumber(position.entryPrice) ?? 0,
        markPrice,
        marginMode: portfolio.dataStatus === 'fresh' && portfolio.remoteStatus === 'healthy' ? position.marginMode : null,
        liquidationPrice: position.liquidationPrice,
        liquidationPriceCheckedAt: position.liquidationPriceCheckedAt,
        leverage: position.leverage || null,
        unrealizedPnl: parseNumber(position.unrealizedPnl) ?? 0,
        unrealizedAvailable: parseNumber(position.unrealizedPnl) !== null,
        valueAvailable: parseNumber(position.value) !== null,
        realizedPnl: parseNumber(position.realizedPnl),
        fundingFee: parseNumber(position.fundingFee),
        crossExAdlRank: position.crossExAdlRank ?? null,
        exchangeAdlRank: position.exchangeAdlRank ?? null,
      };
    })
    .filter((row): row is StrategyPositionRow => row !== null);
}

export function prepareExecutionPositionRows(
  snapshot: TradingSnapshot,
  portfolio: AuthenticatedPortfolioSnapshot | null,
  options: { allowStalePortfolio?: boolean } = {},
): StrategyPositionRow[] {
  const freshPortfolioPositions = portfolio && (options.allowStalePortfolio || (portfolio.dataStatus === 'fresh' && portfolio.remoteStatus === 'healthy'))
    ? portfolio.snapshot.futuresPositions
    : [];
  const freshMarginPositions = portfolio?.dataStatus === 'fresh' && portfolio.remoteStatus === 'healthy'
    ? portfolio.snapshot.futuresPositions
    : [];

  return snapshot.positions
    .map((position): StrategyPositionRow | null => {
      const quantity = parseNumber(position.quantity) ?? 0;
      if (quantity === 0) return null;
      const symbol = symbolParts(position.symbol);
      const entryPrice = parseNumber(position.entry_price) ?? 0;
      const markPrice = parseNumber(position.mark_price) ?? 0;
      const portfolioPosition = freshPortfolioPositions.find((candidate) =>
        candidate.positionId === position.position_id || candidate.symbol === position.symbol);
      const marginPosition = freshMarginPositions.find((candidate) =>
        candidate.positionId === position.position_id || candidate.symbol === position.symbol);
      const reportedPnl = portfolioPosition ? parseNumber(portfolioPosition.unrealizedPnl) : null;
      return {
        id: `${symbol.venue}:${position.position_id || position.symbol}`,
        positionId: position.position_id,
        symbol: position.symbol,
        venue: symbol.venue,
        asset: symbol.asset,
        quote: symbol.quote,
        side: quantity < 0 ? 'Short' : 'Long',
        quantity, rawQuantity: position.quantity, rawEntryPrice: position.entry_price, rawMarkPrice: position.mark_price,
        value: Math.abs(quantity * markPrice),
        initialMargin: parseNumber(marginPosition?.initialMargin),
        entryPrice,
        markPrice,
        marginMode: marginPosition?.marginMode,
        liquidationPrice: marginPosition?.liquidationPrice,
        liquidationPriceCheckedAt: marginPosition?.liquidationPriceCheckedAt,
        leverage: portfolioPosition?.leverage || null,
        unrealizedPnl: reportedPnl ?? ((markPrice - entryPrice) * quantity),
        unrealizedAvailable: reportedPnl !== null || (parseNumber(position.mark_price) !== null && parseNumber(position.entry_price) !== null),
        valueAvailable: parseNumber(position.mark_price) !== null,
        realizedPnl: parseNumber(position.realized_pnl),
        fundingFee: positionFundingFee(position, freshPortfolioPositions),
        crossExAdlRank: portfolioPosition?.crossExAdlRank ?? null,
        exchangeAdlRank: portfolioPosition?.exchangeAdlRank ?? null,
      };
    })
    .filter((row): row is StrategyPositionRow => row !== null);
}

function marketKey(row: StrategyPositionRow): string {
  return `${row.venue}:${row.asset}:${row.quote}`;
}

/**
 * Use the same execution-position snapshot shown by the trading page. A healthy portfolio
 * snapshot enriches those rows with leverage and reported PnL and also fills any missing legs.
 */
export function prepareStrategyPositions(
  portfolio: AuthenticatedPortfolioSnapshot | null,
  tradingSnapshot: TradingSnapshot | null = null,
  options: { retainStalePortfolio?: boolean } = {},
): StrategyPositionsView {
  const portfolioFresh = portfolio?.dataStatus === 'fresh' && portfolio.remoteStatus === 'healthy';
  if (!portfolioFresh && options.retainStalePortfolio) return portfolio
    ? { status: 'stale', rows: portfolioRows(portfolio).sort((a, b) => b.value - a.value) }
    : { status: 'unavailable', rows: [] };
  if (!tradingSnapshot && !portfolio) return { status: 'unavailable', rows: [] };
  if (!tradingSnapshot && !portfolioFresh) return { status: 'stale', rows: [] };

  const rowsByMarket = new Map<string, StrategyPositionRow>();
  if (portfolioFresh && portfolio) {
    for (const row of portfolioRows(portfolio)) rowsByMarket.set(marketKey(row), row);
  }
  if (tradingSnapshot) {
    for (const row of prepareExecutionPositionRows(tradingSnapshot, portfolio)) rowsByMarket.set(marketKey(row), row);
  }
  const rows = [...rowsByMarket.values()].sort((left, right) => right.value - left.value);

  return { status: portfolioFresh ? 'fresh' : 'stale', rows };
}

/** Match the trading terminal's position grouping: one expandable row per asset. */
export function groupPositionRows(rows: readonly PositionTableRow[], rates?: Record<string,string>): PositionTableGroup[] {
  const groups = new Map<string, StrategyPositionRow[]>();
  for (const row of rows) {
    const key = positionGroupKey(row.asset, row.venue);
    const legs = groups.get(key) ?? [];
    legs.push(row);
    groups.set(key, legs);
  }

  return [...groups.entries()].map(([groupKey, legs]) => {
    const assets = [...new Set(legs.map((leg) => canonicalPositionAsset(leg.asset, leg.venue)))];
    const asset = assets[0];
    const mixedAssets = assets.length > 1;
    const quantity = legs.reduce((sum, leg) => sum + leg.quantity, 0);
    const grossQuantity = legs.reduce((sum, leg) => sum + Math.abs(leg.quantity), 0);
    const grossNotional = convertedTotal(legs,(_,i)=>legs[i].valueAvailable===false?null:legs[i].value,rates);
    const leverages = new Set(legs.map((leg) => leg.leverage));
    return {
      key: `${groupKey}-PERP`,
      asset,
      label: positionGroupLabel(assets),
      mixedAssets,
      legs,
      quantity,
      grossQuantity,
      grossNotional,
      weightedEntryPrice: grossQuantity > 0
        ? legs.reduce((sum, leg) => sum + leg.entryPrice * Math.abs(leg.quantity), 0) / grossQuantity
        : 0,
      weightedMarkPrice: grossQuantity > 0
        ? legs.reduce((sum, leg) => sum + leg.markPrice * Math.abs(leg.quantity), 0) / grossQuantity
        : 0,
      unrealizedPnl: convertedTotal(legs,(_,i)=>legs[i].unrealizedAvailable===false?null:legs[i].unrealizedPnl,rates),
      venueCount: new Set(legs.map((leg) => leg.venue)).size,
      fullyHedged: mixedAssets
        ? legs.some((leg) => leg.quantity > 0) && legs.some((leg) => leg.quantity < 0)
        : grossQuantity > 0 && Math.abs(quantity) <= Math.max(1e-12, grossQuantity * 1e-9),
      leverage: leverages.size === 1 ? [...leverages][0] : null,
    };
  });
}

export const groupStrategyPositions = groupPositionRows;
