import { afterEach, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import type Database from 'better-sqlite3';
import Fastify from 'fastify';
import { openDatabase } from './database.js';
import { TransactionFeeService } from './transaction-fee-service.js';
import { registerTransactionFeeRoutes } from './transaction-fee-routes.js';
import { DEFAULT_CREDENTIAL_PROFILE, type CredentialVault } from './credential-vault.js';
import type { GateAccountBookRecord, GateCrossExTrade, ReadOnlyCrossExGateway } from './crossex-client.js';
const databases: Database.Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
function fixture() {
  const db = openDatabase(':memory:', fileURLToPath(new URL('../../../migrations/', import.meta.url))); databases.push(db);
  let now = Date.parse('2026-10-01T00:00:00Z'), profile = 'a', book: GateAccountBookRecord[] = [], trades: GateCrossExTrade[] = [];
  let tradeFailure = false, bookHidden = false, wait: Promise<void> | null = null;
  const queries: number[] = [];
  const vault = { get: async (id: string) => { expect(id).toBe(DEFAULT_CREDENTIAL_PROFILE); return { apiKey: 'synthetic', apiSecret: 'synthetic' }; } } as CredentialVault;
  const gateway = { queryAccount: async () => { const user_id = profile; if (wait) await wait; return { user_id }; },
    queryAccountBook: async (_c: unknown, q: { from: number; to: number }) => bookHidden ? [] : book.filter((b) => Number(b.create_time) >= q.from && Number(b.create_time) <= q.to),
    queryFeeTrades: async (_c: unknown, q: { from: number; to: number }) => { queries.push(q.from); if (tradeFailure) throw new Error('fee_trades_unavailable'); return trades.filter((t) => Number(t.create_time) >= q.from && Number(t.create_time) <= q.to); },
  } as unknown as ReadOnlyCrossExGateway;
  const service = new TransactionFeeService({ database: db, gateway, vault, context: () => profile, profile: () => profile, now: () => now });
  return { db, service, queries, time: () => now, advance: (ms = 60000) => { now += ms; }, change: () => { profile = 'b'; book = []; trades = []; }, wait: (p: Promise<void> | null) => { wait = p; },
    hideBook: (hidden: boolean) => { bookHidden = hidden; }, failTrades: (fail: boolean) => { tradeFailure = fail; }, records: () => {
      book = [{ id: 'bill', business_id: 'order', statement_type: 'TRADING_FEE', exchange_type: 'BYBIT', coin: 'USDT', change: '-2', balance: '100', create_time: String(now + 1000) }];
      trades = [{ transaction_id: 'fill', order_id: 'order', text: 'client', symbol: 'BYBIT_FUTURE_BTC_USDT', exchange_type: 'BYBIT', business_type: 'FUTURE', side: 'BUY', qty: '1', price: '100', fee: '2', fee_coin: 'USDT', fee_rate: '0.001', match_role: 'TAKER', rpnl: '0', position_mode: 'SINGLE', position_side: 'LONG', create_time: String(now + 1000) }];
    } };
}
describe('read-only transaction fee collection', () => {
  it('recovers a late task bill outside the normal tail without rewinding fresh coverage', async () => {
    const f = fixture(), start = f.time(), created = new Date(start).toISOString();
    f.db.prepare(`INSERT INTO execution_strategies (id,kind,environment,status,config_json,created_at,updated_at,credential_profile_id)
      VALUES ('PAIR-LATE','position','live','RUNNING','{}',?,?,'a')`).run(created, created);
    f.db.prepare(`INSERT INTO execution_orders (id,remote_order_id,client_order_id,environment,symbol,venue,side,order_type,time_in_force,quantity,state,executed_quantity,strategy_id,fee_phase,created_at,updated_at)
      VALUES ('local','order','client','live','BYBIT_FUTURE_BTC_USDT','BYBIT','BUY','MARKET','IOC','1','FILLED','1','PAIR-LATE','entry',?,?)`).run(created, created);
    await f.service.refresh(); f.records(); f.hideBook(true); f.advance(); await f.service.refresh();
    expect((await f.service.summary()).tasks[0].metric.status).toBe('unavailable');
    f.advance(); await f.service.refresh(); f.advance(); await f.service.refresh();
    f.hideBook(false); f.advance(); await f.service.refresh();
    const summary = await f.service.summary();
    expect(summary.tasks[0].metric).toMatchObject({ amount: '2', status: 'ready', pending: 0 });
    expect(summary.checkedAt).toBe(f.time()); await f.service.stop();
  });
  it('collects account fees without requiring task attribution and preserves separate fill coverage', async () => {
    const f = fixture(), start = f.time(); await f.service.refresh(); f.records(); f.failTrades(true); f.advance(); await f.service.refresh();
    expect((await f.service.summary()).total.amount).toBe('2');
    f.advance(180000); f.failTrades(false); await f.service.refresh();
    expect(f.queries.at(-1)).toBe(start); expect(f.db.prepare('SELECT COUNT(*) AS n FROM fee_trades').get()).toEqual({ n: 1 });
    expect((await f.service.summary()).unassigned.amount).toBe('2'); await f.service.stop();
  });
  it('drops delayed old-account observations and stops an unresponsive reader', async () => {
    const f = fixture(); let release!: () => void;
    f.wait(new Promise<void>((resolve) => { release = resolve; })); const pending = f.service.refresh(); await Promise.resolve(); f.change(); release(); await pending;
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM fee_book').get()).toEqual({ n: 0 });
    f.wait(new Promise<void>(() => undefined)); const stuck = f.service.refresh(); await f.service.stop(); await stuck;
  });
  it('rejects writes, arbitrary account selectors and out-of-scope task details', async () => {
    const f = fixture(), app = Fastify(); registerTransactionFeeRoutes(app, f.service);
    try {
      expect((await app.inject('/api/crossex/transaction-fees')).statusCode).toBe(403);
      const headers = { 'x-gct-read-intent': 'transaction-fees' };
      expect((await app.inject({ url: '/api/crossex/transaction-fees?profileId=other', headers })).statusCode).toBe(400);
      expect((await app.inject({ url: '/api/crossex/transaction-fees/details?taskId=foreign', headers })).statusCode).toBe(404);
      expect((await app.inject({ url: '/api/crossex/transaction-fees/details?page=-1', headers })).statusCode).toBe(400);
      expect((await app.inject({ url: '/api/crossex/transaction-fees', method: 'POST', headers })).statusCode).toBe(404);
      const result = await app.inject({ url: '/api/crossex/transaction-fees', headers }); expect(result.statusCode).toBe(200); expect(result.json().profileId).toBe('a');
    } finally { await app.close(); await f.service.stop(); }
  });
});
