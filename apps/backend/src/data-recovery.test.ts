import { afterEach, describe, expect, it, vi } from 'vitest';
import { FundingOverviewService } from './funding-overview.js';
import type { PublicMarketDataGateway, VenueFundingStat } from '@gate-crossex/public-data';
import { GateCrossExClient } from './crossex-client.js';
import { PublicMarketDataError, VenuePublicMarketDataClient } from '@gate-crossex/public-data';
import { BoundedRead } from './bounded-read.js';

afterEach(() => vi.useRealTimers());
const row = { venue: 'GATE', base: 'BTC', quote: 'USDT', fundingRate8h: '0.001' } as VenueFundingStat;
const turn = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

describe('bounded independent data refresh', () => {
  it('projects newly refreshed held-position funding instead of an older page cache', async () => {
    vi.useFakeTimers(); let rate = '0.001';
    const gateway = { queryVenueFundingStats: async () => [{ ...row, fundingRate8h: rate }] } as unknown as PublicMarketDataGateway;
    const service = new FundingOverviewService(gateway);
    const catalog = { assets: new Map([['BTC', [{ venue: 'GATE', symbol: 'GATE_FUTURE_BTC_USDT', quote: 'USDT' }]]]) } as Parameters<typeof service.buildResponse>[0];
    await service.ensureFresh(); const old = service.buildResponse(catalog).assets[0].venues[0].fetchedAt;
    await vi.advanceTimersByTimeAsync(90000); rate = '0.002'; await service.refreshForManagedPositions();
    const projected = service.buildResponse(catalog, new Set(['GATE_FUTURE_BTC_USDT']));
    expect(projected.cacheStatus).toBe('fresh');
    expect(projected.assets[0].venues[0]).toMatchObject({ fundingRate8h: '0.002', fetchedAt: new Date().toISOString() });
    expect(service.buildResponse(catalog).assets[0].venues[0]).toMatchObject({ fundingRate8h: '0.001', fetchedAt: old });
  });
  it('records bounded read generations and last success without letting a logger failure break reads', async () => {
    vi.useFakeTimers(); const events: unknown[] = []; let fail = false;
    const gateway = { queryVenueFundingStats: async () => { if (fail) throw new Error('synthetic'); return [row]; } } as unknown as PublicMarketDataGateway;
    const service = new FundingOverviewService(gateway, { onRead: event => { events.push(event); if (event.outcome === 'started') throw new Error('logger'); } });
    await service.refreshForManagedPositions(); const prior = Date.now();
    fail = true; await vi.advanceTimersByTimeAsync(30001); await service.refreshForManagedPositions();
    expect(events).toContainEqual(expect.objectContaining({ venue: 'GATE', outcome: 'unavailable', generation: 8,
      startedAt: prior + 30001, deadlineAt: prior + 38001, endedAt: prior + 30001, lastSuccessAt: prior }));
  });
  it('reads OKX funding without manufacturing an empty successful market envelope', async () => {
    const fetcher = vi.fn<typeof fetch>(async url => {
      expect(new URL(String(url)).pathname).toBe('/api/v5/public/funding-rate');
      return Response.json({ code: '0', msg: '', data: [{ instId: 'SKHYNIX-USDT-SWAP', fundingRate: '0.001', fundingTime: '1000000', nextFundingTime: '29800000' }] });
    });
    const client = new VenuePublicMarketDataClient(fetcher);
    expect(await client.queryVenueFundingRates('OKX', new AbortController().signal)).toEqual(expect.arrayContaining([expect.objectContaining({ base: 'SKHYNIX', fundingRate8h: '0.001' })]));
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('does not use an unverified display interval as executable funding', async () => {
    const gateway = { queryVenueFundingStats: async () => [{ ...row, fundingCycleVerified: false }] } as unknown as PublicMarketDataGateway;
    const service = new FundingOverviewService(gateway); await service.refreshForManagedPositions();
    expect(service.managedFunding('GATE_FUTURE_BTC_USDT')).toBeNull();
  });
  it.each([{}, { code: -1, msg: 'invalid response' }, []])('distinguishes invalid Binance period metadata from a valid default list: %j', async payload => {
    const client = new VenuePublicMarketDataClient(async url => new URL(String(url)).pathname.endsWith('/premiumIndex')
      ? Response.json([{ symbol: 'SKHYNIXUSDT', lastFundingRate: '0.001', nextFundingTime: Date.now() + 1000 }])
      : Response.json(payload));
    const gateway = { queryVenueFundingRates: (venue: Parameters<typeof client.queryVenueFundingRates>[0], signal: AbortSignal) =>
      venue === 'BINANCE' ? client.queryVenueFundingRates(venue, signal) : Promise.resolve([]) } as unknown as PublicMarketDataGateway;
    const service = new FundingOverviewService(gateway); await service.refreshForManagedPositions();
    if (Array.isArray(payload)) expect(service.managedFunding('BINANCE_FUTURE_SKHYNIX_USDT')?.rate8h).toBe('0.001');
    else expect(service.managedFunding('BINANCE_FUTURE_SKHYNIX_USDT')).toBeNull();
  });
  it('preserves a real HTTP Retry-After header longer than ten seconds', async () => {
    const client = new VenuePublicMarketDataClient(async () => Response.json({}, { status: 429, headers: { 'Retry-After': '120' } }));
    await expect(client.queryVenueFundingRates('BYBIT', new AbortController().signal)).rejects.toMatchObject({ code: 'UPSTREAM_HTTP_429', retryAfterMs: 120000 });
  });
  it('does not request optional display tickers while collecting executable funding', async () => {
    const paths: string[] = [];
    const client = new VenuePublicMarketDataClient(async url => {
      const path = new URL(String(url)).pathname; paths.push(path);
      if (path.endsWith('/premiumIndex')) return Response.json([{ symbol: 'SKHYNIXUSDT', lastFundingRate: '0.001', nextFundingTime: Date.now() + 1000 }]);
      if (path.endsWith('/fundingInfo')) return Response.json([{ symbol: 'SKHYNIXUSDT', fundingIntervalHours: 4 }]);
      throw new Error('optional display endpoint must not gate funding');
    });
    expect(await client.queryVenueFundingRates('BINANCE', new AbortController().signal)).toEqual(expect.arrayContaining([
      expect.objectContaining({ base: 'SKHYNIX', fundingRate8h: '0.002' }),
    ]));
    expect(paths).toHaveLength(2);
  });
  it('honors venue Retry-After without stalling healthy venues', async () => {
    vi.useFakeTimers(); let gateReads = 0;
    const gateway = { queryVenueFundingStats: async (venue: string) => {
      if (venue === 'GATE' && ++gateReads === 1) throw new PublicMarketDataError('RATE_LIMITED', 120000);
      return [{ ...row, venue }];
    } } as unknown as PublicMarketDataGateway;
    const service = new FundingOverviewService(gateway);
    await service.refreshForManagedPositions(); await vi.advanceTimersByTimeAsync(6000); await service.refreshForManagedPositions();
    expect(gateReads).toBe(1); expect(service.managedFunding('BINANCE_FUTURE_BTC_USDT')).not.toBeNull();
    await vi.advanceTimersByTimeAsync(120000); await service.refreshForManagedPositions(); expect(gateReads).toBe(2);
  });
  it('does not let an earlier managed failure invalidate a newer page success', async () => {
    vi.useFakeTimers(); let fail!: (error: Error) => void;
    const gateway = { queryVenueFundingRates: async (venue: string) => venue === 'GATE' ? new Promise<never>((_, reject) => { fail = reject; }) : [],
      queryVenueFundingStats: async () => [row] } as unknown as PublicMarketDataGateway;
    const service = new FundingOverviewService(gateway), managed = service.refreshForManagedPositions();
    await turn(); await service.ensureFresh(); fail(new Error('older request failed')); await managed;
    expect(service.managedFunding('GATE_FUTURE_BTC_USDT')?.rate8h).toBe('0.001');
  });
  it('blocks contradictory funding at one timestamp, including identical replay, until a newer observation', () => {
    const now = Date.now(), service = new FundingOverviewService({} as PublicMarketDataGateway, { now: () => now + 3 });
    service.acceptNativeFunding('DERIBIT_FUTURE_BTC_USDC', '0.01', now, now);
    service.acceptNativeFunding('DERIBIT_FUTURE_BTC_USDC', '-0.01', now, now);
    service.acceptNativeFunding('DERIBIT_FUTURE_BTC_USDC', '0.01', now, now);
    expect(service.managedFunding('DERIBIT_FUTURE_BTC_USDC')).toBeNull();
    service.acceptNativeFunding('DERIBIT_FUTURE_BTC_USDC', '0.02', now + 1, now + 1);
    expect(service.managedFunding('DERIBIT_FUTURE_BTC_USDC')?.rate8h).toBe('0.02');
  });
  it('bounds uncooperative work, reports saturation, and resumes after the physical work settles', async () => {
    vi.useFakeTimers(); const lane = new BoundedRead(), finish: Array<() => void> = [];
    const work = () => new Promise<void>(resolve => finish.push(resolve));
    const first = lane.run(work, 10).catch(e => e.message); await vi.advanceTimersByTimeAsync(11);
    const second = lane.run(work, 10).catch(e => e.message); await vi.advanceTimersByTimeAsync(11);
    expect(await first).toBe('read_deadline_exceeded'); expect(await second).toBe('read_deadline_exceeded');
    await expect(lane.run(work, 10)).rejects.toThrow('read_capacity_exhausted'); expect(finish).toHaveLength(2);
    finish.forEach(resolve => resolve()); await turn(); await expect(lane.run(async () => 'restored', 10)).resolves.toBe('restored');
  });
  it.each(['venue', 'classification'])('publishes healthy funding while %s never settles and retries the failed lane', async blocker => {
    vi.useFakeTimers(); let attempts = 0;
    const gateway = { queryVenueFundingStats: async (venue: string) => {
      if (venue === 'DERIBIT' && ++attempts === 1 && blocker === 'venue') return new Promise<never>(() => undefined);
      return [row];
    } } as unknown as PublicMarketDataGateway;
    const service = new FundingOverviewService(gateway, { cryptoMarketCapProvider: blocker === 'classification'
      ? { load: () => new Promise<never>(() => undefined) } : undefined });
    const refresh = service.refreshForManagedPositions(); await turn();
    expect(service.managedFunding('GATE_FUTURE_BTC_USDT')?.rate8h).toBe('0.001');
    await vi.advanceTimersByTimeAsync(8_001); await refresh;
    await vi.advanceTimersByTimeAsync(5_001); await service.refreshForManagedPositions();
    expect(attempts).toBeGreaterThanOrEqual(blocker === 'venue' ? 2 : 1);
    expect(service.managedFunding('GATE_FUTURE_BTC_USDT')).not.toBeNull();
  });

  it('does not publish a timed-out funding response over a newer successful sample', async () => {
    vi.useFakeTimers(); let release!: (rows: VenueFundingStat[]) => void, attempts = 0;
    const gateway = { queryVenueFundingStats: async (venue: string) => venue !== 'GATE' ? [] : ++attempts === 1
      ? new Promise<VenueFundingStat[]>(resolve => { release = resolve; }) : [row] } as unknown as PublicMarketDataGateway;
    const service = new FundingOverviewService(gateway);
    const first = service.refreshForManagedPositions(); await vi.advanceTimersByTimeAsync(8_001); await first;
    await vi.advanceTimersByTimeAsync(5_001); await service.refreshForManagedPositions();
    release([{ ...row, fundingRate8h: '999' }]); await turn();
    expect(service.managedFunding('GATE_FUTURE_BTC_USDT')?.rate8h).toBe('0.001');
  });

  it('shares Retry-After with independent account readers without sharing the blocked queue', async () => {
    vi.useFakeTimers(); const fetched = vi.fn(async () => new Response('{}', { status: 429, headers: { 'Retry-After': '2' } }));
    const client = new GateCrossExClient(fetched, Date.now, undefined, 0), credentials = { apiKey: 'synthetic', apiSecret: 'synthetic' };
    await expect(client.queryAccount(credentials)).rejects.toMatchObject({ statusCode: 429 });
    const next = client.createStatisticsReader().queryAccount(credentials).catch(error => error);
    await vi.advanceTimersByTimeAsync(1_999); expect(fetched).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2); await next; expect(fetched).toHaveBeenCalledTimes(2);
  });
});
