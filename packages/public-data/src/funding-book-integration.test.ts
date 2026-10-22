import { expect, it, vi } from 'vitest';
import { VenuePublicMarketDataClient } from './index.js';

const now = 1_000_000;
const response = (data: unknown) => Promise.resolve(new Response(JSON.stringify(data)));

it.each(['OKX', 'BYBIT', 'DERIBIT'] as const)('maps %s explicit best-quote fields without using last price', async (venue) => {
  const client = new VenuePublicMarketDataClient(vi.fn((url) => {
    if (venue === 'BYBIT') return response({ retCode: 0, result: { list: [{ symbol: 'BTCUSDT', fundingRate: '0.0001', nextFundingTime: '0', openInterestValue: '10', lastPrice: '90000', bid1Price: '50000', ask1Price: '50001' }] } });
    if (venue === 'DERIBIT') return response({ result: [{ instrument_name: 'BTC_USDC-PERPETUAL', last: 90000, bid_price: 50000, ask_price: 50001 }] });
    const row = String(url).includes('funding-rate') ? { instId: 'BTC-USDT-SWAP', fundingRate: '0.0001', fundingTime: '0', nextFundingTime: '28800000' }
      : String(url).includes('open-interest') ? { instId: 'BTC-USDT-SWAP', oiUsd: '10' }
        : { instId: 'BTC-USDT-SWAP', last: '90000', open24h: '90000', bidPx: '50000', askPx: '50001', ts: String(now) };
    return response({ code: '0', msg: '', data: [row] });
  }) as typeof fetch, () => now);
  expect((await client.queryVenueFundingStats(venue))[0]).toMatchObject({ lastPrice: '90000', bidPrice: '50000', askPrice: '50001' });
});

it('preserves old Kraken last price for existing consumers but supplies independent MNT best quotes', async () => {
  const client = new VenuePublicMarketDataClient(vi.fn(() => response({ tickers: [{
    symbol: 'PF_MNTUSD', pair: 'MNT:USD', tag: 'perpetual', fundingRate: 0.0001,
    markPrice: 0.6938, last: 0.6938, bid: 0.6889, ask: 0.6994, lastTime: '2000-01-01T00:00:00Z',
  }] })) as typeof fetch, () => now);
  expect((await client.queryVenueFundingStats('KRAKEN'))[0]).toMatchObject({
    lastPrice: '0.6938', bidPrice: '0.6889', askPrice: '0.6994', bookObservedAt: new Date(now).toISOString(),
  });
});

it('does not drop a Gate funding row when its book is malformed', async () => {
  const client = new VenuePublicMarketDataClient(vi.fn((url) => response(String(url).endsWith('/contracts') ? [] : [{
    contract: 'MNT_USDT', funding_rate: '0.00005', mark_price: '0.69', last: '0.69', highest_bid: {}, lowest_ask: '0.7',
  }])) as typeof fetch, () => now);
  const [stat] = await client.queryVenueFundingStats('GATE');
  expect(stat.fundingRate).toBe('0.00005');
  expect(stat.lastPrice).toBe('0.69');
  expect(stat.bidPrice).toBeUndefined();
});

it('reads Binance bookTicker separately from ticker lastPrice and fails closed if its source is stale', async () => {
  let sourceTime = now;
  const client = new VenuePublicMarketDataClient(vi.fn((url) => {
    if (String(url).endsWith('bookTicker')) return response([{ symbol: 'MNTUSDT', bidPrice: '0.688', askPrice: '0.689', time: sourceTime }]);
    if (String(url).endsWith('premiumIndex')) return response([{ symbol: 'MNTUSDT', lastFundingRate: '0.0001', nextFundingTime: 0 }]);
    if (String(url).endsWith('24hr')) return response([{ symbol: 'MNTUSDT', lastPrice: '0.8', priceChangePercent: '1' }]);
    return response([]);
  }) as typeof fetch, () => now);
  expect((await client.queryVenueFundingStats('BINANCE'))[0]).toMatchObject({ bidPrice: '0.688', askPrice: '0.689', lastPrice: '0.8' });
  sourceTime = now - 31_000;
  const [stale] = await client.queryVenueFundingStats('BINANCE');
  expect(stale.bidPrice).toBeUndefined();
  expect(stale.fundingRate).toBe('0.0001');
});
