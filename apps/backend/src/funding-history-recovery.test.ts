import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolve } from 'node:path';
import type Database from 'better-sqlite3';
import { PublicMarketDataError, type PublicMarketDataGateway } from '@gate-crossex/public-data';
import { openDatabase } from './database.js';
import { FundingHistoryService } from './funding-history.js';
import { readFundingHistoryCoverage, replaceFundingHistoryRange } from './repositories.js';

const DAY = 86_400_000, NOW = 100 * DAY, SYMBOL = 'BYBIT_FUTURE_ETH_USDT';
const databases: Database.Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
function setup(query: NonNullable<PublicMarketDataGateway['queryFundingHistory']> = vi.fn(async () => [{ timestamp: NOW - 1000, rate: '0.002' }])) {
  const db = openDatabase(':memory:', resolve(process.cwd(), '../../migrations')); databases.push(db);
  replaceFundingHistoryRange(db, SYMBOL, NOW - 70 * DAY, NOW - 40 * DAY,
    [{ timestamp: NOW - 41 * DAY, rate: '0.001' }], new Date(NOW - 40 * DAY).toISOString());
  const service = new FundingHistoryService(db, { queryFundingHistory: query } as unknown as PublicMarketDataGateway,
    { now: () => NOW, venueSpacingMs: { BYBIT: 0 } });
  return { db, service, query };
}

describe('funding coverage recovery', () => {
  it('rebuilds only the requested disconnected window and preserves old rows and coverage evidence', async () => {
    const { db, service, query } = setup();
    const series = await service.loadSeries([SYMBOL], 30 * DAY);
    expect(query).toHaveBeenCalledExactlyOnceWith(SYMBOL, NOW - 30 * DAY, NOW, undefined);
    expect(series.entries[0]).toMatchObject({ status: 'ok', points: [{ timestamp: NOW - 1000, rate: '0.002' }] });
    expect(readFundingHistoryCoverage(db, SYMBOL)).toMatchObject({ coveredFrom: NOW - 30 * DAY, coveredTo: NOW });
    expect(db.prepare('SELECT count(*) AS n FROM funding_rate_history').get()).toEqual({ n: 2 });
    const audit = db.prepare("SELECT payload_json FROM audit_events WHERE type='funding_history_coverage_rebased'").get() as { payload_json: string };
    expect(JSON.parse(audit.payload_json)).toMatchObject({ symbol: SYMBOL, previous: { coveredTo: NOW - 40 * DAY }, next: { coveredFrom: NOW - 30 * DAY, coveredTo: NOW } });
    expect(service.loadRankingSnapshot([SYMBOL]).entries[0]).toMatchObject({ status: 'ok', rate30d: '0.002' });
  });

  it('does not report stale data as zero when upstream fails', async () => {
    const { db, service } = setup(vi.fn(async () => { throw new PublicMarketDataError('INCOMPLETE_HISTORY'); }));
    expect((await service.loadSeries([SYMBOL], DAY)).entries[0]).toMatchObject({ status: 'unavailable', points: [] });
    expect(service.loadRankingSnapshot([SYMBOL]).entries[0]).toMatchObject({ rate24h: null, rate7d: null, rate30d: null });
    expect(readFundingHistoryCoverage(db, SYMBOL)?.coveredTo).toBe(NOW - 40 * DAY);
    expect(db.prepare('SELECT count(*) AS n FROM funding_rate_history').get()).toEqual({ n: 1 });
  });

  it('serves no fake zero while a disconnected refresh is pending', async () => {
    let finish!: (value: Array<{ timestamp: number; rate: string }>) => void;
    const { service } = setup(vi.fn(() => new Promise<Array<{ timestamp: number; rate: string }>>(resolve => { finish = resolve; })));
    expect(service.loadCachedMany([SYMBOL]).entries[0]).toMatchObject({ status: 'pending', rate30d: null });
    await vi.waitFor(() => expect(finish).toBeDefined()); finish([]);
    await vi.waitFor(() => expect(service.loadRankingSnapshot([SYMBOL]).entries[0]).toMatchObject({ status: 'ok', rate30d: '0' }));
  });

  it('rolls back the rebase audit, coverage and rows together if the write fails', () => {
    const { db } = setup(), original = readFundingHistoryCoverage(db, SYMBOL);
    db.exec("CREATE TRIGGER reject_test_write BEFORE INSERT ON funding_rate_history BEGIN SELECT RAISE(ABORT, 'injected_failure'); END");
    expect(() => replaceFundingHistoryRange(db, SYMBOL, NOW - DAY, NOW,
      [{ timestamp: NOW - 1000, rate: '0.3' }], new Date(NOW).toISOString(), { allowRebase: true, expectedCoverage: original }))
      .toThrow('injected_failure');
    expect(readFundingHistoryCoverage(db, SYMBOL)).toEqual(original);
    expect(db.prepare('SELECT count(*) AS n FROM funding_rate_history').get()).toEqual({ n: 1 });
    expect(db.prepare('SELECT count(*) AS n FROM audit_events').get()).toEqual({ n: 0 });
  });

  it('discards a late response after a newer coverage commit without replacing corrected rows', () => {
    const { db } = setup(), original = readFundingHistoryCoverage(db, SYMBOL);
    const rows = [{ timestamp: NOW - 1000, rate: '0.4' }];
    expect(replaceFundingHistoryRange(db, SYMBOL, NOW - 30 * DAY, NOW, rows,
      new Date(NOW).toISOString(), { allowRebase: true, expectedCoverage: original })).toBe(true);
    const latest = readFundingHistoryCoverage(db, SYMBOL);
    expect(replaceFundingHistoryRange(db, SYMBOL, NOW - DAY, NOW, [{ ...rows[0], rate: '0.1' }],
      new Date(NOW).toISOString(), { allowRebase: true, expectedCoverage: original })).toBe(false);
    expect(readFundingHistoryCoverage(db, SYMBOL)).toEqual(latest);
    expect(db.prepare('SELECT rate FROM funding_rate_history WHERE funding_time=?').get(NOW - 1000)).toEqual({ rate: '0.4' });
  });

  it('coalesces concurrent one-day and thirty-day requests and extends the verified window', async () => {
    const query = vi.fn(async (_symbol: string, from: number) => [{ timestamp: Math.max(from + 1000, NOW - 8 * DAY), rate: '0.002' }]);
    const { service, db } = setup(query);
    const results = await Promise.all([service.loadSeries([SYMBOL], DAY), service.loadSeries([SYMBOL], 30 * DAY)]);
    expect(results.every(r => r.entries[0].status === 'ok')).toBe(true);
    expect(query).toHaveBeenCalledTimes(2);
    expect(readFundingHistoryCoverage(db, SYMBOL)).toMatchObject({ coveredFrom: NOW - 30 * DAY, coveredTo: NOW });
    expect(db.prepare("SELECT count(*) AS n FROM audit_events WHERE type='funding_history_coverage_rebased'").get()).toEqual({ n: 1 });
  });

  it('does not spin or repeatedly call upstream after a failed shared cold read', async () => {
    const query = vi.fn(async () => { throw new PublicMarketDataError('UPSTREAM_HTTP_503'); });
    const { service } = setup(query), symbol = 'BYBIT_FUTURE_NEW_USDT';
    const results = await Promise.all([service.loadSeries([symbol], DAY), service.loadSeries([symbol], 30 * DAY)]);
    expect(results.every(r => r.entries[0].status === 'unavailable')).toBe(true);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('never commits a completed response after its background request was aborted', async () => {
    let finish!: (value: Array<{ timestamp: number; rate: string }>) => void;
    const query = vi.fn(() => new Promise<Array<{ timestamp: number; rate: string }>>(resolve => { finish = resolve; }));
    const { service, db } = setup(query), original = readFundingHistoryCoverage(db, SYMBOL);
    service.startBackground(); await vi.waitFor(() => expect(finish).toBeDefined());
    const stopping = service.stopBackground(); finish([{ timestamp: NOW - 1000, rate: '0.5' }]); await stopping;
    expect(readFundingHistoryCoverage(db, SYMBOL)).toEqual(original);
    expect(db.prepare('SELECT count(*) AS n FROM audit_events').get()).toEqual({ n: 0 });
  });

  it('keeps incomplete history pending during cooldown and recovers without a page reload', async () => {
    let now = NOW, attempts = 0;
    const query = vi.fn(async () => { if (++attempts === 1) throw new PublicMarketDataError('INCOMPLETE_HISTORY'); return []; });
    const { db } = setup();
    const service = new FundingHistoryService(db, { queryFundingHistory: query } as unknown as PublicMarketDataGateway,
      { now: () => now, venueSpacingMs: { BYBIT: 0 } });
    await service.loadSeries([SYMBOL], DAY);
    expect(service.loadCachedMany([SYMBOL], DAY).entries[0]).toMatchObject({ status: 'pending', rate24h: null });
    expect(query).toHaveBeenCalledTimes(1); now += 60_001;
    expect(service.loadCachedMany([SYMBOL], DAY).entries[0]).toMatchObject({ status: 'pending', rate24h: null });
    await vi.waitFor(() => expect(service.loadCachedMany([SYMBOL], DAY).entries[0]).toMatchObject({ status: 'ok', rate24h: '0' }));
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('starts the shared failure cooldown at completion even after a slow request', async () => {
    let now = NOW;
    const { db } = setup();
    const query = vi.fn(async () => { now += 61_000; throw new PublicMarketDataError('UPSTREAM_HTTP_503'); });
    const service = new FundingHistoryService(db, { queryFundingHistory: query } as unknown as PublicMarketDataGateway,
      { now: () => now, venueSpacingMs: { BYBIT: 0 } });
    await Promise.all([service.loadSeries(['BYBIT_FUTURE_NEW_USDT'], DAY), service.loadSeries(['BYBIT_FUTURE_NEW_USDT'], 30 * DAY)]);
    expect(query).toHaveBeenCalledTimes(1);
  });
});
