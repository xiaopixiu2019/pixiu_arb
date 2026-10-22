import type { FundingStatVenue, PublicMarketDataGateway, VenueFundingStat } from '@gate-crossex/public-data';
import { ReferenceSymbolSchema, type ReferenceQuote, type ReferenceQuotesResponse } from '@gate-crossex/shared-types';

const CACHE_MS = 15_000;
type Cached<T> = { at: number; pending: boolean; value: Promise<T> };

function cachedRead<T>(load: () => Promise<T>, now: () => number): Cached<T> {
  const pending = load();
  const cached: Cached<T> = { at: now(), pending: true, value: pending };
  cached.value = pending.finally(() => { cached.pending = false; cached.at = now(); });
  return cached;
}

/** Independent public quote cache. Never touches managed WS subscriptions or funding freshness. */
export class ReferenceQuotesService {
  private readonly bulk = new Map<FundingStatVenue, Cached<VenueFundingStat[]>>();
  private readonly books = new Map<string, Cached<ReferenceQuote>>();
  private active = 0;
  private readonly nativeBudget = new Map<string, { startedAt: number; calls: number }>();
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly gateway: PublicMarketDataGateway, private readonly now = Date.now) {}

  private async bounded<T>(load: () => Promise<T>): Promise<T> {
    if (this.active >= 4) {
      if (this.waiters.length >= 100) throw new Error('REFERENCE_QUOTE_BUSY');
      await new Promise<void>((resolve, reject) => {
        const resume = () => { clearTimeout(timer); resolve(); };
        const timer = setTimeout(() => {
          const index = this.waiters.indexOf(resume);
          if (index >= 0) this.waiters.splice(index, 1);
          reject(new Error('REFERENCE_QUOTE_TIMEOUT'));
        }, 10_000);
        this.waiters.push(resume);
      });
    } else this.active += 1;
    try { return await load(); }
    finally {
      const next = this.waiters.shift();
      if (next) next(); else this.active -= 1;
    }
  }

  private bulkRows(venue: FundingStatVenue): Promise<VenueFundingStat[]> {
    const cached = this.bulk.get(venue);
    if (cached && (cached.pending || this.now() - cached.at < CACHE_MS)) return cached.value;
    const next = cachedRead(() => this.bounded(() => this.gateway.queryVenueFundingStats?.(venue) ?? Promise.reject(new Error('UNSUPPORTED'))), this.now);
    this.bulk.set(venue, next);
    return next.value;
  }

  private nativeBook(symbol: string, venue: string) {
    return this.bounded(() => {
      const now = this.now();
      const previous = this.nativeBudget.get(venue);
      const budget = previous && now - previous.startedAt < 60_000 ? previous : { startedAt: now, calls: 0 };
      this.nativeBudget.set(venue, budget);
      if (budget.calls >= 300) throw new Error('REFERENCE_QUOTE_BUSY');
      budget.calls += 1;
      return this.gateway.queryReferenceBook?.(symbol) ?? Promise.reject(new Error('UNSUPPORTED'));
    });
  }

  private validBook(book: { bidPrice?: string; askPrice?: string; bookObservedAt?: string } | undefined) {
    const bid = Number(book?.bidPrice), ask = Number(book?.askPrice);
    const age = this.now() - Date.parse(book?.bookObservedAt ?? '');
    return Number.isFinite(bid) && Number.isFinite(ask) && bid > 0 && ask > 0 && bid <= ask
      && Number.isFinite(age) && age <= 45_000 && age >= -5_000;
  }

  private async bulkBook(venue: FundingStatVenue, base: string, quote: string) {
    try { return (await this.bulkRows(venue)).find((row) => row.venue === venue && row.base === base && row.quote === quote); }
    catch (error) {
      // Binance's funding-feed failure cannot suppress its independent public depth read.
      if (venue === 'BINANCE' && this.gateway.queryReferenceBook) return undefined;
      throw error;
    }
  }

  private async load(symbol: string): Promise<ReferenceQuote> {
    const stamp = () => new Date(this.now()).toISOString();
    const [, venue, base, quote] = /^(\w+)_FUTURE_([A-Z0-9]+)_([A-Z0-9]+)$/.exec(symbol)!;
    try {
      let book = venue === 'HYPERLIQUID'
        ? await this.nativeBook(symbol, venue)
        : await this.bulkBook(venue as FundingStatVenue, base, quote);
      if (venue === 'BINANCE' && !this.validBook(book) && this.gateway.queryReferenceBook) book = await this.nativeBook(symbol, venue);
      if (!this.validBook(book)) {
        return { symbol, status: 'unavailable', reason: 'missing_book', fetchedAt: stamp() };
      }
      return { symbol, status: 'ok', bidPrice: book?.bidPrice, askPrice: book?.askPrice, bookObservedAt: book?.bookObservedAt, fetchedAt: stamp() };
    } catch (error) {
      const reason = error instanceof Error && error.message === 'REFERENCE_QUOTE_TIMEOUT' ? 'timeout'
        : error instanceof Error && error.message === 'REFERENCE_QUOTE_BUSY' ? 'busy' : 'venue_unavailable';
      return { symbol, status: 'unavailable', reason, fetchedAt: stamp() };
    }
  }

  private quote(symbol: string): Promise<ReferenceQuote> {
    const cached = this.books.get(symbol);
    if (cached && (cached.pending || this.now() - cached.at < CACHE_MS)) return cached.value;
    // Expire before reloading, retaining a bounded number of instrument results.
    if (this.books.size >= 500) {
      const expired = [...this.books].find(([, entry]) => !entry.pending)?.[0];
      if (expired) this.books.delete(expired);
      else return Promise.resolve({ symbol, status: 'unavailable', reason: 'busy', fetchedAt: new Date(this.now()).toISOString() });
    }
    const next = cachedRead(() => this.load(symbol), this.now);
    this.books.set(symbol, next);
    return next.value;
  }

  private async responseQuote(symbol: string): Promise<ReferenceQuote> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([this.quote(symbol), new Promise<ReferenceQuote>((resolve) => {
        timer = setTimeout(() => resolve({ symbol, status: 'unavailable', reason: 'timeout', fetchedAt: new Date(this.now()).toISOString() }), 12_000);
      })]);
    } finally { clearTimeout(timer); }
  }

  async read(symbols: readonly string[], allowed: ReadonlySet<string>): Promise<ReferenceQuotesResponse> {
    if (symbols.length < 1 || symbols.length > 100 || symbols.some((symbol) => !ReferenceSymbolSchema.safeParse(symbol).success)) throw new Error('INVALID_REFERENCE_SYMBOLS');
    const entries = await Promise.all([...new Set(symbols)].map((symbol) => allowed.has(symbol)
      ? this.responseQuote(symbol)
      : Promise.resolve<ReferenceQuote>({ symbol, status: 'unavailable', reason: 'unknown_contract', fetchedAt: new Date(this.now()).toISOString() })));
    return { entries, fetchedAt: new Date(this.now()).toISOString() };
  }
}
