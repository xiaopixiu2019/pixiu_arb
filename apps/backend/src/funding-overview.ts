import { BoundedRead } from './bounded-read.js';
import { FUNDING_STAT_VENUES, PublicMarketDataError } from '@gate-crossex/public-data';
import type { FundingStatVenue, PublicMarketDataGateway, VenueFundingStat } from '@gate-crossex/public-data';
import type { FundingOverviewResponse, FundingOverviewVenueEntry, MarketCatalogVenue } from '@gate-crossex/shared-types';
import {
  BUNDLED_MARKET_CAP_SNAPSHOT,
  classifyFundingAsset,
  type CryptoMarketCapProvider,
} from './asset-classification.js';
import { nativeMarketAsset } from './market-asset-aliases.js';

interface VenueCacheEntry {
  rows: Map<string, VenueFundingStat>;
  fetchedAt: string | null;
  ok: boolean;
  rowCount: number;
}

export interface FundingOverviewCatalogView {
  assets: ReadonlyMap<string, MarketCatalogVenue[]>;
}

export interface FundingOverviewServiceOptions {
  /** Age after which a request triggers a background refresh; a cold cache always awaits one sweep. */
  freshMs?: number;
  /** More frequent refresh interval around Hyperliquid's hourly funding settlement. */
  settlementFreshMs?: number;
  now?: () => number;
  warn?: (venue: string, reason: string) => void;
  warnClassification?: (reason: string) => void;
  onRead?: (event: FundingReadEvent) => void;
  cryptoMarketCapProvider?: CryptoMarketCapProvider;
}

export interface FundingReadEvent {
  venue: string; operation: string; generation: number; startedAt: number; deadlineAt: number;
  endedAt: number | null; lastSuccessAt: number | null; outcome: 'started' | 'success' | 'unavailable';
}

const DEFAULT_FRESH_MS = 5 * 60_000;
const DEFAULT_SETTLEMENT_FRESH_MS = 30_000;
const SETTLEMENT_WINDOW_MS = 5 * 60_000;
const HOUR_MS = 60 * 60_000;
const CROSSEX_FUTURE_SYMBOL = /^[A-Z0-9]+_FUTURE_([A-Z0-9]+)_(?:USDT|USDC|USD)$/;

function nativeAssetFromSymbol(symbol: string): string | null {
  return CROSSEX_FUTURE_SYMBOL.exec(symbol)?.[1] ?? null;
}

/** Refresh faster from five minutes before until five minutes after each UTC hour. */
export function fundingOverviewRefreshInterval(now: number): number {
  const positionInHour = ((now % HOUR_MS) + HOUR_MS) % HOUR_MS;
  return positionInHour >= HOUR_MS - SETTLEMENT_WINDOW_MS || positionInHour < SETTLEMENT_WINDOW_MS
    ? DEFAULT_SETTLEMENT_FRESH_MS
    : DEFAULT_FRESH_MS;
}

/**
 * Aggregates funding rate and open interest for every catalog perpetual from the venues' bulk
 * public REST feeds. The CrossEx WebSocket cannot cover this breadth — its public channels are
 * capped at 100 symbols per connection — so the overview is REST-polled instead, on demand only:
 * nothing is fetched until the funding page asks, and nothing runs while it is closed.
 */
export class FundingOverviewService {
  private readonly venues = new Map<FundingStatVenue, VenueCacheEntry>();
  private readonly refreshes = new Map<boolean, Promise<void>>();
  private querySequence = 0;
  private readonly readSuccess = new Map<string, number>();
  private readonly onRead: NonNullable<FundingOverviewServiceOptions['onRead']>;
  private readonly managedVersions = new Map<FundingStatVenue, number>();
  private readonly cooldowns = new Map<FundingStatVenue, number>();
  private readonly nativeConflicts = new Map<string, number>();
  private readonly managedVenues = new Map<FundingStatVenue, VenueCacheEntry>();
  private lastPageRefreshCompletedAt: number | null = null;
  private readonly nativeFunding = new Map<string, { rate8h: string; fetchedAt: number }>();
  acceptNativeFunding(symbol: string, rate8h: string, sourceAt: number, receivedAt: number): void {
    if (typeof rate8h !== 'string' || rate8h.trim() === '' || !Number.isFinite(Number(rate8h)) || !Number.isFinite(sourceAt) || receivedAt - sourceAt > 3000 || sourceAt > receivedAt + 2000) return;
    const prior = this.nativeFunding.get(symbol);
    if (prior && sourceAt <= prior.fetchedAt) {
      if (sourceAt === prior.fetchedAt && Number(prior.rate8h) !== Number(rate8h)) this.nativeConflicts.set(symbol, sourceAt);
      return;
    }
    this.nativeConflicts.delete(symbol);
    if (this.nativeFunding.size >= 200 && !this.nativeFunding.has(symbol)) this.nativeFunding.delete(this.nativeFunding.keys().next().value!);
    this.nativeFunding.set(symbol, { rate8h, fetchedAt: sourceAt });
  }
  private backupFunding(symbol: string): { rate8h: string; fetchedAt: number } | null {
    const value = this.nativeFunding.get(symbol);
    return value && this.nativeConflicts.get(symbol) !== value.fetchedAt && value.fetchedAt <= this.now() && this.now() - value.fetchedAt <= 60000 ? value : null;
  }
  private readonly readLanes = new Map<string, BoundedRead>();
  private lastRefreshCompletedAt: number | null = null;
  private lastRefreshFailed = false;
  private readonly freshMs: number;
  private readonly settlementFreshMs: number;
  private readonly now: () => number;
  private readonly warn: (venue: string, reason: string) => void;
  private readonly warnClassification: (reason: string) => void;
  private readonly cryptoMarketCapProvider: CryptoMarketCapProvider | undefined;
  private topMarketCapSymbols = new Set(BUNDLED_MARKET_CAP_SNAPSHOT.assets.map((asset) => asset.symbol));
  private knownCryptoSymbols = new Set(BUNDLED_MARKET_CAP_SNAPSHOT.knownSymbols);
  private classification: FundingOverviewResponse['classification'] = {
    source: 'COINGECKO',
    marketCapLimit: 20,
    status: 'fallback',
    fetchedAt: BUNDLED_MARKET_CAP_SNAPSHOT.fetchedAt,
  };

  constructor(private readonly gateway: PublicMarketDataGateway, options: FundingOverviewServiceOptions = {}) {
    this.onRead = options.onRead ?? (() => undefined);
    this.freshMs = options.freshMs ?? DEFAULT_FRESH_MS;
    // A fixed freshMs in tests/custom deployments remains fixed unless an explicit settlement
    // interval is also supplied.
    this.settlementFreshMs = options.settlementFreshMs ?? options.freshMs ?? DEFAULT_SETTLEMENT_FRESH_MS;
    this.now = options.now ?? Date.now;
    this.warn = options.warn ?? (() => undefined);
    this.warnClassification = options.warnClassification ?? (() => undefined);
    this.cryptoMarketCapProvider = options.cryptoMarketCapProvider;
  }

  /** Cold call awaits the first sweep; warm calls serve cached rows and revalidate in the background. */
  async ensureFresh(): Promise<void> {
    if (typeof this.gateway.queryVenueFundingStats !== 'function' && !this.cryptoMarketCapProvider) return;
    const last = this.lastPageRefreshCompletedAt;
    const now = this.now();
    if (last !== null && now >= last && now - last <= this.currentFreshMs(now)) return;
    const refresh = this.refresh();
    if (last === null) await refresh;
  }

  private currentFreshMs(now = this.now()): number {
    return fundingOverviewRefreshInterval(now) === DEFAULT_SETTLEMENT_FRESH_MS
      ? this.settlementFreshMs
      : this.freshMs;
  }

  async refreshForManagedPositions(): Promise<void> {
    if (FUNDING_STAT_VENUES.every(venue => { const entry = this.managedVenues.get(venue); return entry?.ok && entry.fetchedAt && this.now() >= Date.parse(entry.fetchedAt) && this.now() - Date.parse(entry.fetchedAt) < 30000; })) return;
    if (!this.gateway.queryVenueFundingRates && this.refreshes.has(false)) return this.refreshes.get(false)!;
    const interval = this.lastRefreshFailed ? 5_000 : 30_000;
    if (this.lastRefreshCompletedAt === null || this.now() < this.lastRefreshCompletedAt || this.now() - this.lastRefreshCompletedAt >= interval) await this.refresh(true);
  }

  managedFunding(symbol: string): { rate8h: string; fetchedAt: number } | null {
    const [venue, , base, quote] = symbol.split('_');
    const cached = this.managedVenues.get(venue as FundingStatVenue) ?? this.venues.get(venue as FundingStatVenue);
    const fetchedAt = Date.parse(cached?.fetchedAt ?? '');
    if (!cached?.ok || !Number.isFinite(fetchedAt) || fetchedAt > this.now() || this.now() - fetchedAt > 60_000) return this.backupFunding(symbol);
    const stat = [...cached.rows.values()].find((row) => row.quote === quote
      && nativeMarketAsset(venue, 'FUTURE', row.base) === base);
    if (stat?.fundingCycleVerified === false || typeof stat?.fundingRate8h !== 'string' || stat.fundingRate8h.trim() === '' || !Number.isFinite(Number(stat.fundingRate8h))) return this.backupFunding(symbol);
    return { rate8h: stat.fundingRate8h, fetchedAt };
  }

  private lane(key: string): BoundedRead {
    let lane = this.readLanes.get(key);
    if (!lane) { lane = new BoundedRead(); this.readLanes.set(key, lane); }
    return lane;
  }

  private traceRead(event: FundingReadEvent): void {
    try { this.onRead(event); } catch { /* Diagnostics cannot change financial availability. */ }
  }

  private refresh(managed = false): Promise<void> {
    const pending = this.refreshes.get(managed); if (pending) return pending;
    const run = (async () => {
      if (managed) this.lastRefreshFailed = false;
      const query = managed ? this.gateway.queryVenueFundingRates ?? this.gateway.queryVenueFundingStats : this.gateway.queryVenueFundingStats;
      const venues = query ? FUNDING_STAT_VENUES.map(async venue => {
        const started = this.now(), version = ++this.querySequence;
        if ((this.cooldowns.get(venue) ?? 0) > started) { if (managed) this.lastRefreshFailed = true; return; }
        const key = `${managed}:${venue}`;
        const event: FundingReadEvent = { venue, operation: managed ? 'funding_rates' : 'funding_overview', generation: version,
          startedAt: started, deadlineAt: started + 8000, endedAt: null, lastSuccessAt: this.readSuccess.get(key) ?? null, outcome: 'started' };
        this.traceRead(event);
        let outcome: FundingReadEvent['outcome'] = 'unavailable';
        try {
          const values = await this.lane(`${managed}:${venue}`).run(signal => query.call(this.gateway, venue, signal), 8000);
          if (values.length && values.every(stat => stat.fundingCycleVerified !== false)) { outcome = 'success'; this.readSuccess.set(key, this.now()); }
          if (managed && values.some(stat => stat.fundingCycleVerified === false)) this.lastRefreshFailed = true;
          const rows = new Map(values.map(stat => [`${stat.base}:${stat.quote}`, stat]));
          const entry = { rows, fetchedAt: new Date(started).toISOString(), ok: true, rowCount: rows.size };
          if (!managed) this.venues.set(venue, entry);
          if ((this.managedVersions.get(venue) ?? 0) <= version) { this.managedVenues.set(venue, entry); this.managedVersions.set(venue, version); }
        } catch (error) {
          if (managed) this.lastRefreshFailed = true;
          if (error instanceof PublicMarketDataError && error.retryAfterMs) this.cooldowns.set(venue, Math.max(this.cooldowns.get(venue) ?? 0, this.now() + error.retryAfterMs));
          this.warn(venue, error instanceof PublicMarketDataError ? error.code : error instanceof Error ? error.message : 'PUBLIC_DATA_ERROR');
          const cache = managed ? this.managedVenues : this.venues, previous = cache.get(venue);
          if (managed && (this.managedVersions.get(venue) ?? 0) > version) return;
          if (managed) this.managedVersions.set(venue, version);
          cache.set(venue, { rows: previous?.rows ?? new Map(), fetchedAt: previous?.fetchedAt ?? null, ok: false, rowCount: previous?.rowCount ?? 0 });
        } finally {
          this.traceRead({ ...event, endedAt: this.now(), outcome, lastSuccessAt: this.readSuccess.get(key) ?? null });
        }
      }) : [];
      await Promise.all([...venues, ...(managed ? [] : [this.refreshClassification()])]);
      if (managed) this.lastRefreshCompletedAt = this.now(); else this.lastPageRefreshCompletedAt = this.now();
    })().finally(() => { this.refreshes.delete(managed); });
    this.refreshes.set(managed, run); return run;
  }

  private async refreshClassification(): Promise<void> {
    if (!this.cryptoMarketCapProvider) return;
    try {
      const { snapshot, status } = await this.lane('classification').run(() => this.cryptoMarketCapProvider!.load(), 8000);
      this.topMarketCapSymbols = new Set(snapshot.assets.map(asset => asset.symbol));
      this.knownCryptoSymbols = new Set(snapshot.knownSymbols);
      this.classification = { source: 'COINGECKO', marketCapLimit: 20, status, fetchedAt: snapshot.fetchedAt };
    } catch {
      this.warnClassification('COINGECKO_MARKET_CAP_UNAVAILABLE');
      this.classification = { ...this.classification, status: this.classification.fetchedAt ? 'stale' : 'unavailable' };
    }
  }

  buildResponse(catalog: FundingOverviewCatalogView, symbols?: ReadonlySet<string>): FundingOverviewResponse {
    const cache = symbols ? this.managedVenues : this.venues;
    const selected = [...catalog.assets.entries()].map(([asset, venues]) =>
      [asset, symbols ? venues.filter((venue) => symbols.has(venue.symbol)) : venues] as const)
      .filter(([, venues]) => venues.length > 0);
    const assets = selected.map(([asset, venueList]) => ({
      asset,
      assetClass: classifyFundingAsset(asset, catalog.assets.get(asset) ?? venueList, this.topMarketCapSymbols, this.knownCryptoSymbols),
      venues: venueList.map((entry): FundingOverviewVenueEntry => {
        const cached = cache.get(entry.venue as FundingStatVenue);
        // Catalog assets are canonical identities, while venue statistics retain the native
        // ticker. Join through the executable CrossEx symbol so aliases never alter routing.
        const nativeAsset = nativeAssetFromSymbol(entry.symbol) ?? asset;
        const stat = cached?.rows.get(`${nativeAsset}:${entry.quote}`);
        return {
          venue: entry.venue,
          symbol: entry.symbol,
          quote: entry.quote,
          fundingRate: stat?.fundingRate ?? null,
          fundingIntervalHours: stat?.fundingCycleVerified === false ? null : stat?.fundingIntervalHours ?? null,
          fundingRate8h: stat?.fundingCycleVerified === false ? null : stat?.fundingRate8h ?? null,
          nextFundingAt: stat?.nextFundingAt ?? null,
          openInterestValue: stat?.openInterestValue ?? null,
          lastPrice: stat?.lastPrice ?? null,
          bidPrice: stat?.bidPrice ?? null,
          askPrice: stat?.askPrice ?? null,
          bookObservedAt: stat?.bookObservedAt ?? null,
          change24h: stat?.change24h ?? null,
          fetchedAt: stat ? cached?.fetchedAt ?? null : null,
        };
      }),
    }));
    const venueStatus = FUNDING_STAT_VENUES.map((venue) => {
      const entry = cache.get(venue);
      return {
        venue,
        status: entry?.ok ? ('ok' as const) : ('error' as const),
        fetchedAt: entry?.fetchedAt ?? null,
        rowCount: entry?.rowCount ?? 0,
      };
    });
    const newestFetch = venueStatus.reduce<string | null>(
      (newest, entry) => (entry.fetchedAt && (!newest || entry.fetchedAt > newest) ? entry.fetchedAt : newest),
      null,
    );
    return {
      assets,
      venueStatus,
      classification: this.classification,
      fetchedAt: newestFetch ?? new Date(this.now()).toISOString(),
      cacheStatus: symbols
        ? selected.every(([, entries]) => entries.every(entry => { const value = cache.get(entry.venue as FundingStatVenue);
          const at = Date.parse(value?.fetchedAt ?? ''); return value?.ok && at <= this.now() && this.now() - at <= 60000; })) ? 'fresh' : 'stale'
        : this.lastPageRefreshCompletedAt !== null && this.now() - this.lastPageRefreshCompletedAt <= this.currentFreshMs() * 2 ? 'fresh' : 'stale',
    };
  }
}
