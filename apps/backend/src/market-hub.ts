import { pendingMarket, seedMarket } from './market-placeholders.js';
import { QuoteSourceSelector, type QuoteHealth } from './quote-source-selector.js';
import type { NativeQuote } from './native-market-data.js';
import WebSocket from 'ws';
import { z } from 'zod';
import { QuoteRecovery, quoteUnavailableReason, activeQuoteDemand, type QuoteRecoveryOptions } from './quote-recovery.js';
import { parseExecutableQuote, quoteStatistics, sameQuote } from './executable-quote.js';
import {
  contiguousCandleTail,
  type Candle,
  type CandleInterval,
  type OrderBookSnapshot,
  type PublicTrade,
} from '@gate-crossex/shared-types';

const MARKET_ASSETS = ['BTC', 'ETH', 'SOL', 'XRP', 'DOGE', 'SUI', 'PEPE', 'AAVE', 'LINK', 'ARB'] as const;
const MARKET_VENUES = ['GATE', 'BINANCE', 'OKX', 'BYBIT', 'KRAKEN', 'HYPERLIQUID', 'DERIBIT'] as const;
const CANDLE_INTERVALS = ['1m', '5m', '15m', '30m', '1h', '4h', '1d'] as const;
const MAX_CANDLES = 500;
const MAX_TRADES = 80;
const MAX_BOOK_LEVELS = 50;
const BOOK_EMIT_INTERVAL_MS = 200;
const MAX_SYMBOLS_PER_SUBSCRIPTION = 100;
const DYNAMIC_MARKET_IDLE_MS = 30 * 60_000;
const DYNAMIC_MARKET_SWEEP_MS = 5 * 60_000;

type MarketVenue = typeof MARKET_VENUES[number];

export interface LiveMarket {
  symbol: string;
  venue: MarketVenue;
  asset: string;
  lastPrice: string;
  bidPrice: string;
  bidSize: string;
  askPrice: string;
  askSize: string;
  open24h: string;
  high24h: string;
  low24h: string;
  volume24h: string;
  quoteVolume24h: string;
  fundingRate: string;
  nextFundingAt: string;
  openInterest: string;
  openInterestValue: string;
  receivedAt: string;
  updatedAt: string;
  source: 'gate_crossex_websocket' | 'native_venue' | 'demo_seed';
  nativeSymbol?: string;
  nativeValidUntil?: number;
  quoteHealth?: QuoteHealth;
  quoteChannel?: 'ticker' | 'order_book_1' | 'order_book_5';
  tickerUpdatedAt?: string;
  fundingUpdatedAt?: string;
  openInterestUpdatedAt?: string;
}

export interface MarketSnapshot {
  connectionState: 'connecting' | 'healthy' | 'reconnecting' | 'stale' | 'disconnected';
  updatedAt: string;
  markets: LiveMarket[];
  quoteRecovery?: { connections: number; attemptsInWindow: number; limit: number;
    quotes: Array<{ symbol: string; reason: string | null; source: 'primary' | 'recovery' | 'native' }> };
}

export type MarketHubMessage =
  | { type: 'market.snapshot'; payload: MarketSnapshot }
  | { type: 'market.update'; payload: LiveMarket }
  | { type: 'orderbook.update'; payload: OrderBookSnapshot }
  | { type: 'trade.update'; payload: { symbol: string; trade: PublicTrade } }
  | { type: 'kline.snapshot'; payload: { symbol: string; interval: CandleInterval; candles: Candle[] } }
  | { type: 'kline.update'; payload: { symbol: string; interval: CandleInterval; candle: Candle } };

export interface MarketDefinition {
  symbol: string;
  venue: MarketVenue;
  asset: string;
}

/** Streamed symbols beyond the seed set are bounded so a long session cannot grow subscriptions without limit. */
const MAX_DYNAMIC_SYMBOLS = 1_000;

type MarketListener = (message: MarketHubMessage) => void;

const FundingPushSchema = z.object({
  channel: z.literal('funding_rate'), event: z.literal('update'), result: z.object({ s: z.string(), r: z.string(), T: z.number().finite().nullable() }),
});
const OpenInterestPushSchema = z.object({
  channel: z.literal('open_interest'), event: z.literal('update'), result: z.object({ s: z.string(), oi: z.string(), oiV: z.string().optional() }),
});
const BookLevelSchema = z.tuple([z.string(), z.string()]);
const OrderBookUpdatePushSchema = z.object({
  channel: z.literal('order_book_update'), event: z.literal('update'), result: z.object({
    snapshot: z.boolean().optional(), ts: z.number(), s: z.string(),
    U: z.union([z.string(), z.number()]).optional(), u: z.union([z.string(), z.number()]).optional(),
    a: z.array(BookLevelSchema), b: z.array(BookLevelSchema),
  }),
});
const TradePushSchema = z.object({
  channel: z.literal('trade'), event: z.literal('update'), result: z.object({
    s: z.string(), i: z.string(), p: z.string(), q: z.string(), S: z.enum(['BUY', 'SELL']), ts: z.number(),
  }).passthrough(),
});
const KlinePushSchema = z.object({
  channel: z.string().regex(/^kline_(1m|5m|15m|30m|1h|4h|1d)$/), event: z.literal('update'), result: z.object({
    s: z.string(), o: z.string(), h: z.string(), l: z.string(), c: z.string(), v: z.string(),
    t: z.number(), T: z.number(), x: z.boolean(),
  }),
});
const SubscriptionFailureSchema = z.object({
  channel: z.string(),
  event: z.literal('subscribe'),
  result: z.object({ status: z.literal('failed') }),
  error: z.object({ message: z.string() }),
});

function invalidSymbolsFromMessage(message: string): string[] {
  const body = message.match(/invalidSymbols:\[([^\]]*)\]/)?.[1];
  return body ? body.split(',').map((symbol) => symbol.trim()).filter(Boolean) : [];
}

interface BookState {
  bids: Map<string, string>;
  asks: Map<string, string>;
  updatedAt: string;
  dirty: boolean;
  emitTimer: ReturnType<typeof setTimeout> | null;
}

/** Alternate identifiers some venues use in `trade` pushes (e.g. raw "BTCUSDT") mapped back to CrossEx symbols. */
function tradeSymbolKeys(symbol: string): string[] {
  const parts = symbol.split('_');
  const base = parts[2] ?? '';
  const quote = parts[3] ?? '';
  const compact = `${base}${quote}`;
  return [symbol.replaceAll('_', ''), compact, `${compact}SWAP`, `${compact}PERP`, `${base}${quote === 'USD' ? 'PFUSD' : ''}`].filter(Boolean);
}

function normalizeTradeSymbol(raw: string): string {
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export class CrossExMarketHub {
  private socket: WebSocket | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
  private stopped = true;
  private state: MarketSnapshot['connectionState'] = 'disconnected';
  private readonly subscriptions = new Map<string, Set<string>>();
  private readonly invalidSymbols = new Map<string, Set<string>>();
  private readonly markets = new Map<string, LiveMarket>();
  private readonly conflictingTickerTimestamps = new Map<string, number>();
  private fundingObserver: ((symbol: string, rate: string, sourceAt: number) => void) | null = null;
  setFundingObserver(observer: NonNullable<CrossExMarketHub['fundingObserver']>): void { this.fundingObserver = observer; }
  private readonly selector = new QuoteSourceSelector();
  private readonly quoteOwners = new Map<string, WebSocket | undefined>();
  private readonly quoteDemand = new Map<string, number>();
  private readonly recovery: QuoteRecovery;
  private readonly listeners = new Set<MarketListener>();
  private readonly quoteWatchers = new Map<string, number>();
  private readonly bookWatchers = new Map<string, number>();
  private readonly tradeWatchers = new Map<string, number>();
  private readonly klineWatchers = new Map<string, number>();
  private readonly books = new Map<string, BookState>();
  private readonly trades = new Map<string, PublicTrade[]>();
  private readonly candleSeries = new Map<string, Candle[]>();
  private readonly tradeSymbolAliases = new Map<string, string>();
  private readonly dynamicMarkets = new Map<string, number>();
  private dynamicSymbolCount = 0;
  private dynamicMarketSweep: ReturnType<typeof setInterval> | null = null;

  private readonly heartbeatIntervalMs: number;
  private readonly marketIdlePingAfterMs: number;
  private readonly staleAfterMs: number;

  constructor(
    private readonly url: string,
    options: { heartbeatIntervalMs?: number; marketIdlePingAfterMs?: number; staleAfterMs?: number; recovery?: QuoteRecoveryOptions } = {},
  ) {
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? 25_000;
    this.marketIdlePingAfterMs = options.marketIdlePingAfterMs ?? 2_000;
    this.staleAfterMs = options.staleAfterMs ?? 60_000;
    this.recovery = new QuoteRecovery(url, {
      demand: () => activeQuoteDemand(this.quoteDemand, this.quoteWatchers),
      missing: symbol => quoteUnavailableReason(this.markets.get(symbol)) !== null,
      owns: (socket, symbol) => this.quoteOwners.get(symbol) === socket,
      accept: (raw, at, socket) => this.acceptRecoveryQuote(raw, at, socket),
      invalidate: socket => this.invalidateQuotes(socket),
    }, options.recovery);
    MARKET_ASSETS.forEach((asset, assetIndex) => MARKET_VENUES.forEach((venue, venueIndex) => {
      const market = seedMarket(venue, asset, venueIndex, assetIndex);
      this.markets.set(market.symbol, market);
    }));
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.dynamicMarketSweep = setInterval(() => this.evictIdleDynamicMarkets(), DYNAMIC_MARKET_SWEEP_MS);
    this.dynamicMarketSweep.unref?.();
    this.connect();
    this.recovery.start();
  }

  stop(): void {
    this.stopped = true;
    this.recovery.stop();
    this.invalidateQuotes(this.socket ?? undefined);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.heartbeat) clearInterval(this.heartbeat);
    if (this.dynamicMarketSweep) clearInterval(this.dynamicMarketSweep);
    this.reconnectTimer = null;
    this.heartbeat = null;
    this.dynamicMarketSweep = null;
    for (const book of this.books.values()) {
      if (book.emitTimer) clearTimeout(book.emitTimer);
      book.emitTimer = null;
    }
    this.socket?.close();
    this.socket = null;
    this.state = 'disconnected';
    this.selector.clear();
  }

  snapshot(): MarketSnapshot {
    const markets = [...this.markets.keys()].map(symbol => this.selectedMarket(symbol)!).sort((a, b) => a.asset.localeCompare(b.asset) || a.venue.localeCompare(b.venue));
    const newest = markets.reduce((latest, market) => market.updatedAt > latest ? market.updatedAt : latest, new Date(0).toISOString());
    return { connectionState: this.connectionState(), updatedAt: newest, markets, quoteRecovery: {
      ...this.recovery.diagnostics(), quotes: activeQuoteDemand(this.quoteDemand, this.quoteWatchers).map(symbol => ({ symbol,
        reason: this.conflictingTickerTimestamps.has(symbol) ? 'timestamp_conflict' : quoteUnavailableReason(this.selectedMarket(symbol) ?? undefined),
        source: this.selectedMarket(symbol)?.source === 'native_venue' ? 'native' : this.quoteOwners.get(symbol) && this.quoteOwners.get(symbol) !== this.socket ? 'recovery' : 'primary',
      })),
    } };
  }

  connectionState(): MarketSnapshot['connectionState'] {
    return !this.stopped && this.recovery.connected() ? 'healthy' : this.state;
  }

  /** Registered market count without building the sorted snapshot. */
  marketCount(): number {
    return this.markets.size;
  }

  market(symbol: string): LiveMarket | null {
    if (this.markets.has(symbol)) this.quoteDemand.set(symbol, Date.now());
    if (this.dynamicMarkets.has(symbol)) this.dynamicMarkets.set(symbol, Date.now());
    return this.selectedMarket(symbol);
  }

  quoteDemandSymbols(): string[] { return activeQuoteDemand(this.quoteDemand, this.quoteWatchers); }
  invalidateNativeQuote(symbol: string, sourceAt: number): void {
    if (!this.markets.has(symbol)) return;
    this.selector.invalidate(symbol, sourceAt); this.notify({ type: 'market.update', payload: this.selectedMarket(symbol)! });
  }
  revokeNativeQuote(symbol: string): void {
    if (!this.markets.has(symbol)) return;
    this.selector.revoke(symbol); this.notify({ type: 'market.update', payload: this.selectedMarket(symbol)! });
  }
  acceptNativeQuote(quote: NativeQuote): void {
    if (!this.markets.has(quote.symbol)) return;
    this.selector.accept(quote); this.notify({ type: 'market.update', payload: this.selectedMarket(quote.symbol)! });
  }
  private selectedMarket(symbol: string): LiveMarket | null {
    const current = this.markets.get(symbol); return current ? this.selector.select(current) : null;
  }
  private probePrimary(now: number): void {
    const socket = this.socket; if (!socket || socket.readyState !== WebSocket.OPEN) return;
    const missing = this.selector.missingPrimary(this.quoteDemandSymbols(), now);
    if (missing.length && this.recovery.takeSharedAttempt(now)) this.sendSubscribe(socket, 'ticker', missing);
  }

  private invalidateQuotes(owner: WebSocket | undefined): void {
    for (const [symbol, market] of this.markets) {
      if (market.source === 'gate_crossex_websocket' && this.quoteOwners.get(symbol) === owner) {
        this.publish({ ...market, receivedAt: '' });
      }
    }
  }

  private acceptRecoveryQuote(raw: string, at: number, socket: WebSocket): void {
    let payload: unknown;
    try { payload = JSON.parse(raw); } catch { return; }
    const value = parseExecutableQuote(payload);
    if (!value) return;
    const current = this.markets.get(value.s);
    if (!current || !Number.isFinite(new Date(value.ts).getTime())) return;
    if (this.quoteOwners.get(value.s) !== socket && quoteUnavailableReason(current) === null) return;
    const incoming = { ...current, bidPrice: value.bp, askPrice: value.ap,
      source: 'gate_crossex_websocket' as const, updatedAt: new Date(value.ts).toISOString(), receivedAt: new Date(at).toISOString() };
    if (quoteUnavailableReason(incoming) !== null || ![value.bs, value.as].every(n => Number.isFinite(Number(n)) && Number(n) >= 0)) return;
    this.handleMessage(raw, at, socket);
  }

  /** Assets present at construction; these stream from the moment the socket connects. */
  isSeedAsset(asset: string): boolean {
    return (MARKET_ASSETS as readonly string[]).includes(asset);
  }

  hasAsset(asset: string): boolean {
    for (const market of this.markets.values()) {
      if (market.asset === asset) return true;
    }
    return false;
  }

  /**
   * Register markets discovered from the instrument catalog and subscribe their public channels.
   * Safe to call repeatedly: known symbols are skipped. Returns false when the dynamic-symbol
   * budget is exhausted, in which case nothing was added.
   */
  ensureMarkets(definitions: MarketDefinition[]): boolean {
    const missing = definitions.filter((definition) => !this.markets.has(definition.symbol));
    if (missing.length === 0) return true;
    if (this.dynamicSymbolCount + missing.length > MAX_DYNAMIC_SYMBOLS) return false;
    this.dynamicSymbolCount += missing.length;
    for (const definition of missing) {
      this.markets.set(definition.symbol, pendingMarket(definition));
      this.dynamicMarkets.set(definition.symbol, Date.now());
    }
    for (const definition of definitions) {
      if (this.dynamicMarkets.has(definition.symbol)) this.dynamicMarkets.set(definition.symbol, Date.now());
    }
    const symbols = missing.map((definition) => definition.symbol);
    for (const channel of ['ticker', 'funding_rate', 'open_interest']) {
      this.subscribeSymbols(channel, symbols);
    }
    return true;
  }

  orderBook(symbol: string): OrderBookSnapshot | null {
    const book = this.books.get(symbol);
    if (!book) return null;
    return this.bookSnapshot(symbol, book);
  }

  recentTrades(symbol: string): PublicTrade[] {
    return [...(this.trades.get(symbol) ?? [])];
  }

  candles(symbol: string, interval: CandleInterval): Candle[] {
    return [...(this.candleSeries.get(`${symbol}:${interval}`) ?? [])];
  }

  /** Merge REST backfill behind live websocket candles; live data wins on collision. */
  seedCandles(symbol: string, interval: CandleInterval, candles: Candle[]): void {
    const key = `${symbol}:${interval}`;
    const merged = new Map<number, Candle>();
    for (const candle of candles) merged.set(candle.startTime, candle);
    for (const candle of this.candleSeries.get(key) ?? []) merged.set(candle.startTime, candle);
    this.replaceCandles(symbol, interval, [...merged.values()]);
  }

  /** Replace a series with an authoritative, gap-free snapshot and repaint stream watchers. */
  replaceCandles(symbol: string, interval: CandleInterval, candles: Candle[]): void {
    const ordered = contiguousCandleTail(candles, interval, MAX_CANDLES);
    this.candleSeries.set(`${symbol}:${interval}`, ordered);
    // An empty snapshot is meaningful too: it clears a stale client series.
    this.notify({ type: 'kline.snapshot', payload: { symbol, interval, candles: ordered } });
  }

  subscribe(listener: MarketListener): () => void {
    this.listeners.add(listener);
    try {
      listener({ type: 'market.snapshot', payload: this.snapshot() });
    } catch { /* a broken listener must not take down the hub */ }
    return () => this.listeners.delete(listener);
  }

  /** Deliver to every listener; one throwing listener must not break the stream or its peers. */
  private notify(message: MarketHubMessage): void {
    for (const listener of this.listeners) {
      try {
        listener(message);
      } catch { /* isolated above */ }
    }
  }

  watchOrderBook(symbol: string): () => void {
    return this.watch(this.bookWatchers, 'order_book_update', symbol, () => {
      const book = this.books.get(symbol);
      if (book?.emitTimer) clearTimeout(book.emitTimer);
      this.books.delete(symbol);
    });
  }

  /** Re-request only a manual execution's selected quotes if their initial stream did not arrive. */
  requestQuoteRefresh(symbols: string[]): void {
    const requested = [...new Set(symbols)].filter(symbol => this.markets.has(symbol));
    const socket = this.socket;
    if (requested.length && socket?.readyState === WebSocket.OPEN) this.sendSubscribe(socket, 'ticker', requested);
  }

  /** Keep dynamically discovered ticker markets registered while a client displays them. */
  watchQuotes(symbols: string[]): () => void {
    const watched = [...new Set(symbols)].filter((symbol) => this.markets.has(symbol));
    for (const symbol of watched) {
      this.quoteWatchers.set(symbol, (this.quoteWatchers.get(symbol) ?? 0) + 1);
      if (this.dynamicMarkets.has(symbol)) this.dynamicMarkets.set(symbol, Date.now());
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      for (const symbol of watched) {
        const count = (this.quoteWatchers.get(symbol) ?? 1) - 1;
        if (count > 0) this.quoteWatchers.set(symbol, count);
        else this.quoteWatchers.delete(symbol);
      }
    };
  }

  watchTrades(symbol: string): () => void {
    for (const key of tradeSymbolKeys(symbol)) this.tradeSymbolAliases.set(key, symbol);
    return this.watch(this.tradeWatchers, 'trade', symbol, () => {
      this.trades.delete(symbol);
      for (const key of tradeSymbolKeys(symbol)) this.tradeSymbolAliases.delete(key);
    });
  }

  watchKlines(symbol: string, interval: CandleInterval): () => void {
    return this.watch(this.klineWatchers, `kline_${interval}`, symbol, () => undefined);
  }

  private watch(watchers: Map<string, number>, channel: string, symbol: string, onRelease: () => void): () => void {
    const key = `${channel}:${symbol}`;
    const current = watchers.get(key) ?? 0;
    watchers.set(key, current + 1);
    if (current === 0) this.subscribeSymbols(channel, [symbol]);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const count = (watchers.get(key) ?? 1) - 1;
      if (count > 0) {
        watchers.set(key, count);
        return;
      }
      watchers.delete(key);
      this.unsubscribeSymbols(channel, [symbol]);
      onRelease();
    };
  }

  private subscribeSymbols(channel: string, symbols: string[]): void {
    const set = this.subscriptions.get(channel) ?? new Set<string>();
    const invalid = this.invalidSymbols.get(channel);
    const added = symbols.filter((symbol) => !set.has(symbol) && !invalid?.has(symbol));
    for (const symbol of added) set.add(symbol);
    this.subscriptions.set(channel, set);
    const socket = this.socket;
    if (added.length > 0 && socket?.readyState === WebSocket.OPEN) {
      this.sendSubscribe(socket, channel, added);
    }
  }

  private unsubscribeSymbols(channel: string, symbols: string[]): void {
    const set = this.subscriptions.get(channel);
    if (!set) return;
    const removed = symbols.filter((symbol) => set.delete(symbol));
    const socket = this.socket;
    if (removed.length > 0 && socket?.readyState === WebSocket.OPEN) {
      this.sendUnsubscribe(socket, channel, removed);
    }
  }

  private connect(): void {
    if (this.stopped) return;
    this.state = this.reconnectAttempt === 0 ? 'connecting' : 'reconnecting';
    // Receipt evidence belongs to one connection. Keep source watermarks for ordering, but
    // require each symbol to arrive on this socket before it can become executable again.
    this.invalidateQuotes(this.socket ?? undefined);
    const socket = new WebSocket(this.url);
    this.socket = socket;
    let awaitingPong = false;
    let lastPingAt = 0;
    let lastMessageAt = Date.now();
    let lastMarketMessageAt = Date.now();
    socket.on('pong', () => { awaitingPong = false; });
    socket.on('open', () => {
      if (this.stopped || this.socket !== socket) { socket.close(); return; }
      this.state = 'healthy';
      this.reconnectAttempt = 0;
      awaitingPong = false;
      lastMessageAt = Date.now();
      lastMarketMessageAt = Date.now();
      lastPingAt = Date.now();
      const symbols = [...this.markets.keys()];
      for (const channel of ['ticker', 'funding_rate', 'open_interest']) {
        const invalid = this.invalidSymbols.get(channel);
        this.subscriptions.set(channel, new Set(symbols.filter((symbol) => !invalid?.has(symbol))));
      }
      for (const [channel, subscribed] of this.subscriptions) {
        if (subscribed.size > 0) this.sendSubscribe(socket, channel, [...subscribed]);
      }
      if (this.heartbeat) clearInterval(this.heartbeat);
      this.heartbeat = setInterval(() => {
        if (socket.readyState !== WebSocket.OPEN) return;
        const now = Date.now();
        this.probePrimary(now);
        // Application traffic never substitutes for protocol Ping/Pong. Probe idle sockets
        // early, and keep the mandatory periodic ping even during continuous market traffic.
        if (awaitingPong && now - lastPingAt >= this.heartbeatIntervalMs) { socket.terminate(); return; }
        if (!awaitingPong && (now - lastPingAt >= this.heartbeatIntervalMs
          || now - lastMarketMessageAt > this.marketIdlePingAfterMs)) {
          awaitingPong = true;
          lastPingAt = now;
          socket.ping();
        }
        const nextState = now - lastMessageAt > this.staleAfterMs ? 'stale' : 'healthy';
        if (nextState !== this.state) {
          this.state = nextState;
          this.notify({ type: 'market.snapshot', payload: this.snapshot() });
        }
      }, Math.min(this.heartbeatIntervalMs, this.marketIdlePingAfterMs));
      this.heartbeat.unref?.();
      this.notify({ type: 'market.snapshot', payload: this.snapshot() });
    });
    socket.on('message', (data) => {
      if (this.stopped || this.socket !== socket) return;
      const receivedAt = Date.now();
      lastMessageAt = receivedAt;
      if (this.state === 'stale') {
        this.state = 'healthy';
        this.notify({ type: 'market.snapshot', payload: this.snapshot() });
      }
      if (this.handleMessage(data.toString(), receivedAt, socket)) lastMarketMessageAt = receivedAt;
    });
    socket.on('error', () => undefined);
    socket.on('close', () => {
      if (this.socket !== socket && !this.stopped) return;
      this.invalidateQuotes(socket);
      if (this.heartbeat) clearInterval(this.heartbeat);
      this.heartbeat = null;
      if (this.socket === socket) this.socket = null;
      for (const [symbol, book] of this.books) {
        if (book.emitTimer) clearTimeout(book.emitTimer);
        this.books.delete(symbol);
      }
      if (this.stopped) return;
      this.state = 'reconnecting';
      const exponential = Math.min(30_000, 1_000 * 2 ** Math.min(5, this.reconnectAttempt++));
      const wait = Math.round(exponential * (0.85 + Math.random() * 0.3));
      this.reconnectTimer = setTimeout(() => this.connect(), wait);
      this.reconnectTimer.unref?.();
    });
  }

  private sendSubscribe(socket: WebSocket, channel: string, payload: string[]): void {
    if (channel === 'ticker' && socket === this.socket) this.selector.markPrimarySubscription(payload);
    for (let index = 0; index < payload.length; index += MAX_SYMBOLS_PER_SUBSCRIPTION) {
      socket.send(JSON.stringify({
        time: Math.floor(Date.now() / 1_000),
        event: 'subscribe',
        channel,
        payload: payload.slice(index, index + MAX_SYMBOLS_PER_SUBSCRIPTION),
      }));
    }
  }

  private sendUnsubscribe(socket: WebSocket, channel: string, payload: string[]): void {
    for (let index = 0; index < payload.length; index += MAX_SYMBOLS_PER_SUBSCRIPTION) {
      socket.send(JSON.stringify({
        time: Math.floor(Date.now() / 1_000),
        event: 'unsubscribe',
        channel,
        payload: payload.slice(index, index + MAX_SYMBOLS_PER_SUBSCRIPTION),
      }));
    }
  }

  private evictIdleDynamicMarkets(): void {
    const cutoff = Date.now() - DYNAMIC_MARKET_IDLE_MS;
    for (const [symbol, lastUsedAt] of this.dynamicMarkets) {
      if (lastUsedAt > cutoff || this.isActivelyWatched(symbol)) continue;
      for (const channel of ['ticker', 'funding_rate', 'open_interest']) {
        this.unsubscribeSymbols(channel, [symbol]);
        this.invalidSymbols.get(channel)?.delete(symbol);
      }
      this.markets.delete(symbol); this.selector.delete(symbol);
      this.conflictingTickerTimestamps.delete(symbol);
      this.quoteOwners.delete(symbol);
      this.quoteDemand.delete(symbol);
      this.dynamicMarkets.delete(symbol);
      this.dynamicSymbolCount = Math.max(0, this.dynamicSymbolCount - 1);
    }
  }

  private isActivelyWatched(symbol: string): boolean {
    if ((this.quoteWatchers.get(symbol) ?? 0) > 0) return true;
    return [...this.bookWatchers.keys(), ...this.tradeWatchers.keys(), ...this.klineWatchers.keys()]
      .some((key) => key.endsWith(`:${symbol}`));
  }

  /**
   * Handle one upstream frame and report whether it was a recognized market-data update.
   * Frames arrive continuously for every subscribed symbol, so the channel/event fields are
   * inspected first and exactly one schema runs per frame instead of trying each in sequence.
   */
  private handleMessage(raw: string, receivedAt: number, owner?: WebSocket): boolean {
    let payload: unknown;
    try { payload = JSON.parse(raw); } catch { return false; }
    if (typeof payload !== 'object' || payload === null) return false;
    const frame = payload as { channel?: unknown; event?: unknown };
    if (frame.event === 'subscribe') {
      const subscriptionFailure = SubscriptionFailureSchema.safeParse(payload);
      if (!subscriptionFailure.success) return false;
      const channel = subscriptionFailure.data.channel;
      const symbols = this.subscriptions.get(channel);
      const invalidFound = invalidSymbolsFromMessage(subscriptionFailure.data.error.message);
      if (!symbols || invalidFound.length === 0) return false;
      const invalid = this.invalidSymbols.get(channel) ?? new Set<string>();
      for (const symbol of invalidFound) {
        symbols.delete(symbol);
        invalid.add(symbol);
      }
      this.invalidSymbols.set(channel, invalid);
      const socket = this.socket;
      if (socket?.readyState === WebSocket.OPEN && symbols.size > 0 && ['ticker', 'funding_rate', 'open_interest'].includes(channel)) {
        this.sendSubscribe(socket, channel, [...symbols]);
      }
      return false;
    }
    if (frame.event !== 'update' || typeof frame.channel !== 'string') return false;
    if (frame.channel === 'ticker' || frame.channel === 'order_book_1' || frame.channel === 'order_book_5') {
      const value = parseExecutableQuote(payload);
      if (!value || !Number.isFinite(new Date(value.ts).getTime())) return false;
      const current = this.markets.get(value.s);
      if (!current) return true;
      const currentTimestamp = current.source === 'gate_crossex_websocket'
        ? Date.parse(current.updatedAt)
        : Number.NEGATIVE_INFINITY;
      // A reconnect can flush delayed frames after a newer ticker has already arrived. Never
      // roll a symbol's executable bid/ask backward to an older source timestamp.
      if (Number.isFinite(currentTimestamp) && value.ts < currentTimestamp) return true;
      let quoteReceivedAt = new Date(receivedAt).toISOString();
      if (value.ts === currentTimestamp) {
        if (this.conflictingTickerTimestamps.get(value.s) === value.ts) return true;
        if (!sameQuote(value, current)) {
          // Contradictory executable quotes at one timestamp have no provable ordering.
          // Neither replay may restore execution; wait for a strictly newer source quote.
          this.conflictingTickerTimestamps.set(value.s, value.ts);
          this.publish({ ...current, receivedAt: '' });
          return true;
        }
        // Replaying the same quote is not a new delivery of new market information.
        // Preserve its original lag and age, including an originally delayed receipt.
        if (this.quoteOwners.get(value.s) === owner && Number.isFinite(Date.parse(current.receivedAt))) quoteReceivedAt = current.receivedAt;
      } else {
        this.conflictingTickerTimestamps.delete(value.s);
      }
      if (Number.isFinite(Number(value.bp)) && Number.isFinite(Number(value.ap)) && Number(value.bp) > 0 && Number(value.ap) >= Number(value.bp)) this.selector.observeCross(value.s, value.ts, receivedAt, owner === this.socket);
      this.quoteOwners.set(value.s, owner);
      this.publish({ ...current, ...quoteStatistics(value, current), bidPrice: value.bp, bidSize: value.bs, askPrice: value.ap,
        askSize: value.as, quoteChannel: value.channel, receivedAt: quoteReceivedAt,
        updatedAt: new Date(value.ts).toISOString(), source: 'gate_crossex_websocket' });
      return true;
    }
    // The ticker's `updatedAt`, `receivedAt`, and `source` are the strategy engine's evidence that
    // bid/ask came from the exchange recently and arrived promptly. Funding and open-interest
    // pushes must never refresh them, or seed, stale, or delayed prices could pass that gate.
    if (frame.channel === 'funding_rate') {
      const funding = FundingPushSchema.safeParse(payload);
      if (!funding.success || !Number.isFinite(Number(funding.data.result.r))) return false;
      const sourceAt = Number((payload as { time_ms?: unknown }).time_ms);
      if (Number.isFinite(sourceAt) && receivedAt - sourceAt <= 3000 && sourceAt <= receivedAt + 2000) this.fundingObserver?.(funding.data.result.s, funding.data.result.r, sourceAt);
      const current = this.markets.get(funding.data.result.s);
      if (current) this.publish({ ...current, fundingRate: funding.data.result.r, nextFundingAt: funding.data.result.T === null ? '' : new Date(funding.data.result.T).toISOString(), fundingUpdatedAt: new Date(receivedAt).toISOString() });
      return true;
    }
    if (frame.channel === 'open_interest') {
      const interest = OpenInterestPushSchema.safeParse(payload);
      if (!interest.success) return false;
      const current = this.markets.get(interest.data.result.s);
      if (current) this.publish({ ...current, openInterest: interest.data.result.oi, openInterestValue: interest.data.result.oiV ?? '0', openInterestUpdatedAt: new Date(receivedAt).toISOString() });
      return true;
    }
    if (frame.channel === 'order_book_update') {
      const bookUpdate = OrderBookUpdatePushSchema.safeParse(payload);
      if (!bookUpdate.success) return false;
      this.applyBookUpdate(bookUpdate.data.result);
      return true;
    }
    if (frame.channel === 'trade') {
      const trade = TradePushSchema.safeParse(payload);
      if (!trade.success) return false;
      this.applyTrade(trade.data.result);
      return true;
    }
    if (frame.channel.startsWith('kline_')) {
      const kline = KlinePushSchema.safeParse(payload);
      if (!kline.success) return false;
      const interval = kline.data.channel.slice('kline_'.length) as CandleInterval;
      this.applyKline(interval, kline.data.result);
      return true;
    }
    return false;
  }

  private applyBookUpdate(result: z.infer<typeof OrderBookUpdatePushSchema>['result']): void {
    const symbol = result.s;
    if (!this.bookWatchers.has(`order_book_update:${symbol}`)) return;
    let book = this.books.get(symbol);
    if (!book || result.snapshot) {
      if (book?.emitTimer) clearTimeout(book.emitTimer);
      book = { bids: new Map(), asks: new Map(), updatedAt: new Date(result.ts).toISOString(), dirty: false, emitTimer: null };
      this.books.set(symbol, book);
    }
    const apply = (levels: Map<string, string>, updates: Array<[string, string]>) => {
      for (const [price, quantity] of updates) {
        if (Number(quantity) === 0) levels.delete(price);
        else levels.set(price, quantity);
      }
    };
    apply(book.bids, result.b);
    apply(book.asks, result.a);
    book.updatedAt = new Date(result.ts).toISOString();
    this.scheduleBookEmit(symbol, book);
  }

  private scheduleBookEmit(symbol: string, book: BookState): void {
    if (book.emitTimer) {
      book.dirty = true;
      return;
    }
    this.emitBook(symbol, book);
    book.emitTimer = setTimeout(() => {
      book.emitTimer = null;
      if (book.dirty) {
        book.dirty = false;
        this.scheduleBookEmit(symbol, book);
      }
    }, BOOK_EMIT_INTERVAL_MS);
  }

  private bookSnapshot(symbol: string, book: BookState): OrderBookSnapshot {
    const bids = [...book.bids.entries()].sort((a, b) => Number(b[0]) - Number(a[0])).slice(0, MAX_BOOK_LEVELS);
    const asks = [...book.asks.entries()].sort((a, b) => Number(a[0]) - Number(b[0])).slice(0, MAX_BOOK_LEVELS);
    return { symbol, bids, asks, updatedAt: book.updatedAt, source: 'gate_crossex_websocket' };
  }

  private emitBook(symbol: string, book: BookState): void {
    const snapshot = this.bookSnapshot(symbol, book);
    this.notify({ type: 'orderbook.update', payload: snapshot });
  }

  private applyTrade(result: { s: string; i: string; p: string; q: string; S: 'BUY' | 'SELL'; ts: number }): void {
    const symbol = this.tradeWatchers.has(`trade:${result.s}`)
      ? result.s
      : this.tradeSymbolAliases.get(normalizeTradeSymbol(result.s));
    if (!symbol || !this.tradeWatchers.has(`trade:${symbol}`)) return;
    const trade: PublicTrade = {
      id: result.i, symbol, price: result.p, quantity: result.q, side: result.S,
      executedAt: new Date(result.ts).toISOString(),
    };
    const buffer = this.trades.get(symbol) ?? [];
    if (buffer.some((existing) => existing.id === trade.id)) return;
    buffer.unshift(trade);
    if (buffer.length > MAX_TRADES) buffer.length = MAX_TRADES;
    this.trades.set(symbol, buffer);
    this.notify({ type: 'trade.update', payload: { symbol, trade } });
  }

  private applyKline(interval: CandleInterval, result: { s: string; o: string; h: string; l: string; c: string; v: string; t: number; x: boolean }): void {
    if (!this.klineWatchers.has(`kline_${interval}:${result.s}`)) return;
    const key = `${result.s}:${interval}`;
    const series = this.candleSeries.get(key) ?? [];
    const candle: Candle = { startTime: result.t, open: result.o, high: result.h, low: result.l, close: result.c, volume: result.v, closed: result.x };
    const last = series[series.length - 1];
    if (last && last.startTime === candle.startTime) series[series.length - 1] = candle;
    else if (!last || candle.startTime > last.startTime) series.push(candle);
    else {
      const index = series.findIndex((existing) => existing.startTime === candle.startTime);
      if (index >= 0) series[index] = candle;
      else return;
    }
    if (series.length > MAX_CANDLES) series.splice(0, series.length - MAX_CANDLES);
    this.candleSeries.set(key, series);
    this.notify({ type: 'kline.update', payload: { symbol: result.s, interval, candle } });
  }

  private publish(market: LiveMarket): void {
    this.markets.set(market.symbol, market);
    this.notify({ type: 'market.update', payload: this.selectedMarket(market.symbol) ?? market });
  }
}

export { invalidSymbolsFromMessage, CANDLE_INTERVALS };
export type { CandleInterval };
