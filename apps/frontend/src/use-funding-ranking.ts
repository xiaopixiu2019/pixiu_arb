import { useEffect, useRef, useState } from 'react';
import { api, type FundingHistoryEntry } from './api.js';
import { applyFundingAssetOrder } from './funding-rates.js';
import type { FundingPairRow } from './funding-row.js';
import { fundingArb, pairPriceSpread, sortedFundingOrder, type VisibleFundingExchange } from './funding-sort.js';
import { exchanges, type FundingMetric, type FundingSortKey, type SortDirection } from './route-shared.js';

type History = Record<string, FundingHistoryEntry>;
interface RankingInput {
  rows: FundingPairRow[];
  scope: string;
  source: 'overview' | 'fallback' | null;
  sortKey: FundingSortKey;
  direction: SortDirection;
  metric: FundingMetric;
  venues: readonly VisibleFundingExchange[];
  history: History;
  onHistory: (duration: 1 | 7 | 30, entries: FundingHistoryEntry[]) => void;
  quotes: { key: string; completedKey: string | null; loading: boolean };
}

function pairSymbols(input: RankingInput, history: History): string {
  return [...new Set([...input.rows].sort((a, b) => a.asset.localeCompare(b.asset)).flatMap((row) => {
    const arb = fundingArb(row, input.venues, input.metric, history);
    return [arb.low, arb.high].flatMap((leg) => {
      const symbol = row.symbols[exchanges.findIndex((venue) => venue.id === leg?.venue.id)];
      return symbol ? [symbol] : [];
    });
  }))].join(',');
}

/** A single bounded collection, never a subscription to future quote changes. */
async function waitForQuotes(ready: () => boolean, signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve) => {
    const done = () => { clearInterval(poll); clearTimeout(deadline); signal.removeEventListener('abort', done); resolve(); };
    const poll = setInterval(() => { if (ready()) done(); }, 50);
    const deadline = setTimeout(done, 15_000);
    signal.addEventListener('abort', done, { once: true });
    if (signal.aborted || ready()) done();
  });
}

async function rankingHistory(input: RankingInput, signal: AbortSignal) {
  let history = input.history;
  const { metric, sortKey } = input;
  if (!['24h', '7d', '30d'].includes(metric) || sortKey === 'asset' || sortKey === 'oi') return { history, incomplete: false };
  const symbols = [...new Set(input.rows.flatMap((row) => input.venues.flatMap(({ index }) => row.symbols[index] ?? [])))];
  const duration = metric === '24h' ? 1 : metric === '7d' ? 7 : 30;
  try {
    const result = symbols.length ? await api.fundingRankings(symbols, duration, signal) : null;
    if (result && !signal.aborted) {
      history = { ...history, ...Object.fromEntries(result.entries.map((entry) => [entry.symbol, entry])) };
      input.onHistory(duration, result.entries);
    }
    const incomplete = symbols.some((symbol) => history[symbol]?.status !== 'ok'
      || (duration === 1 ? history[symbol].rate24h : duration === 7 ? history[symbol].rate7d : history[symbol].rate30d) === null);
    return { history, incomplete };
  } catch {
    return { history, incomplete: true };
  }
}

async function prepareRanking(start: RankingInput, current: () => RankingInput, signal: AbortSignal) {
  const { history, incomplete } = await rankingHistory(start, signal);
  if (signal.aborted) return null;
  if (start.sortKey === 'priceSpread') {
    const expected = pairSymbols(start, history);
    if (expected) await waitForQuotes(() => {
      const quotes = current().quotes;
      return quotes.key === expected && quotes.completedKey === expected && !quotes.loading;
    }, signal);
  }
  if (signal.aborted) return null;
  const rows = current().rows;
  const order = sortedFundingOrder(rows, start.sortKey, start.direction, start.venues, start.metric, history);
  const coverage = start.sortKey === 'priceSpread' ? { total: rows.length,
    available: rows.filter((row) => pairPriceSpread(row, fundingArb(row, start.venues, start.metric, history)) !== null).length } : null;
  return { applied: applyFundingAssetOrder(rows, order), coverage, incomplete };
}

export function useFundingRanking(input: RankingInput) {
  const latest = useRef(input);
  latest.current = input;
  const [refresh, setRefresh] = useState(0);
  const [applied, setApplied] = useState<FundingPairRow[] | null>(null);
  const [preparing, setPreparing] = useState(false);
  const [historyIncomplete, setHistoryIncomplete] = useState(false);
  const [coverage, setCoverage] = useState<{ available: number; total: number } | null>(null);
  const { scope, source, sortKey, direction, metric } = input;

  useEffect(() => {
    if (!source) return;
    const controller = new AbortController();
    setPreparing(true);
    setHistoryIncomplete(false);
    setCoverage(null);
    void prepareRanking(latest.current, () => latest.current, controller.signal).then((result) => {
      if (!result || controller.signal.aborted) return;
      setApplied(result.applied);
      setCoverage(result.coverage);
      setHistoryIncomplete(result.incomplete);
      setPreparing(false);
    });
    return () => controller.abort();
  }, [scope, source, sortKey, direction, metric, refresh]);

  return { applied, preparing, coverage, historyIncomplete, update: () => setRefresh((value) => value + 1) };
}
