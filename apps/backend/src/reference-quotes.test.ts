import { describe, expect, it, vi } from 'vitest';
import type { PublicMarketDataGateway, VenueFundingStat } from '@gate-crossex/public-data';
import { ReferenceQuotesService } from './reference-quotes.js';

describe('independent reference quotes', () => {
  const now = 1_790_000_000_000;
  const gate = 'GATE_FUTURE_BTC_USDT', hyper = 'HYPERLIQUID_FUTURE_BTC_USDC';
  const book = { bidPrice: '100', askPrice: '101', bookObservedAt: new Date(now).toISOString() };
  const stat: VenueFundingStat = { ...book, venue: 'GATE', base: 'BTC', quote: 'USDT', fundingRate: null, fundingIntervalHours: 8, fundingRate8h: null, nextFundingAt: null, openInterestValue: null, lastPrice: '99999', change24h: null };
  const gateway = (overrides: Partial<PublicMarketDataGateway> = {}): PublicMarketDataGateway => ({
    querySnapshot: async () => { throw new Error('not used'); },
    queryVenueFundingStats: async () => [stat], queryReferenceBook: async () => book, ...overrides,
  });
  it('coalesces concurrent exact contracts, uses bulk venue data, expires without changing source time', async () => {
    let clock = now;
    const bulk = vi.fn(async () => [stat]);
    const native = vi.fn(async () => book);
    const service = new ReferenceQuotesService(gateway({ queryVenueFundingStats: bulk, queryReferenceBook: native }), () => clock);
    const allowed = new Set([gate, hyper]);
    const results = await Promise.all([service.read([gate, hyper], allowed), service.read([gate, hyper], allowed)]);
    expect(bulk).toHaveBeenCalledTimes(1); expect(native).toHaveBeenCalledTimes(1);
    expect(results[0].entries).toEqual(results[1].entries);
    clock += 16_000; await service.read([gate, hyper], allowed);
    expect(bulk).toHaveBeenCalledTimes(2); expect(native).toHaveBeenCalledTimes(2);
    clock += 46_000;
    expect((await service.read([gate], allowed)).entries[0]).toMatchObject({ status: 'unavailable', reason: 'missing_book' });
  });
  it('isolates a failed venue, never promotes mark price, and does not fetch unknown contracts', async () => {
    const bulk = vi.fn(async () => [{ ...stat, bidPrice: undefined, askPrice: undefined }]);
    const service = new ReferenceQuotesService(gateway({ queryVenueFundingStats: bulk, queryReferenceBook: async () => { throw new Error('failure'); } }), () => now);
    const unknown = 'GATE_FUTURE_OTHER_USDT';
    expect((await service.read([gate, hyper, unknown], new Set([gate, hyper]))).entries.map((entry) => entry.reason)).toEqual(['missing_book', 'venue_unavailable', 'unknown_contract']);
    expect(bulk).toHaveBeenCalledTimes(1);
  });
  it('bounds concurrent native reads and rejects excessive or malformed selections', async () => {
    let active = 0, maximum = 0;
    const service = new ReferenceQuotesService(gateway({ queryReferenceBook: async () => {
      active += 1; maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 1)); active -= 1; return book;
    } }), () => now);
    const symbols = Array.from({ length: 20 }, (_, index) => `HYPERLIQUID_FUTURE_A${index}_USDC`);
    const result = await service.read(symbols, new Set(symbols));
    expect(result.entries.every((entry) => entry.status === 'ok')).toBe(true); expect(maximum).toBe(4);
    await expect(service.read([...symbols, ...Array(81).fill(gate)], new Set(symbols))).rejects.toThrow('INVALID_REFERENCE_SYMBOLS');
    await expect(service.read(['http://internal'], new Set())).rejects.toThrow('INVALID_REFERENCE_SYMBOLS');
  });
  it('retains single flight past the result TTL and stamps the completed read', async () => {
    let clock = now, finish: (() => void) | undefined;
    const native = vi.fn(async () => { await new Promise<void>((resolve) => { finish = resolve; }); return { ...book, bookObservedAt: new Date(clock).toISOString() }; });
    const service = new ReferenceQuotesService(gateway({ queryReferenceBook: native }), () => clock);
    const first = service.read([hyper], new Set([hyper]));
    clock += 16_000;
    const second = service.read([hyper], new Set([hyper]));
    expect(native).toHaveBeenCalledTimes(1); finish!();
    expect((await first).entries[0].fetchedAt).toBe(new Date(clock).toISOString());
    expect((await second).entries[0].status).toBe('ok');
    clock += 10_000; await service.read([hyper], new Set([hyper]));
    expect(native).toHaveBeenCalledTimes(1);
  });
  it.each(['stale', 'failure'])('recovers a %s Binance bulk feed using a fresh explicit depth book', async (state) => {
    const symbol = 'BINANCE_FUTURE_BTC_USDT';
    const native = vi.fn(async () => book);
    const service = new ReferenceQuotesService(gateway({ queryReferenceBook: native,
      queryVenueFundingStats: async () => { if (state === 'failure') throw new Error('funding feed unavailable'); return [{ ...stat, venue: 'BINANCE', bookObservedAt: new Date(now - 60_000).toISOString() }]; },
    }), () => now);
    expect((await service.read([symbol], new Set([symbol]))).entries[0]).toMatchObject({ status: 'ok', bidPrice: '100', askPrice: '101' });
    expect(native).toHaveBeenCalledExactlyOnceWith(symbol);
  });
  it('caps targeted native reads per venue per minute independently of cache size', async () => {
    let clock = now;
    const native = vi.fn(async () => ({ ...book, bookObservedAt: new Date(clock).toISOString() }));
    const service = new ReferenceQuotesService(gateway({ queryReferenceBook: native }), () => clock);
    const symbols = Array.from({ length: 301 }, (_, index) => `HYPERLIQUID_FUTURE_BUDGET${index}_USDC`);
    for (let start = 0; start < 300; start += 100) await service.read(symbols.slice(start, start + 100), new Set(symbols));
    expect((await service.read(symbols.slice(300), new Set(symbols))).entries[0]).toMatchObject({ reason: 'busy' });
    expect(native).toHaveBeenCalledTimes(300);
    clock += 60_001;
    expect((await service.read(symbols.slice(300), new Set(symbols))).entries[0].status).toBe('ok');
    expect(native).toHaveBeenCalledTimes(301);
  });
  it('returns partial availability within the frontend timeout and expires queued work', async () => {
    vi.useFakeTimers();
    try {
      const native = vi.fn(async () => { await new Promise((resolve) => setTimeout(resolve, 8_000)); return { ...book, bookObservedAt: new Date().toISOString() }; });
      const service = new ReferenceQuotesService(gateway({ queryReferenceBook: native }));
      const symbols = Array.from({ length: 100 }, (_, index) => `HYPERLIQUID_FUTURE_SLOW${index}_USDC`);
      const read = service.read(symbols, new Set(symbols));
      await vi.advanceTimersByTimeAsync(12_000);
      const result = await read;
      expect(result.entries.filter((entry) => entry.status === 'ok')).toHaveLength(4);
      expect(result.entries.filter((entry) => entry.reason === 'timeout')).toHaveLength(96);
      expect(native).toHaveBeenCalledTimes(8);
      await vi.advanceTimersByTimeAsync(8_000);
      expect(native).toHaveBeenCalledTimes(8);
    } finally { vi.useRealTimers(); }
  });
});
