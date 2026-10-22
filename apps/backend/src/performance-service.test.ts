import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { AccountPerformanceService } from './performance-service.js';
import { registerPerformanceRoutes } from './performance-routes.js';
import { DEFAULT_CREDENTIAL_PROFILE, type CredentialVault } from './credential-vault.js';
import type { GateAccountBookRecord, GateTransferRecord, ReadOnlyCrossExGateway } from './crossex-client.js';
const databases: Database.Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
function fixture() {
  const db = new Database(':memory:'); databases.push(db);
  db.exec(readFileSync(new URL('../../../migrations/0025_account_performance.sql', import.meta.url), 'utf8'));
  let now = Date.parse('2026-09-30T02:00:00Z'), profile = 'account-a', equity = '1000', identity: string | undefined = 'user-a';
  let book: GateAccountBookRecord[] = [], transfers: GateTransferRecord[] = [], pause: Promise<void> | null = null, rateLag = 0, vaultPause: Promise<void> | null = null;
  const vault = { get: async (id: string) => { expect(id).toBe(DEFAULT_CREDENTIAL_PROFILE); if (vaultPause) await vaultPause; return { apiKey: 'synthetic', apiSecret: 'synthetic' }; } } as CredentialVault;
  const gateway = {
    queryAccount: async () => {
      const user = identity; if (pause) await pause;
      return { user_id: user, account_mode: 'CROSS_EXCHANGE', assets: [{ exchange_type: 'CROSSEX', coin: 'USDT', equity, available_balance: equity, liability: '0' }] };
    },
    queryValuationRates: async () => { now += rateLag; return { USDT: '1' }; },
    queryAccountBook: async () => book, queryTransfers: async () => transfers,
  } as unknown as ReadOnlyCrossExGateway;
  const service = new AccountPerformanceService({ database: db, gateway, vault, context: () => profile, profile: () => profile, now: () => now });
  return { service, db, advance: () => { now += 60_000; }, balance: (e: string) => { equity = e; },
    delayValuation: () => { rateLag = 5000; },
    pauseVault: (value: Promise<void>) => { vaultPause = value; },
    identity: (id: string | undefined) => { identity = id; }, profile: (p: string) => { profile = p; },
    pause: (p: Promise<void> | null) => { pause = p; }, deposit: (includeBook = true) => {
      transfers = [{ id: 't1', text: '', from_account_type: 'SPOT', to_account_type: 'CROSSEX', coin: 'USDT', amount: '100', actual_receive: '100', status: 'SUCCESS', fail_reason: null, create_time: now + 30_000, update_time: now + 30_000 }];
      book = includeBook ? [{ id: 'b1', business_id: 'opaque', statement_type: 'TRANSFER_IN', exchange_type: 'CROSSEX', coin: 'USDT', change: '100', balance: '1100', create_time: String(now + 30_000) }] : [];
    } };
}
describe('persistent read-only account performance', () => {
  it('does not block shutdown on an unresponsive credential store', async () => {
    const f = fixture(); f.pauseVault(new Promise<void>(() => undefined));
    const work = f.service.refresh(); await f.service.stop(); await work;
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM performance_samples').get()).toEqual({ n: 0 });
  });
  it('persists baseline and deduplicated flows; deposits are not earnings', async () => {
    const f = fixture(); await f.service.refresh();
    expect((await f.service.read('30d')).cumulativeProfit.value).toBe('0');
    f.deposit(); f.advance(); f.balance('1150'); await f.service.refresh();
    const result = await f.service.read('all');
    expect(result.totalEquity.value).toBe('1150'); expect(result.cumulativeProfit.value).toBe('50');
    expect(Number(result.cumulativeReturn.value)).toBeCloseTo(100 * 50 / 1050);
    expect(result.todayProfit.status).toBe('partial'); expect(result.yesterdayProfit.value).toBeNull();
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM performance_flows').get()).toEqual({ n: 1 });
  });
  it('timestamps the captured balances before a slower public valuation read', async () => {
    const f = fixture(); f.delayValuation(); await f.service.refresh();
    expect((await f.service.read('all')).checkedAt).toBe('2026-09-30T02:00:00.000Z');
  });
  it('does not treat a transfer missing from the ledger as profit', async () => {
    const f = fixture(); await f.service.refresh(); f.deposit(false); f.advance(); f.balance('1100'); await f.service.refresh();
    const result = await f.service.read('all'); expect(result.totalEquity.value).toBe('1100');
    expect(result.cumulativeProfit).toMatchObject({ value: null, reason: 'unreconciled_transfer' });
  });
  it('discards in-flight old-account reads and requires verified account identity', async () => {
    const f = fixture(); let release!: () => void;
    f.pause(new Promise<void>((resolve) => { release = resolve; }));
    const pending = f.service.refresh(); await Promise.resolve();
    f.profile('account-b'); release(); await pending;
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM performance_samples').get()).toEqual({ n: 0 });
    f.pause(null); f.identity(undefined); expect((await f.service.read('all')).totalEquity.value).toBeNull();
    f.identity('user-b'); await f.service.refresh(); expect((await f.service.read('all')).profileId).toBe('account-b');
  });
  it('requires read intent and rejects arbitrary account selection in the API', async () => {
    const f = fixture(), app = Fastify(); registerPerformanceRoutes(app, f.service);
    try {
      expect((await app.inject('/api/crossex/performance')).statusCode).toBe(403);
      expect((await app.inject({ url: '/api/crossex/performance?profileId=other', headers: { 'x-gct-read-intent': 'account-performance' } })).statusCode).toBe(400);
      const r = await app.inject({ url: '/api/crossex/performance?range=7d', headers: { 'x-gct-read-intent': 'account-performance' } });
      expect(r.statusCode).toBe(200); expect(r.json().profileId).toBe('account-a');
    } finally { await app.close(); await f.service.stop(); }
  });
});
