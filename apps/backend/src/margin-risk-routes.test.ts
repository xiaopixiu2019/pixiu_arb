import { afterEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { resolve } from 'node:path';
import { openDatabase } from './database.js';
import { MarginRiskStore } from './margin-risk-store.js';
import { MarginRiskMonitor } from './margin-risk-monitor.js';
import { registerMarginRiskRoutes } from './margin-risk-routes.js';
const resources: Array<{ app: FastifyInstance; db: ReturnType<typeof openDatabase>; monitor: MarginRiskMonitor }> = [];
afterEach(async () => { for (const r of resources.splice(0)) { await r.app.close(); await r.monitor.stop(); r.db.close(); } });
describe('risk configuration API', () => {
  it('requires explicit intent, one-use CSRF and the same account before changing risk policy', async () => {
    const db = openDatabase(':memory:', resolve('../../migrations')), app = Fastify();
    const monitor = new MarginRiskMonitor(new MarginRiskStore(db), { context: () => 'account', live: () => false, groups: () => [], uncovered: () => [],
      account: async () => ({ profileId: 'profile', userId: 'fake', label: 'Test', account: { available_margin: '100', margin_balance: '200', initial_margin: '100', maintenance_margin: '10',
        initial_margin_rate: '2', maintenance_margin_rate: '20', assets: [], account_mode: 'CROSS_EXCHANGE', exchange_type: 'CROSSEX', position_mode: 'SINGLE', update_time: String(Date.now()) } }) });
    registerMarginRiskRoutes(app, monitor); resources.push({ app, db, monitor }); await monitor.refresh();
    const config = (await app.inject('/api/risk/margin/policy')).json();
    const payload = { ...config, policy: { ...config.policy, initial: { warn: 111, reduce: 105, recover: 115 } } };
    expect((await app.inject({ method: 'PUT', url: '/api/risk/margin/policy', payload })).statusCode).toBe(403);
    expect((await app.inject({ method: 'PUT', url: '/api/risk/margin/policy', headers: { 'x-gct-risk-intent': 'configure-margin' }, payload })).statusCode).toBe(200);
    expect((await app.inject({ method: 'PUT', url: '/api/risk/margin/policy', headers: { 'x-gct-risk-intent': 'configure-margin' }, payload })).statusCode).toBe(403);
    const next = (await app.inject('/api/risk/margin/policy')).json();
    expect((await app.inject({ method: 'PUT', url: '/api/risk/margin/policy', headers: { 'x-gct-risk-intent': 'configure-margin' }, payload: { ...next, accountId: 'other' } })).statusCode).toBe(409);
    expect(monitor.snapshot().policy.initial.warn).toBe(111);
  });
});
