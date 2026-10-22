import { useReferenceQuotes } from './use-reference-quotes.js';
import { averageFunding, fundingArb, fundingMetricRate, pairPriceSpread } from './funding-sort.js';
import { useFundingRanking } from './use-funding-ranking.js';
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  api,
  type FundingHistoryEntry,
  type FundingHistorySeriesEntry,
  type FundingOverviewAsset,
  type FundingOverviewResponse,
  type FundingOverviewVenueEntry,
  type LiveMarket,
  type MarketSnapshot,
} from './api.js';
import type { FundingChartSeries } from './charts.js';
import { cumulativeFundingHistory } from './cumulative-funding-history.js';
import {
  overviewFundingRates,
  fundingHistoryRequestKey,
} from './funding-rates.js';
import { formatFundingInterval, formatFundingRate, formatOpenInterest } from './funding-display.js';
import { fundingOpenInterest, retainFundingRows, type FundingPairRow } from './funding-row.js';
import { formatPriceSpread } from './funding-price-spread.js';
import { FundingAssetClassFilter, FundingAssetTag, FundingClassificationSource, type FundingAssetClassFilterValue } from './funding-filter-controls.js';
import type { ExchangeLogoId } from './exchange-logos.js';
import {
  FUNDING_VENUE_COLORS,
  SEED_ASSETS,
  VenueIcon,
  assetIcon,
  assetName,
  exchanges,
  fundingVenueName,
  type PairedPositionPrefill,
  type FundingMetric,
  type FundingSortKey,
  type SortDirection,
} from './route-shared.js';
import { useLanguage } from './i18n.js';
const FundingHistoryChart = lazy(() => import('./charts.js').then((module) => ({ default: module.FundingHistoryChart })));
type FundingHistoryDuration = 1 | 7 | 30;
type FundingHistoryCache = Record<FundingHistoryDuration, Record<string, FundingHistoryEntry>>;
function isHistoricalMetric(metric: FundingMetric): metric is '24h' | '7d' | '30d' {
  return metric === '24h' || metric === '7d' || metric === '30d';
}

function historyDuration(metric: FundingMetric): FundingHistoryDuration {
  return metric === '24h' ? 1 : metric === '7d' ? 7 : 30;
}

const OI_FILTER_PRESETS = [
  { label: 'Any', millions: 0 }, { label: '$1M', millions: 1 }, { label: '$5M', millions: 5 },
  { label: '$10M', millions: 10 }, { label: '$50M', millions: 50 },
];
const FUNDING_PAGE_SIZES = [25, 50, 100];
const DEFAULT_MIN_AVG_OI_MILLIONS = '5';
const FUNDING_OVERVIEW_POLL_MS = 30_000;

type FundingDetailDuration = 1 | 7 | 30;
type FundingDetailMode = 'settlement' | 'cumulative';

interface FundingDetailVenueRow {
  symbol: string;
  venue: string;
  name: string;
  color: string;
  mean: number;
  min: number;
  max: number;
  latest: number;
  cumulative: number;
  settlements: number;
  fetchedAt: string;
}

export function FundingDetailView({ asset, onBack, fundingOverview, onFundingOverview }: {
  asset: string;
  onBack: () => void;
  fundingOverview: FundingOverviewResponse | null;
  onFundingOverview: (overview: FundingOverviewResponse) => void;
}) {
  const { t, language, theme } = useLanguage();
  const [duration, setDuration] = useState<FundingDetailDuration>(30);
  const [mode, setMode] = useState<FundingDetailMode>('cumulative');
  const [venues, setVenues] = useState<FundingOverviewVenueEntry[]>(() =>
    fundingOverview?.assets.find((entry) => entry.asset === asset)?.venues ?? []);
  const [seriesBySymbol, setSeriesBySymbol] = useState<Record<string, FundingHistorySeriesEntry>>({});
  const [rangeFrom, setRangeFrom] = useState<number | null>(null);
  const [pending, setPending] = useState(0);
  const [failed, setFailed] = useState(false);
  const locale = language === 'zh' ? 'zh-CN' : 'en-GB';

  useEffect(() => {
    let cancelled = false;
    setFailed(false);
    const cached = fundingOverview?.assets.find((entry) => entry.asset === asset);
    if (cached) {
      setVenues(cached.venues);
      return () => { cancelled = true; };
    }
    if (fundingOverview) {
      setVenues([]);
      setFailed(true);
      return () => { cancelled = true; };
    }
    void api.fundingOverview()
      .then((response) => {
        if (cancelled) return;
        onFundingOverview(response);
        const selected = response.assets.find((entry) => entry.asset === asset);
        if (!selected) {
          setFailed(true);
          setVenues([]);
          return;
        }
        setVenues(selected.venues);
      })
      .catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; };
  }, [asset, fundingOverview, onFundingOverview]);

  useEffect(() => {
    if (venues.length === 0) return;
    let cancelled = false;
    setSeriesBySymbol({});
    setRangeFrom(null);
    setPending(venues.length);
    setFailed(false);
    const symbols = [...new Set(venues.map((venue) => venue.symbol))];
    void api.fundingHistorySeries(symbols, duration)
      .then((response) => {
        if (cancelled) return;
        setSeriesBySymbol(Object.fromEntries(response.entries.map((entry) => [entry.symbol, entry])));
        setRangeFrom(response.from);
      })
      .catch(() => { if (!cancelled) setFailed(true); })
      .finally(() => { if (!cancelled) setPending(0); });
    return () => { cancelled = true; };
  }, [duration, venues]);

  const chartSeries = useMemo<FundingChartSeries[]>(() => venues.flatMap((venue) => {
    const entry = seriesBySymbol[venue.symbol];
    if (!entry || entry.status !== 'ok' || entry.points.length === 0) return [];
    const points = mode === 'cumulative'
      ? cumulativeFundingHistory(entry.points, rangeFrom)
      : entry.points.flatMap((point) => {
          const rate = Number(point.rate) * 100;
          return Number.isFinite(rate) ? [{ time: point.timestamp, value: rate }] : [];
        });
    return [{
      id: venue.symbol,
      label: fundingVenueName(venue.venue),
      color: FUNDING_VENUE_COLORS[venue.venue] ?? '#8aa9ff',
      points,
    }];
  }), [mode, rangeFrom, seriesBySymbol, venues]);

  const rows = useMemo<FundingDetailVenueRow[]>(() => venues.flatMap((venue) => {
    const entry = seriesBySymbol[venue.symbol];
    if (!entry || entry.status !== 'ok') return [];
    const rates = entry.points.map((point) => Number(point.rate) * 100).filter(Number.isFinite);
    if (rates.length === 0) return [];
    const cumulative = rates.reduce((total, rate) => total + rate, 0);
    return [{
      symbol: venue.symbol,
      venue: venue.venue,
      name: fundingVenueName(venue.venue),
      color: FUNDING_VENUE_COLORS[venue.venue] ?? '#8aa9ff',
      mean: cumulative / rates.length,
      min: Math.min(...rates),
      max: Math.max(...rates),
      latest: rates[rates.length - 1] ?? 0,
      cumulative,
      settlements: rates.length,
      fetchedAt: entry.fetchedAt,
    }];
  }).sort((left, right) => right.cumulative - left.cumulative), [seriesBySymbol, venues]);

  const lastUpdatedAt = rows.reduce<number>((newest, row) => {
    const timestamp = Date.parse(row.fetchedAt);
    return Number.isFinite(timestamp) ? Math.max(newest, timestamp) : newest;
  }, Number.NEGATIVE_INFINITY);
  const lastUpdatedText = Number.isFinite(lastUpdatedAt)
    ? new Date(lastUpdatedAt).toLocaleString(locale, {
        month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
      })
    : '—';
  const formatPercent = (value: number, digits = 4) => `${value > 0 ? '+' : ''}${value.toFixed(digits)}%`;

  return <div className="alternate-view funding-detail-view">
    <button className="funding-detail-back" onClick={onBack}><span>←</span>{t('Back to funding rates')}</button>
    <section className="view-heading funding-detail-heading">
      <div className="funding-detail-title">
        <span className="funding-detail-asset">{assetIcon(asset)}</span>
        <div><p className="eyebrow">{asset} · {t('Perpetual futures')}</p><h1>{t('Historical funding')}</h1><p>{t('Realized settlement history across every listed venue.')}</p></div>
      </div>
      <div className="funding-detail-updated"><span>{t('Last updated at')}</span><strong>{lastUpdatedText}</strong><small>{duration}D · {rows.length}/{venues.length || '—'} {t('Exchanges').toLowerCase()}</small></div>
    </section>

    <section className="funding-detail-card terminal-panel">
      <header className="funding-detail-card-head">
        <div><p className="eyebrow">{asset} · {duration}D</p><h2>{t(mode === 'cumulative' ? 'Cumulative funding' : 'Settlement funding')}</h2><small>{t(mode === 'cumulative' ? 'What a position would have paid / earned' : 'Actual rates paid at each settlement')}</small></div>
        <div className="funding-detail-controls">
          <div><span>{t('Duration')}</span>{([1, 7, 30] as FundingDetailDuration[]).map((value) => <button key={value} className={duration === value ? 'active' : ''} onClick={() => setDuration(value)}>{value === 1 ? '24h' : `${value}d`}</button>)}</div>
          <div><button className={mode === 'settlement' ? 'active' : ''} onClick={() => setMode('settlement')}>{t('Per settlement')}</button><button className={mode === 'cumulative' ? 'active' : ''} onClick={() => setMode('cumulative')}>{t('Cumulative')}</button></div>
        </div>
      </header>

      <div className="funding-detail-chart-wrap">
        <Suspense fallback={<div className="funding-history-chart chart-module-loading" role="status">{t('Loading venue histories…')}</div>}>
          <FundingHistoryChart
            series={chartSeries}
            seriesKey={`${asset}:${duration}:${mode}`}
            theme={theme}
            locale={locale}
            placeholder={pending > 0 ? t('Loading venue histories…') : t('Funding history unavailable.')}
            showDataTable={false}
          />
        </Suspense>
        <div className="funding-detail-legend">{chartSeries.map((item) => {
          const latest = item.points[item.points.length - 1]?.value;
          return <span key={item.id}><i style={{ background: item.color }} /><strong>{item.label}</strong><em>{latest === undefined ? '—' : formatPercent(latest)}</em></span>;
        })}</div>
      </div>

      <div className="funding-detail-table-wrap">
        <table className="funding-detail-table">
          <thead><tr><th>{t('Exchange')}</th><th>{t('Mean')}</th><th>{t('Min')}</th><th>{t('Max')}</th><th>{t('Latest')}</th><th>{t('Cumulative')}</th><th>{t('Settlements')}</th></tr></thead>
          <tbody>{rows.map((row) => <tr key={row.symbol}>
            <td><i style={{ background: row.color }} /><span><strong>{row.name}</strong><small>{row.symbol}</small></span></td>
            <td className={row.mean >= 0 ? 'positive' : 'negative'}>{formatPercent(row.mean)}</td>
            <td className={row.min >= 0 ? 'positive' : 'negative'}>{formatPercent(row.min)}</td>
            <td className={row.max >= 0 ? 'positive' : 'negative'}>{formatPercent(row.max)}</td>
            <td className={row.latest >= 0 ? 'positive' : 'negative'}>{formatPercent(row.latest)}</td>
            <td className={row.cumulative >= 0 ? 'positive' : 'negative'}><strong>{formatPercent(row.cumulative)}</strong></td>
            <td>{row.settlements}</td>
          </tr>)}</tbody>
        </table>
        {rows.length === 0 && <div className={`funding-detail-empty${failed ? ' error' : ''}`}>{pending > 0 ? t('Loading venue histories…') : t('Funding history unavailable.')}</div>}
      </div>
      <footer className="funding-detail-footer"><span><i /> {t('Historical settlements stored locally · latest tail refreshed ~15m')}</span><span>{t('Select a duration or chart mode to explore realized funding.')}</span></footer>
    </section>
  </div>;
}
export function FundingRatesView({ marketSnapshot, onMarketFallback, onOpenAsset, onOpenStrategy, metric, onMetricChange, fundingOverview, onFundingOverview, fundingHistoryCache, onFundingHistoryEntries }: {
  marketSnapshot: MarketSnapshot | null;
  onMarketFallback: () => Promise<void>;
  onOpenAsset: (asset: string) => void;
  onOpenStrategy: (prefill: PairedPositionPrefill) => void;
  metric: FundingMetric;
  onMetricChange: (metric: FundingMetric) => void;
  fundingOverview: FundingOverviewResponse | null;
  onFundingOverview: (overview: FundingOverviewResponse) => void;
  fundingHistoryCache: FundingHistoryCache;
  onFundingHistoryEntries: (duration: FundingHistoryDuration, entries: FundingHistoryEntry[]) => void;
}) {
  const { t, language } = useLanguage();
  const [query, setQuery] = useState('');
  const [selectedExchanges, setSelectedExchanges] = useState(exchanges.map((exchange) => exchange.id));
  const [sortKey, setSortKey] = useState<FundingSortKey>('arb');
  const [sortDirection, setSortDirection] = useState<SortDirection>('desc');
  const [overviewState, setOverviewState] = useState<'loading' | 'live' | 'failed'>(fundingOverview ? 'live' : 'loading');
  const [historyPending, setHistoryPending] = useState<Set<string>>(() => new Set());
  const [historyRefreshTick, setHistoryRefreshTick] = useState(0);
  const historySymbolsRef = useRef<string[]>([]);
  const marketFallbackRequestedRef = useRef(false);
  const initialOverviewRef = useRef(fundingOverview);
  const [minOiMillionsText, setMinOiMillionsText] = useState(DEFAULT_MIN_AVG_OI_MILLIONS);
  const [assetClassFilter, setAssetClassFilter] = useState<FundingAssetClassFilterValue>('ALL');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);

  // Reuse the parent cache until its normal refresh boundary when returning from details.
  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;
    const load = () => {
      api.fundingOverview()
        .then((response) => { if (!cancelled) { onFundingOverview(response); setOverviewState('live'); } })
        .catch(() => {
          if (cancelled) return;
          setOverviewState((current) => current === 'live' ? 'live' : 'failed');
          if (!marketFallbackRequestedRef.current) {
            marketFallbackRequestedRef.current = true;
            void onMarketFallback().catch(() => undefined);
          }
        })
        .finally(() => {
          if (!cancelled) {
            timer = window.setTimeout(load, FUNDING_OVERVIEW_POLL_MS);
          }
        });
    };
    const cachedAt = Date.parse(initialOverviewRef.current?.fetchedAt ?? '');
    const initialDelay = Number.isFinite(cachedAt)
      ? Math.min(FUNDING_OVERVIEW_POLL_MS, Math.max(0, FUNDING_OVERVIEW_POLL_MS - (Date.now() - cachedAt)))
      : 0;
    timer = window.setTimeout(load, initialDelay);
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [onFundingOverview, onMarketFallback]);

  const [quoteSymbols, setQuoteSymbols] = useState<string[]>([]);
  const referenceQuotes = useReferenceQuotes(quoteSymbols);
  const [visibleQuoteSymbols, setVisibleQuoteSymbols] = useState<string[]>([]);
  // A slow full-market price ranking must not hold the displayed page's quotes hostage.
  const visibleQuotes = useReferenceQuotes(sortKey === 'priceSpread' ? visibleQuoteSymbols : [], 5_000);
  const overview = fundingOverview;
  const historicalMetric = isHistoricalMetric(metric);
  const historyDurationDays = historyDuration(metric);
  const historyBySymbol = fundingHistoryCache[historyDurationDays];
  const historyBySymbolRef = useRef<Record<string, FundingHistoryEntry>>(historyBySymbol);
  historyBySymbolRef.current = historyBySymbol;

  const allPairs = useMemo<FundingPairRow[]>(() => {
    const quoteBySymbol = new Map(referenceQuotes.entries.map((entry) => [entry.symbol, entry]));
    for (const entry of visibleQuotes.entries) {
      const previous = quoteBySymbol.get(entry.symbol);
      if (!previous || entry.fetchedAt >= previous.fetchedAt) quoteBySymbol.set(entry.symbol, entry);
    }
    const overviewAssets = new Map<string, FundingOverviewAsset>();
    for (const item of overview?.assets ?? []) overviewAssets.set(item.asset, item);
    const codes = new Set<string>(overviewAssets.keys());
    const useFallback = !overview && overviewState === 'failed';
    if (useFallback) for (const market of marketSnapshot?.markets ?? []) codes.add(market.asset);
    if (useFallback && codes.size === 0) for (const asset of SEED_ASSETS) codes.add(asset);
    const hubMarkets = new Map<string, LiveMarket>();
    for (const market of marketSnapshot?.markets ?? []) hubMarkets.set(`${market.venue}:${market.asset}`, market);
    return [...codes].map((asset) => {
      const entryByVenue = new Map<string, FundingOverviewVenueEntry>();
      for (const entry of overviewAssets.get(asset)?.venues ?? []) entryByVenue.set(entry.venue, entry);
      const rates: Array<number | null> = [];
      const rates8h: Array<number | null> = [];
      const intervalHours: Array<number | null> = [];
      const symbols: Array<string | null> = [];
      const listed: boolean[] = [];
      const oiValues: Array<number | null> = [];
      let oi = 0;
      let oiVenues = 0;
      for (const exchange of exchanges) {
        const venueCode = exchange.id.toUpperCase();
        const entry = entryByVenue.get(venueCode);
        const hub = hubMarkets.get(`${venueCode}:${asset}`);
        const hubLive = hub && hub.source === 'gate_crossex_websocket' ? hub : null;
        // Funding has one overview source shared with execution previews. Ticker
        // source flags cannot authenticate their separate funding fields.
        const interval = entry?.fundingIntervalHours ?? null;
        const { rate, rate8h } = overviewFundingRates(entry);
        const venueOi = entry?.openInterestValue != null ? Number(entry.openInterestValue)
          : hubLive && Number(hubLive.openInterestValue) > 0 ? Number(hubLive.openInterestValue)
            : useFallback && hub ? Number(hub.openInterestValue) : 0;
        const validVenueOi = Number.isFinite(venueOi) && venueOi > 0 ? venueOi : null;
        oiValues.push(validVenueOi);
        if (validVenueOi !== null) { oi += validVenueOi; oiVenues += 1; }
        rates.push(rate !== null && Number.isFinite(rate) ? rate : null);
        rates8h.push(rate8h !== null && Number.isFinite(rate8h) ? rate8h : null);
        intervalHours.push(interval);
        symbols.push(entry?.symbol ?? null);
        listed.push(Boolean(entry) || Boolean(hub));
      }
      return {
        asset,
        assetClass: overviewAssets.get(asset)?.assetClass ?? 'UNCLASSIFIED',
        name: assetName(asset),
        icon: assetIcon(asset),
        rates,
        rates8h,
        intervalHours,
        symbols,
        listed,
        oiValues,
        oi,
        avgOi: oiVenues > 0 ? oi / oiVenues : 0,
        oiVenues,
        referenceQuotes: [...entryByVenue.values()].flatMap((entry) => quoteBySymbol.get(entry.symbol) ?? []),
        priceSnapshot: {
          venues: [...entryByVenue.values()],
          healthyVenues: overview?.venueStatus.filter((entry) => entry.status === 'ok').map((entry) => entry.venue) ?? [],
          fresh: overview?.cacheStatus === 'fresh',
          checkedAt: Math.max(referenceQuotes.checkedAt, visibleQuotes.checkedAt),
        },
      };
    });
  }, [overview, overviewState, marketSnapshot, referenceQuotes.entries, referenceQuotes.checkedAt, visibleQuotes.entries, visibleQuotes.checkedAt]);

  const parsedMinOi = Number(minOiMillionsText);
  const minAvgOiUsd = Number.isFinite(parsedMinOi) && parsedMinOi > 0 ? parsedMinOi * 1_000_000 : 0;
  const visibleExchanges = useMemo(
    () => exchanges.map((venue, index) => ({ venue, index })).filter(({ venue }) => selectedExchanges.includes(venue.id)),
    [selectedExchanges],
  );
  const scopedPairs = useMemo(
    () => allPairs.map((item) => ({ ...item, ...fundingOpenInterest(item, visibleExchanges) })),
    [allPairs, visibleExchanges],
  );

  const metricRate = useCallback((item: FundingPairRow, venueIndex: number): number | null => {
    return fundingMetricRate(item, venueIndex, metric, historyBySymbol);
  }, [historyBySymbol, metric]);

  const getArb = useCallback((item: FundingPairRow) => {
    return fundingArb(item, visibleExchanges, metric, historyBySymbol);
  }, [historyBySymbol, metric, visibleExchanges]);

  const getAverage = useCallback((item: FundingPairRow) => {
    return averageFunding(item, visibleExchanges, metric, historyBySymbol);
  }, [historyBySymbol, metric, visibleExchanges]);

  const matchedMarkets = useMemo(() => scopedPairs.filter((item) => (
    `${item.asset} ${item.name}`.toLowerCase().includes(query.toLowerCase())
    && item.avgOi >= minAvgOiUsd
    && (assetClassFilter === 'ALL' || item.assetClass === assetClassFilter)
  )), [assetClassFilter, minAvgOiUsd, query, scopedPairs]);
  const ranking = useFundingRanking({
    rows: matchedMarkets, scope: JSON.stringify([query, minAvgOiUsd, assetClassFilter, selectedExchanges]),
    source: overview ? 'overview' : overviewState === 'failed' ? 'fallback' : null,
    sortKey, direction: sortDirection, metric, venues: visibleExchanges, history: historyBySymbol,
    onHistory: onFundingHistoryEntries, quotes: referenceQuotes,
  });
  const preparingSort = ranking.preparing ? sortKey : null;
  const filteredMarkets = useMemo(() => retainFundingRows(ranking.applied ?? [], scopedPairs), [ranking.applied, scopedPairs]);
  const matchedAssets = new Set(matchedMarkets.map((row) => row.asset));
  const membershipChanged = ranking.applied !== null && (matchedAssets.size !== ranking.applied.length
    || ranking.applied.some((row) => !matchedAssets.has(row.asset)));

  const totalPages = Math.max(1, Math.ceil(filteredMarkets.length / pageSize));
  const currentPage = Math.min(page, totalPages);
  const pageStart = (currentPage - 1) * pageSize;
  const visibleMarkets = useMemo(
    () => filteredMarkets.slice(pageStart, pageStart + pageSize),
    [filteredMarkets, pageStart, pageSize],
  );
  const selectedPairSymbols = (rows: readonly FundingPairRow[]) => [...rows].sort((left, right) => left.asset.localeCompare(right.asset)).flatMap((item) => {
    const arb = getArb(item);
    return [arb.low, arb.high].flatMap((leg) => {
      const symbol = item.symbols[exchanges.findIndex((venue) => venue.id === leg?.venue.id)];
      return symbol ? [symbol] : [];
    });
  }).join(',');
  const quoteRequestKey = selectedPairSymbols(sortKey === 'priceSpread' ? matchedMarkets : visibleMarkets);
  const visibleQuoteKey = sortKey === 'priceSpread' ? selectedPairSymbols(visibleMarkets) : '';
  useEffect(() => { setQuoteSymbols(quoteRequestKey ? quoteRequestKey.split(',') : []); }, [quoteRequestKey]);
  useEffect(() => { setVisibleQuoteSymbols(visibleQuoteKey ? visibleQuoteKey.split(',') : []); }, [visibleQuoteKey]);
  const maxOi = Math.max(...filteredMarkets.map((item) => item.oi), 1);
  const historySymbols = useMemo(() => {
    if (metric !== '24h' && metric !== '7d' && metric !== '30d') return [];
    const symbols = new Set<string>();
    for (const item of visibleMarkets) for (const { index } of visibleExchanges) {
      const symbol = item.symbols[index];
      if (symbol) symbols.add(symbol);
    }
    return [...symbols];
  }, [metric, visibleMarkets, visibleExchanges]);
  const historyRequestKey = `${historyDurationDays}:${fundingHistoryRequestKey(historySymbols)}`;
  historySymbolsRef.current = historySymbols;
  const historicalUpdatedAt = historicalMetric
    ? historySymbols.reduce<number>((newest, symbol) => {
        const entry = historyBySymbol[symbol];
        if (entry?.status !== 'ok') return newest;
        const timestamp = Date.parse(entry.fetchedAt);
        return Number.isFinite(timestamp) ? Math.max(newest, timestamp) : newest;
      }, Number.NEGATIVE_INFINITY)
    : Number.NEGATIVE_INFINITY;
  const currentUpdatedAt = Date.parse(overview?.fetchedAt ?? marketSnapshot?.updatedAt ?? '');
  const lastUpdatedAt = historicalMetric && Number.isFinite(historicalUpdatedAt)
    ? historicalUpdatedAt
    : currentUpdatedAt;
  const lastUpdatedIso = Number.isFinite(lastUpdatedAt) ? new Date(lastUpdatedAt).toISOString() : undefined;
  const lastUpdatedText = Number.isFinite(lastUpdatedAt)
    ? new Date(lastUpdatedAt).toLocaleString(language === 'zh' ? 'zh-CN' : 'en-GB', {
        month: 'short',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
      })
    : '—';

  useEffect(() => {
    const requestedSymbols = historySymbolsRef.current.filter(
      (symbol) => {
        const entry = historyBySymbolRef.current[symbol];
        if (entry?.status === 'unavailable') return false;
        if (entry?.status !== 'ok') return true;
        return historyDurationDays === 1 ? entry.rate24h === null
          : historyDurationDays === 7 ? entry.rate7d === null
            : entry.rate30d === null;
      },
    );
    if (requestedSymbols.length === 0) {
      setHistoryPending((current) => current.size === 0 ? current : new Set());
      return;
    }
    let cancelled = false;
    let retryTimer: number | undefined;
    const load = async () => {
      setHistoryPending(new Set(requestedSymbols));
      const batches: string[][] = [];
      for (let offset = 0; offset < requestedSymbols.length; offset += 50) {
        batches.push(requestedSymbols.slice(offset, offset + 50));
      }
      // The endpoint is SQLite-first and returns immediately. Launch every batch
      // together so missing venue ranges can warm in parallel behind cached rows.
      const results = await Promise.all(batches.map(async (batch) => {
        try {
          return { batch, response: await api.fundingHistory(batch, historyDurationDays) };
        } catch {
          return { batch, response: null };
        }
      }));
      if (cancelled) return;

      const retrySymbols = new Set<string>();
      const entries: FundingHistoryEntry[] = [];
      for (const result of results) {
        if (!result.response) {
          for (const symbol of result.batch) retrySymbols.add(symbol);
          continue;
        }
        for (const entry of result.response.entries) {
          entries.push(entry);
          if (entry.status === 'pending') retrySymbols.add(entry.symbol);
        }
      }
      onFundingHistoryEntries(historyDurationDays, entries);
      setHistoryPending(retrySymbols);
      if (retrySymbols.size > 0) {
        retryTimer = window.setTimeout(() => setHistoryRefreshTick((current) => current + 1), 8_000);
      }
    };
    void load();
    return () => {
      cancelled = true;
      if (retryTimer !== undefined) window.clearTimeout(retryTimer);
    };
  }, [historyRequestKey, historyDurationDays, historyRefreshTick, onFundingHistoryEntries]);

  function toggleExchange(exchangeId: ExchangeLogoId) {
    const removing = selectedExchanges.includes(exchangeId);
    if (removing && selectedExchanges.length === 1) return;
    setPage(1);
    setSelectedExchanges((current) => removing ? current.filter((id) => id !== exchangeId) : [...current, exchangeId]);
    if (removing && sortKey === exchangeId) {
      setSortKey('oi');
      setSortDirection('desc');
    }
  }

  function changeSort(nextKey: FundingSortKey) {
    setSortDirection(sortKey === nextKey ? sortDirection === 'desc' ? 'asc' : 'desc' : nextKey === 'asset' ? 'asc' : 'desc');
    setSortKey(nextKey);
    setPage(1);
  }

  function changeMetric(nextMetric: FundingMetric) {
    if (nextMetric === metric) return;
    setPage(1);
    onMetricChange(nextMetric);
  }

  function sortMark(key: FundingSortKey) {
    if (preparingSort === key) return <span className="sort-mark active" aria-hidden="true">…</span>;
    return <span className={sortKey === key ? 'sort-mark active' : 'sort-mark'}>{sortKey === key ? sortDirection === 'desc' ? '↓' : '↑' : '↕'}</span>;
  }

  if (!overview && overviewState === 'loading') {
    return <div className="alternate-view funding-view">
      <section className="view-heading funding-heading">
        <div><p className="eyebrow">{t('Perpetual futures')}</p><h1>{t('Funding rate matrix.')}</h1><p>{t('Compare annualized funding spreads across exchanges.')}</p></div>
      </section>
      <section className="funding-card funding-skeleton terminal-panel" role="status" aria-label={t('Loading all trading pairs…')}>
        <div className="funding-skeleton-filters"><i /><i /><i /><i /><i /></div>
        <div className="funding-skeleton-toolbar"><i /><i /><i /></div>
        <div className="funding-skeleton-table">
          <div className="funding-skeleton-head" />
          {Array.from({ length: 8 }, (_, index) => <div className="funding-skeleton-row" key={index}><i /><i /><i /><i /><i /><i /></div>)}
        </div>
        <span className="sr-only">{t('Loading all trading pairs…')}</span>
      </section>
    </div>;
  }

  return <div className="alternate-view funding-view">
    <section className="view-heading funding-heading">
      <div><p className="eyebrow">{t('Perpetual futures')}</p><h1>{t('Funding rate matrix.')}</h1><p>{t('Compare annualized funding spreads across exchanges.')}</p></div>
    </section>

    <section className="funding-card terminal-panel">
      <div className="exchange-filter" role="group" aria-label="Filter exchanges">
        <span>{t('Exchanges')}</span>
        {exchanges.map((venue) => <button key={venue.id} className={selectedExchanges.includes(venue.id) ? 'selected' : ''} aria-pressed={selectedExchanges.includes(venue.id)} onClick={() => toggleExchange(venue.id)}><VenueIcon id={venue.id} short={venue.short} />{venue.name}<em>{selectedExchanges.includes(venue.id) ? '✓' : '+'}</em></button>)}
        <small>{selectedExchanges.length} {t('selected')} · {t('at least one required')}</small>
      </div>
      <div className="oi-filter" role="group" aria-label="Minimum average open interest">
        <span>{t('Min average OI')}</span>
        {OI_FILTER_PRESETS.map((preset) => {
          const active = minAvgOiUsd === preset.millions * 1_000_000;
          return <button key={preset.label} className={active ? 'selected' : ''} aria-pressed={active} onClick={() => { setPage(1); setMinOiMillionsText(preset.millions === 0 ? '' : String(preset.millions)); }}>{preset.label === 'Any' ? t('Any') : preset.label}</button>;
        })}
        <label className="oi-custom"><span>$</span><input inputMode="decimal" value={minOiMillionsText} onChange={(event) => { setPage(1); setMinOiMillionsText(event.target.value.replace(/[^0-9.]/g, '')); }} placeholder="0" aria-label={t('Min average OI')} /><span>M</span></label>
        <small>{overviewState === 'loading' && !overview ? t('Loading all trading pairs…') : `${filteredMarkets.length} / ${allPairs.length} ${t('pairs')}`}</small>
      </div>
      <FundingAssetClassFilter
        value={assetClassFilter}
        onChange={(value) => { setPage(1); setAssetClassFilter(value); }}
        t={t}
      />
      <div className="funding-toolbar">
        <label className="funding-search"><span aria-hidden="true">⌕</span><input value={query} onChange={(event) => { setPage(1); setQuery(event.target.value); }} placeholder={t('Search asset')} aria-label={t('Search asset')} /></label>
        <div className="metric-switch" role="group" aria-label="Funding rate period">
          {(['Per interval', 'APR', '24h', '7d', '30d'] as FundingMetric[]).map((item) => <button key={item} className={metric === item ? 'active' : ''} aria-pressed={metric === item} onClick={() => changeMetric(item)}>{item === '24h' || item === '7d' || item === '30d' ? t(`Cumulative ${item}`) : t(item)}</button>)}
        </div>
        {preparingSort && <small className="funding-sort-status" role="status">{t('Preparing sort…')}</small>}
        <small className="funding-last-updated">{t('Last updated at')} <time dateTime={lastUpdatedIso}>{lastUpdatedText}</time></small>
      </div>
      <div className="funding-ranking-controls">
        <span>{t('Values keep updating · order stays until you update ranking')}</span>
        <button type="button" disabled={ranking.preparing} onClick={() => { setPage(1); ranking.update(); }}>{t('Update ranking')}</button>
        {sortKey === 'priceSpread' && referenceQuotes.loading && <small role="status">{t('Loading reference quotes; order stays in place…')}</small>}
        {ranking.coverage && <small role="status">{t('Quotes available at ranking')}: {ranking.coverage.available}/{ranking.coverage.total}</small>}
        {ranking.historyIncomplete && <small role="status">{t('History incomplete; ranked available values.')}</small>}
        {membershipChanged && <small role="status">{t('Filter matches changed; update ranking to apply.')}</small>}
      </div>
      <div className="funding-table-wrap" aria-busy={preparingSort !== null}>
        <table className="funding-table">
          <thead><tr>
            <th><button className="sort-header asset-sort" onClick={() => changeSort('asset')}>{t('Asset')} {sortMark('asset')}</button></th>
            <th><button className="sort-header" onClick={() => changeSort('oi')}>{t('Open interest')} {sortMark('oi')}</button></th>
            <th><button className="sort-header" onClick={() => changeSort('average')}><span><strong>{t('Average rate')}</strong><small>{metric === 'Per interval' ? t('8h equivalent') : t('Tradable venues')}</small></span>{sortMark('average')}</button></th>
            <th><button className="sort-header arb-sort" onClick={() => changeSort('arb')}><span><strong>{t('Max arb')}</strong><small>{metric === 'Per interval' ? t('8h equivalent spread') : t('Best spread')}</small></span>{sortMark('arb')}</button></th>
            <th className="funding-price-heading"><button className="sort-header" onClick={() => changeSort('priceSpread')}>{t('Price difference')} {sortMark('priceSpread')}</button></th>
            {visibleExchanges.map(({ venue }) => <th key={venue.id}><button className="sort-header exchange-sort" onClick={() => changeSort(venue.id as FundingSortKey)}><span className="exchange-heading"><VenueIcon id={venue.id} short={venue.short} /><span><strong>{venue.name}</strong>{sortMark(venue.id as FundingSortKey)}</span></span></button></th>)}
          </tr></thead>
          <tbody>{visibleMarkets.map((item, index) => {
            const arb = getArb(item);
            const lowArb = arb.low;
            const highArb = arb.high;
            const average = getAverage(item);
            const priceSpread = pairPriceSpread(item, arb);
            const priceDetail = [t('Order book snapshot; excludes fees, slippage and USD/USDT/USDC conversion.'),
              ...[lowArb, highArb].flatMap((leg, legIndex) => {
                const venueEntry = item.priceSnapshot?.venues.find((value) => value.venue === leg?.venue.id.toUpperCase());
                const entry = item.referenceQuotes?.find((value) => value.symbol === venueEntry?.symbol);
                return entry ? [`${leg?.venue.name}: ${(legIndex === 0 ? entry.askPrice : entry.bidPrice) ?? '—'} ${venueEntry?.quote ?? ''} · ${t(legIndex === 0 ? 'Buy at best ask' : 'Sell at best bid')} · ${entry.bookObservedAt ?? '—'}`] : [];
              }), priceSpread === null ? t('Price missing, stale or incomparable') : '',
            ].filter(Boolean).join('\n');
            return <tr key={item.asset} className="funding-clickable-row" onClick={() => onOpenAsset(item.asset)}>
              <td><button className="funding-history-link" aria-label={`${item.asset} ${t('Historical funding')}`} onClick={(event) => { event.stopPropagation(); onOpenAsset(item.asset); }}><span className={`funding-asset asset-tone-${index % 5}`}>{item.icon}</span><span><strong>{item.asset}<FundingAssetTag value={item.assetClass} t={t} /></strong><small>{item.name} {t('Perpetual').toLowerCase()}</small></span></button></td>
              <td>{item.oi > 0
                ? <><strong className="oi-value">{formatOpenInterest(item.oi)}</strong><span className="oi-bar"><i style={{ width: `${Math.max(4, (item.oi / maxOi) * 100)}%` }} /></span><small className="oi-avg">{t('avg')} {formatOpenInterest(item.avgOi)}</small></>
                : <><strong className="oi-value">—</strong><small className="oi-avg">{t('no data')}</small></>}</td>
              <td className="average-funding-cell"><strong className={average.rate === null ? 'funding-rate funding-missing' : 'funding-rate funding-average'}>{average.rate === null ? '—' : formatFundingRate(average.rate, metric)}</strong></td>
              <td className="arb-cell"><div className="arb-cell-layout"><span className="arb-summary"><strong>{arb.spread !== null ? formatFundingRate(arb.spread, metric) : '—'}</strong><small>{visibleExchanges.length <= 1 ? t('Select 2+ exchanges') : arb.spread !== null ? `${t('Long')} ${lowArb?.venue.short} · ${t('Short')} ${highArb?.venue.short}` : t('no data')}</small></span>{lowArb && highArb && <button className="arb-strategy-button" title={t('Open hedge strategy')} aria-label={`${t('Open hedge strategy')}: ${item.asset}, ${t('Long')} ${lowArb.venue.name}, ${t('Short')} ${highArb.venue.name}`} onClick={(event) => {
                event.stopPropagation();
                onOpenStrategy({ asset: item.asset, longVenue: lowArb.venue.id, shortVenue: highArb.venue.id });
              }} onKeyDown={(event) => event.stopPropagation()}><span aria-hidden="true">⇄</span><em>{t('Open')}</em></button>}</div></td>
              <td className="funding-price-cell" title={priceDetail}><strong className={priceSpread === null ? 'funding-missing' : priceSpread >= 0 ? 'positive' : 'negative'}>{formatPriceSpread(priceSpread)}</strong></td>
              {visibleExchanges.map(({ venue, index: rateIndex }) => {
                const historicalMetric = metric === '24h' || metric === '7d' || metric === '30d';
                const symbol = item.symbols[rateIndex];
                const rate = metricRate(item, rateIndex);
                if (rate === null) {
                  const detail = !item.listed[rateIndex] ? t('not listed')
                    : historicalMetric && symbol && (historyPending.has(symbol) || !historyBySymbol[symbol]) ? t('Loading funding history…')
                      : historicalMetric ? t('history unavailable') : t('no data');
                  return <td key={`${item.asset}-${venue.id}`}><strong className="funding-rate funding-missing">{historicalMetric && symbol && (historyPending.has(symbol) || !historyBySymbol[symbol]) ? '…' : '—'}</strong><small>{detail}</small></td>;
                }
                const colorClass = arb.spread !== null && venue.id === arb.high?.venue.id ? 'funding-highest' : arb.spread !== null && venue.id === arb.low?.venue.id ? 'funding-lowest' : 'funding-base';
                const interval = formatFundingInterval(item.intervalHours[rateIndex]);
                return <td key={`${item.asset}-${venue.id}`}><strong className={`funding-rate ${colorClass}`}>{formatFundingRate(rate, metric)}</strong><small className={metric === 'APR' ? undefined : 'funding-period-label'}>{metric === 'APR' ? t('annualized') : metric === 'Per interval' ? `${t('next payment')}${interval ? ` · ${interval}` : ''}` : `${t('cumulative')} ${metric}`}</small></td>;
              })}
            </tr>;
          })}</tbody>
        </table>
        {visibleMarkets.length === 0 && <div className="funding-empty">{
          ranking.preparing ? t('Preparing sort…')
            : overviewState === 'loading' && scopedPairs.every((item) => item.oi <= 0) ? t('Loading all trading pairs…')
            : query ? <>{t('No perpetual markets match')} “{query}”.</>
              : <>{t('No pairs clear the average OI filter.')} {t('Lower the minimum to see more pairs.')}</>
        }</div>}
      </div>
      {filteredMarkets.length >= 10 && <div className="funding-pagination">
        <span className="page-range">{filteredMarkets.length === 0 ? `0 ${t('pairs')}` : `${pageStart + 1}–${Math.min(pageStart + pageSize, filteredMarkets.length)} / ${filteredMarkets.length} ${t('pairs')}`}</span>
        <div className="page-controls">
          <button onClick={() => setPage(1)} disabled={currentPage <= 1} aria-label={t('First page')}>«</button>
          <button onClick={() => setPage(currentPage - 1)} disabled={currentPage <= 1}>{t('Prev')}</button>
          <span className="page-indicator">{t('Page')} {currentPage} / {totalPages}</span>
          <button onClick={() => setPage(currentPage + 1)} disabled={currentPage >= totalPages}>{t('Next')}</button>
          <button onClick={() => setPage(totalPages)} disabled={currentPage >= totalPages} aria-label={t('Last page')}>»</button>
        </div>
        <label className="page-size"><select value={pageSize} onChange={(event) => { setPage(1); setPageSize(Number(event.target.value)); }}>{FUNDING_PAGE_SIZES.map((size) => <option key={size} value={size}>{size}</option>)}</select><span>{t('per page')}</span></label>
      </div>}
      <footer className="funding-footer">
        <span>
          {overview ? t('Aggregated from venue public REST · refreshed 5m, 30s near settlement') : t(marketSnapshot?.markets.some((market) => market.source === 'gate_crossex_websocket') ? 'Live Gate CrossEx WebSocket' : 'Seed data while awaiting market updates')}
          {overviewState === 'failed' && !overview ? <> · {t('Venue REST unavailable — showing streamed markets only')}</> : null}
          {(overview?.venueStatus.filter((status) => status.status === 'error') ?? []).length > 0
            ? <> · {overview?.venueStatus.filter((status) => status.status === 'error').map((status) => exchanges.find((exchange) => exchange.id === status.venue.toLowerCase())?.name ?? status.venue).join(', ')} {t('unavailable')}</>
            : null}
        </span>
        <span>{t('Click any row to inspect realized funding history.')} · {t('Historical settlements stored locally · latest tail refreshed ~15m')} · {t('OI averaged across selected venues reporting it')}</span>
        <FundingClassificationSource classification={overview?.classification} language={language} t={t} />
      </footer>
    </section>
  </div>;
}
