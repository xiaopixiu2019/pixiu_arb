import type { PortfolioFuturesPosition } from '@gate-crossex/shared-types';

export interface AdlRankDisplay {
  key: string;
  venue: string;
  crossExRank?: string | null;
  exchangeRank?: string | null;
}

export interface AdlPositionReference {
  positionId?: string | null;
  symbol: string;
  venue: string;
}

export type AdlRiskTone = 'unavailable' | 'safe' | 'caution' | 'danger';

export function adlRiskTone(level: number | null): AdlRiskTone {
  if (level === null) return 'unavailable';
  if (level <= 2) return 'safe';
  if (level === 3) return 'caution';
  return 'danger';
}

function integerRank(rawRank: string | null | undefined): number | null {
  if (rawRank === null || rawRank === undefined || rawRank.trim() === '') return null;
  const value = Number(rawRank);
  return Number.isInteger(value) ? value : null;
}

export function crossExAdlLightLevel(rawRank: string | null | undefined): number | null {
  const rank = integerRank(rawRank);
  return rank !== null && rank >= 1 && rank <= 5 ? rank : null;
}

/** Convert each venue's documented raw ADL scale to a common 0–5 light count. */
export function exchangeAdlLightLevel(venue: string, rawRank: string | null | undefined): number | null {
  const rank = integerRank(rawRank);
  if (rank === null) return null;
  switch (venue.toUpperCase()) {
    case 'BINANCE':
      return rank >= 0 && rank <= 4 ? rank + 1 : null;
    case 'OKX':
    case 'BYBIT':
      return rank >= 0 && rank <= 5 ? rank : null;
    case 'GATE':
      return rank >= 1 && rank <= 5 ? 6 - rank : null;
    case 'KRAKEN':
      return rank >= 20 && rank <= 100 && rank % 20 === 0 ? Math.ceil((120 - rank) / 20) : null;
    default:
      // Gate currently documents no exchange-rank scale for Hyperliquid or Deribit.
      return null;
  }
}

export function adlRanksForPositions(
  references: readonly AdlPositionReference[],
  portfolioPositions: readonly PortfolioFuturesPosition[],
): AdlRankDisplay[] {
  return references.map((reference, index) => {
    const exact = reference.positionId
      ? portfolioPositions.find((position) => position.positionId === reference.positionId)
      : undefined;
    const position = exact ?? portfolioPositions.find((candidate) => candidate.symbol === reference.symbol);
    return {
      key: `${reference.positionId ?? reference.symbol}:${index}`,
      venue: reference.venue,
      crossExRank: position?.crossExAdlRank ?? null,
      exchangeRank: position?.exchangeAdlRank ?? null,
    };
  });
}
