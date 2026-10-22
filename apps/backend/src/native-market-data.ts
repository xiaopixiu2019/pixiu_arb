import WebSocket from 'ws';
import { Decimal } from 'decimal.js';
import { z } from 'zod';

export interface NativeIdentity { symbol: string; nativeSymbol: string; multiplier: string; validUntil: number; fundingHours?: number }
export interface NativeQuote { symbol: string; nativeSymbol: string; bidPrice: string; askPrice: string;
  bidSize: string; askSize: string; sourceAt: number; receivedAt: number; validUntil: number }
interface RawQuote { nativeSymbol: string; bid: unknown; ask: unknown; bidSize: unknown; askSize: unknown; sourceAt: number }
type RecordValue = Record<string, unknown>;
const object = (value: unknown): RecordValue => z.record(z.string(), z.unknown()).parse(value);
const rows = (value: unknown): RecordValue[] => z.array(z.unknown()).parse(value).map(object);
const str = (value: unknown): string => typeof value === 'string' || typeof value === 'number' ? String(value) : '';
const positive = (value: unknown) => (typeof value === 'number' || typeof value === 'string' && value.trim() !== '') && Number.isFinite(Number(value)) && Number(value) > 0;
const WS_URLS: Record<string, string> = { GATE: 'wss://fx-ws.gateio.ws/v4/ws/usdt',
  KRAKEN: 'wss://futures.kraken.com/ws/v1', DERIBIT: 'wss://www.deribit.com/ws/api/v2' };

export function normalizeNativeQuote(meta: NativeIdentity, raw: RawQuote, now: number): NativeQuote | null {
  if (raw.nativeSymbol !== meta.nativeSymbol || meta.validUntil <= now || !positive(meta.multiplier)
    || !Number.isFinite(raw.sourceAt) || now - raw.sourceAt > 3000 || raw.sourceAt > now + 2000
    || ![raw.bid, raw.ask, raw.bidSize, raw.askSize].every(positive) || Number(raw.ask) < Number(raw.bid)) return null;
  return { symbol: meta.symbol, nativeSymbol: meta.nativeSymbol, bidPrice: str(raw.bid), askPrice: str(raw.ask),
    bidSize: new Decimal(str(raw.bidSize)).mul(meta.multiplier).toString(),
    askSize: new Decimal(str(raw.askSize)).mul(meta.multiplier).toString(), sourceAt: raw.sourceAt, receivedAt: now, validUntil: meta.validUntil };
}

interface Stream { socket: WebSocket; symbols: Map<string, NativeIdentity>; pingAt: number; awaitingPong: boolean }
export interface NativeMarketOptions {
  demand(): string[]; allowed(symbol: string): boolean; accept(quote: NativeQuote): void;
  funding?(symbol: string, rate8h: string, sourceAt: number, receivedAt: number): void;
  unavailable?(symbol: string, reason: string): void;
  revoke?(symbol: string): void;
  invalidate?(symbol: string, sourceAt: number, reason: string): void;
  fetch?: typeof fetch; websocket?: (url: string) => WebSocket;
}

/** Public feeds only. Separate from authenticated order/account clients; exact contracts, bounded demand. */
export class NativeMarketData {
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly identities = new Map<string, NativeIdentity>();
  private readonly streams = new Map<string, Stream>();
  private readonly pending = new Map<string, AbortController>();
  private readonly next = new Map<string, number>();
  private readonly venueNext = new Map<string, number>();
  private readonly reconnectAt = new Map<string, number>();
  private readonly metadata = new Map<string, { value: unknown; until: number }>();
  private generation = 0;
  constructor(private readonly options: NativeMarketOptions) {}
  acceptCrossExFunding(symbol: string, rate: string, sourceAt: number): void {
    if (!['BINANCE', 'OKX', 'BYBIT', 'HYPERLIQUID'].includes(symbol.split('_')[0])) return;
    const meta = this.identities.get(symbol), hours = meta?.fundingHours;
    if (meta && hours && Number.isFinite(hours) && hours > 0 && hours <= 24) this.fee(meta, rate, 8 / hours, sourceAt);
  }
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), 500); this.timer.unref?.(); this.tick();
  }
  stop(): void {
    this.generation++; if (this.timer) clearInterval(this.timer); this.timer = null;
    for (const controller of this.pending.values()) controller.abort();
    for (const symbol of this.identities.keys()) this.options.revoke?.(symbol);
    for (const stream of this.streams.values()) stream.socket.terminate();
    this.streams.clear(); this.identities.clear(); this.metadata.clear(); this.next.clear();
  }
  private tick(): void {
    const now = Date.now(), demand = [...new Set(this.options.demand())].filter(s => this.options.allowed(s)).slice(0, 100);
    for (const key of this.identities.keys()) if (!demand.includes(key)) { this.identities.delete(key); this.next.delete(key); this.options.revoke?.(key); }
    for (const symbol of [...demand].sort((a, b) => (this.next.get(a) ?? 0) - (this.next.get(b) ?? 0))) {
      const venue = symbol.split('_')[0], meta = this.identities.get(symbol);
      if (this.pending.size >= 4 || this.pending.has(symbol) || now < (this.next.get(symbol) ?? 0)
        || now < (this.venueNext.get(venue) ?? 0)) continue;
      if (meta && meta.validUntil > now + 15000 && WS_URLS[venue]) continue;
      this.next.set(symbol, now + 2000); this.venueNext.set(venue, now + 250);
      const controller = new AbortController(), generation = this.generation; this.pending.set(symbol, controller);
      void this.sample(symbol, controller.signal, generation).catch(() => {
        if (generation === this.generation) this.options.unavailable?.(symbol, 'native_read_unavailable');
      }).finally(() => { this.pending.delete(symbol); });
    }
    for (const venue of Object.keys(WS_URLS)) this.maintainStream(venue, demand, now);
  }
  private async sample(symbol: string, signal: AbortSignal, generation: number): Promise<void> {
    const meta = this.identities.get(symbol);
    const identity = meta && meta.validUntil > Date.now() + 15000 ? meta : await this.identity(symbol, signal);
    signal.throwIfAborted(); if (generation !== this.generation) return;
    this.identities.set(symbol, identity);
    if (WS_URLS[symbol.split('_')[0]]) return;
    const raw = await this.book(identity, signal); signal.throwIfAborted();
    if (generation === this.generation) this.deliver(identity, raw);
  }
  private deliver(meta: NativeIdentity, raw: RawQuote): void {
    if (!this.options.allowed(meta.symbol)) return;
    const quote = normalizeNativeQuote(meta, raw, Date.now());
    if (quote) this.options.accept(quote); else {
      this.options.unavailable?.(meta.symbol, 'native_quote_invalid_or_stale');
      if (raw.nativeSymbol === meta.nativeSymbol) this.options.invalidate?.(meta.symbol, raw.sourceAt, 'native_quote_invalid_or_stale');
    }
  }
  private async json(venue: string, url: string, signal: AbortSignal, body?: unknown, cached = false): Promise<unknown> {
    const cacheKey = `${url}:${JSON.stringify(body ?? null)}`, prior = this.metadata.get(cacheKey);
    if (cached && prior && prior.until > Date.now() + 15000) return prior.value;
    const combined = AbortSignal.any([signal, AbortSignal.timeout(4000)]);
    const response = await (this.options.fetch ?? fetch)(url, { signal: combined, redirect: 'error',
      ...(body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) });
    if (response.status === 429) {
      const header = response.headers.get('retry-after'), seconds = Number(header);
      const wait = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : Date.parse(header ?? '') - Date.now();
      this.venueNext.set(venue, Date.now() + (Number.isFinite(wait) && wait > 0 ? wait : 30000));
    }
    if (!response.ok) { void response.body?.cancel(); throw new Error('native_http_unavailable'); }
    const reader = response.body?.getReader(); if (!reader) throw new Error('native_empty_response');
    const abort = () => { void reader.cancel().catch(() => undefined); }; combined.addEventListener('abort', abort, { once: true });
    let text = '', size = 0; const decoder = new TextDecoder();
    try {
      for (;;) { combined.throwIfAborted(); const chunk = await reader.read(); combined.throwIfAborted(); if (chunk.done) break;
        size += chunk.value.byteLength; if (size > 8_000_000) { abort(); throw new Error('native_response_too_large'); } text += decoder.decode(chunk.value, { stream: true }); }
      text += decoder.decode(); const value: unknown = JSON.parse(text);
      if (cached) { if (this.metadata.size >= 200) this.metadata.delete(this.metadata.keys().next().value!); this.metadata.set(cacheKey, { value, until: Date.now() + 60000 }); }
      return value;
    } finally { combined.removeEventListener('abort', abort); reader.releaseLock(); }
  }
  private async identity(symbol: string, signal: AbortSignal): Promise<NativeIdentity> {
    const match = /^([A-Z]+)_FUTURE_([A-Z0-9]+)_(USDT|USDC|USD)$/.exec(symbol);
    if (!match) throw new Error('native_symbol_invalid');
    const [, venue, asset, quote] = match; let nativeSymbol = '', multiplier = '1', valid = false, fundingHours: number | undefined;
    let validUntil = Date.now() + 60000;
    const get = async (url: string, body?: unknown) => {
      const value = await this.json(venue, url, signal, body, true);
      validUntil = Math.min(validUntil, this.metadata.get(`${url}:${JSON.stringify(body ?? null)}`)?.until ?? 0);
      return value;
    };
    if (venue === 'GATE' && quote === 'USDT') {
      nativeSymbol = `${asset}_${quote}`; const r = object(await get(`https://api.gateio.ws/api/v4/futures/usdt/contracts/${nativeSymbol}`));
      valid = r.name === nativeSymbol && r.type === 'direct' && r.in_delisting !== true && (!r.status || r.status === 'trading'); multiplier = str(r.quanto_multiplier);
    } else if (venue === 'BINANCE' && ['USDT', 'USDC'].includes(quote)) {
      nativeSymbol = `${asset}${quote}`; const r = rows(object(await get('https://fapi.binance.com/fapi/v1/exchangeInfo')).symbols).find(r => r.symbol === nativeSymbol);
      valid = !!r && r.baseAsset === asset && r.quoteAsset === quote && r.marginAsset === quote && r.status === 'TRADING'
        && ['PERPETUAL', 'TRADIFI_PERPETUAL'].includes(str(r.contractType));
      try {
        const info = rows(await get('https://fapi.binance.com/fapi/v1/fundingInfo')).find(r => r.symbol === nativeSymbol);
        fundingHours = info ? Number(info.fundingIntervalHours) : 8;
      } catch { /* Unknown cycle disables the funding fallback, not the independently verified book. */ }
    } else if (venue === 'OKX') {
      nativeSymbol = `${asset}-${quote}-SWAP`; const r = rows(object(await get('https://www.okx.com/api/v5/public/instruments?instType=SWAP')).data).find(r => r.instId === nativeSymbol);
      valid = !!r && r.ctType === 'linear' && r.ctValCcy === asset && r.settleCcy === quote && r.state === 'live'; multiplier = str(r?.ctVal);
      try {
        const fee = rows(object(await get(`https://www.okx.com/api/v5/public/funding-rate?instId=${nativeSymbol}`)).data).find(r => r.instId === nativeSymbol);
        if (fee) fundingHours = (Number(fee.nextFundingTime) - Number(fee.fundingTime)) / 3600000;
      } catch { /* Never infer a funding cycle from a missing response. */ }
    } else if (venue === 'BYBIT') {
      nativeSymbol = `${asset}${quote}`; const r = rows(object(object(await get(`https://api.bybit.com/v5/market/instruments-info?category=linear&symbol=${nativeSymbol}`)).result).list).find(r => r.symbol === nativeSymbol);
      valid = !!r && r.baseCoin === asset && r.quoteCoin === quote && r.settleCoin === quote && r.status === 'Trading' && r.contractType === 'LinearPerpetual'; fundingHours = Number(r?.fundingInterval) / 60;
    } else if (venue === 'HYPERLIQUID' && quote === 'USDC') {
      nativeSymbol = asset; const r = rows(object(await get('https://api.hyperliquid.xyz/info', { type: 'meta' })).universe).find(r => r.name === asset);
      valid = !!r && r.isDelisted !== true; fundingHours = 1; // HIP aliases need a separately proved namespace; never guess one.
    } else if (venue === 'KRAKEN' && quote === 'USD') {
      nativeSymbol = `PF_${asset === 'BTC' ? 'XBT' : asset}USD`;
      const r = rows(object(await get('https://futures.kraken.com/derivatives/api/v3/instruments')).instruments).find(r => r.symbol === nativeSymbol);
      valid = !!r && r.type === 'flexible_futures' && r.tradeable !== false && Number(r.contractSize) === 1;
    } else if (venue === 'DERIBIT' && quote === 'USDC') {
      nativeSymbol = `${asset}_USDC-PERPETUAL`; const r = object(object(await get(`https://www.deribit.com/api/v2/public/get_instrument?instrument_name=${nativeSymbol}`)).result);
      valid = r.instrument_name === nativeSymbol && r.base_currency === asset && r.quote_currency === quote && r.settlement_currency === quote
        && r.instrument_type === 'linear' && r.kind === 'future' && r.is_active === true;
    }
    if (!valid || !positive(multiplier)) throw new Error('native_contract_unverified');
    return { symbol, nativeSymbol, multiplier, validUntil, fundingHours };
  }
  private async book(meta: NativeIdentity, signal: AbortSignal): Promise<RawQuote> {
    const venue = meta.symbol.split('_')[0], name = meta.nativeSymbol;
    let r: RecordValue, bid: unknown, ask: unknown, bidSize: unknown, askSize: unknown, sourceAt: number;
    const level = (value: unknown) => z.array(z.array(z.unknown())).parse(value)[0] ?? [undefined, undefined];
    if (venue === 'BINANCE') {
      r = object(await this.json(venue, `https://fapi.binance.com/fapi/v1/depth?symbol=${name}&limit=5`, signal));
      [bid, bidSize] = level(r.bids); [ask, askSize] = level(r.asks); sourceAt = Number(r.E);
    } else if (venue === 'OKX') {
      const envelope = object(await this.json(venue, `https://www.okx.com/api/v5/market/books?instId=${name}&sz=5`, signal));
      if (envelope.code !== '0') throw new Error('native_rejected'); r = rows(envelope.data)[0];
      [bid, bidSize] = level(r.bids); [ask, askSize] = level(r.asks); sourceAt = Number(r.ts);
    } else if (venue === 'BYBIT') {
      const envelope = object(await this.json(venue, `https://api.bybit.com/v5/market/orderbook?category=linear&symbol=${name}&limit=1`, signal));
      if (envelope.retCode !== 0) throw new Error('native_rejected'); r = object(envelope.result);
      if (r.s !== name) throw new Error('native_identity_changed');
      [bid, bidSize] = level(r.b); [ask, askSize] = level(r.a); sourceAt = Number(r.cts);
    } else {
      r = object(await this.json(venue, 'https://api.hyperliquid.xyz/info', signal, { type: 'l2Book', coin: name }));
      if (r.coin !== name) throw new Error('native_identity_changed');
      const levels = z.array(z.array(z.unknown())).length(2).parse(r.levels), b = levels[0][0] === undefined ? {} : object(levels[0][0]), a = levels[1][0] === undefined ? {} : object(levels[1][0]);
      bid = b.px; bidSize = b.sz; ask = a.px; askSize = a.sz; sourceAt = Number(r.time);
    }
    return { nativeSymbol: name, bid, ask, bidSize, askSize, sourceAt };
  }
  private maintainStream(venue: string, demand: string[], now: number): void {
    const needed = new Map(demand.flatMap(symbol => {
      const meta = this.identities.get(symbol); return symbol.startsWith(`${venue}_`) && meta && meta.validUntil > now ? [[meta.nativeSymbol, meta] as const] : [];
    }));
    let stream = this.streams.get(venue);
    if (!needed.size) { stream?.socket.terminate(); this.streams.delete(venue); return; }
    if (!stream) {
      if (now < (this.reconnectAt.get(venue) ?? 0)) return;
      const socket = (this.options.websocket ?? (url => new WebSocket(url)))(WS_URLS[venue]);
      stream = { socket, symbols: new Map(), pingAt: now, awaitingPong: false }; this.streams.set(venue, stream);
      const owner = stream;
      socket.on('message', raw => { if (this.streams.get(venue) === owner) this.onFrame(venue, owner, String(raw)); });
      socket.on('pong', () => { owner.awaitingPong = false; });
      const retire = () => { if (this.streams.get(venue) !== owner) return; this.streams.delete(venue); this.reconnectAt.set(venue, Date.now() + 5000); socket.terminate(); };
      socket.on('error', retire); socket.on('close', retire);
    }
    if (stream.socket.readyState !== WebSocket.OPEN) return;
    const added = [...needed.keys()].filter(k => !stream!.symbols.has(k)), removed = [...stream.symbols.keys()].filter(k => !needed.has(k));
    if (removed.length) this.subscribe(venue, stream.socket, removed, 'unsubscribe');
    if (added.length) this.subscribe(venue, stream.socket, added, 'subscribe');
    stream.symbols = needed;
    if (now - stream.pingAt > 10000) {
      if (stream.awaitingPong) { stream.socket.terminate(); return; }
      stream.pingAt = now; stream.awaitingPong = true; stream.socket.ping();
    }
  }
  private subscribe(venue: string, socket: WebSocket, names: string[], action: 'subscribe' | 'unsubscribe'): void {
    if (venue === 'DERIBIT') socket.send(JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method: `public/${action}`, params: { channels: names.map(n => `ticker.${n}.100ms`) } }));
    else if (venue === 'KRAKEN') socket.send(JSON.stringify({ event: action, feed: 'ticker', product_ids: names }));
    else for (const channel of ['futures.book_ticker', 'futures.tickers']) socket.send(JSON.stringify({ time: Math.floor(Date.now() / 1000), event: action, channel, payload: names }));
  }
  private onFrame(venue: string, stream: Stream, raw: string): void {
    try {
      const x = object(JSON.parse(raw));
      if (venue === 'GATE' && x.event === 'update' && x.channel === 'futures.tickers') {
        for (const r of rows(x.result)) { const meta = stream.symbols.get(str(r.contract));
          const hours = Number(r.funding_interval) / 3600;
          if (meta && hours > 0 && hours <= 24 && Number.isFinite(hours)) this.fee(meta, r.funding_rate, 8 / hours, Number(r.t)); }
        return;
      }
      let r: RecordValue, name: string, quote: RawQuote;
      if (venue === 'GATE' && x.event === 'update' && x.channel === 'futures.book_ticker') {
        r = object(x.result); name = str(r.s); quote = { nativeSymbol: name, bid: r.b, ask: r.a, bidSize: r.B, askSize: r.A, sourceAt: Number(r.t) };
      } else if (venue === 'KRAKEN' && x.feed === 'ticker') {
        r = x; name = str(r.product_id); if (r.suspended !== false || r.tag !== 'perpetual') {
          const meta = stream.symbols.get(name); if (meta) this.options.invalidate?.(meta.symbol, Number(r.time), 'native_market_suspended'); return;
        }
        quote = { nativeSymbol: name, bid: r.bid, ask: r.ask, bidSize: r.bid_size, askSize: r.ask_size, sourceAt: Number(r.time) };
      } else if (venue === 'DERIBIT' && x.method === 'subscription') {
        const params = object(x.params); r = object(params.data); name = str(r.instrument_name);
        if (params.channel !== `ticker.${name}.100ms`) return;
        if (r.state !== 'open') { const meta = stream.symbols.get(name); if (meta) this.options.invalidate?.(meta.symbol, Number(r.timestamp), 'native_market_not_open'); return; }
        quote = { nativeSymbol: name, bid: r.best_bid_price, ask: r.best_ask_price, bidSize: r.best_bid_amount, askSize: r.best_ask_amount, sourceAt: Number(r.timestamp) };
      } else return;
      const meta = stream.symbols.get(name); if (!meta) return; this.deliver(meta, quote);
      if (venue === 'DERIBIT') this.fee(meta, r.funding_8h, 1, quote.sourceAt);
      if (venue === 'KRAKEN' && positive(r.markPrice)) this.fee(meta, r.funding_rate, 8 / Number(r.markPrice), quote.sourceAt);
    } catch { /* Malformed public frames never advance an executable quote or funding timestamp. */ }
  }
  private fee(meta: NativeIdentity, value: unknown, factor: number, sourceAt: number): void {
    const now = Date.now();
    if (meta.validUntil <= now || !this.options.allowed(meta.symbol) || (typeof value !== 'string' && typeof value !== 'number') || str(value).trim() === ''
      || !Number.isFinite(Number(value)) || !Number.isFinite(factor) || !Number.isFinite(sourceAt) || now - sourceAt > 3000 || sourceAt > now + 2000) return;
    this.options.funding?.(meta.symbol, new Decimal(str(value)).mul(factor).toString(), sourceAt, now);
  }
}
