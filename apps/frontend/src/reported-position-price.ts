import type { PositionTableRow } from './strategy-positions.js';

export type PriceKind = 'entry' | 'mark';

/** Raw source presence distinguishes missing data from an explicitly reported zero. */
export function reportedPositionPrice(row: PositionTableRow, kind: PriceKind): string | null {
  const rawKey = kind === 'entry' ? 'rawEntryPrice' : 'rawMarkPrice';
  const raw = Object.hasOwn(row, rawKey) ? row[rawKey] : String(kind === 'entry' ? row.entryPrice : row.markPrice);
  if (typeof raw !== 'string' || !/^(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(raw.trim())) return null;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? raw.trim() : null;
}
