import { describe, expect, it, vi } from 'vitest';
import { VenuePublicMarketDataClient } from './index.js';

describe('funding history pagination completeness', () => {
  it.each([false, true])('rejects malformed short-page rows instead of creating false empty/partial coverage (mixed=%s)', async mixed => {
    const rows = [{ time: 90_000, fundingRate: 'not-a-rate' }];
    if (mixed) rows.push({ time: 95_000, fundingRate: '0.001' });
    const client = new VenuePublicMarketDataClient(vi.fn(async () => new Response(JSON.stringify(rows))) as typeof fetch, () => 100_000, {
      hyperliquidMetadataStore: { read: () => ({ nativeNames: ['ETH'], fetchedAt: new Date(100_000).toISOString() }), write: () => undefined },
    });
    await expect(client.queryFundingHistory('HYPERLIQUID_FUTURE_ETH_USDC', 0, 100_000)).rejects.toMatchObject({ code: 'INCOMPLETE_HISTORY' });
  });
  it.each(['BYBIT', 'OKX', 'HYPERLIQUID'].flatMap(venue => [false, true].map(complete => ({ venue, complete }))))(
    'checks final-page completeness for $venue (complete=$complete)', async ({ venue, complete }) => {
    let call = 0;
    const fetchMock = vi.fn(async () => {
      call++;
      const count = venue === 'HYPERLIQUID' ? 500 : venue === 'BYBIT' ? 200 : 100;
      const rows = Array.from({ length: count }, (_, index) => {
        let time = venue === 'HYPERLIQUID' ? call * 1000 + index : 90_000 - call * 1000 - index;
        if (complete && call === (venue === 'HYPERLIQUID' ? 3 : venue === 'BYBIT' ? 5 : 10) && index === count - 1) {
          time = venue === 'HYPERLIQUID' ? 100_000 : 0;
        }
        return venue === 'HYPERLIQUID' ? { time, fundingRate: '0.001' }
          : venue === 'BYBIT' ? { fundingRateTimestamp: String(time), fundingRate: '0.001' }
            : { fundingTime: String(time), fundingRate: '0.001', realizedRate: '0.001' };
      });
      return new Response(JSON.stringify(venue === 'HYPERLIQUID' ? rows
        : venue === 'BYBIT' ? { retCode: 0, result: { list: rows } } : { code: '0', msg: '', data: rows }));
    });
    const client = new VenuePublicMarketDataClient(fetchMock as typeof fetch, () => 100_000, {
      sleep: async () => undefined,
      hyperliquidMetadataStore: { read: () => ({ nativeNames: ['ETH'], fetchedAt: new Date(100_000).toISOString() }), write: () => undefined },
    });
    const result = client.queryFundingHistory(`${venue}_FUTURE_ETH_${venue === 'HYPERLIQUID' ? 'USDC' : 'USDT'}`, 0, 100_000);
    if (complete) await expect(result).resolves.toHaveLength(venue === 'HYPERLIQUID' ? 1500 : 999);
    else await expect(result).rejects.toMatchObject({ code: 'INCOMPLETE_HISTORY' });
    expect(call).toBe(venue === 'HYPERLIQUID' ? 3 : venue === 'BYBIT' ? 5 : 10);
  });
});
