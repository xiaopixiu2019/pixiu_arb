import { z } from 'zod';
import type { FundingAssetClass, MarketCatalogVenue } from '@gate-crossex/shared-types';

const MARKET_CAP_LIMIT = 20;
const COINGECKO_MARKETS_URL = new URL('https://api.coingecko.com/api/v3/coins/markets');
COINGECKO_MARKETS_URL.search = new URLSearchParams({
  vs_currency: 'usd',
  order: 'market_cap_desc',
  per_page: '50',
  page: '1',
  sparkline: 'false',
}).toString();
const COINGECKO_STABLECOINS_URL = new URL(COINGECKO_MARKETS_URL);
COINGECKO_STABLECOINS_URL.searchParams.set('category', 'stablecoins');
COINGECKO_STABLECOINS_URL.searchParams.set('per_page', '250');
const COINGECKO_COIN_LIST_URL = new URL('https://api.coingecko.com/api/v3/coins/list?include_platform=false');

const CoinGeckoMarketRowSchema = z.object({
  id: z.string().min(1).max(120),
  symbol: z.string().min(1).max(40),
  name: z.string().min(1).max(160),
  market_cap_rank: z.number().int().positive().nullable(),
});
const CoinGeckoCoinListRowSchema = z.object({
  id: z.string().min(1).max(120),
  symbol: z.string().min(1).max(40),
  name: z.string().min(1).max(160),
});

export const CryptoMarketCapSnapshotSchema = z.object({
  assets: z.array(z.object({
    id: z.string().min(1).max(120),
    symbol: z.string().regex(/^[A-Z0-9_]+$/).max(40),
    name: z.string().min(1).max(160),
    rank: z.number().int().min(1).max(10_000),
  })).length(MARKET_CAP_LIMIT),
  knownSymbols: z.array(z.string().regex(/^[A-Z0-9_]+$/).max(40)).max(100_000),
  fetchedAt: z.iso.datetime(),
});
export type CryptoMarketCapSnapshot = z.infer<typeof CryptoMarketCapSnapshotSchema>;
export type CryptoMarketCapStatus = 'fresh' | 'stale' | 'fallback';

export interface CryptoMarketCapStore {
  read(): CryptoMarketCapSnapshot | null;
  write(snapshot: CryptoMarketCapSnapshot): void;
}

export interface CryptoMarketCapProvider {
  load(): Promise<{ snapshot: CryptoMarketCapSnapshot; status: CryptoMarketCapStatus }>;
}

export interface CoinGeckoMarketCapProviderOptions {
  store?: CryptoMarketCapStore;
  freshMs?: number;
  failureRetryMs?: number;
  requestTimeoutMs?: number;
  fallbackSnapshot?: CryptoMarketCapSnapshot;
}

const FALLBACK_TOP_20 = [
  ['bitcoin', 'BTC', 'Bitcoin'],
  ['ethereum', 'ETH', 'Ethereum'],
  ['binancecoin', 'BNB', 'BNB'],
  ['ripple', 'XRP', 'XRP'],
  ['solana', 'SOL', 'Solana'],
  ['tron', 'TRX', 'TRON'],
  ['figure-heloc', 'FIGR_HELOC', 'Figure Heloc'],
  ['hyperliquid', 'HYPE', 'Hyperliquid'],
  ['zcash', 'ZEC', 'Zcash'],
  ['dogecoin', 'DOGE', 'Dogecoin'],
  ['rain', 'RAIN', 'Rain'],
  ['monero', 'XMR', 'Monero'],
  ['chainlink', 'LINK', 'Chainlink'],
  ['whitebit', 'WBT', 'WhiteBIT Coin'],
  ['leo-token', 'LEO', 'LEO Token'],
  ['cardano', 'ADA', 'Cardano'],
  ['stellar', 'XLM', 'Stellar'],
  ['bitcoin-cash', 'BCH', 'Bitcoin Cash'],
  ['canton-network', 'CC', 'Canton'],
  ['litecoin', 'LTC', 'Litecoin'],
] as const;

export const BUNDLED_MARKET_CAP_SNAPSHOT = CryptoMarketCapSnapshotSchema.parse({
  assets: FALLBACK_TOP_20.map(([id, symbol, name], index) => ({ id, symbol, name, rank: index + 1 })),
  knownSymbols: FALLBACK_TOP_20.map(([, symbol]) => symbol),
  fetchedAt: '2026-09-05T07:12:30.000Z',
});

// Version-controlled because CrossEx exposes executable symbols but no asset-class metadata.
// This covers single stocks, ETFs, equity indexes/baskets, and pre-IPO equity proxies.
const STOCK_ASSETS = new Set([
  'AAOI', 'AAPL', 'AMAT', 'AMD', 'AMZN', 'ANTH', 'ANTHROPIC', 'ANSEM', 'ARM', 'ASML', 'AVGO',
  'BABA', 'BB', 'BE', 'BIOTECH', 'BIRD', 'BMNR', 'BOT', 'BX', 'CAMBRICON', 'CAR', 'CBRS', 'CIEN',
  'CL', 'COHR', 'COIN', 'COST', 'CRCL', 'CRDO', 'CRWD', 'CRWV', 'CXMT', 'DEFENSE', 'DELL', 'DKNG',
  'DRAM', 'EBAY', 'ENERGY', 'EWT', 'EWJ', 'EWY', 'EWZ', 'GEV', 'GIGADEV', 'GLDMINE', 'GLW',
  'GOOG', 'GOOGL', 'GME', 'GPRO', 'H100', 'HIMS', 'HYUNDAI', 'IBIDEN', 'IBM', 'IBOV', 'IGV',
  'INFOTECH', 'INNOLIGHT', 'INTC', 'IONQ', 'IREN', 'JP225', 'KIOXIA', 'KORU', 'KR200', 'KSTR',
  'KWEB', 'LITE', 'LLY', 'LRCX', 'LYTE', 'MAGS', 'MAG7', 'MELI', 'META', 'MINIMAX', 'MRNA',
  'MRVL', 'MSFT', 'MSTR', 'MU', 'NAVER', 'NBIS', 'NCLD', 'NET', 'NFLX', 'NIFTY', 'NOK', 'NOW',
  'NUCLEAR', 'NVDA', 'OAI', 'OPENAI', 'ORCL', 'PLTR', 'PURRDAT', 'QCOM', 'RDDT', 'RIVN', 'RKLB',
  'ROBOT', 'RTX', 'SEMI', 'SEMIS', 'SHAZ', 'SHEIN', 'SKHX', 'SKHY', 'SKHYNIX', 'SMCI', 'SMH',
  'SMSN', 'SNDK', 'SOFI', 'SOFTBANK', 'SOXL', 'SP500', 'SPACEX', 'SPCX', 'STRC', 'TER', 'TENCENT',
  'TSLA', 'TSM', 'TTWO', 'UNITREE', 'US500', 'USA100', 'USA500', 'USAR', 'USENERGY', 'USTECH',
  'VST', 'WDC', 'XBI', 'XIAOMI', 'XLE', 'XYZ100', 'YMTC', 'ZHIPU', 'ZM',
]);

const OTHER_ASSETS = new Set([
  '10Y', '2Y', '30Y', 'ALUMINIUM', 'BRENTOIL', 'COPPER', 'CORN', 'DXY', 'EUR', 'GAS', 'GOLD',
  'GBP', 'JPY', 'KRW', 'NATGAS', 'OIL', 'PALLADIUM', 'PLATINUM', 'SILVER', 'TTF', 'URANIUM',
  'USBOND', 'USOIL', 'VIX', 'WHEAT', 'WTI',
]);

const CRYPTO_SYMBOL_ALIASES: Readonly<Record<string, string>> = {
  KPEPE: 'PEPE',
  KSHIB: 'SHIB',
  KBONK: 'BONK',
  KLUNC: 'LUNC',
  KFLOKI: 'FLOKI',
  KDOGS: 'DOGS',
  KNEIRO: 'NEIRO',
  '1000PEPE': 'PEPE',
};

function cryptoRankingSymbol(asset: string): string {
  const normalized = asset.trim().toUpperCase();
  return CRYPTO_SYMBOL_ALIASES[normalized] ?? normalized;
}

function isVenueScopedStock(asset: string, venues: readonly MarketCatalogVenue[]): boolean {
  if (asset !== 'QNT') return false;
  return venues.length > 0 && venues.every((venue) => venue.venue === 'HYPERLIQUID');
}

export function classifyFundingAsset(
  asset: string,
  venues: readonly MarketCatalogVenue[],
  topMarketCapSymbols: ReadonlySet<string>,
  knownCryptoSymbols: ReadonlySet<string> = topMarketCapSymbols,
): FundingAssetClass {
  const normalized = asset.trim().toUpperCase();
  if (!/^[A-Z0-9_]+$/.test(normalized)) return 'UNCLASSIFIED';
  if (STOCK_ASSETS.has(normalized) || isVenueScopedStock(normalized, venues)) return 'STOCK';
  if (OTHER_ASSETS.has(normalized)) return 'OTHER';
  const rankingSymbol = cryptoRankingSymbol(normalized);
  if (topMarketCapSymbols.has(rankingSymbol)) return 'CRYPTO_BLUE_CHIP';
  return knownCryptoSymbols.has(rankingSymbol) ? 'CRYPTO_ALTCOIN' : 'UNCLASSIFIED';
}

export class CoinGeckoMarketCapProvider implements CryptoMarketCapProvider {
  private readonly store: CryptoMarketCapStore | undefined;
  private readonly freshMs: number;
  private readonly failureRetryMs: number;
  private readonly requestTimeoutMs: number;
  private snapshot: CryptoMarketCapSnapshot;
  private snapshotOrigin: 'live' | 'stored' | 'fallback';
  private inFlight: Promise<{ snapshot: CryptoMarketCapSnapshot; status: CryptoMarketCapStatus }> | null = null;
  private lastAttemptAt = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly fetchImplementation: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
    options: CoinGeckoMarketCapProviderOptions = {},
  ) {
    this.store = options.store;
    this.freshMs = options.freshMs ?? 4 * 60 * 60_000;
    this.failureRetryMs = options.failureRetryMs ?? 15 * 60_000;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 8_000;
    const stored = this.readStoredSnapshot();
    this.snapshot = stored ?? options.fallbackSnapshot ?? BUNDLED_MARKET_CAP_SNAPSHOT;
    this.snapshotOrigin = stored ? 'stored' : 'fallback';
  }

  async load(): Promise<{ snapshot: CryptoMarketCapSnapshot; status: CryptoMarketCapStatus }> {
    const now = this.now();
    const age = now - Date.parse(this.snapshot.fetchedAt);
    if (this.snapshotOrigin !== 'fallback' && age < this.freshMs) {
      return { snapshot: this.snapshot, status: 'fresh' };
    }
    if (now - this.lastAttemptAt < this.failureRetryMs) return this.currentFallback();
    if (this.inFlight) return this.inFlight;
    this.lastAttemptAt = now;
    const pending = this.refresh().finally(() => {
      if (this.inFlight === pending) this.inFlight = null;
    });
    this.inFlight = pending;
    return pending;
  }

  private readStoredSnapshot(): CryptoMarketCapSnapshot | null {
    try {
      return this.store?.read() ?? null;
    } catch {
      return null;
    }
  }

  private currentFallback(): { snapshot: CryptoMarketCapSnapshot; status: CryptoMarketCapStatus } {
    return {
      snapshot: this.snapshot,
      status: this.snapshotOrigin === 'fallback' ? 'fallback' : 'stale',
    };
  }

  private async refresh(): Promise<{ snapshot: CryptoMarketCapSnapshot; status: CryptoMarketCapStatus }> {
    try {
      const [rows, stablecoinRows, coinListRows] = await Promise.all([
        this.fetchRows(COINGECKO_MARKETS_URL, 50),
        this.fetchRows(COINGECKO_STABLECOINS_URL, 1),
        this.fetchCoinList(),
      ]);
      const stablecoinIds = new Set(stablecoinRows.map((row) => row.id));
      const ranked = rows
        .filter((row): row is typeof row & { market_cap_rank: number } => (
          row.market_cap_rank !== null && !stablecoinIds.has(row.id)
        ))
        .sort((left, right) => left.market_cap_rank - right.market_cap_rank)
        .slice(0, MARKET_CAP_LIMIT);
      const snapshot = CryptoMarketCapSnapshotSchema.parse({
        assets: ranked.map((row, index) => ({
          id: row.id,
          symbol: row.symbol.toUpperCase(),
          name: row.name,
          rank: index + 1,
        })),
        knownSymbols: [...new Set(coinListRows.map((row) => row.symbol.toUpperCase()))]
          .filter((symbol) => /^[A-Z0-9_]+$/.test(symbol))
          .sort((left, right) => left.localeCompare(right)),
        fetchedAt: new Date(this.now()).toISOString(),
      });
      this.snapshot = snapshot;
      this.snapshotOrigin = 'live';
      try {
        this.store?.write(snapshot);
      } catch {
        // The validated in-memory result remains usable when durable caching fails.
      }
      return { snapshot, status: 'fresh' };
    } catch {
      return this.currentFallback();
    }
  }

  private async fetchRows(url: URL, minimumRows: number): Promise<Array<z.infer<typeof CoinGeckoMarketRowSchema>>> {
    const response = await this.fetchImplementation(url, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(this.requestTimeoutMs),
    });
    if (!response.ok) throw new Error(`COINGECKO_HTTP_${response.status}`);
    const text = await response.text();
    if (text.length > 2_000_000) throw new Error('COINGECKO_RESPONSE_TOO_LARGE');
    const rawRows = z.array(z.unknown()).min(minimumRows).parse(JSON.parse(text));
    const rows = rawRows.flatMap((rawRow) => {
      const parsed = CoinGeckoMarketRowSchema.safeParse(rawRow);
      return parsed.success ? [parsed.data] : [];
    });
    if (rows.length < minimumRows) throw new Error('COINGECKO_VALID_ROWS_INSUFFICIENT');
    return rows;
  }

  private async fetchCoinList(): Promise<Array<z.infer<typeof CoinGeckoCoinListRowSchema>>> {
    const response = await this.fetchImplementation(COINGECKO_COIN_LIST_URL, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(this.requestTimeoutMs),
    });
    if (!response.ok) throw new Error(`COINGECKO_HTTP_${response.status}`);
    const text = await response.text();
    if (text.length > 8_000_000) throw new Error('COINGECKO_RESPONSE_TOO_LARGE');
    const rawRows = z.array(z.unknown()).min(MARKET_CAP_LIMIT).parse(JSON.parse(text));
    const rows = rawRows.flatMap((rawRow) => {
      const parsed = CoinGeckoCoinListRowSchema.safeParse(rawRow);
      return parsed.success ? [parsed.data] : [];
    });
    if (rows.length < MARKET_CAP_LIMIT) throw new Error('COINGECKO_VALID_ROWS_INSUFFICIENT');
    return rows;
  }
}
