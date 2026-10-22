import { describe, expect, it } from 'vitest';
import { fundingPriceSpread, formatPriceSpread, type FundingPriceSnapshot } from './funding-price-spread.js';

const now = Date.parse('2026-09-23T06:10:00Z');
const snapshot: FundingPriceSnapshot = {
  checkedAt: now, fresh: true, healthyVenues: ['BINANCE', 'HYPERLIQUID', 'GATE'],
  venues: [
    { venue: 'BINANCE', symbol: 'BINANCE_FUTURE_BTC_USDT', quote: 'USDT', lastPrice: '90000', bidPrice: '86340', askPrice: '86350.3', bookObservedAt: new Date(now).toISOString(), fetchedAt: new Date(now).toISOString() },
    { venue: 'HYPERLIQUID', symbol: 'HYPERLIQUID_FUTURE_BTC_USDC', quote: 'USDC', lastPrice: '99999', bidPrice: '86461', askPrice: '86470', bookObservedAt: new Date(now).toISOString(), fetchedAt: new Date(now).toISOString() },
    { venue: 'GATE', symbol: 'GATE_FUTURE_BTC_USDT', quote: 'USDT', lastPrice: '99999', bidPrice: '99998', askPrice: '100000', bookObservedAt: new Date(now).toISOString(), fetchedAt: new Date(now).toISOString() },
  ],
};

describe('funding pair reference price spread', () => {
  it('reproduces MNT: an attractive old trade spread cannot override an adverse bid/ask spread', () => {
    const venues = [
      { ...snapshot.venues[0], venue: 'GATE', symbol: 'GATE_FUTURE_MNT_USDT', lastPrice: '0.6875', bidPrice: '0.689', askPrice: '0.6893' },
      { ...snapshot.venues[1], venue: 'KRAKEN', symbol: 'KRAKEN_FUTURE_MNT_USD', quote: 'USD', lastPrice: '0.6938', bidPrice: '0.6889', askPrice: '0.6994' },
    ];
    expect(formatPriceSpread(fundingPriceSpread('MNT', { ...snapshot, venues, healthyVenues: ['GATE', 'KRAKEN'] }, 'gate', 'kraken'))).toBe('-5.80 bps');
  });
  it('never substitutes last price for missing or expired quotes', () => {
    for (const book of [{ bidPrice: null }, { askPrice: null }, { bidPrice: '90000' }, { bookObservedAt: null }, { bookObservedAt: new Date(now - 360_001).toISOString() }]) {
      expect(fundingPriceSpread('BTC', { ...snapshot, venues: [{ ...snapshot.venues[0], ...book }, snapshot.venues[1]] }, 'binance', 'hyperliquid')).toBeNull();
    }
  });
  it('uses exactly the selected long and short legs, including their signed direction', () => {
    const spread = fundingPriceSpread('BTC', snapshot, 'binance', 'hyperliquid');
    expect(formatPriceSpread(spread)).toBe('+12.82 bps');
    expect(fundingPriceSpread('BTC', snapshot, 'hyperliquid', 'binance')).toBeLessThan(0);
    expect(formatPriceSpread(0)).toBe('+0.00 bps');
    expect(formatPriceSpread(-8.351)).toBe('-8.35 bps');
    expect(formatPriceSpread(-0.00001)).toBe('-0.00 bps');
    expect(formatPriceSpread(null)).toBe('—');
  });

  it.each([null, '', '0', '-1', 'NaN', 'Infinity'])('rejects an invalid price %s instead of manufacturing zero', (askPrice) => {
    expect(fundingPriceSpread('BTC', { ...snapshot, venues: [{ ...snapshot.venues[0], askPrice }, snapshot.venues[1]] }, 'binance', 'hyperliquid')).toBeNull();
  });

  it('rejects missing legs, failed venues, stale caches, expired or mismatched sampling rounds', () => {
    expect(fundingPriceSpread('BTC', undefined, 'binance', 'hyperliquid')).toBeNull();
    expect(fundingPriceSpread('BTC', snapshot, undefined, 'hyperliquid')).toBeNull();
    expect(fundingPriceSpread('BTC', snapshot, 'binance', 'binance')).toBeNull();
    expect(fundingPriceSpread('BTC', { ...snapshot, healthyVenues: ['BINANCE'] }, 'binance', 'hyperliquid')).toBeNull();
    expect(fundingPriceSpread('BTC', { ...snapshot, fresh: false }, 'binance', 'hyperliquid')).toBeNull();
    expect(fundingPriceSpread('BTC', { ...snapshot, checkedAt: now + 360_001 }, 'binance', 'hyperliquid')).toBeNull();
    expect(fundingPriceSpread('BTC', { ...snapshot, checkedAt: now - 1 }, 'binance', 'hyperliquid')).toBeNull();
    const venues = [{ ...snapshot.venues[0], fetchedAt: new Date(now - 30_000).toISOString() }, snapshot.venues[1]];
    expect(fundingPriceSpread('BTC', { ...snapshot, venues }, 'binance', 'hyperliquid')).toBeNull();
  });

  it('rejects mismatched asset units and unsupported quote currencies', () => {
    const venues = [{ ...snapshot.venues[0], symbol: 'BINANCE_FUTURE_1000BTC_USDT' }, snapshot.venues[1]];
    expect(fundingPriceSpread('BTC', { ...snapshot, venues }, 'binance', 'hyperliquid')).toBeNull();
    expect(fundingPriceSpread('ETH', snapshot, 'binance', 'hyperliquid')).toBeNull();
    expect(fundingPriceSpread('BTC', { ...snapshot, venues: [{ ...snapshot.venues[0], quote: 'EUR' }, snapshot.venues[1]] }, 'binance', 'hyperliquid')).toBeNull();
  });
});
