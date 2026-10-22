import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type WebSocket from 'ws';
import { NativeMarketData, normalizeNativeQuote } from './native-market-data.js';
import { CrossExMarketHub } from './market-hub.js';
import { freshManagedQuote } from './managed-position-model.js';

describe('independent executable quote boundary', () => {
  it.each(['GATE', 'BINANCE', 'OKX', 'BYBIT', 'KRAKEN', 'HYPERLIQUID', 'DERIBIT'])('normalizes verified %s units without manufacturing time', venue => {
    const now = Date.now(), symbol = `${venue}_FUTURE_BTC_${venue === 'KRAKEN' ? 'USD' : ['DERIBIT', 'HYPERLIQUID'].includes(venue) ? 'USDC' : 'USDT'}`;
    const q = normalizeNativeQuote({ symbol, nativeSymbol: 'verified', multiplier: venue === 'OKX' ? '0.01' : '1', validUntil: now + 1000 },
      { nativeSymbol: 'verified', bid: '100', ask: '101', bidSize: '2', askSize: '3', sourceAt: now - 100 }, now);
    expect(q?.sourceAt).toBe(now - 100);
    expect(q?.bidSize).toBe(venue === 'OKX' ? '0.02' : '2');
  });
  it.each(['identity', 'stale', 'crossed', 'units', 'metadata', 'quantity'])('rejects %s failure', failure => {
    const now = Date.now();
    const meta = { symbol: 'OKX_FUTURE_BTC_USDT', nativeSymbol: 'BTC-USDT-SWAP', multiplier: failure === 'units' ? 'NaN' : '0.01', validUntil: now + (failure === 'metadata' ? -1 : 1000) };
    expect(normalizeNativeQuote(meta, { nativeSymbol: failure === 'identity' ? 'OTHER' : meta.nativeSymbol,
      bid: '100', ask: failure === 'crossed' ? '99' : '101', bidSize: failure === 'quantity' ? '0' : '2', askSize: '3',
      sourceAt: now - (failure === 'stale' ? 4000 : 10) }, now)).toBeNull();
  });
  it('selects native data when CrossEx is unavailable and returns to a fresh CrossEx quote', () => {
    const hub = new CrossExMarketHub('ws://127.0.0.1:1'), now = Date.now(), symbol = 'BYBIT_FUTURE_BTC_USDT';
    hub.acceptNativeQuote({ symbol, nativeSymbol: 'BTCUSDT', bidPrice: '100', askPrice: '101', bidSize: '2', askSize: '3', sourceAt: now, receivedAt: now, validUntil: now + 60000 });
    expect(hub.market(symbol)?.source).toBe('native_venue'); expect(freshManagedQuote(hub.market(symbol), now)).toBe(true);
    const push = (ts: number) => (hub as unknown as { handleMessage(raw: string, at: number): void }).handleMessage(JSON.stringify({ channel: 'ticker', event: 'update', result: {
      s: symbol, ts, lp: '100', bp: '100', ap: '101', bs: '2', as: '3', o: '99', h: '102', l: '98', v: '10',
    } }), ts);
    push(now + 1); expect(hub.market(symbol)?.source).toBe('native_venue');
    push(now + 2);
    expect(hub.market(symbol)?.source).toBe('gate_crossex_websocket');
    expect(freshManagedQuote(hub.market(symbol), now + 16000)).toBe(false);
  });
  it('blocks conflicting and revoked native quotes until a strictly newer sample', () => {
    const hub = new CrossExMarketHub('ws://127.0.0.1:1'), now = Date.now(), symbol = 'DERIBIT_FUTURE_BTC_USDC';
    const quote = { symbol, nativeSymbol: 'BTC_USDC-PERPETUAL', bidPrice: '100', askPrice: '101', bidSize: '2', askSize: '3', sourceAt: now, receivedAt: now, validUntil: now + 60000 };
    hub.acceptNativeQuote(quote); expect(freshManagedQuote(hub.market(symbol), now)).toBe(true);
    hub.acceptNativeQuote({ ...quote, bidPrice: '90' }); expect(freshManagedQuote(hub.market(symbol), now)).toBe(false);
    hub.acceptNativeQuote(quote); expect(freshManagedQuote(hub.market(symbol), now)).toBe(false);
    hub.acceptNativeQuote({ ...quote, sourceAt: now + 1 }); expect(freshManagedQuote(hub.market(symbol), now)).toBe(true);
    hub.invalidateNativeQuote(symbol, now + 2); hub.acceptNativeQuote({ ...quote, sourceAt: now + 1 });
    expect(freshManagedQuote(hub.market(symbol), now)).toBe(false);
    hub.acceptNativeQuote({ ...quote, sourceAt: now + 3 }); expect(freshManagedQuote(hub.market(symbol), now)).toBe(true);
  });
});

class PublicSocket extends EventEmitter {
  readyState = 1;
  ping() { this.emit('pong'); }
  terminate() { this.readyState = 3; this.emit('close'); }
  send(raw: string) {
    const x = JSON.parse(raw);
    if (x.event === 'unsubscribe' || x.method === 'public/unsubscribe') return;
    const emit = (value: unknown) => queueMicrotask(() => this.emit('message', JSON.stringify(value)));
    for (const name of x.product_ids ?? []) emit({ feed: 'ticker', product_id: name, tag: 'perpetual', suspended: false,
      bid: 100, ask: 101, bid_size: 2, ask_size: 3, time: Date.now(), funding_rate: 0.01, markPrice: 100 });
    for (const channel of x.params?.channels ?? []) emit({ method: 'subscription', params: { channel, data: {
      instrument_name: channel.split('.')[1], state: 'open', best_bid_price: 100, best_ask_price: 101,
      best_bid_amount: 2, best_ask_amount: 3, timestamp: Date.now(), funding_8h: 0.001 } } });
    if (x.channel === 'futures.book_ticker') for (const name of x.payload) emit({ event: 'update', channel: x.channel,
      result: { s: name, b: '100', a: '101', B: 2, A: 3, t: Date.now() } });
    if (x.channel === 'futures.tickers') emit({ event: 'update', channel: x.channel,
      result: x.payload.map((contract: string) => ({ contract, funding_rate: '0.001', funding_interval: 14400, t: Date.now() })) });
  }
}

describe('native adapters and actual hub consumer', () => {
  it('serves all nineteen verified contracts with CrossEx absent, preserves units, and expires old data', async () => {
    vi.useFakeTimers();
    const assets: Record<string, string[]> = { GATE: ['BTC'], BINANCE: ['BTC', 'SKHYNIX'], OKX: ['BTC', 'SKHYNIX'],
      BYBIT: ['BTC', 'ETH', 'MSTR', 'SNDK', 'SOXL'], KRAKEN: ['BTC', 'SNDK', 'WLFI'], HYPERLIQUID: ['BTC', 'ETH'], DERIBIT: ['BTC', 'MSTR', 'SOXL', 'WLFI'] };
    const symbols = Object.entries(assets).flatMap(([v, aa]) => aa.map(a => `${v}_FUTURE_${a}_${v === 'KRAKEN' ? 'USD' : ['DERIBIT', 'HYPERLIQUID'].includes(v) ? 'USDC' : 'USDT'}`));
    const hub = new CrossExMarketHub('ws://127.0.0.1:1');
    hub.ensureMarkets(symbols.map(symbol => ({ symbol, venue: symbol.split('_')[0] as 'GATE', asset: symbol.split('_')[2] })));
    let emptyBinance = false;
    const fetcher: typeof fetch = async (url, init) => {
      const u = new URL(String(url)); expect(u.pathname).not.toContain('crossex'); expect(new Headers(init?.headers).has('KEY')).toBe(false);
      const name = u.searchParams.get('symbol') ?? '', inst = u.searchParams.get('instId') ?? '';
      let value: unknown;
      if (u.pathname.endsWith('/contracts/BTC_USDT')) value = { name: 'BTC_USDT', type: 'direct', quanto_multiplier: '0.0001' };
      else if (u.pathname.endsWith('/exchangeInfo')) value = { symbols: assets.BINANCE.map(a => ({ symbol: `${a}USDT`, baseAsset: a, quoteAsset: 'USDT', marginAsset: 'USDT', status: 'TRADING', contractType: a === 'SKHYNIX' ? 'TRADIFI_PERPETUAL' : 'PERPETUAL' })) };
      else if (u.pathname.endsWith('/fundingInfo')) value = [{ symbol: 'SKHYNIXUSDT', fundingIntervalHours: 4 }];
      else if (u.pathname === '/api/v5/public/instruments') value = { data: assets.OKX.map(a => ({ instId: `${a}-USDT-SWAP`, ctType: 'linear', ctValCcy: a, settleCcy: 'USDT', state: 'live', ctVal: a === 'BTC' ? '0.01' : '1' })) };
      else if (u.pathname.endsWith('/funding-rate')) value = { data: [{ instId: inst, fundingTime: Date.now(), nextFundingTime: Date.now() + 28800000 }] };
      else if (u.pathname.endsWith('/instruments-info')) value = { result: { list: [{ symbol: name, baseCoin: name.slice(0, -4), quoteCoin: 'USDT', settleCoin: 'USDT', status: 'Trading', contractType: 'LinearPerpetual', fundingInterval: 480 }] } };
      else if (u.pathname.endsWith('/v3/instruments')) value = { instruments: assets.KRAKEN.map(a => ({ symbol: `PF_${a === 'BTC' ? 'XBT' : a}USD`, type: 'flexible_futures', contractSize: 1 })) };
      else if (u.pathname.endsWith('/get_instrument')) { const n = u.searchParams.get('instrument_name')!; value = { result: { instrument_name: n, base_currency: n.split('_')[0], quote_currency: 'USDC', settlement_currency: 'USDC', instrument_type: 'linear', kind: 'future', is_active: true } }; }
      else if (u.pathname === '/info') { const body = JSON.parse(String(init?.body)); value = body.type === 'meta' ? { universe: assets.HYPERLIQUID.map(name => ({ name })) }
        : { coin: body.coin, time: Date.now(), levels: [[{ px: '100', sz: '2' }], [{ px: '101', sz: '3' }]] }; }
      else if (u.pathname.endsWith('/depth')) value = { E: Date.now(), bids: emptyBinance ? [] : [['100', '2']], asks: emptyBinance ? [] : [['101', '3']] };
      else if (u.pathname.endsWith('/books')) value = { code: '0', data: [{ ts: String(Date.now()), bids: [['100', '2']], asks: [['101', '3']] }] };
      else if (u.pathname.endsWith('/orderbook')) value = { retCode: 0, result: { s: name, cts: Date.now(), b: [['100', '2']], a: [['101', '3']] } };
      else throw new Error(`unexpected public endpoint ${u.pathname}`);
      return Response.json(value);
    };
    const funding = new Map<string, string>(), sockets = new Map<string, PublicSocket>();
    const native = new NativeMarketData({ demand: () => symbols, allowed: s => symbols.includes(s), accept: q => hub.acceptNativeQuote(q), fetch: fetcher,
      funding: (symbol, rate8h) => funding.set(symbol, rate8h),
      invalidate: (symbol, at) => hub.invalidateNativeQuote(symbol, at), revoke: symbol => hub.revokeNativeQuote(symbol),
      websocket: url => { const socket = new PublicSocket(); sockets.set(url, socket); return socket as unknown as WebSocket; } });
    try {
      native.start(); await vi.advanceTimersByTimeAsync(6000);
      for (const symbol of symbols) { expect(hub.market(symbol)?.source, symbol).toBe('native_venue'); expect(freshManagedQuote(hub.market(symbol), Date.now()), symbol).toBe(true); }
      expect(hub.market('GATE_FUTURE_BTC_USDT')?.bidSize).toBe('0.0002');
      expect(hub.market('OKX_FUTURE_BTC_USDT')?.bidSize).toBe('0.02');
      expect(funding.get('GATE_FUTURE_BTC_USDT')).toBe('0.002');
      expect(funding.get('DERIBIT_FUTURE_BTC_USDC')).toBe('0.001');
      expect(funding.get('KRAKEN_FUTURE_BTC_USD')).toBe('0.0008');
      native.acceptCrossExFunding('BINANCE_FUTURE_SKHYNIX_USDT', '0.001', Date.now());
      native.acceptCrossExFunding('HYPERLIQUID_FUTURE_ETH_USDC', '0.001', Date.now());
      expect(funding.get('BINANCE_FUTURE_SKHYNIX_USDT')).toBe('0.002');
      expect(funding.get('HYPERLIQUID_FUTURE_ETH_USDC')).toBe('0.008');
      native.acceptCrossExFunding('BYBIT_FUTURE_UNKNOWN_USDT', '999', Date.now());
      expect(funding.has('BYBIT_FUTURE_UNKNOWN_USDT')).toBe(false);
      const old = hub.market('BINANCE_FUTURE_BTC_USDT')!;
      emptyBinance = true; await vi.advanceTimersByTimeAsync(2500);
      expect(freshManagedQuote(hub.market(old.symbol), Date.now())).toBe(false);
      hub.acceptNativeQuote({ symbol: old.symbol, nativeSymbol: 'BTCUSDT', bidPrice: '100', askPrice: '101', bidSize: '2', askSize: '3', sourceAt: Date.parse(old.updatedAt), receivedAt: Date.now(), validUntil: Date.now() + 60000 });
      expect(freshManagedQuote(hub.market(old.symbol), Date.now())).toBe(false);
      emptyBinance = false; await vi.advanceTimersByTimeAsync(2500);
      expect(freshManagedQuote(hub.market(old.symbol), Date.now())).toBe(true);
      const socket = sockets.get('wss://www.deribit.com/ws/api/v2')!, at = Date.now();
      const push = (state: string, timestamp: number) => socket.emit('message', JSON.stringify({ method: 'subscription', params: {
        channel: 'ticker.WLFI_USDC-PERPETUAL.100ms', data: { instrument_name: 'WLFI_USDC-PERPETUAL', state, timestamp,
          best_bid_price: 100, best_ask_price: 101, best_bid_amount: 2, best_ask_amount: 3 } } }));
      push('closed', at); expect(freshManagedQuote(hub.market('DERIBIT_FUTURE_WLFI_USDC'), Date.now())).toBe(false);
      push('open', at - 1); expect(freshManagedQuote(hub.market('DERIBIT_FUTURE_WLFI_USDC'), Date.now())).toBe(false);
      push('open', at + 1); expect(freshManagedQuote(hub.market('DERIBIT_FUTURE_WLFI_USDC'), Date.now())).toBe(true);
      native.stop(); await vi.advanceTimersByTimeAsync(16000);
      for (const symbol of symbols) expect(freshManagedQuote(hub.market(symbol), Date.now())).toBe(false);
    } finally { native.stop(); hub.stop(); vi.useRealTimers(); }
  });
});
