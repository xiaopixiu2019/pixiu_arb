import { afterEach, describe, expect, it } from 'vitest';
import WebSocket, { WebSocketServer } from 'ws';
import { CrossExMarketHub } from './market-hub.js';
import { waitForStrategyQuotes } from './strategy-quote-readiness.js';
import { recoveryBookChannel } from './executable-quote.js';

const LEFT = 'HYPERLIQUID_FUTURE_ZHIPU_USDC';
const RIGHT = 'GATE_FUTURE_ZHIPU_USDT';
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate: () => boolean, timeout = 2_000) {
  const end = Date.now() + timeout;
  while (!predicate()) { if (Date.now() > end) throw Error('condition_timeout'); await delay(10); }
}
function ticker(symbol: string, ts = Date.now(), price = '100') {
  return JSON.stringify({ channel: 'ticker', event: 'update', result: {
    s: symbol, lp: price, bp: price, bs: '2', ap: '101', as: '3', o: '99', h: '102', l: '98', v: '10', ts,
  } });
}
async function setup(serve: (s: WebSocket, index: number) => void, autoPong = true) {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0, autoPong });
  await new Promise<void>(r => server.once('listening', r));
  const addr = server.address(); if (!addr || typeof addr === 'string') throw Error('address');
  const sockets: WebSocket[] = []; const timers: ReturnType<typeof setInterval>[] = [];
  server.on('connection', (socket: WebSocket) => { sockets.push(socket); serve(socket, sockets.length - 1); });
  const hub = new CrossExMarketHub(`ws://127.0.0.1:${addr.port}`, {
    heartbeatIntervalMs: 50, marketIdlePingAfterMs: 20,
    recovery: { tickMs: 20, probeTimeoutMs: 160, retryIntervalMs: 40, maxAttempts: 4, budgetWindowMs: 5_000, pingIntervalMs: 50 },
  });
  hub.ensureMarkets([{ symbol: LEFT, venue: 'HYPERLIQUID', asset: 'ZHIPU' }, { symbol: RIGHT, venue: 'GATE', asset: 'ZHIPU' }]);
  cleanup.push(async () => { timers.forEach(clearInterval); hub.stop(); sockets.forEach(s => s.terminate()); await new Promise<void>(r => server.close(() => r())); });
  hub.start(); await until(() => hub.connectionState() === 'healthy');
  return { hub, sockets, timers };
}

describe('manual quote recovery', () => {
  it('re-probes an ACK-only PONS leg when both recovery sockets retain healthy legs', async () => {
    const other = 'GATE_FUTURE_SAMSUNG_USDT', requests = new Map<WebSocket, number>(), streaming = new Set<WebSocket>();
    const h = await setup((socket, index) => socket.on('message', raw => {
      const m = JSON.parse(String(raw)); if (index === 0 || m.event !== 'subscribe' || m.channel !== 'ticker') return;
      if (m.payload.includes(LEFT)) {
        const count = (requests.get(socket) ?? 0) + 1; requests.set(socket, count);
        if (count > 1) socket.send(ticker(LEFT));
      }
      const served = index === 1 ? other : RIGHT;
      if (m.payload.includes(served) && !streaming.has(socket)) {
        streaming.add(socket); socket.send(ticker(served));
        h.timers.push(setInterval(() => { if (socket.readyState === WebSocket.OPEN) socket.send(ticker(served)); }, 20));
      }
    }));
    h.hub.ensureMarkets([{ symbol: other, venue: 'GATE', asset: 'SAMSUNG' }]);
    const release = h.hub.watchQuotes([other, RIGHT, LEFT]);
    await waitForStrategyQuotes(h.hub, [other, RIGHT, LEFT], () => true, 1200);
    expect(h.sockets).toHaveLength(3);
    expect(h.sockets.every(s => s.readyState === WebSocket.OPEN)).toBe(true);
    expect([...requests.values()].some(n => n > 1)).toBe(true);
    expect(h.hub.snapshot().quoteRecovery?.attemptsInWindow).toBeLessThanOrEqual(4);
    release();
  });

  it('bounds repeated subscription probes without disconnecting healthy owners or accepting ACKs', async () => {
    const other = 'GATE_FUTURE_SAMSUNG_USDT'; let probes = 0;
    const streaming = new Set<WebSocket>();
    const h = await setup((socket, index) => socket.on('message', raw => {
      const m = JSON.parse(String(raw)); if (index === 0 || m.event !== 'subscribe' || m.channel !== 'ticker') return;
      if (m.payload.includes(LEFT)) probes++;
      const served = index === 1 ? other : RIGHT;
      if (m.payload.includes(served) && !streaming.has(socket)) {
        streaming.add(socket); socket.send(ticker(served));
        h.timers.push(setInterval(() => { if (socket.readyState === WebSocket.OPEN) socket.send(ticker(served)); }, 20));
      }
    }));
    h.hub.ensureMarkets([{ symbol: other, venue: 'GATE', asset: 'SAMSUNG' }]);
    const release = h.hub.watchQuotes([other, RIGHT, LEFT]);
    await expect(waitForStrategyQuotes(h.hub, [LEFT], () => true, 650)).rejects.toMatchObject({ code: 'strategy_market_data_unavailable' });
    expect(probes).toBeGreaterThan(2); expect(probes).toBeLessThanOrEqual(4);
    expect(h.sockets).toHaveLength(3);
    await expect(waitForStrategyQuotes(h.hub, [other, RIGHT], () => true, 0)).resolves.toBeUndefined();
    release();
  });

  it.each(['BINANCE', 'GATE', 'OKX', 'HYPERLIQUID', 'DERIBIT'])('selects supported full snapshots for %s without hardcoding the asset', venue => {
    expect(recoveryBookChannel(`${venue}_FUTURE_ZHIPU_USDC`)).toBe('order_book_5');
    expect(recoveryBookChannel(`${venue}_FUTURE_ETH_USDT`)).toBe('order_book_5');
  });
  it('uses Bybit level one and never guesses unsupported Kraken snapshot channels', () => {
    expect(recoveryBookChannel('BYBIT_FUTURE_SIREN_USDT')).toBe('order_book_1');
    expect(recoveryBookChannel('KRAKEN_FUTURE_BTC_USD')).toBeNull();
  });
  it('recovers the exact requested contract from a full book when ticker is ACK-only', async () => {
    const h = await setup((s, index) => s.on('message', raw => {
      const m = JSON.parse(raw.toString());
      if (index === 0 || m.event !== 'subscribe' || m.channel !== 'order_book_5') return;
      s.send(JSON.stringify({ channel: m.channel, event: 'update', result: {
        s: LEFT, ts: Date.now(), b: [['100', '2'], ['99', '4']], a: [['101', '3'], ['102', '5']],
      } }));
    }));
    const release = h.hub.watchQuotes([LEFT]);
    await waitForStrategyQuotes(h.hub, [LEFT], () => true, 1_000);
    expect(h.hub.market(LEFT)).toMatchObject({ bidPrice: '100', askPrice: '101', bidSize: '2', askSize: '3',
      quoteChannel: 'order_book_5', lastPrice: '0' });
    release();
  });

  it('clears seed statistics and does not turn equivalent ticker/book decimals into a conflict', async () => {
    const h = await setup(() => undefined);
    const symbol = 'HYPERLIQUID_FUTURE_BTC_USDC';
    expect(Number(h.hub.market(symbol)?.lastPrice)).toBeGreaterThan(0);
    const release = h.hub.watchQuotes([symbol]);
    await until(() => h.sockets.length > 1);
    const ts = Date.now();
    const book = (at = ts, bid = '100.0') => JSON.stringify({ channel: 'order_book_5', event: 'update',
      result: { s: symbol, ts: at, b: [[bid, '2.000']], a: [['101.00', '3.0']] } });
    h.sockets[1]!.send(book());
    await waitForStrategyQuotes(h.hub, [symbol], () => true, 500);
    expect(h.hub.market(symbol)).toMatchObject({ lastPrice: '0', open24h: '0', high24h: '0', volume24h: '0',
      fundingRate: '', openInterestValue: '0' });
    expect(h.hub.market(symbol)?.tickerUpdatedAt).toBeUndefined();
    h.sockets[1]!.send(ticker(symbol, ts));
    await until(() => h.hub.market(symbol)?.quoteChannel === 'ticker');
    expect(h.hub.market(symbol)?.receivedAt).not.toBe('');
    h.sockets[1]!.send(book(ts + 1));
    await until(() => h.hub.market(symbol)?.quoteChannel === 'order_book_5');
    expect(h.hub.market(symbol)?.tickerUpdatedAt).toBe(new Date(ts).toISOString());
    h.sockets[1]!.send(book(ts + 1, '99')); // a real same-time contradiction remains unavailable
    await until(() => h.hub.market(symbol)?.receivedAt === '');
    release();
  });

  it('keeps independently proven funding and OI when a seed receives its first executable book', async () => {
    const h = await setup(() => undefined);
    h.sockets[0]!.send(JSON.stringify({ channel: 'funding_rate', event: 'update', result: { s: LEFT, r: '0.001', T: Date.now() + 3600000 } }));
    h.sockets[0]!.send(JSON.stringify({ channel: 'open_interest', event: 'update', result: { s: LEFT, oi: '10', oiV: '1000' } }));
    await until(() => Boolean(h.hub.market(LEFT)?.fundingUpdatedAt));
    const release = h.hub.watchQuotes([LEFT]);
    await until(() => h.sockets.length > 1);
    h.sockets[1]!.send(JSON.stringify({ channel: 'order_book_5', event: 'update', result: {
      s: LEFT, ts: Date.now(), b: [['100', '2']], a: [['101', '3']],
    } }));
    await waitForStrategyQuotes(h.hub, [LEFT], () => true, 500);
    expect(h.hub.market(LEFT)).toMatchObject({ fundingRate: '0.001', openInterestValue: '1000' });
    release();
  });

  it('rejects malformed, stale, crossed and wrong-symbol books rather than manufacturing freshness', async () => {
    const h = await setup(() => undefined);
    const release = h.hub.watchQuotes([LEFT]);
    await until(() => h.sockets.length > 1);
    const send = (result: unknown, channel = 'order_book_5') => h.sockets[1]!.send(JSON.stringify({ channel, event: 'update', result }));
    const valid = { s: LEFT, ts: Date.now(), b: [['100', '2']], a: [['101', '3']] };
    send({ ...valid, ts: Date.now() - 20_000 });
    send({ ...valid, a: [['99', '3']] });
    send({ ...valid, b: [] });
    send({ ...valid, b: [['100', '0']] });
    send({ ...valid, s: RIGHT });
    send(valid, 'order_book_update');
    await delay(30);
    expect(h.hub.market(LEFT)?.source).toBe('demo_seed');
    expect(h.hub.market(RIGHT)?.source).toBe('demo_seed');
    send(valid);
    await waitForStrategyQuotes(h.hub, [LEFT], () => true, 500);
    const quote = h.hub.market(LEFT)!;
    send({ ...valid, ts: valid.ts - 1, b: [['98', '1']] });
    await delay(15);
    expect(h.hub.market(LEFT)?.updatedAt).toBe(quote.updatedAt);
    expect(h.hub.market(LEFT)?.bidPrice).toBe('100');
    release();
  });

  it('does not let application traffic satisfy an unanswered protocol ping', async () => {
    const h = await setup(() => undefined, false);
    h.timers.push(setInterval(() => { if (h.sockets[0]?.readyState === WebSocket.OPEN) h.sockets[0].send(ticker(RIGHT)); }, 5));
    await until(() => h.sockets[0]?.readyState !== WebSocket.OPEN);
    expect(h.hub.connectionState()).toBe('reconnecting');
  });

  it('sends periodic protocol pings despite continuous market pushes', async () => {
    let pings = 0;
    const h = await setup(s => s.on('ping', () => { pings++; }));
    h.timers.push(setInterval(() => h.sockets[0]?.send(ticker(RIGHT)), 5));
    await delay(240);
    expect(pings).toBeGreaterThanOrEqual(3);
    expect(h.sockets).toHaveLength(1);
  });

  it('recovers an ACK-only leg on a candidate without reconnecting the healthy primary', async () => {
    const h = await setup((s, index) => s.on('message', raw => {
      const message = JSON.parse(raw.toString());
      if (message.event !== 'subscribe' || message.channel !== 'ticker') return;
      s.send(JSON.stringify({ event: 'subscribe', channel: 'ticker', result: { status: 'success' } }));
      if (index === 0) s.send(ticker(RIGHT));
      else if (message.payload.includes(LEFT)) s.send(ticker(LEFT));
    }));
    const release = h.hub.watchQuotes([LEFT, RIGHT]);
    const primary = h.sockets[0];
    await waitForStrategyQuotes(h.hub, [LEFT, RIGHT], () => true, 2_000);
    expect(h.hub.market(LEFT)?.source).toBe('gate_crossex_websocket');
    expect(primary.readyState).toBe(WebSocket.OPEN);
    expect(h.sockets.length).toBeLessThanOrEqual(3);
    release();
  });

  it('rotates silent candidates with a bounded budget and never treats ACK as a quote', async () => {
    const h = await setup(s => s.on('message', () => s.send(JSON.stringify({ event: 'subscribe', channel: 'ticker', result: { status: 'success' } }))));
    const release = h.hub.watchQuotes([LEFT]);
    await expect(waitForStrategyQuotes(h.hub, [LEFT], () => true, 750)).rejects.toMatchObject({ code: 'strategy_market_data_unavailable' });
    expect(h.sockets.length).toBeGreaterThan(2);
    expect(h.sockets.length).toBeLessThanOrEqual(5);
    expect(h.sockets.filter(s => s.readyState === WebSocket.OPEN).length).toBeLessThanOrEqual(3);
    expect(h.hub.market(LEFT)?.source).toBe('demo_seed');
    release();
  });

  it('rejects delayed and unrelated candidate data and recovers only with a fresh requested quote', async () => {
    const h = await setup((s, index) => s.on('message', raw => {
      const m = JSON.parse(raw.toString()); if (index === 0 || m.event !== 'subscribe') return;
      s.send(ticker(LEFT, Date.now() - 4_000));
      s.send(ticker(RIGHT, Date.now(), '999'));
    }));
    const release = h.hub.watchQuotes([LEFT]);
    await until(() => h.sockets.length > 1);
    await delay(40);
    expect(h.hub.market(LEFT)?.source).toBe('demo_seed');
    expect(h.hub.market(RIGHT)?.bidPrice).not.toBe('999');
    h.sockets[1]!.send(ticker(LEFT));
    await waitForStrategyQuotes(h.hub, [LEFT], () => true, 1_000);
    release();
  });

  it('invalidates only the disconnected quote owner and preserves primary receipts', async () => {
    let owner: WebSocket | undefined;
    const h = await setup((s, index) => s.on('message', raw => {
      const m = JSON.parse(raw.toString()); if (m.event !== 'subscribe' || m.channel !== 'ticker') return;
      if (index === 0 && m.payload.includes(RIGHT)) s.send(ticker(RIGHT));
      else if (index > 0 && m.payload.includes(LEFT) && (!owner || owner === s)) {
        owner = s; s.send(ticker(LEFT));
      }
    }));
    const release = h.hub.watchQuotes([LEFT, RIGHT]);
    await waitForStrategyQuotes(h.hub, [LEFT, RIGHT], () => true, 2_000);
    const receipt = h.hub.market(RIGHT)?.receivedAt;
    expect(owner).toBeDefined();
    owner!.terminate();
    // Keep replacement frames withheld until the disconnected owner's invalidation is checked.
    await until(() => h.hub.market(LEFT)?.receivedAt === '');
    expect(h.hub.market(RIGHT)?.receivedAt).toBe(receipt);
    expect(h.sockets[0]?.readyState).toBe(WebSocket.OPEN);
    owner = undefined;
    await waitForStrategyQuotes(h.hub, [LEFT, RIGHT], () => true, 2_000);
    release();
  });

  it('keeps a recovered leg valid across primary reconnect and ignores retired candidate messages', async () => {
    const h = await setup((s, index) => s.on('message', raw => {
      const m = JSON.parse(raw.toString()); if (m.event !== 'subscribe' || m.channel !== 'ticker') return;
      if (index === 0) s.send(ticker(RIGHT)); else s.send(ticker(LEFT));
    }));
    const release = h.hub.watchQuotes([LEFT]);
    await waitForStrategyQuotes(h.hub, [LEFT], () => true, 2_000);
    const receipt = h.hub.market(LEFT)?.receivedAt;
    const internals = h.hub as unknown as { recovery: { candidates: Set<{ socket: { emit(event: string, data: string): void } }> } };
    const candidate = [...internals.recovery.candidates][0]!;
    h.sockets[0]!.terminate();
    await delay(100);
    expect(h.hub.market(LEFT)?.receivedAt).toBe(receipt);
    await expect(waitForStrategyQuotes(h.hub, [LEFT], () => true, 0)).resolves.toBeUndefined();
    h.hub.stop();
    candidate.socket.emit('message', ticker(LEFT, Date.now(), '999'));
    expect(h.hub.market(LEFT)?.bidPrice).not.toBe('999');
    const count = h.sockets.length;
    await delay(100);
    expect(h.sockets.length).toBe(count);
    release();
  });
});
