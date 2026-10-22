import { readHyperliquidBook } from './hyperliquid-book.js';
import { z } from 'zod';
import type { Candle, CandleInterval, PublicMarketSnapshot } from '@gate-crossex/shared-types';
import { fundingBook } from './funding-book.js';

const BinanceBookSchema = z.object({
  bidPrice: z.string(),
  askPrice: z.string(),
  time: z.number(),
});
const BinancePremiumSchema = z.object({
  markPrice: z.string(),
  indexPrice: z.string(),
  lastFundingRate: z.string(),
  nextFundingTime: z.number(),
  time: z.number(),
});
const GateTickerSchema = z.array(z.object({
  last: z.string(),
  funding_rate_indicative: z.string(),
  index_price: z.string(),
  funding_rate: z.string(),
  mark_price: z.string(),
  highest_bid: z.string(),
  lowest_ask: z.string(),
})).min(1);
const GateContractSchema = z.object({
  funding_next_apply: z.number(),
});
const OkxTickerSchema = okxEnvelope(z.object({
  last: z.string(), askPx: z.string(), bidPx: z.string(), ts: z.string(),
}));
const OkxMarkSchema = okxEnvelope(z.object({ markPx: z.string(), ts: z.string() }));
const OkxIndexSchema = okxEnvelope(z.object({ idxPx: z.string(), ts: z.string() }));
const OkxFundingSchema = okxEnvelope(z.object({
  fundingRate: z.string(), fundingTime: z.string(), nextFundingRate: z.string(), nextFundingTime: z.string(), ts: z.string(),
}));

function okxEnvelope<T extends z.ZodType>(item: T) {
  return z.object({ code: z.literal('0'), msg: z.string(), data: z.array(item).min(1) });
}

const GateContractListSchema = z.array(z.object({
  name: z.string(),
  quanto_multiplier: z.string(),
  funding_interval: z.union([z.string(), z.number()]).optional(),
  funding_next_apply: z.union([z.string(), z.number()]).optional(),
})).min(1);
const OkxInstrumentListSchema = okxEnvelope(z.object({
  instId: z.string(), ctVal: z.string(), ctValCcy: z.string(),
}));

// --- Bulk funding/OI rows. Envelopes parse strictly; rows parse one at a time so a single
// malformed listing cannot take down a whole venue.
const numeric = z.union([z.string(), z.number()]);
const GateFundingRowSchema = z.object({
  highest_bid: z.unknown().optional(), lowest_ask: z.unknown().optional(),
  contract: z.string(), funding_rate: numeric, mark_price: numeric,
  last: numeric.optional(), change_percentage: numeric.optional(),
  total_size: numeric.optional(), quanto_multiplier: numeric.optional(),
});
const BinanceFundingRowSchema = z.object({
  symbol: z.string(), lastFundingRate: numeric, nextFundingTime: z.number(),
});
const BinanceTicker24hRowSchema = z.object({
  symbol: z.string(), lastPrice: numeric, priceChangePercent: numeric,
});
const BinanceFundingInfoRowSchema = z.object({
  symbol: z.string(), fundingIntervalHours: numeric,
});
const OkxFundingRowSchema = z.object({
  instId: z.string(), fundingRate: numeric, fundingTime: numeric, nextFundingTime: numeric,
});
const OkxOpenInterestRowSchema = z.object({ instId: z.string(), oiUsd: numeric });
const OkxTickerRowSchema = z.object({ instId: z.string(), last: numeric, open24h: numeric, bidPx: z.unknown().optional(), askPx: z.unknown().optional(), ts: z.unknown().optional() });
const BybitFundingRowSchema = z.object({
  bid1Price: z.unknown().optional(), ask1Price: z.unknown().optional(),
  symbol: z.string(), fundingRate: z.string(), nextFundingTime: z.string(),
  openInterestValue: z.string(), fundingIntervalHour: numeric.optional(),
  lastPrice: numeric.optional(), price24hPcnt: numeric.optional(),
});
const KrakenFundingRowSchema = z.object({
  bid: z.unknown().optional(), ask: z.unknown().optional(),
  symbol: z.string(), pair: z.string(), tag: z.string(),
  markPrice: z.number().optional(), fundingRate: z.number().optional(),
  openInterest: z.number().optional(), suspended: z.boolean().optional(),
  last: z.number().optional(), change24h: z.number().optional(),
});
const HyperliquidUniverseEntrySchema = z.object({
  name: z.string().min(1).max(120),
  isDelisted: z.boolean().optional(),
});
const HyperliquidPerpMetaSchema = z.object({
  universe: z.array(HyperliquidUniverseEntrySchema),
});
const HyperliquidAllPerpMetasSchema = z.array(HyperliquidPerpMetaSchema).min(1);
const HyperliquidMetaAndCtxSchema = z.tuple([
  HyperliquidPerpMetaSchema,
  z.array(z.object({
    funding: numeric.optional(), openInterest: numeric.optional(), markPx: numeric.optional(), prevDayPx: numeric.optional(),
  })),
]);
const DeribitBookSummaryRowSchema = z.object({
  bid_price: z.unknown().optional(), ask_price: z.unknown().optional(),
  instrument_name: z.string(), open_interest: z.number().optional(),
  mark_price: z.number().optional(), funding_8h: z.number().optional(),
  last: z.number().nullable().optional(), price_change: z.number().nullable().optional(),
});
const GateFundingHistoryRowSchema = z.object({ r: numeric, t: numeric });
const BinanceFundingHistoryRowSchema = z.object({
  fundingRate: numeric, fundingTime: numeric,
});
const OkxFundingHistoryRowSchema = z.object({
  fundingRate: numeric, realizedRate: numeric.optional(), fundingTime: numeric,
});
const BybitFundingHistorySchema = z.object({
  retCode: z.number(),
  result: z.object({
    list: z.array(z.object({ fundingRate: numeric, fundingRateTimestamp: numeric })),
  }),
});
const KrakenFundingAnalyticsSchema = z.object({
  result: z.object({
    timestamp: z.array(z.number()),
    data: z.object({ relativeRate: z.array(z.array(numeric).min(4)) }),
    more: z.boolean(),
  }),
  errors: z.array(z.unknown()),
});
const HyperliquidFundingHistoryRowSchema = z.object({
  fundingRate: numeric, time: z.number(),
});
const DeribitFundingHistorySchema = z.object({
  result: z.array(z.object({ timestamp: z.number(), interest_1h: z.number() })),
});

/** Kraken quotes a handful of assets under legacy codes; CrossEx uses the modern ones. */
const KRAKEN_ASSET_RENAMES: Record<string, string> = { XBT: 'BTC', XDG: 'DOGE' };
const HYPERLIQUID_METADATA_FRESH_MS = 30 * 60_000;
const HYPERLIQUID_FORCED_REFRESH_MIN_MS = 60_000;
const HYPERLIQUID_FUNDING_HISTORY_RETRY_DELAYS_MS = [500, 1_500] as const;
const HYPERLIQUID_FUNDING_HISTORY_PAGE_SPACING_MS = 1_500;

function hyperliquidBase(nativeName: string): string {
  const separator = nativeName.lastIndexOf(':');
  return separator === -1 ? nativeName : nativeName.slice(separator + 1);
}

function hyperliquidDex(nativeName: string): string {
  const separator = nativeName.indexOf(':');
  return separator === -1 ? '' : nativeName.slice(0, separator);
}

/** Prefer Hyperliquid's first perp DEX; otherwise require one unambiguous live HIP-3 market. */
function selectHyperliquidNativeName(base: string, nativeNames: readonly string[]): string | null {
  if (nativeNames.includes(base)) return base;
  const candidates = nativeNames.filter((nativeName) => hyperliquidBase(nativeName) === base);
  return candidates.length === 1 ? candidates[0] ?? null : null;
}

function finiteNumber(value: unknown): number | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  if (typeof value === 'string' && value.trim() === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function historyNumber(value: unknown): number {
  const parsed = finiteNumber(value);
  if (parsed === null) throw new PublicMarketDataError('INCOMPLETE_HISTORY');
  return parsed;
}

function positiveNumberText(value: unknown): string | null {
  const parsed = finiteNumber(value);
  return parsed !== null && parsed > 0 ? String(parsed) : null;
}

/** Venue percentage fields use whole percents; normalize all overview changes to a fraction. */
function fractionFromPercent(value: unknown): string | null {
  const parsed = finiteNumber(value);
  return parsed === null ? null : String(parsed / 100);
}

function changeFraction(currentValue: unknown, previousValue: unknown): string | null {
  const current = finiteNumber(currentValue);
  const previous = finiteNumber(previousValue);
  return current !== null && previous !== null && current > 0 && previous > 0 ? String((current / previous) - 1) : null;
}

/** Normalize a per-interval funding rate to its 8h equivalent so venues stay comparable. */
function rateScaledTo8h(rate: number, intervalHours: number): string {
  const hours = Number.isFinite(intervalHours) && intervalHours > 0 && intervalHours <= 24 ? intervalHours : 8;
  return String(rate * (8 / hours));
}

function fundingIntervalHours(value: unknown, fallback = 8): number {
  const parsed = finiteNumber(value);
  return parsed !== null && parsed > 0 && parsed <= 24 ? parsed : fallback;
}

/** Multiply to a USD amount, rounded to whole dollars; null when any factor is missing or the result is not positive. */
function positiveProduct(...factors: Array<number | null>): string | null {
  let product = 1;
  for (const factor of factors) {
    if (factor === null || factor < 0) return null;
    product *= factor;
  }
  if (!Number.isFinite(product)) return null;
  const rounded = Math.round(product);
  return rounded > 0 ? String(rounded) : null;
}

export class PublicMarketDataError extends Error {
  constructor(readonly code: string, readonly retryAfterMs: number | null = null) {
    super(`Public market data request failed: ${code}`);
    this.name = 'PublicMarketDataError';
  }
}

export function isRetryablePublicMarketDataError(error: unknown): error is PublicMarketDataError {
  if (!(error instanceof PublicMarketDataError)) return false;
  if (error.code === 'NETWORK_ERROR') return true;
  const match = /^UPSTREAM_HTTP_(\d{3})$/.exec(error.code);
  if (!match) return false;
  const status = Number(match[1]);
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function retryAfterMilliseconds(value: string | null): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp)
    ? Math.max(0, timestamp - Date.now())
    : null;
}

async function sleepWithAbort(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw new PublicMarketDataError('ABORTED');
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, milliseconds);
    const onAbort = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      reject(new PublicMarketDataError('ABORTED'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export interface VenueContractSize {
  base: string;
  quote: string;
  /** Base units represented by one unit of the venue's contract-sized public feed. */
  multiplier: string;
}

export const FUNDING_STAT_VENUES = ['GATE', 'BINANCE', 'OKX', 'BYBIT', 'KRAKEN', 'HYPERLIQUID', 'DERIBIT'] as const;
export type FundingStatVenue = typeof FUNDING_STAT_VENUES[number];

/**
 * One perpetual's funding and open-interest stats from a venue's bulk public REST feed.
 * The CrossEx WebSocket cannot serve this breadth (100 symbols per channel per connection),
 * so the funding-rate overview aggregates venue-native bulk endpoints instead.
 */
export interface VenueFundingStat {
  bidPrice?: string;
  askPrice?: string;
  bookObservedAt?: string;
  venue: FundingStatVenue;
  /** Asset code in CrossEx form (Kraken XBT/XDG already renamed to BTC/DOGE). */
  base: string;
  quote: string;
  /** Native fraction charged or paid at one venue funding interval. */
  fundingRate: string | null;
  /** Native funding interval in hours. */
  fundingIntervalHours: number;
  /** False when a display fallback interval lacks current metadata; never executable. */
  fundingCycleVerified?: boolean;
  /** 8h-equivalent funding fraction for cross-venue comparisons. */
  fundingRate8h: string | null;
  nextFundingAt: string | null;
  /** Open interest in USD; null where the venue publishes none in bulk (BINANCE). */
  openInterestValue: string | null;
  /** Last or mark price from the venue's bulk ticker feed. */
  lastPrice: string | null;
  /** Fractional 24h change, e.g. -0.012 means -1.2%. */
  change24h: string | null;
}

/** One realized funding settlement/accrual from a venue's public history feed. */
export interface FundingRatePoint {
  timestamp: number;
  /** Fractional rate realized at `timestamp`, e.g. 0.0001 means 0.01%. */
  rate: string;
}

export interface PublicMarketDataGateway {
  querySnapshot(crossExSymbol: string): Promise<PublicMarketSnapshot>;
  queryReferenceBook?(crossExSymbol: string): Promise<{ bidPrice?: string; askPrice?: string; bookObservedAt?: string }>;
  /** Optional candle backfill for supported perpetual venues. */
  queryCandles?(crossExSymbol: string, interval: CandleInterval, limit: number, before?: number): Promise<Candle[]>;
  /** Optional contract sizes for venues whose public feeds report contract counts (GATE, OKX). */
  queryContractSizes?(venue: 'GATE' | 'OKX'): Promise<VenueContractSize[]>;
  /** Optional bulk funding/open-interest stats for every perpetual a venue lists. */
  queryVenueFundingStats?(venue: FundingStatVenue, signal?: AbortSignal): Promise<VenueFundingStat[]>;
  queryVenueFundingRates?(venue: FundingStatVenue, signal: AbortSignal): Promise<VenueFundingStat[]>;
  /** Optional realized funding history for one CrossEx perpetual symbol. */
  queryFundingHistory?(crossExSymbol: string, startTime: number, endTime: number, signal?: AbortSignal): Promise<FundingRatePoint[]>;
}

export const HyperliquidPerpMetadataSnapshotSchema = z.object({
  nativeNames: z.array(z.string().min(1).max(120)).max(10_000),
  fetchedAt: z.iso.datetime(),
});
export type HyperliquidPerpMetadataSnapshot = z.infer<typeof HyperliquidPerpMetadataSnapshotSchema>;

/** Optional durable last-good storage supplied by the backend. */
export interface HyperliquidPerpMetadataStore {
  read(): HyperliquidPerpMetadataSnapshot | null;
  write(snapshot: HyperliquidPerpMetadataSnapshot): void;
}

export interface VenuePublicMarketDataClientOptions {
  hyperliquidMetadataStore?: HyperliquidPerpMetadataStore;
  hyperliquidMetadataFreshMs?: number;
  hyperliquidForcedRefreshMinMs?: number;
  /** Injectable so retry and pagination delays remain deterministic in tests. */
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
}

const GateCandleSchema = z.array(z.object({
  t: z.number(),
  o: z.string(),
  h: z.string(),
  l: z.string(),
  c: z.string(),
  v: z.number(),
}));
const BinanceCandleSchema = z.array(z.tuple([
  z.number(), z.string(), z.string(), z.string(), z.string(), z.string(),
]).rest(z.unknown()));
const OkxCandleSchema = z.object({
  code: z.literal('0'),
  msg: z.string(),
  data: z.array(z.array(z.string()).min(6)),
});
const BybitCandleSchema = z.object({
  retCode: z.number(),
  result: z.object({ list: z.array(z.array(z.string()).min(6)) }),
});
const KrakenCandleSchema = z.object({
  candles: z.array(z.object({
    time: z.number(), open: numeric, high: numeric, low: numeric, close: numeric, volume: numeric,
  })),
});
const HyperliquidCandleSchema = z.array(z.object({
  t: z.number(), o: numeric, h: numeric, l: numeric, c: numeric, v: numeric,
}));
const DeribitCandleSchema = z.object({
  result: z.union([
    z.object({ status: z.literal('no_data') }),
    z.object({
      status: z.literal('ok'),
      ticks: z.array(z.number()), open: z.array(z.number()), high: z.array(z.number()),
      low: z.array(z.number()), close: z.array(z.number()), volume: z.array(z.number()),
    }),
  ]),
});

const INTERVAL_MILLISECONDS: Record<CandleInterval, number> = {
  '1m': 60_000, '5m': 300_000, '15m': 900_000, '30m': 1_800_000,
  '1h': 3_600_000, '4h': 14_400_000, '1d': 86_400_000,
};
const OKX_BAR: Record<CandleInterval, string> = {
  '1m': '1m', '5m': '5m', '15m': '15m', '30m': '30m', '1h': '1H', '4h': '4H', '1d': '1D',
};
const BYBIT_BAR: Record<CandleInterval, string> = {
  '1m': '1', '5m': '5', '15m': '15', '30m': '30', '1h': '60', '4h': '240', '1d': 'D',
};
const DERIBIT_BAR: Record<CandleInterval, string> = {
  '1m': '1', '5m': '5', '15m': '15', '30m': '30', '1h': '60', '4h': '60', '1d': '1D',
};

interface ParsedSymbol {
  venue: FundingStatVenue;
  base: string;
  quote: string;
}

function parseCrossExFutureSymbol(symbol: string): ParsedSymbol {
  const match = /^(BINANCE|GATE|OKX|BYBIT|KRAKEN|HYPERLIQUID|DERIBIT)_FUTURE_(.+)_([A-Z0-9]+)$/.exec(symbol);
  if (!match?.[1] || !match[2] || !match[3]) throw new PublicMarketDataError('UNSUPPORTED_SYMBOL');
  return { venue: match[1] as ParsedSymbol['venue'], base: match[2], quote: match[3] };
}

function candlesFromDeribitArrays(payload: z.infer<typeof DeribitCandleSchema>): Candle[] {
  if (payload.result.status === 'no_data') return [];
  const { ticks, open, high, low, close, volume } = payload.result;
  const length = ticks.length;
  if ([open, high, low, close, volume].some((values) => values.length !== length)) {
    throw new PublicMarketDataError('INVALID_RESPONSE_SCHEMA');
  }
  return ticks.map((startTime, index) => ({
    startTime,
    open: String(open[index]), high: String(high[index]), low: String(low[index]),
    close: String(close[index]), volume: String(volume[index]), closed: true,
  }));
}

/** Deribit has no native 4h chart resolution, so compose UTC-aligned bars from its 1h series. */
function aggregateCandles(candles: Candle[], intervalMilliseconds: number): Candle[] {
  const buckets = new Map<number, Candle>();
  for (const candle of candles.sort((left, right) => left.startTime - right.startTime)) {
    const startTime = Math.floor(candle.startTime / intervalMilliseconds) * intervalMilliseconds;
    const existing = buckets.get(startTime);
    if (!existing) {
      buckets.set(startTime, { ...candle, startTime });
      continue;
    }
    existing.high = String(Math.max(Number(existing.high), Number(candle.high)));
    existing.low = String(Math.min(Number(existing.low), Number(candle.low)));
    existing.close = candle.close;
    existing.volume = String(Number(existing.volume) + Number(candle.volume));
  }
  return [...buckets.values()];
}

function isoFromMilliseconds(value: number | string): string {
  const milliseconds = Number(value);
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) throw new PublicMarketDataError('INVALID_TIMESTAMP');
  return new Date(milliseconds).toISOString();
}

function isoFromSeconds(value: number): string {
  return isoFromMilliseconds(value * 1_000);
}

async function fetchJson(
  fetchImplementation: typeof fetch,
  url: string,
  maximumBytes = 1_000_000,
  post?: { body: string },
  signal?: AbortSignal,
): Promise<unknown> {
  let response: Response;
  const timeoutSignal = AbortSignal.timeout(8_000);
  const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
  try {
    response = await fetchImplementation(url, {
      method: post ? 'POST' : 'GET',
      headers: { Accept: 'application/json', ...(post ? { 'Content-Type': 'application/json' } : {}) },
      ...(post ? { body: post.body } : {}),
      redirect: 'error',
      signal: requestSignal,
    });
  } catch {
    if (signal?.aborted) throw new PublicMarketDataError('ABORTED');
    throw new PublicMarketDataError('NETWORK_ERROR');
  }
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new PublicMarketDataError('RESPONSE_TOO_LARGE');
  }
  let text = '';
  if (response.body) {
    const reader = response.body.getReader();
    const abort = () => { void reader.cancel().catch(() => undefined); };
    requestSignal.addEventListener('abort', abort, { once: true });
    const decoder = new TextDecoder();
    let receivedBytes = 0;
    try {
      while (true) {
        requestSignal.throwIfAborted();
        const chunk = await reader.read();
        requestSignal.throwIfAborted();
        if (chunk.done) break;
        receivedBytes += chunk.value.byteLength;
        if (receivedBytes > maximumBytes) {
          await reader.cancel().catch(() => undefined);
          throw new PublicMarketDataError('RESPONSE_TOO_LARGE');
        }
        text += decoder.decode(chunk.value, { stream: true });
      }
      text += decoder.decode();
    } catch (error) {
      if (error instanceof PublicMarketDataError) throw error;
      if (signal?.aborted) throw new PublicMarketDataError('ABORTED');
      throw new PublicMarketDataError('NETWORK_ERROR');
    } finally {
      requestSignal.removeEventListener('abort', abort);
      reader.releaseLock();
    }
  } else {
    text = await response.text();
    if (new TextEncoder().encode(text).byteLength > maximumBytes) {
      throw new PublicMarketDataError('RESPONSE_TOO_LARGE');
    }
  }
  if (!response.ok) {
    throw new PublicMarketDataError(
      `UPSTREAM_HTTP_${response.status}`,
      retryAfterMilliseconds(response.headers.get('retry-after')),
    );
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new PublicMarketDataError('INVALID_JSON');
  }
}

function parsePayload<T>(schema: z.ZodType<T>, payload: unknown): T {
  const parsed = schema.safeParse(payload);
  if (!parsed.success) throw new PublicMarketDataError('INVALID_RESPONSE_SCHEMA');
  return parsed.data;
}

async function optionalPayload<T>(request: Promise<unknown>, schema: z.ZodType<T>, fallback: T): Promise<T> {
  try {
    return parsePayload(schema, await request);
  } catch {
    return fallback;
  }
}

export class VenuePublicMarketDataClient implements PublicMarketDataGateway {
  private readonly hyperliquidMetadataStore: HyperliquidPerpMetadataStore | undefined;
  private readonly hyperliquidMetadataFreshMs: number;
  private readonly hyperliquidForcedRefreshMinMs: number;
  private readonly sleep: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  private hyperliquidState: { snapshot: HyperliquidPerpMetadataSnapshot | null; inFlight: Promise<HyperliquidPerpMetadataSnapshot> | null; lastAttempt: number } = { snapshot: null, inFlight: null, lastAttempt: Number.NEGATIVE_INFINITY };

  constructor(
    private readonly fetchImplementation: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
    options: VenuePublicMarketDataClientOptions = {},
  ) {
    this.hyperliquidMetadataStore = options.hyperliquidMetadataStore;
    this.hyperliquidMetadataFreshMs = options.hyperliquidMetadataFreshMs ?? HYPERLIQUID_METADATA_FRESH_MS;
    this.hyperliquidForcedRefreshMinMs = options.hyperliquidForcedRefreshMinMs ?? HYPERLIQUID_FORCED_REFRESH_MIN_MS;
    this.sleep = options.sleep ?? sleepWithAbort;
    try {
      this.hyperliquidState.snapshot = options.hyperliquidMetadataStore?.read() ?? null;
    } catch {
      this.hyperliquidState.snapshot = null;
    }
  }

  private async loadHyperliquidMetadata(force = false): Promise<HyperliquidPerpMetadataSnapshot> {
    const now = this.now();
    const cached = this.hyperliquidState.snapshot;
    const cachedAt = Date.parse(cached?.fetchedAt ?? '');
    if (
      !force
      && cached
      && Number.isFinite(cachedAt)
      && now - cachedAt < this.hyperliquidMetadataFreshMs
    ) {
      return cached;
    }
    if (
      force
      && cached
      && now - this.hyperliquidState.lastAttempt < this.hyperliquidForcedRefreshMinMs
    ) {
      return cached;
    }
    if (this.hyperliquidState.inFlight) return this.hyperliquidState.inFlight;

    this.hyperliquidState.lastAttempt = now;
    const previous = cached;
    const pending = (async () => {
      try {
        const payload = await fetchJson(
          this.fetchImplementation,
          'https://api.hyperliquid.xyz/info',
          8_000_000,
          { body: JSON.stringify({ type: 'allPerpMetas' }) },
        );
        const metas = parsePayload(HyperliquidAllPerpMetasSchema, payload);
        const nativeNames = [...new Set(metas.flatMap((meta) => meta.universe
          .filter((entry) => entry.isDelisted !== true)
          .map((entry) => entry.name)))]
          .sort((left, right) => left.localeCompare(right));
        if (nativeNames.length === 0) throw new PublicMarketDataError('EMPTY_HYPERLIQUID_METADATA');
        const snapshot = HyperliquidPerpMetadataSnapshotSchema.parse({
          nativeNames,
          fetchedAt: new Date(this.now()).toISOString(),
        });
        this.hyperliquidState.snapshot = snapshot;
        try {
          this.hyperliquidMetadataStore?.write(snapshot);
        } catch {
          // The validated in-memory snapshot remains useful when durable cache writes fail.
        }
        return snapshot;
      } catch (error) {
        if (previous) return previous;
        throw error;
      }
    })().finally(() => {
      if (this.hyperliquidState.inFlight === pending) this.hyperliquidState.inFlight = null;
    });
    this.hyperliquidState.inFlight = pending;
    return pending;
  }

  private async resolveHyperliquidNativeName(base: string): Promise<string> {
    const cached = await this.loadHyperliquidMetadata();
    const cachedName = selectHyperliquidNativeName(base, cached.nativeNames);
    if (cachedName) return cachedName;

    const refreshed = await this.loadHyperliquidMetadata(true);
    const refreshedName = selectHyperliquidNativeName(base, refreshed.nativeNames);
    if (refreshedName) return refreshedName;
    const hasCandidate = refreshed.nativeNames.some((nativeName) => hyperliquidBase(nativeName) === base);
    throw new PublicMarketDataError(hasCandidate
      ? 'AMBIGUOUS_HYPERLIQUID_MARKET'
      : 'UNKNOWN_HYPERLIQUID_MARKET');
  }

  async queryReferenceBook(crossExSymbol: string) {
    const symbol = parseCrossExFutureSymbol(crossExSymbol);
    if (symbol.venue === 'BINANCE' && ['USDT', 'USDC'].includes(symbol.quote)) {
      const payload = await fetchJson(this.fetchImplementation,
        `https://fapi.binance.com/fapi/v1/depth?symbol=${encodeURIComponent(symbol.base + symbol.quote)}&limit=5`, 100_000);
      const level = z.tuple([z.string(), z.string()]);
      const book = parsePayload(z.object({ E: z.number(), bids: z.array(level).min(1).max(5), asks: z.array(level).min(1).max(5) }), payload);
      if (![book.bids[0][1], book.asks[0][1]].every((size) => Number.isFinite(Number(size)) && Number(size) > 0)) throw new PublicMarketDataError('INVALID_REFERENCE_BOOK');
      const result = fundingBook(book.bids[0][0], book.asks[0][0], this.now(), book.E);
      if (!result.bidPrice || !result.askPrice) throw new PublicMarketDataError('INVALID_REFERENCE_BOOK');
      return result;
    }
    if (symbol.venue !== 'HYPERLIQUID' || symbol.quote !== 'USDC') throw new PublicMarketDataError('UNSUPPORTED_SYMBOL');
    const coin = await this.resolveHyperliquidNativeName(symbol.base);
    return readHyperliquidBook(this.fetchImplementation, coin, this.now);
  }

  async querySnapshot(crossExSymbol: string): Promise<PublicMarketSnapshot> {
    const symbol = parseCrossExFutureSymbol(crossExSymbol);
    if (symbol.venue === 'BINANCE') return this.queryBinance(crossExSymbol, symbol);
    if (symbol.venue === 'GATE') return this.queryGate(crossExSymbol, symbol);
    if (symbol.venue === 'OKX') return this.queryOkx(crossExSymbol, symbol);
    throw new PublicMarketDataError('UNSUPPORTED_SYMBOL');
  }

  async queryCandles(crossExSymbol: string, interval: CandleInterval, limit: number, before?: number): Promise<Candle[]> {
    const symbol = parseCrossExFutureSymbol(crossExSymbol);
    const boundedLimit = Math.max(1, Math.min(500, Math.trunc(limit)));
    let candles: Candle[];
    switch (symbol.venue) {
      case 'BINANCE': candles = await this.queryBinanceCandles(symbol, interval, boundedLimit, before); break;
      case 'GATE': candles = await this.queryGateCandles(symbol, interval, boundedLimit, before); break;
      case 'OKX': candles = await this.queryOkxCandles(symbol, interval, boundedLimit, before); break;
      case 'BYBIT': candles = await this.queryBybitCandles(symbol, interval, boundedLimit, before); break;
      case 'KRAKEN': candles = await this.queryKrakenCandles(symbol, interval, boundedLimit, before); break;
      case 'HYPERLIQUID': candles = await this.queryHyperliquidCandles(symbol, interval, boundedLimit, before); break;
      case 'DERIBIT': candles = await this.queryDeribitCandles(symbol, interval, boundedLimit, before); break;
    }
    const now = this.now();
    return candles
      .filter((candle) => before === undefined || candle.startTime < before)
      .sort((left, right) => left.startTime - right.startTime)
      .slice(-boundedLimit)
      .map((candle) => ({ ...candle, closed: candle.startTime + INTERVAL_MILLISECONDS[interval] <= now }));
  }

  async queryContractSizes(venue: 'GATE' | 'OKX'): Promise<VenueContractSize[]> {
    if (venue === 'GATE') {
      const payload = await fetchJson(this.fetchImplementation, 'https://api.gateio.ws/api/v4/futures/usdt/contracts', 8_000_000);
      return parsePayload(GateContractListSchema, payload).flatMap((contract) => {
        const match = /^([A-Z0-9]+)_([A-Z0-9]+)$/.exec(contract.name);
        return match?.[1] && match[2] ? [{ base: match[1], quote: match[2], multiplier: contract.quanto_multiplier }] : [];
      });
    }
    const payload = await fetchJson(this.fetchImplementation, 'https://www.okx.com/api/v5/public/instruments?instType=SWAP', 8_000_000);
    return parsePayload(OkxInstrumentListSchema, payload).data.flatMap((instrument) => {
      const match = /^([A-Z0-9]+)-([A-Z0-9]+)-SWAP$/.exec(instrument.instId);
      // ctVal only denominates base units on linear swaps, where ctValCcy names the base coin.
      return match?.[1] && match[2] && instrument.ctValCcy === match[1]
        ? [{ base: match[1], quote: match[2], multiplier: instrument.ctVal }]
        : [];
    });
  }

  private async queryGateCandles(symbol: ParsedSymbol, interval: CandleInterval, limit: number, before?: number): Promise<Candle[]> {
    if (symbol.quote !== 'USDT') throw new PublicMarketDataError('UNSUPPORTED_SETTLEMENT');
    const contract = `${symbol.base}_${symbol.quote}`;
    const timeQuery = before === undefined
      ? `limit=${limit}`
      : `from=${Math.max(1, Math.floor((before - 1) / 1000) - Math.ceil(INTERVAL_MILLISECONDS[interval] / 1000) * limit)}&to=${Math.floor((before - 1) / 1000)}`;
    const payload = await fetchJson(
      this.fetchImplementation,
      `https://api.gateio.ws/api/v4/futures/usdt/candlesticks?contract=${encodeURIComponent(contract)}&interval=${interval}&${timeQuery}`,
      4_000_000,
    );
    return parsePayload(GateCandleSchema, payload).map((row) => ({
      startTime: row.t * 1_000, open: row.o, high: row.h, low: row.l, close: row.c,
      volume: String(row.v), closed: true,
    }));
  }

  private async queryBinanceCandles(symbol: ParsedSymbol, interval: CandleInterval, limit: number, before?: number): Promise<Candle[]> {
    if (!['USDT', 'USDC'].includes(symbol.quote)) throw new PublicMarketDataError('UNSUPPORTED_SETTLEMENT');
    const venueSymbol = `${symbol.base}${symbol.quote}`;
    const endQuery = before === undefined ? '' : `&endTime=${before - 1}`;
    const payload = await fetchJson(
      this.fetchImplementation,
      `https://fapi.binance.com/fapi/v1/klines?symbol=${encodeURIComponent(venueSymbol)}&interval=${interval}&limit=${limit}${endQuery}`,
      4_000_000,
    );
    return parsePayload(BinanceCandleSchema, payload).map((row) => ({
      startTime: row[0], open: row[1], high: row[2], low: row[3], close: row[4],
      volume: row[5], closed: true,
    }));
  }

  private async queryOkxCandles(symbol: ParsedSymbol, interval: CandleInterval, limit: number, before?: number): Promise<Candle[]> {
    if (!['USDT', 'USDC'].includes(symbol.quote)) throw new PublicMarketDataError('UNSUPPORTED_SETTLEMENT');
    const instrument = `${symbol.base}-${symbol.quote}-SWAP`;
    const path = before === undefined ? 'candles' : 'history-candles';
    const cursorQuery = before === undefined ? '' : `&after=${before}`;
    const payload = await fetchJson(
      this.fetchImplementation,
      `https://www.okx.com/api/v5/market/${path}?instId=${encodeURIComponent(instrument)}&bar=${OKX_BAR[interval]}&limit=${Math.min(limit, 300)}${cursorQuery}`,
      4_000_000,
    );
    const rows = parsePayload(OkxCandleSchema, payload).data;
    return rows.map((row) => {
      const [ts, open, high, low, close, volume] = row;
      if (!ts || !open || !high || !low || !close || volume === undefined) throw new PublicMarketDataError('INVALID_RESPONSE_SCHEMA');
      const startTime = Number(ts);
      if (!Number.isFinite(startTime) || startTime <= 0) throw new PublicMarketDataError('INVALID_TIMESTAMP');
      return { startTime, open, high, low, close, volume, closed: true };
    });
  }

  private async queryBybitCandles(symbol: ParsedSymbol, interval: CandleInterval, limit: number, before?: number): Promise<Candle[]> {
    if (!['USDT', 'USDC'].includes(symbol.quote)) throw new PublicMarketDataError('UNSUPPORTED_SETTLEMENT');
    // Bybit's USDC perpetuals retain the legacy BTCPERP/ETHPERP instrument naming.
    const instrument = symbol.quote === 'USDC' ? `${symbol.base}PERP` : `${symbol.base}${symbol.quote}`;
    const endQuery = before === undefined ? '' : `&end=${before - 1}`;
    const payload = await fetchJson(
      this.fetchImplementation,
      `https://api.bybit.com/v5/market/kline?category=linear&symbol=${encodeURIComponent(instrument)}&interval=${BYBIT_BAR[interval]}&limit=${limit}${endQuery}`,
      4_000_000,
    );
    const envelope = parsePayload(BybitCandleSchema, payload);
    if (envelope.retCode !== 0) throw new PublicMarketDataError('UPSTREAM_REJECTED');
    return envelope.result.list.map((row) => {
      const [timestamp, open, high, low, close, volume] = row;
      const startTime = Number(timestamp);
      if (!timestamp || !open || !high || !low || !close || volume === undefined
        || !Number.isFinite(startTime) || startTime <= 0) {
        throw new PublicMarketDataError('INVALID_RESPONSE_SCHEMA');
      }
      return { startTime, open, high, low, close, volume, closed: true };
    });
  }

  private async queryKrakenCandles(symbol: ParsedSymbol, interval: CandleInterval, limit: number, before?: number): Promise<Candle[]> {
    if (symbol.quote !== 'USD') throw new PublicMarketDataError('UNSUPPORTED_SETTLEMENT');
    const venueBase = Object.entries(KRAKEN_ASSET_RENAMES)
      .find(([, crossExBase]) => crossExBase === symbol.base)?.[0] ?? symbol.base;
    const instrument = `PF_${venueBase}${symbol.quote}`;
    const toQuery = before === undefined ? '' : `&to=${Math.floor((before - 1) / 1000)}`;
    const payload = await fetchJson(
      this.fetchImplementation,
      `https://futures.kraken.com/api/charts/v1/trade/${encodeURIComponent(instrument)}/${interval}?count=${limit}${toQuery}`,
      4_000_000,
    );
    return parsePayload(KrakenCandleSchema, payload).candles.map((row) => ({
      startTime: row.time, open: String(row.open), high: String(row.high), low: String(row.low),
      close: String(row.close), volume: String(row.volume), closed: true,
    }));
  }

  private async queryHyperliquidCandles(symbol: ParsedSymbol, interval: CandleInterval, limit: number, before?: number): Promise<Candle[]> {
    if (symbol.quote !== 'USDC') throw new PublicMarketDataError('UNSUPPORTED_SETTLEMENT');
    const nativeName = await this.resolveHyperliquidNativeName(symbol.base);
    const endTime = before === undefined ? this.now() : before - 1;
    const startTime = Math.max(1, endTime - INTERVAL_MILLISECONDS[interval] * limit);
    const payload = await fetchJson(
      this.fetchImplementation,
      'https://api.hyperliquid.xyz/info',
      4_000_000,
      { body: JSON.stringify({ type: 'candleSnapshot', req: { coin: nativeName, interval, startTime, endTime } }) },
    );
    return parsePayload(HyperliquidCandleSchema, payload).map((row) => ({
      startTime: row.t, open: String(row.o), high: String(row.h), low: String(row.l),
      close: String(row.c), volume: String(row.v), closed: true,
    }));
  }

  private async queryDeribitCandles(symbol: ParsedSymbol, interval: CandleInterval, limit: number, before?: number): Promise<Candle[]> {
    if (symbol.quote !== 'USDC') throw new PublicMarketDataError('UNSUPPORTED_SETTLEMENT');
    const endTimestamp = before === undefined ? this.now() : before - 1;
    const startTimestamp = Math.max(1, endTimestamp - INTERVAL_MILLISECONDS[interval] * limit);
    const instrument = `${symbol.base}_USDC-PERPETUAL`;
    const payload = await fetchJson(
      this.fetchImplementation,
      `https://www.deribit.com/api/v2/public/get_tradingview_chart_data?instrument_name=${encodeURIComponent(instrument)}&start_timestamp=${startTimestamp}&end_timestamp=${endTimestamp}&resolution=${DERIBIT_BAR[interval]}`,
      4_000_000,
    );
    const candles = candlesFromDeribitArrays(parsePayload(DeribitCandleSchema, payload));
    return interval === '4h' ? aggregateCandles(candles, INTERVAL_MILLISECONDS['4h']) : candles;
  }

  private async queryBinance(crossExSymbol: string, symbol: ParsedSymbol): Promise<PublicMarketSnapshot> {
    if (!['USDT', 'USDC'].includes(symbol.quote)) throw new PublicMarketDataError('UNSUPPORTED_SETTLEMENT');
    const venueSymbol = `${symbol.base}${symbol.quote}`;
    const [bookPayload, premiumPayload] = await Promise.all([
      fetchJson(this.fetchImplementation, `https://fapi.binance.com/fapi/v1/ticker/bookTicker?symbol=${encodeURIComponent(venueSymbol)}`),
      fetchJson(this.fetchImplementation, `https://fapi.binance.com/fapi/v1/premiumIndex?symbol=${encodeURIComponent(venueSymbol)}`),
    ]);
    const book = parsePayload(BinanceBookSchema, bookPayload);
    const premium = parsePayload(BinancePremiumSchema, premiumPayload);
    return {
      symbol: crossExSymbol, venue: 'BINANCE', product: 'FUTURE',
      bidPrice: book.bidPrice, askPrice: book.askPrice, lastPrice: null,
      markPrice: premium.markPrice, indexPrice: premium.indexPrice,
      fundingRate: premium.lastFundingRate, predictedFundingRate: null,
      nextFundingAt: isoFromMilliseconds(premium.nextFundingTime),
      sourceTimestamp: isoFromMilliseconds(Math.max(book.time, premium.time)),
      fetchedAt: new Date(this.now()).toISOString(), source: 'binance_futures_public_rest',
    };
  }

  private async queryGate(crossExSymbol: string, symbol: ParsedSymbol): Promise<PublicMarketSnapshot> {
    if (symbol.quote !== 'USDT') throw new PublicMarketDataError('UNSUPPORTED_SETTLEMENT');
    const contract = `${symbol.base}_${symbol.quote}`;
    const [tickerPayload, contractPayload] = await Promise.all([
      fetchJson(this.fetchImplementation, `https://api.gateio.ws/api/v4/futures/usdt/tickers?contract=${encodeURIComponent(contract)}`),
      fetchJson(this.fetchImplementation, `https://api.gateio.ws/api/v4/futures/usdt/contracts/${encodeURIComponent(contract)}`),
    ]);
    const ticker = parsePayload(GateTickerSchema, tickerPayload)[0];
    const contractDetails = parsePayload(GateContractSchema, contractPayload);
    if (!ticker) throw new PublicMarketDataError('INVALID_RESPONSE_SCHEMA');
    const fetchedAt = new Date(this.now()).toISOString();
    return {
      symbol: crossExSymbol, venue: 'GATE', product: 'FUTURE',
      bidPrice: ticker.highest_bid, askPrice: ticker.lowest_ask, lastPrice: ticker.last,
      markPrice: ticker.mark_price, indexPrice: ticker.index_price,
      fundingRate: ticker.funding_rate, predictedFundingRate: ticker.funding_rate_indicative,
      nextFundingAt: isoFromSeconds(contractDetails.funding_next_apply),
      sourceTimestamp: fetchedAt, fetchedAt, source: 'gate_futures_public_rest',
    };
  }

  async queryVenueFundingRates(venue: FundingStatVenue, signal: AbortSignal): Promise<VenueFundingStat[]> {
    return this.queryVenueFundingStats(venue, signal, true);
  }
  async queryVenueFundingStats(venue: FundingStatVenue, signal?: AbortSignal, fundingOnly = false): Promise<VenueFundingStat[]> {
    if (signal) {
      signal.throwIfAborted();
      const scopedFetch: typeof fetch = (url, init) => {
        signal.throwIfAborted();
        const path = new URL(String(url)).pathname;
        if (fundingOnly && ['/fapi/v1/ticker/24hr', '/fapi/v1/ticker/bookTicker'].includes(path)) return Promise.resolve(Response.json([]));
        return this.fetchImplementation(url, { ...init, signal: init?.signal ? AbortSignal.any([signal, init.signal]) : signal });
      };
      const scoped = new VenuePublicMarketDataClient(scopedFetch, this.now, { hyperliquidMetadataStore: this.hyperliquidMetadataStore,
        hyperliquidMetadataFreshMs: this.hyperliquidMetadataFreshMs, hyperliquidForcedRefreshMinMs: this.hyperliquidForcedRefreshMinMs, sleep: this.sleep });
      scoped.hyperliquidState = this.hyperliquidState;
      return scoped.queryVenueFundingStats(venue, undefined, fundingOnly);
    }
    if (venue === 'GATE') return this.queryGateFundingStats();
    if (venue === 'BINANCE') return this.queryBinanceFundingStats();
    if (venue === 'OKX') return this.queryOkxFundingStats(fundingOnly);
    if (venue === 'BYBIT') return this.queryBybitFundingStats();
    if (venue === 'KRAKEN') return this.queryKrakenFundingStats();
    if (venue === 'HYPERLIQUID') return this.queryHyperliquidFundingStats();
    return this.queryDeribitFundingStats();
  }

  async queryFundingHistory(crossExSymbol: string, startTime: number, endTime: number, signal?: AbortSignal): Promise<FundingRatePoint[]> {
    const symbol = parseCrossExFutureSymbol(crossExSymbol);
    if (!Number.isFinite(startTime) || !Number.isFinite(endTime) || startTime >= endTime) {
      throw new PublicMarketDataError('INVALID_TIME_RANGE');
    }
    let points: FundingRatePoint[];
    switch (symbol.venue) {
      case 'GATE': points = await this.queryGateFundingHistory(symbol, startTime, endTime, signal); break;
      case 'BINANCE': points = await this.queryBinanceFundingHistory(symbol, startTime, endTime, signal); break;
      case 'OKX': points = await this.queryOkxFundingHistory(symbol, startTime, signal); break;
      case 'BYBIT': points = await this.queryBybitFundingHistory(symbol, startTime, endTime, signal); break;
      case 'KRAKEN': points = await this.queryKrakenFundingHistory(symbol, startTime, endTime, signal); break;
      case 'HYPERLIQUID': points = await this.queryHyperliquidFundingHistory(symbol, startTime, endTime, signal); break;
      case 'DERIBIT': points = await this.queryDeribitFundingHistory(symbol, startTime, endTime, signal); break;
    }
    if (points.some(point => !Number.isSafeInteger(point.timestamp) || point.timestamp < 0
      || finiteNumber(point.rate) === null)) throw new PublicMarketDataError('INCOMPLETE_HISTORY');
    return points
      .filter((point) => point.timestamp > startTime && point.timestamp <= endTime && Number.isFinite(Number(point.rate)))
      .sort((left, right) => left.timestamp - right.timestamp);
  }

  private async queryGateFundingHistory(symbol: ParsedSymbol, startTime: number, endTime: number, signal?: AbortSignal): Promise<FundingRatePoint[]> {
    if (symbol.quote !== 'USDT') throw new PublicMarketDataError('UNSUPPORTED_SETTLEMENT');
    const contract = `${symbol.base}_${symbol.quote}`;
    const payload = await fetchJson(
      this.fetchImplementation,
      `https://api.gateio.ws/api/v4/futures/usdt/funding_rate?contract=${encodeURIComponent(contract)}&from=${Math.floor(startTime / 1_000)}&to=${Math.floor(endTime / 1_000)}&limit=1000`,
      1_000_000,
      undefined,
      signal,
    );
    const rows = parsePayload(z.array(GateFundingHistoryRowSchema), payload);
    if (rows.length >= 1000) throw new PublicMarketDataError('INCOMPLETE_HISTORY');
    return rows.flatMap((row) => {
      const rate = historyNumber(row.r);
      const timestamp = historyNumber(row.t);
      return [{ timestamp: timestamp * 1_000, rate: String(rate) }];
    });
  }

  private async queryBinanceFundingHistory(symbol: ParsedSymbol, startTime: number, endTime: number, signal?: AbortSignal): Promise<FundingRatePoint[]> {
    if (!['USDT', 'USDC'].includes(symbol.quote)) throw new PublicMarketDataError('UNSUPPORTED_SETTLEMENT');
    const venueSymbol = `${symbol.base}${symbol.quote}`;
    const payload = await fetchJson(
      this.fetchImplementation,
      `https://fapi.binance.com/fapi/v1/fundingRate?symbol=${encodeURIComponent(venueSymbol)}&startTime=${Math.floor(startTime)}&endTime=${Math.floor(endTime)}&limit=1000`,
      1_000_000,
      undefined,
      signal,
    );
    const rows = parsePayload(z.array(BinanceFundingHistoryRowSchema), payload);
    if (rows.length >= 1000) throw new PublicMarketDataError('INCOMPLETE_HISTORY');
    return rows.flatMap((row) => {
      const rate = historyNumber(row.fundingRate);
      const timestamp = historyNumber(row.fundingTime);
      return [{ timestamp, rate: String(rate) }];
    });
  }

  private async queryOkxFundingHistory(symbol: ParsedSymbol, startTime: number, signal?: AbortSignal): Promise<FundingRatePoint[]> {
    if (!['USDT', 'USDC'].includes(symbol.quote)) throw new PublicMarketDataError('UNSUPPORTED_SETTLEMENT');
    const instrument = `${symbol.base}-${symbol.quote}-SWAP`;
    const points: FundingRatePoint[] = [];
    let after: number | null = null;
    for (let page = 0; page < 10; page += 1) {
      const payload = await fetchJson(
        this.fetchImplementation,
        `https://www.okx.com/api/v5/public/funding-rate-history?instId=${encodeURIComponent(instrument)}&limit=100${after === null ? '' : `&after=${after}`}`,
        1_000_000,
        undefined,
        signal,
      );
      const rows = parsePayload(z.object({
        code: z.literal('0'),
        msg: z.string(),
        data: z.array(OkxFundingHistoryRowSchema),
      }), payload).data;
      if (rows.length === 0) return points;
      let oldest = Number.POSITIVE_INFINITY;
      for (const row of rows) {
        const rate = historyNumber(row.realizedRate === undefined || row.realizedRate === '' ? row.fundingRate : row.realizedRate);
        const timestamp = historyNumber(row.fundingTime);
        oldest = Math.min(oldest, timestamp);
        points.push({ timestamp, rate: String(rate) });
      }
      if (!Number.isFinite(oldest) || (after !== null && oldest >= after)) throw new PublicMarketDataError('INCOMPLETE_HISTORY');
      if (oldest <= startTime || rows.length < 100) return points;
      after = oldest;
    }
    throw new PublicMarketDataError('INCOMPLETE_HISTORY');
  }

  private async queryBybitFundingHistory(symbol: ParsedSymbol, startTime: number, endTime: number, signal?: AbortSignal): Promise<FundingRatePoint[]> {
    if (!['USDT', 'USDC'].includes(symbol.quote)) throw new PublicMarketDataError('UNSUPPORTED_SETTLEMENT');
    const venueSymbol = symbol.quote === 'USDC' ? `${symbol.base}PERP` : `${symbol.base}${symbol.quote}`;
    const points: FundingRatePoint[] = [];
    let cursor = endTime;
    for (let page = 0; page < 5; page += 1) {
      const payload = await fetchJson(
        this.fetchImplementation,
        `https://api.bybit.com/v5/market/funding/history?category=linear&symbol=${encodeURIComponent(venueSymbol)}&startTime=${Math.floor(startTime)}&endTime=${Math.floor(cursor)}&limit=200`,
        1_000_000,
        undefined,
        signal,
      );
      const envelope = parsePayload(BybitFundingHistorySchema, payload);
      if (envelope.retCode !== 0) throw new PublicMarketDataError('UPSTREAM_REJECTED');
      const rows = envelope.result.list;
      if (rows.length === 0) return points;
      let oldest = Number.POSITIVE_INFINITY;
      for (const row of rows) {
        const rate = historyNumber(row.fundingRate);
        const timestamp = historyNumber(row.fundingRateTimestamp);
        oldest = Math.min(oldest, timestamp);
        points.push({ timestamp, rate: String(rate) });
      }
      if (!Number.isFinite(oldest) || (oldest > cursor)) throw new PublicMarketDataError('INCOMPLETE_HISTORY');
      if (oldest <= startTime || rows.length < 200) return points;
      cursor = oldest - 1;
    }
    throw new PublicMarketDataError('INCOMPLETE_HISTORY');
  }

  private async queryKrakenFundingHistory(symbol: ParsedSymbol, startTime: number, endTime: number, signal?: AbortSignal): Promise<FundingRatePoint[]> {
    if (symbol.quote !== 'USD') throw new PublicMarketDataError('UNSUPPORTED_SETTLEMENT');
    const legacyBase = symbol.base === 'BTC' ? 'XBT' : symbol.base === 'DOGE' ? 'XDG' : symbol.base;
    const instrument = `PF_${legacyBase}${symbol.quote}`;
    const payload = await fetchJson(
      this.fetchImplementation,
      `https://futures.kraken.com/api/charts/v1/analytics/${encodeURIComponent(instrument)}/funding?since=${Math.floor(startTime / 1_000)}&to=${Math.floor(endTime / 1_000)}&interval=3600`,
      4_000_000,
      undefined,
      signal,
    );
    const result = parsePayload(KrakenFundingAnalyticsSchema, payload);
    if (result.errors.length > 0 || result.result.more
      || result.result.timestamp.length !== result.result.data.relativeRate.length) throw new PublicMarketDataError('INCOMPLETE_HISTORY');
    return result.result.timestamp.flatMap((timestamp, index) => {
      const bucket = result.result.data.relativeRate[index];
      const rate = historyNumber(bucket?.[3]);
      return [{ timestamp, rate: String(rate) }];
    });
  }

  private async fetchHyperliquidFundingHistoryPage(
    nativeName: string,
    startTime: number,
    endTime: number,
    signal?: AbortSignal,
  ): Promise<unknown> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await fetchJson(
          this.fetchImplementation,
          'https://api.hyperliquid.xyz/info',
          1_000_000,
          { body: JSON.stringify({
            type: 'fundingHistory',
            coin: nativeName,
            startTime: Math.floor(startTime),
            endTime: Math.floor(endTime),
          }) },
          signal,
        );
      } catch (error) {
        if (signal?.aborted) throw new PublicMarketDataError('ABORTED');
        const retryDelay = HYPERLIQUID_FUNDING_HISTORY_RETRY_DELAYS_MS[attempt];
        if (retryDelay === undefined || !isRetryablePublicMarketDataError(error)) throw error;
        await this.sleep(Math.max(retryDelay, error.retryAfterMs ?? 0), signal);
        if (signal?.aborted) throw new PublicMarketDataError('ABORTED');
      }
    }
  }

  private async queryHyperliquidFundingHistory(symbol: ParsedSymbol, startTime: number, endTime: number, signal?: AbortSignal): Promise<FundingRatePoint[]> {
    if (symbol.quote !== 'USDC') throw new PublicMarketDataError('UNSUPPORTED_SETTLEMENT');
    const nativeName = await this.resolveHyperliquidNativeName(symbol.base);
    const points: FundingRatePoint[] = [];
    let cursor = startTime;
    for (let page = 0; page < 3; page += 1) {
      if (page > 0) await this.sleep(HYPERLIQUID_FUNDING_HISTORY_PAGE_SPACING_MS, signal);
      const payload = await this.fetchHyperliquidFundingHistoryPage(nativeName, cursor, endTime, signal);
      const rows = parsePayload(z.array(HyperliquidFundingHistoryRowSchema), payload);
      if (rows.length === 0) return points;
      for (const row of rows) {
        const rate = historyNumber(row.fundingRate);
        points.push({ timestamp: row.time, rate: String(rate) });
      }
      if (rows.length < 500) return points;
      const lastTimestamp = rows[rows.length - 1]?.time;
      if (!lastTimestamp || lastTimestamp < cursor) throw new PublicMarketDataError('INCOMPLETE_HISTORY');
      cursor = lastTimestamp + 1;
      if (cursor > endTime) return points;
    }
    throw new PublicMarketDataError('INCOMPLETE_HISTORY');
  }

  private async queryDeribitFundingHistory(symbol: ParsedSymbol, startTime: number, endTime: number, signal?: AbortSignal): Promise<FundingRatePoint[]> {
    if (symbol.quote !== 'USDC') throw new PublicMarketDataError('UNSUPPORTED_SETTLEMENT');
    const instrument = `${symbol.base}_${symbol.quote}-PERPETUAL`;
    const payload = await fetchJson(
      this.fetchImplementation,
      `https://www.deribit.com/api/v2/public/get_funding_rate_history?instrument_name=${encodeURIComponent(instrument)}&start_timestamp=${Math.floor(startTime)}&end_timestamp=${Math.floor(endTime)}`,
      4_000_000,
      undefined,
      signal,
    );
    return parsePayload(DeribitFundingHistorySchema, payload).result.map((row) => ({
      timestamp: row.timestamp,
      // Deribit returns rolling 8h and realized hourly interest; summing rolling 8h values
      // would count the same accrual repeatedly.
      rate: String(row.interest_1h),
    }));
  }

  private async queryGateFundingStats(): Promise<VenueFundingStat[]> {
    const [payload, contractRows] = await Promise.all([
      fetchJson(this.fetchImplementation, 'https://api.gateio.ws/api/v4/futures/usdt/tickers', 8_000_000),
      optionalPayload(
        fetchJson(this.fetchImplementation, 'https://api.gateio.ws/api/v4/futures/usdt/contracts', 8_000_000),
        GateContractListSchema,
        [],
      ),
    ]);
    const contracts = new Map(contractRows.map((contract) => [contract.name, contract]));
    const rows = parsePayload(z.array(z.unknown()), payload);
    const stats: VenueFundingStat[] = [];
    for (const rawRow of rows) {
      const row = GateFundingRowSchema.safeParse(rawRow);
      if (!row.success) continue;
      const match = /^([A-Z0-9]+)_(USDT|USDC|USD)$/.exec(row.data.contract);
      if (!match?.[1] || !match[2]) continue;
      const rate = finiteNumber(row.data.funding_rate);
      const contract = contracts.get(row.data.contract);
      const intervalHours = fundingIntervalHours(
        contract?.funding_interval === undefined ? undefined : Number(contract.funding_interval) / 3_600,
      );
      const nextFunding = finiteNumber(contract?.funding_next_apply);
      stats.push({
        venue: 'GATE', base: match[1], quote: match[2],
        fundingCycleVerified: contract?.funding_interval !== undefined && Number.isFinite(Number(contract.funding_interval)) && Number(contract.funding_interval) > 0 && Number(contract.funding_interval) <= 86400,
        ...fundingBook(row.data.highest_bid, row.data.lowest_ask, this.now()),
        fundingRate: rate === null ? null : String(rate),
        fundingIntervalHours: intervalHours,
        fundingRate8h: rate === null ? null : rateScaledTo8h(rate, intervalHours),
        nextFundingAt: nextFunding !== null && nextFunding > 0 ? new Date(nextFunding * 1_000).toISOString() : null,
        openInterestValue: positiveProduct(
          finiteNumber(row.data.total_size),
          finiteNumber(row.data.quanto_multiplier),
          finiteNumber(row.data.mark_price),
        ),
        lastPrice: positiveNumberText(row.data.last) ?? positiveNumberText(row.data.mark_price),
        change24h: fractionFromPercent(row.data.change_percentage),
      });
    }
    return stats;
  }

  private async queryBinanceFundingStats(): Promise<VenueFundingStat[]> {
    let fundingInfoVerified = true;
    let fundingInfoError: unknown;
    const optionalRowsSchema = z.array(z.unknown());
    const [fundingPayload, tickerRows, fundingInfoRows, bookRows] = await Promise.all([
      fetchJson(this.fetchImplementation, 'https://fapi.binance.com/fapi/v1/premiumIndex', 4_000_000),
      optionalPayload(
        fetchJson(this.fetchImplementation, 'https://fapi.binance.com/fapi/v1/ticker/24hr', 8_000_000),
        optionalRowsSchema,
        [],
      ),
      fetchJson(this.fetchImplementation, 'https://fapi.binance.com/fapi/v1/fundingInfo', 4_000_000)
        .then(payload => parsePayload(optionalRowsSchema, payload))
        .catch(error => { fundingInfoVerified = false; fundingInfoError = error; return []; }),
      optionalPayload(fetchJson(this.fetchImplementation, 'https://fapi.binance.com/fapi/v1/ticker/bookTicker', 8_000_000), optionalRowsSchema, []),
    ]);
    if (fundingInfoError instanceof PublicMarketDataError && fundingInfoError.retryAfterMs) throw fundingInfoError;
    const books = new Map<string, ReturnType<typeof fundingBook>>();
    for (const raw of bookRows) {
      const row = z.object({ symbol: z.string(), bidPrice: z.unknown().optional(), askPrice: z.unknown().optional(), time: z.unknown().optional() }).safeParse(raw);
      if (row.success) books.set(row.data.symbol, fundingBook(row.data.bidPrice, row.data.askPrice, this.now(), row.data.time));
    }
    const rows = parsePayload(z.array(z.unknown()), fundingPayload);
    const tickers = new Map<string, z.infer<typeof BinanceTicker24hRowSchema>>();
    for (const rawRow of tickerRows) {
      const row = BinanceTicker24hRowSchema.safeParse(rawRow);
      if (row.success) tickers.set(row.data.symbol, row.data);
    }
    const fundingIntervals = new Map<string, number>();
    for (const rawRow of fundingInfoRows) {
      const row = BinanceFundingInfoRowSchema.safeParse(rawRow);
      if (row.success && Number.isFinite(Number(row.data.fundingIntervalHours)) && Number(row.data.fundingIntervalHours) > 0 && Number(row.data.fundingIntervalHours) <= 24) fundingIntervals.set(row.data.symbol, fundingIntervalHours(row.data.fundingIntervalHours));
      else fundingInfoVerified = false;
    }
    const stats: VenueFundingStat[] = [];
    for (const rawRow of rows) {
      const row = BinanceFundingRowSchema.safeParse(rawRow);
      if (!row.success) continue;
      // Dated futures carry a settlement suffix (BTCUSDT_260327); only perpetuals are wanted.
      if (row.data.symbol.includes('_')) continue;
      const quote = row.data.symbol.endsWith('USDT') ? 'USDT' : row.data.symbol.endsWith('USDC') ? 'USDC' : null;
      if (!quote) continue;
      const base = row.data.symbol.slice(0, -quote.length);
      if (!base) continue;
      const rate = finiteNumber(row.data.lastFundingRate);
      const intervalHours = fundingIntervals.get(row.data.symbol) ?? 8;
      const ticker = tickers.get(row.data.symbol);
      stats.push({
        venue: 'BINANCE', base, quote, fundingCycleVerified: fundingInfoVerified,
        ...books.get(row.data.symbol),
        fundingRate: rate === null ? null : String(rate),
        fundingIntervalHours: intervalHours,
        fundingRate8h: rate === null ? null : rateScaledTo8h(rate, intervalHours),
        nextFundingAt: row.data.nextFundingTime > 0 ? new Date(row.data.nextFundingTime).toISOString() : null,
        // Binance publishes no bulk open-interest endpoint; the per-symbol one is unusable at catalog scale.
        openInterestValue: null,
        lastPrice: positiveNumberText(ticker?.lastPrice),
        change24h: fractionFromPercent(ticker?.priceChangePercent),
      });
    }
    return stats;
  }

  private async queryOkxFundingStats(fundingOnly = false): Promise<VenueFundingStat[]> {
    const [fundingPayload, tickerPayload] = await Promise.all([
      fetchJson(this.fetchImplementation, 'https://www.okx.com/api/v5/public/funding-rate?instId=ANY', 8_000_000),
      fundingOnly ? Promise.resolve(null) : fetchJson(this.fetchImplementation, 'https://www.okx.com/api/v5/market/tickers?instType=SWAP', 8_000_000),
    ]);
    const tickerBySwap = new Map<string, z.infer<typeof OkxTickerRowSchema>>();
    for (const rawRow of tickerPayload === null ? [] : parsePayload(okxEnvelope(z.unknown()), tickerPayload).data) {
      const row = OkxTickerRowSchema.safeParse(rawRow);
      if (row.success) tickerBySwap.set(row.data.instId, row.data);
    }
    const openInterestBySwap = new Map<string, string>();
    if (!fundingOnly) try {
      const openInterestPayload = await fetchJson(this.fetchImplementation, 'https://www.okx.com/api/v5/public/open-interest?instType=SWAP', 8_000_000);
      for (const rawRow of parsePayload(okxEnvelope(z.unknown()), openInterestPayload).data) {
        const row = OkxOpenInterestRowSchema.safeParse(rawRow);
        if (!row.success) continue;
        const value = finiteNumber(row.data.oiUsd);
        if (value !== null && value > 0) openInterestBySwap.set(row.data.instId, String(value));
      }
    } catch {
      // Funding rows still render without OI; the venue keeps its last-good OI upstream of this call.
    }
    const stats: VenueFundingStat[] = [];
    for (const rawRow of parsePayload(okxEnvelope(z.unknown()), fundingPayload).data) {
      const row = OkxFundingRowSchema.safeParse(rawRow);
      if (!row.success) continue;
      const match = /^([A-Z0-9]+)-(USDT|USDC|USD)-SWAP$/.exec(row.data.instId);
      if (!match?.[1] || !match[2]) continue;
      const rate = finiteNumber(row.data.fundingRate);
      const currentSettle = finiteNumber(row.data.fundingTime);
      const nextSettle = finiteNumber(row.data.nextFundingTime);
      const intervalHours = currentSettle !== null && nextSettle !== null ? (nextSettle - currentSettle) / 3_600_000 : 8;
      const normalizedIntervalHours = fundingIntervalHours(intervalHours);
      const ticker = tickerBySwap.get(row.data.instId);
      stats.push({
        venue: 'OKX', base: match[1], quote: match[2],
        fundingCycleVerified: currentSettle !== null && nextSettle !== null && nextSettle > currentSettle && nextSettle - currentSettle <= 86400000,
        ...fundingBook(ticker?.bidPx, ticker?.askPx, this.now(), ticker?.ts),
        fundingRate: rate === null ? null : String(rate),
        fundingIntervalHours: normalizedIntervalHours,
        fundingRate8h: rate === null ? null : rateScaledTo8h(rate, normalizedIntervalHours),
        nextFundingAt: currentSettle !== null && currentSettle > 0 ? new Date(currentSettle).toISOString() : null,
        openInterestValue: openInterestBySwap.get(row.data.instId) ?? null,
        lastPrice: positiveNumberText(ticker?.last),
        change24h: changeFraction(ticker?.last, ticker?.open24h),
      });
    }
    return stats;
  }

  private async queryBybitFundingStats(): Promise<VenueFundingStat[]> {
    const payload = await fetchJson(this.fetchImplementation, 'https://api.bybit.com/v5/market/tickers?category=linear', 8_000_000);
    const envelope = parsePayload(z.object({ retCode: z.number(), result: z.object({ list: z.array(z.unknown()) }) }), payload);
    if (envelope.retCode !== 0) throw new PublicMarketDataError('UPSTREAM_REJECTED');
    const stats: VenueFundingStat[] = [];
    for (const rawRow of envelope.result.list) {
      const row = BybitFundingRowSchema.safeParse(rawRow);
      if (!row.success) continue;
      // Dated USDC futures look like BTC-26DEC25; perpetuals never carry a dash.
      if (row.data.symbol.includes('-')) continue;
      const symbol = row.data.symbol;
      const quote = symbol.endsWith('USDT') ? 'USDT' : symbol.endsWith('USDC') ? 'USDC' : symbol.endsWith('PERP') ? 'USDC' : null;
      if (!quote) continue;
      const base = symbol.slice(0, -4);
      if (!base) continue;
      const rate = finiteNumber(row.data.fundingRate);
      const nextFunding = finiteNumber(row.data.nextFundingTime);
      const oiValue = finiteNumber(row.data.openInterestValue);
      const change24h = finiteNumber(row.data.price24hPcnt);
      const intervalHours = fundingIntervalHours(row.data.fundingIntervalHour);
      stats.push({
        venue: 'BYBIT', base, quote, fundingCycleVerified: Number.isFinite(Number(row.data.fundingIntervalHour)) && Number(row.data.fundingIntervalHour) > 0 && Number(row.data.fundingIntervalHour) <= 24,
        ...fundingBook(row.data.bid1Price, row.data.ask1Price, this.now()),
        fundingRate: rate === null ? null : String(rate),
        fundingIntervalHours: intervalHours,
        fundingRate8h: rate === null ? null : rateScaledTo8h(rate, intervalHours),
        nextFundingAt: nextFunding !== null && nextFunding > 0 ? new Date(nextFunding).toISOString() : null,
        openInterestValue: oiValue !== null && oiValue > 0 ? String(oiValue) : null,
        lastPrice: positiveNumberText(row.data.lastPrice),
        // Bybit already reports this as a fraction rather than a whole percentage.
        change24h: change24h === null ? null : String(change24h),
      });
    }
    return stats;
  }

  private async queryKrakenFundingStats(): Promise<VenueFundingStat[]> {
    const payload = await fetchJson(this.fetchImplementation, 'https://futures.kraken.com/derivatives/api/v3/tickers', 4_000_000);
    const envelope = parsePayload(z.object({ tickers: z.array(z.unknown()) }), payload);
    const stats: VenueFundingStat[] = [];
    for (const rawRow of envelope.tickers) {
      const row = KrakenFundingRowSchema.safeParse(rawRow);
      if (!row.success) continue;
      // PF_ = linear multi-collateral perpetuals, the contracts CrossEx routes to.
      if (row.data.tag !== 'perpetual' || !row.data.symbol.startsWith('PF_') || row.data.suspended === true) continue;
      const [pairBase, pairQuote] = row.data.pair.split(':');
      if (!pairBase || !pairQuote) continue;
      const base = KRAKEN_ASSET_RENAMES[pairBase] ?? pairBase;
      const mark = finiteNumber(row.data.markPrice);
      const fundingAbsolute = finiteNumber(row.data.fundingRate);
      // Kraken reports the absolute hourly funding rate in quote units; relative = rate / mark.
      const rate8h = mark !== null && mark > 0 && fundingAbsolute !== null ? rateScaledTo8h(fundingAbsolute / mark, 1) : null;
      stats.push({
        venue: 'KRAKEN', base, quote: pairQuote,
        ...fundingBook(row.data.bid, row.data.ask, this.now()),
        fundingRate: mark !== null && mark > 0 && fundingAbsolute !== null ? String(fundingAbsolute / mark) : null,
        fundingIntervalHours: 1,
        fundingRate8h: rate8h,
        nextFundingAt: null,
        openInterestValue: positiveProduct(finiteNumber(row.data.openInterest), mark),
        lastPrice: positiveNumberText(row.data.last) ?? positiveNumberText(row.data.markPrice),
        change24h: fractionFromPercent(row.data.change24h),
      });
    }
    return stats;
  }

  private async queryHyperliquidFundingStats(): Promise<VenueFundingStat[]> {
    const metadata = await this.loadHyperliquidMetadata();
    const liveNativeNames = new Set(metadata.nativeNames);
    const dexes = [...new Set(metadata.nativeNames.map(hyperliquidDex))].sort((left, right) => {
      if (left === '') return -1;
      if (right === '') return 1;
      return left.localeCompare(right);
    });
    const results = await Promise.allSettled(dexes.map(async (dex) => {
      const body = dex === '' ? { type: 'metaAndAssetCtxs' } : { type: 'metaAndAssetCtxs', dex };
      const payload = await fetchJson(
        this.fetchImplementation,
        'https://api.hyperliquid.xyz/info',
        4_000_000,
        { body: JSON.stringify(body) },
      );
      return parsePayload(HyperliquidMetaAndCtxSchema, payload);
    }));
    const successful = results.flatMap((result) => result.status === 'fulfilled' ? [result.value] : []);
    if (successful.length === 0) {
      const failure = results.find((result) => result.status === 'rejected');
      throw failure?.status === 'rejected'
        ? failure.reason
        : new PublicMarketDataError('EMPTY_HYPERLIQUID_CONTEXTS');
    }

    // Hyperliquid settles funding hourly on the hour.
    const nextHour = new Date(Math.ceil((this.now() + 1) / 3_600_000) * 3_600_000).toISOString();
    const candidatesByBase = new Map<string, Array<{ nativeName: string; stat: VenueFundingStat }>>();
    for (const [meta, contexts] of successful) {
      meta.universe.forEach((entry, index) => {
        const context = contexts[index];
        if (!context || entry.isDelisted === true || !liveNativeNames.has(entry.name)) return;
        const base = hyperliquidBase(entry.name);
        const rate = finiteNumber(context.funding);
        const candidates = candidatesByBase.get(base) ?? [];
        candidates.push({
          nativeName: entry.name,
          stat: {
            venue: 'HYPERLIQUID', base, quote: 'USDC',
            fundingRate: rate === null ? null : String(rate),
            fundingIntervalHours: 1,
            fundingRate8h: rate === null ? null : rateScaledTo8h(rate, 1),
            nextFundingAt: nextHour,
            openInterestValue: positiveProduct(finiteNumber(context.openInterest), finiteNumber(context.markPx)),
            lastPrice: positiveNumberText(context.markPx),
            change24h: changeFraction(context.markPx, context.prevDayPx),
          },
        });
        candidatesByBase.set(base, candidates);
      });
    }
    const stats: VenueFundingStat[] = [];
    for (const [base, candidates] of [...candidatesByBase.entries()].sort(([left], [right]) => left.localeCompare(right))) {
      const selectedName = selectHyperliquidNativeName(base, candidates.map((candidate) => candidate.nativeName));
      const selected = candidates.find((candidate) => candidate.nativeName === selectedName);
      if (selected) stats.push(selected.stat);
    }
    return stats;
  }

  private async queryDeribitFundingStats(): Promise<VenueFundingStat[]> {
    const payload = await fetchJson(this.fetchImplementation, 'https://www.deribit.com/api/v2/public/get_book_summary_by_currency?currency=USDC&kind=future', 2_000_000);
    const envelope = parsePayload(z.object({ result: z.array(z.unknown()) }), payload);
    const stats: VenueFundingStat[] = [];
    for (const rawRow of envelope.result) {
      const row = DeribitBookSummaryRowSchema.safeParse(rawRow);
      if (!row.success) continue;
      const match = /^([A-Z0-9]+)_USDC-PERPETUAL$/.exec(row.data.instrument_name);
      if (!match?.[1]) continue;
      stats.push({
        venue: 'DERIBIT', base: match[1], quote: 'USDC',
        ...fundingBook(row.data.bid_price, row.data.ask_price, this.now()),
        // funding_8h is already the 8h rate; Deribit perpetuals accrue funding continuously.
        fundingRate: row.data.funding_8h !== undefined && Number.isFinite(row.data.funding_8h) ? String(row.data.funding_8h) : null,
        fundingIntervalHours: 8,
        fundingRate8h: row.data.funding_8h !== undefined && Number.isFinite(row.data.funding_8h) ? String(row.data.funding_8h) : null,
        nextFundingAt: null,
        openInterestValue: positiveProduct(finiteNumber(row.data.open_interest), finiteNumber(row.data.mark_price)),
        lastPrice: positiveNumberText(row.data.last) ?? positiveNumberText(row.data.mark_price),
        change24h: fractionFromPercent(row.data.price_change),
      });
    }
    return stats;
  }

  private async queryOkx(crossExSymbol: string, symbol: ParsedSymbol): Promise<PublicMarketSnapshot> {
    if (!['USDT', 'USDC'].includes(symbol.quote)) throw new PublicMarketDataError('UNSUPPORTED_SETTLEMENT');
    const instrument = `${symbol.base}-${symbol.quote}-SWAP`;
    const indexInstrument = `${symbol.base}-${symbol.quote}`;
    const [tickerPayload, markPayload, indexPayload, fundingPayload] = await Promise.all([
      fetchJson(this.fetchImplementation, `https://www.okx.com/api/v5/market/ticker?instId=${encodeURIComponent(instrument)}`),
      fetchJson(this.fetchImplementation, `https://www.okx.com/api/v5/public/mark-price?instType=SWAP&instId=${encodeURIComponent(instrument)}`),
      fetchJson(this.fetchImplementation, `https://www.okx.com/api/v5/market/index-tickers?instId=${encodeURIComponent(indexInstrument)}`),
      fetchJson(this.fetchImplementation, `https://www.okx.com/api/v5/public/funding-rate?instId=${encodeURIComponent(instrument)}`),
    ]);
    const ticker = parsePayload(OkxTickerSchema, tickerPayload).data[0];
    const mark = parsePayload(OkxMarkSchema, markPayload).data[0];
    const index = parsePayload(OkxIndexSchema, indexPayload).data[0];
    const funding = parsePayload(OkxFundingSchema, fundingPayload).data[0];
    if (!ticker || !mark || !index || !funding) throw new PublicMarketDataError('INVALID_RESPONSE_SCHEMA');
    return {
      symbol: crossExSymbol, venue: 'OKX', product: 'FUTURE',
      bidPrice: ticker.bidPx || null, askPrice: ticker.askPx || null, lastPrice: ticker.last || null,
      markPrice: mark.markPx, indexPrice: index.idxPx, fundingRate: funding.fundingRate,
      predictedFundingRate: funding.nextFundingRate || null,
      // OKX's current fundingRate settles at fundingTime. nextFundingTime is the
      // following cycle, so using it makes the terminal countdown one full interval too long.
      nextFundingAt: isoFromMilliseconds(funding.fundingTime),
      sourceTimestamp: isoFromMilliseconds(Math.max(Number(ticker.ts), Number(mark.ts), Number(index.ts), Number(funding.ts))),
      fetchedAt: new Date(this.now()).toISOString(), source: 'okx_public_rest',
    };
  }
}
