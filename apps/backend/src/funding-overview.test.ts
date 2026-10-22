import { describe, expect, it } from 'vitest';
import { FUNDING_STAT_VENUES, PublicMarketDataError } from '@gate-crossex/public-data';
import type { FundingStatVenue, PublicMarketDataGateway, VenueFundingStat } from '@gate-crossex/public-data';
import type { MarketCatalogVenue } from '@gate-crossex/shared-types';
import { FundingOverviewService, fundingOverviewRefreshInterval } from './funding-overview.js';

function catalogWith(asset: string, venues: MarketCatalogVenue[]) {
  return { assets: new Map([[asset, venues]]) };
}

function gatewayReturning(handler: (venue: FundingStatVenue) => VenueFundingStat[], onCall?: () => void): PublicMarketDataGateway {
  return {
    querySnapshot: () => Promise.reject(new Error('unused')),
    queryVenueFundingStats: async (venue) => {
      onCall?.();
      return handler(venue);
    },
  };
}

const gateBtcStat: VenueFundingStat = {
  venue: 'GATE', base: 'BTC', quote: 'USDT', fundingRate: '0.00005', fundingIntervalHours: 4, fundingRate8h: '0.0001',
  nextFundingAt: '2026-07-23T08:00:00.000Z', openInterestValue: '2500000',
  lastPrice: '50000', change24h: '0.0125',
};

describe('funding overview service', () => {
  it('refreshes the shared position cache before its sixty-second execution/display deadline', async () => {
    let clock = 1_000_000, calls = 0;
    const service = new FundingOverviewService(gatewayReturning(venue => venue === 'GATE' ? [gateBtcStat] : [], () => { calls += 1; }), { now: () => clock });
    await service.ensureFresh(); clock += 61_000;
    expect(service.managedFunding('GATE_FUTURE_BTC_USDT')).toBeNull();
    await service.refreshForManagedPositions();
    expect(service.managedFunding('GATE_FUTURE_BTC_USDT')).toMatchObject({ rate8h: '0.0001', fetchedAt: clock });
    expect(calls).toBe(FUNDING_STAT_VENUES.length * 2);
  });
  it('keeps catalog-wide asset classification when projecting a venue-scoped alias', async () => {
    const service = new FundingOverviewService(gatewayReturning(() => []));
    await service.ensureFresh();
    const catalog = catalogWith('QNT', [{ venue: 'GATE', symbol: 'GATE_FUTURE_QNT_USDT', quote: 'USDT' },
      { venue: 'HYPERLIQUID', symbol: 'HYPERLIQUID_FUTURE_QNT_USDC', quote: 'USDC' }]);
    const full = service.buildResponse(catalog), scoped = service.buildResponse(catalog, new Set(['HYPERLIQUID_FUTURE_QNT_USDC']));
    expect(full.assets[0].assetClass).not.toBe('STOCK'); expect(scoped.assets[0].assetClass).toBe(full.assets[0].assetClass);
    expect(scoped.assets[0].venues).toHaveLength(1);
  });
  it('forwards independently observed book quotes and never substitutes last price when absent', async () => {
    const service = new FundingOverviewService(gatewayReturning((venue) => venue === 'GATE'
      ? [{ ...gateBtcStat, bidPrice: '49990', askPrice: '50010', bookObservedAt: new Date(990_000).toISOString() }] : []), { now: () => 1_000_000 });
    await service.ensureFresh();
    const rows = service.buildResponse(catalogWith('BTC', [
      { venue: 'GATE', symbol: 'GATE_FUTURE_BTC_USDT', quote: 'USDT' },
      { venue: 'BINANCE', symbol: 'BINANCE_FUTURE_BTC_USDT', quote: 'USDT' },
    ])).assets[0].venues;
    expect(rows[0]).toMatchObject({ bidPrice: '49990', askPrice: '50010', bookObservedAt: new Date(990_000).toISOString(), lastPrice: '50000' });
    expect(rows[1]).toMatchObject({ bidPrice: null, askPrice: null, bookObservedAt: null });
  });
  it('refreshes every five minutes normally and every 30 seconds around the hourly settlement', () => {
    const at = (value: string) => Date.parse(`2026-08-01T12:${value}Z`);
    expect(fundingOverviewRefreshInterval(at('54:59.999'))).toBe(5 * 60_000);
    expect(fundingOverviewRefreshInterval(at('55:00.000'))).toBe(30_000);
    expect(fundingOverviewRefreshInterval(at('00:00.000'))).toBe(30_000);
    expect(fundingOverviewRefreshInterval(at('04:59.999'))).toBe(30_000);
    expect(fundingOverviewRefreshInterval(at('05:00.000'))).toBe(5 * 60_000);
  });

  it('awaits the first sweep, joins stats by asset and quote, and reuses the cache while fresh', async () => {
    let calls = 0;
    let clock = 1_000_000;
    const gateway = gatewayReturning((venue) => venue === 'GATE' ? [gateBtcStat] : [], () => { calls += 1; });
    const service = new FundingOverviewService(gateway, { freshMs: 45_000, now: () => clock });

    await service.ensureFresh();
    expect(calls).toBe(FUNDING_STAT_VENUES.length);

    const response = service.buildResponse(catalogWith('BTC', [
      { venue: 'GATE', symbol: 'GATE_FUTURE_BTC_USDT', quote: 'USDT' },
      { venue: 'BINANCE', symbol: 'BINANCE_FUTURE_BTC_USDT', quote: 'USDT' },
    ]));
    expect(response.cacheStatus).toBe('fresh');
    expect(response.assets).toHaveLength(1);
    expect(response.assets[0]?.assetClass).toBe('CRYPTO_BLUE_CHIP');
    expect(response.classification).toMatchObject({
      source: 'COINGECKO', marketCapLimit: 20, status: 'fallback',
    });
    expect(response.assets[0]?.venues[0]).toMatchObject({
      venue: 'GATE', fundingRate: '0.00005', fundingIntervalHours: 4, fundingRate8h: '0.0001', openInterestValue: '2500000', lastPrice: '50000', change24h: '0.0125',
    });
    // Binance listed in the catalog but absent from stats: the row exists with null data.
    expect(response.assets[0]?.venues[1]).toMatchObject({
      venue: 'BINANCE', fundingRate: null, fundingIntervalHours: null, fundingRate8h: null, openInterestValue: null, lastPrice: null, change24h: null, fetchedAt: null,
    });
    expect(response.venueStatus.find((status) => status.venue === 'GATE')).toMatchObject({ status: 'ok', rowCount: 1 });

    clock += 10_000;
    await service.ensureFresh();
    expect(calls).toBe(FUNDING_STAT_VENUES.length);

    clock += 60_000;
    await service.ensureFresh();
    expect(calls).toBe(FUNDING_STAT_VENUES.length * 2);
  });

  it('a quote mismatch between catalog and venue listing yields no stat', async () => {
    const gateway = gatewayReturning((venue) => venue === 'GATE' ? [gateBtcStat] : []);
    const service = new FundingOverviewService(gateway, { now: () => 0 });
    await service.ensureFresh();
    const response = service.buildResponse(catalogWith('BTC', [{ venue: 'GATE', symbol: 'GATE_FUTURE_BTC_USDC', quote: 'USDC' }]));
    expect(response.assets[0]?.venues[0]).toMatchObject({ fundingRate: null, openInterestValue: null });
  });

  it('joins a canonical asset group to a venue stat through the native executable symbol', async () => {
    const hyperliquidSkhx: VenueFundingStat = {
      venue: 'HYPERLIQUID', base: 'SKHX', quote: 'USDC', fundingRate: '-0.0000184914', fundingIntervalHours: 1, fundingRate8h: '-0.0001479312',
      nextFundingAt: '2026-08-01T18:00:00.000Z', openInterestValue: '354341864',
      lastPrice: '1082.7', change24h: '0.012',
    };
    const gateway = gatewayReturning((venue) => venue === 'HYPERLIQUID' ? [hyperliquidSkhx] : []);
    const service = new FundingOverviewService(gateway, { now: () => 0 });
    await service.ensureFresh();

    const response = service.buildResponse(catalogWith('SKHYNIX', [{
      venue: 'HYPERLIQUID', symbol: 'HYPERLIQUID_FUTURE_SKHX_USDC', quote: 'USDC',
    }]));

    expect(response.assets[0]).toMatchObject({ asset: 'SKHYNIX', assetClass: 'STOCK' });
    expect(response.assets[0]?.venues[0]).toMatchObject({
      symbol: 'HYPERLIQUID_FUTURE_SKHX_USDC',
      fundingRate: '-0.0000184914', fundingIntervalHours: 1, fundingRate8h: '-0.0001479312',
      openInterestValue: '354341864',
      lastPrice: '1082.7',
    });
  });

  it('uses a refreshed non-stablecoin top-20 snapshot for blue-chip classification', async () => {
    const snapshot = {
      assets: Array.from({ length: 20 }, (_, index) => ({
        id: `asset-${index + 1}`,
        symbol: index === 0 ? 'ZETA' : `C${index + 1}`,
        name: `Asset ${index + 1}`,
        rank: index + 1,
      })),
      knownSymbols: ['ZETA'],
      fetchedAt: '2026-09-05T08:00:00.000Z',
    };
    const service = new FundingOverviewService(gatewayReturning(() => []), {
      now: () => Date.parse('2026-09-05T08:01:00.000Z'),
      cryptoMarketCapProvider: { load: async () => ({ snapshot, status: 'fresh' }) },
    });
    await service.ensureFresh();

    const response = service.buildResponse(catalogWith('ZETA', [
      { venue: 'GATE', symbol: 'GATE_FUTURE_ZETA_USDT', quote: 'USDT' },
    ]));

    expect(response.assets[0]?.assetClass).toBe('CRYPTO_BLUE_CHIP');
    expect(response.classification).toEqual({
      source: 'COINGECKO', marketCapLimit: 20, status: 'fresh', fetchedAt: snapshot.fetchedAt,
    });
  });

  it('keeps last-good rows and reports error status when a venue fetch fails', async () => {
    let fail = false;
    let clock = 0;
    const gateway: PublicMarketDataGateway = {
      querySnapshot: () => Promise.reject(new Error('unused')),
      queryVenueFundingStats: async (venue) => {
        if (venue !== 'GATE') return [];
        if (fail) throw new PublicMarketDataError('NETWORK_ERROR');
        return [gateBtcStat];
      },
    };
    const warned: string[] = [];
    const service = new FundingOverviewService(gateway, { freshMs: 1_000, now: () => clock, warn: (venue) => warned.push(venue) });

    await service.ensureFresh();
    fail = true;
    clock = 2_000;
    await service.ensureFresh();
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));

    const response = service.buildResponse(catalogWith('BTC', [{ venue: 'GATE', symbol: 'GATE_FUTURE_BTC_USDT', quote: 'USDT' }]));
    expect(warned).toContain('GATE');
    expect(response.venueStatus.find((status) => status.venue === 'GATE')).toMatchObject({ status: 'error', rowCount: 1 });
    expect(response.assets[0]?.venues[0]).toMatchObject({ fundingRate: '0.00005', fundingRate8h: '0.0001' });
  });
  it('retries a failed managed funding sweep after five seconds without using stale evidence', async () => {
    let clock = 0, calls = 0, fail = true;
    const service = new FundingOverviewService(gatewayReturning((venue) => {
      calls += 1;
      if (venue === 'GATE' && fail) throw new PublicMarketDataError('NETWORK_ERROR');
      return venue === 'GATE' ? [gateBtcStat] : [];
    }), { now: () => clock });
    await service.refreshForManagedPositions();
    expect(service.managedFunding('GATE_FUTURE_BTC_USDT')).toBeNull();
    clock = 4_000; await service.refreshForManagedPositions();
    expect(calls).toBe(FUNDING_STAT_VENUES.length);
    fail = false; clock = 5_000; await service.refreshForManagedPositions();
    expect(calls).toBe(FUNDING_STAT_VENUES.length * 2);
    expect(service.managedFunding('GATE_FUTURE_BTC_USDT')?.rate8h).toBe('0.0001');
  });

  it('degrades to null-data rows when the gateway lacks bulk stats support', async () => {
    const gateway: PublicMarketDataGateway = { querySnapshot: () => Promise.reject(new Error('unused')) };
    const service = new FundingOverviewService(gateway, { now: () => 0 });
    await service.ensureFresh();
    const response = service.buildResponse(catalogWith('BTC', [{ venue: 'GATE', symbol: 'GATE_FUTURE_BTC_USDT', quote: 'USDT' }]));
    expect(response.assets[0]?.venues[0]).toMatchObject({ fundingRate: null });
    expect(response.venueStatus.every((status) => status.status === 'error')).toBe(true);
  });
});
