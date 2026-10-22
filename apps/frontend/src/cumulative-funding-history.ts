export interface FundingSettlementPoint {
  timestamp: number;
  rate: string;
}

export interface CumulativeFundingPoint {
  time: number;
  value: number;
}

/**
 * Convert realized settlement rates (fractions) into a percent-denominated
 * cumulative series. A zero baseline at the requested range start makes
 * differently timed venue series directly comparable.
 */
export function cumulativeFundingHistory(
  settlements: FundingSettlementPoint[],
  rangeFrom: number | null,
): CumulativeFundingPoint[] {
  let cumulative = 0;
  const points = [...settlements]
    .sort((left, right) => left.timestamp - right.timestamp)
    .flatMap((point) => {
      const ratePercent = Number(point.rate) * 100;
      if (!Number.isFinite(ratePercent) || !Number.isFinite(point.timestamp)) return [];
      cumulative += ratePercent;
      return [{ time: point.timestamp, value: cumulative }];
    });

  if (rangeFrom !== null && Number.isFinite(rangeFrom) && points.length > 0 && rangeFrom < points[0].time) {
    points.unshift({ time: rangeFrom, value: 0 });
  }
  return points;
}

export interface RealizedFundingWindow {
  days: number;
  /** Net realized funding percent (short venue minus long venue), or null when a venue has no settlements in the window. */
  value: number | null;
  /** Count of merged settlement timestamps inside the window. */
  settlements: number;
}

/**
 * Net realized funding for a hedged pair over trailing windows carved from one
 * fetched range. Each window covers `(windowStart, rangeEnd]` and re-baselines
 * both venues at its own start, so the value is the actual short-minus-long
 * funding accumulated inside that window regardless of settlement cadence.
 */
export function realizedFundingEdgeWindows(
  longSettlements: FundingSettlementPoint[],
  shortSettlements: FundingSettlementPoint[],
  rangeFrom: number,
  rangeDays: number,
  windowsDays: number[],
): RealizedFundingWindow[] {
  const DAY_MS = 86_400_000;
  return windowsDays.map((days) => {
    const from = rangeFrom + Math.max(0, rangeDays - days) * DAY_MS;
    const longWindow = cumulativeFundingHistory(longSettlements.filter((point) => point.timestamp > from), from);
    const shortWindow = cumulativeFundingHistory(shortSettlements.filter((point) => point.timestamp > from), from);
    const pnl = cumulativeFundingPnl(longWindow, shortWindow);
    if (pnl.length === 0) return { days, value: null, settlements: 0 };
    // The first merged point is the shared zero baseline at the window start.
    return { days, value: pnl[pnl.length - 1].value, settlements: Math.max(0, pnl.length - 1) };
  });
}

/**
 * Combine two stepwise cumulative funding series into the net funding PnL for
 * a hedged position. Positive funding is paid by the long and earned by the
 * short, so net PnL is always `short - long`.
 */
export function cumulativeFundingPnl(
  longHistory: CumulativeFundingPoint[],
  shortHistory: CumulativeFundingPoint[],
): CumulativeFundingPoint[] {
  if (longHistory.length === 0 || shortHistory.length === 0) return [];

  // The chart plots epoch milliseconds at whole-second precision. Exchanges can
  // report the same settlement a few milliseconds apart, so collapse each
  // history to that precision before merging or the chart would receive
  // duplicate timestamps after its seconds conversion.
  const collapseToSeconds = (history: CumulativeFundingPoint[]) => {
    const byTime = new Map<number, number>();
    for (const point of [...history].sort((left, right) => left.time - right.time)) {
      byTime.set(Math.floor(point.time / 1_000) * 1_000, point.value);
    }
    return [...byTime].map(([time, value]) => ({ time, value }));
  };
  const normalizedLong = collapseToSeconds(longHistory);
  const normalizedShort = collapseToSeconds(shortHistory);
  const times = [...new Set([
    ...normalizedLong.map((point) => point.time),
    ...normalizedShort.map((point) => point.time),
  ])].sort((left, right) => left - right);
  const points: CumulativeFundingPoint[] = [];
  let longIndex = 0;
  let shortIndex = 0;
  let longValue: number | null = null;
  let shortValue: number | null = null;

  for (const time of times) {
    while (longIndex < normalizedLong.length && normalizedLong[longIndex].time <= time) {
      longValue = normalizedLong[longIndex].value;
      longIndex += 1;
    }
    while (shortIndex < normalizedShort.length && normalizedShort[shortIndex].time <= time) {
      shortValue = normalizedShort[shortIndex].value;
      shortIndex += 1;
    }
    if (longValue !== null && shortValue !== null) {
      points.push({ time, value: Number((shortValue - longValue).toFixed(12)) });
    }
  }
  return points;
}
