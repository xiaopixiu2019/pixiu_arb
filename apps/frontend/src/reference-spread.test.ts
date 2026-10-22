import { describe, expect, it } from 'vitest';
import { referenceSpread, selectReferencePair, streamedReferenceQuotes } from './reference-spread.js';

describe('shared entry spread', () => {
  const now = 1_790_000_000_000;
  const at = new Date(now).toISOString();
  const entries = [
    { symbol: 'BINANCE_FUTURE_BTC_USDT', status: 'ok' as const, bidPrice: '99', askPrice: '100', bookObservedAt: at, fetchedAt: at },
    { symbol: 'HYPERLIQUID_FUTURE_BTC_USDC', status: 'ok' as const, bidPrice: '102', askPrice: '103', bookObservedAt: at, fetchedAt: at },
  ];
  it('uses short bid and long ask; reversal recomputes opposite sides', () => {
    expect(referenceSpread('BTC', entries, entries[0].symbol, entries[1].symbol, now).bps).toBe(200);
    expect(referenceSpread('BTC', entries, entries[1].symbol, entries[0].symbol, now).bps).toBeCloseTo(-388.3495);
  });
  it('accepts real zero, rejects missing, stale, crossed, wrong units and wrong symbols', () => {
    expect(referenceSpread('BTC', [{ ...entries[0], askPrice: '102' }, entries[1]], entries[0].symbol, entries[1].symbol, now).bps).toBe(0);
    for (const quote of [
      { ...entries[1], bidPrice: null }, { ...entries[1], askPrice: '101' },
      { ...entries[1], bookObservedAt: new Date(now - 46_000).toISOString() },
      { ...entries[1], symbol: 'HYPERLIQUID_FUTURE_1000BTC_USDC' },
      { ...entries[1], status: 'unavailable' as const },
    ]) expect(referenceSpread('BTC', [entries[0], quote], entries[0].symbol, entries[1].symbol, now).bps).toBeNull();
  });
  it('falls back to valid REST books when fresh streamed quotes are crossed or missing', () => {
    const selected = selectReferencePair('BTC', [{ ...entries[0], bidPrice: '104' }, entries[1]], entries, entries[0].symbol, entries[1].symbol, now);
    expect(selected.streamBooksValid).toBe(false);
    expect(referenceSpread('BTC', selected.entries, entries[0].symbol, entries[1].symbol, now).bps).toBe(200);
  });
  it('retains independently fresh exact streamed books without treating connection readiness as price validity', () => {
    const markets = entries.map((entry) => ({ symbol: entry.symbol, source: 'gate_crossex_websocket' as const,
      bidPrice: entry.bidPrice, askPrice: entry.askPrice, updatedAt: at, receivedAt: at }));
    const quotes = streamedReferenceQuotes(markets, entries.map((entry) => entry.symbol), now);
    expect(referenceSpread('BTC', quotes, entries[0].symbol, entries[1].symbol, now).bps).toBe(200);
    expect(streamedReferenceQuotes(markets, entries.map((entry) => entry.symbol), now + 15_001)).toEqual([]);
    expect(streamedReferenceQuotes([{ ...markets[0], receivedAt: new Date(now + 4_000).toISOString() }], [entries[0].symbol], now)).toEqual([]);
    expect(streamedReferenceQuotes(markets, ['GATE_FUTURE_BTC_USDT'], now)).toEqual([]);
  });
});
