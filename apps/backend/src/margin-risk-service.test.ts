import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolve } from 'node:path';
import { openDatabase } from './database.js';
import { TradingRuntime } from './trading-runtime.js';
import { TradingSession } from './trading-session.js';
import { MemoryCredentialVault, DEFAULT_CREDENTIAL_PROFILE } from './credential-vault.js';
import { GateApiError, type GateCrossExAccount, type GateCrossExPosition, type TradingCrossExGateway } from './crossex-client.js';
import { createMarginRiskService } from './margin-risk-service.js';
import type { ManagedPositionManager } from './managed-position-manager.js';
import type { StrategyEngine } from './strategy-engine.js';
import type { LiveMarket } from './market-hub.js';
import type { MarginRiskMonitor } from './margin-risk-monitor.js';
import { initialManagedState } from './managed-position-store.js';
import { MarginReductionEvidence } from './margin-reduction-evidence.js';
const resources: Array<{ db: ReturnType<typeof openDatabase>; monitor: MarginRiskMonitor }> = [];
afterEach(async () => { for (const r of resources.splice(0)) { await r.monitor.stop(); r.db.close(); } });
async function harness() {
  const db = openDatabase(':memory:', resolve('../../migrations')), session = new TradingSession(); session.set('live');
  const vault = new MemoryCredentialVault(); await vault.set(DEFAULT_CREDENTIAL_PROFILE, { apiKey: 'fake', apiSecret: 'fake' });
  let reject = false, split = false;
  const venueAccounts: Record<string, Partial<GateCrossExAccount>> = {};
  const base: GateCrossExAccount = { user_id: 'synthetic', available_margin: '20', margin_balance: '120', initial_margin: '100', maintenance_margin: '10',
    initial_margin_rate: '1.2', maintenance_margin_rate: '12', assets: [], account_mode: 'CROSS_EXCHANGE', exchange_type: 'CROSSEX', position_mode: 'SINGLE', update_time: String(Date.now()) };
  let submitted = 0;
  const createOrder = vi.fn(async () => { submitted += 1; if (reject) throw new GateApiError(400, 'INVALID_PARAM_VALUE'); return { order_id: `order-${submitted}` }; });
  const gateway = { queryAccount: async (_: unknown, venue?: string) => {
    if (split && !venue) throw new GateApiError(400, 'INVALID_PARAM_VALUE');
    return split ? { ...base, ...venueAccounts[venue!], account_mode: 'ISOLATED_EXCHANGE', exchange_type: venue! } : base;
  }, queryPositions: async () => [], queryManagedState: async () => ({ positions: [], openOrders: [] }),
  querySymbols: async () => [{ symbol: 'GATE_FUTURE_BTC_USDT', support_cross: 'true' }], queryPositionMarginMode: async () => 'CROSS',
  queryLeverages: async (_: unknown, symbols: string[]) => Object.fromEntries(symbols.map((s) => [s, '10'])),
  queryRiskLimits: async (symbols: string[]) => symbols.map((symbol) => ({ symbol, tiers: [{ maintenance_rate: '0.01' }] })),
  createOrder } as unknown as TradingCrossExGateway;
  const runtime = new TradingRuntime(db, session, vault, gateway);
  const monitor = createMarginRiskService({ db, gateway, runtime, manager: { setMarginMonitor: vi.fn(), setMarginFacts: vi.fn(), failAll: vi.fn() } as unknown as ManagedPositionManager,
    engine: { haltForMarginRisk: vi.fn() } as unknown as StrategyEngine, enforce: true, context: () => 'account:1',
    profile: () => ({ id: 'account', label: 'Synthetic' }), live: () => true, credentials: () => vault.get(DEFAULT_CREDENTIAL_PROFILE),
    markets: { market: (symbol) => ({ symbol, source: 'gate_crossex_websocket', bidPrice: '10', askPrice: '10', updatedAt: new Date().toISOString(), receivedAt: new Date().toISOString() } as LiveMarket) } });
  resources.push({ db, monitor });
  return { db, gateway, monitor, runtime, createOrder, base, reject: (value: boolean) => { reject = value; }, split: () => { split = true; },
    venueAccount: (venue: string, values: Partial<GateCrossExAccount>) => { venueAccounts[venue] = values; } };
}
const order = { symbol: 'GATE_FUTURE_BTC_USDT', side: 'BUY', type: 'MARKET', quantity: '5', price: '10' };
describe('account admission at the real order boundary', () => {
  it.each(['one', 'all'])('keeps %s transient isolated-unit failures in read recovery instead of identity failure', async scope => {
    const h = await harness(); h.split(); await h.monitor.refresh();
    const query = h.gateway.queryAccount.bind(h.gateway);
    h.gateway.queryAccount = async (...args) => {
      if (args[1] && (scope === 'all' || args[1] === 'BYBIT')) throw new GateApiError(503, 'SERVICE_UNAVAILABLE');
      return query(...args);
    };
    await h.monitor.refresh(); expect(h.monitor.snapshot().fresh).toBe(false); expect(h.monitor.readFailureRequiresReview()).toBe(false);
    h.gateway.queryAccount = query; await h.monitor.refresh(); expect(h.monitor.snapshot().fresh).toBe(true);
  });
  it.each([null, '20'])('previews a legal bounded group with reported market cap %s', async maximum => {
    const h = await harness(), now = new Date().toISOString();
    const symbols = ['GATE_FUTURE_PONS_USDT', 'HYPERLIQUID_FUTURE_PONS_USDC'];
    const config = { kind: 'position', asset: 'PONS', leftVenue: 'GATE', rightVenue: 'HYPERLIQUID',
      leftSide: 'SELL', rightSide: 'BUY', entryBps: '10', totalAmount: '1800', perOrderQuantity: '900',
      executionMethod: 'MAKER_TAKER', makerLeg: 'left', management: { perOrderQuantity: '900' } };
    h.db.prepare(`INSERT INTO execution_strategies (id,kind,environment,status,config_json,credential_profile_id,created_at,updated_at)
      VALUES ('test-group','position','live','RUNNING',?,'account',?,?)`).run(JSON.stringify(config), now, now);
    h.db.prepare('INSERT INTO managed_positions VALUES (?,?,?,?)').run('test-group', 'account',
      JSON.stringify({ ...initialManagedState(), groupId: 'test-group', phase: 'MONITORING', verified: true,
        leftQuantity: '1800', rightQuantity: '1800', maxLeft: '1800', maxRight: '1800' }), now);
    symbols.forEach((symbol, i) => h.db.prepare(`INSERT INTO crossex_instruments
      (symbol,exchange_type,business_type,state,lot_size,min_size,min_notional,tick_size,max_num_orders,max_market_size,default_leverage,delist_time,fetched_at)
      VALUES (?,?,'FUTURE','live',?,?,?,'0.0001','100',?,'3','0',?)`)
      .run(symbol, i === 0 ? 'GATE' : 'HYPERLIQUID', i === 0 ? '10' : '1', i === 0 ? '10' : '1', i === 0 ? null : '10', i === 0 ? '10000000' : maximum, now));
    let observedQuantity = '1800';
    h.gateway.queryManagedState = async () => ({ positions: symbols.map((symbol, i) => ({ symbol,
      position_side: i === 0 ? 'SHORT' : 'LONG', position_qty: observedQuantity, margin_mode: 'CROSS' })) as GateCrossExPosition[], openOrders: [] });
    const inspect = vi.spyOn(MarginReductionEvidence.prototype, 'inspectGroup').mockReturnValue({ ok: true, evidence: {
      initial: '100', maintenance: '10', initialRelease: '1', maintenanceRelease: '0.1', cost: '0.01', cap: '36', apr: '0',
      firstLeg: 0, checkedAt: Date.now(), initialReleaseByLeg: ['0.5', '0.5'], maintenanceReleaseByLeg: ['0.05', '0.05'],
    } });
    try {
      await h.monitor.refresh();
      expect(h.monitor.snapshot().groups[0].readiness).toMatchObject({ status: 'ready', reason: null, maxBatchQuantity: maximum ?? '900' });
      expect(inspect.mock.calls[0][3]).toBe(maximum ?? '900');
      expect(h.createOrder).not.toHaveBeenCalled();
      expect(h.monitor.sources.reviewReady?.()).toBe(true);
      observedQuantity = '1700'; await h.monitor.refresh();
      expect(h.monitor.sources.reviewReady?.()).toBe(false); // Balanced external reductions are not verified owned fills.
      observedQuantity = '1800'; await h.monitor.refresh();
      expect(h.monitor.sources.reviewReady?.()).toBe(true);
    } finally { inspect.mockRestore(); }
  });
  it('admits adequately funded new exposure with debt and keeps reduce-only separate', async () => {
    const h = await harness();
    h.base.assets = [{ coin: 'USDT', exchange_type: 'CROSSEX', balance: '1', available_balance: '1', upnl: '-2', equity: '-1', liability: '1',
      futures_initial_margin: '100', futures_maintenance_margin: '10', borrowing_initial_margin: '0.2', borrowing_maintenance_margin: '0.1' }];
    await expect(h.runtime.createOrder(order)).resolves.toMatchObject({ state: 'NEW' });
    expect(h.createOrder).toHaveBeenCalledTimes(1);
    await h.runtime.createOrder({ ...order, side: 'SELL', reduceOnly: true }); expect(h.createOrder).toHaveBeenCalledTimes(2);
  });
  it('reserves concurrent submissions against stale exchange accounting and still permits reduce-only', async () => {
    const h = await harness();
    const outcomes = await Promise.allSettled([h.runtime.createOrder(order), h.runtime.createOrder(order)]);
    expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
    expect(h.createOrder).toHaveBeenCalledTimes(1);
    await h.runtime.createOrder({ ...order, side: 'SELL', reduceOnly: true }); expect(h.createOrder).toHaveBeenCalledTimes(2);
  });
  it('releases a reservation only for a confirmed rejection and does not consume capacity forever', async () => {
    const h = await harness(); h.reject(true);
    await expect(h.runtime.createOrder(order)).rejects.toBeInstanceOf(GateApiError);
    h.reject(false); await expect(h.runtime.createOrder(order)).resolves.toMatchObject({ state: 'NEW' });
    expect(h.createOrder).toHaveBeenCalledTimes(2);
  });
  it('blocks above-warning accounts when the proposed order would exhaust the buffer', async () => {
    const h = await harness();
    await expect(h.runtime.createOrder({ ...order, quantity: '10' })).rejects.toMatchObject({ code: 'margin_projected_below_warning' });
    expect(h.createOrder).not.toHaveBeenCalled();
  });
  it('queries split-exchange units separately without adding their ratios', async () => {
    const h = await harness(); h.split(); await h.monitor.refresh();
    expect(h.monitor.snapshot().units).toHaveLength(7);
    expect(h.monitor.snapshot().units?.map(unit => unit.exchangeType)).not.toContain('LIGHTER'); // The authenticated client rejects this unsupported exchange type.
    expect(h.monitor.snapshot().metrics?.initialPct).toBe('120');
  });
  it('preserves independent venue capability checks even when another venue has debt', async () => {
    const h = await harness(); h.split();
    h.venueAccount('BINANCE', { assets: [{ coin: 'USDT', exchange_type: 'BINANCE', balance: '1', available_balance: '1', upnl: '-2', equity: '-1', liability: '1',
      futures_initial_margin: '100', futures_maintenance_margin: '10', borrowing_initial_margin: '0.2', borrowing_maintenance_margin: '0.1' }] });
    await expect(h.runtime.createOrder({ ...order, symbol: 'BINANCE_FUTURE_BTC_USDT' })).rejects.toMatchObject({ code: 'cross_margin_capability_unknown' });
    expect(h.createOrder).not.toHaveBeenCalled();
    await expect(h.runtime.createOrder(order)).resolves.toMatchObject({ state: 'NEW' });
    expect(h.createOrder).toHaveBeenCalledTimes(1);
  });
  it('does not use a larger venue balance to admit an order on a small venue', async () => {
    const h = await harness(); h.split();
    h.venueAccount('GATE', { margin_balance: '2', initial_margin: '1', maintenance_margin: '0.1', available_margin: '1', initial_margin_rate: '2', maintenance_margin_rate: '20' });
    await h.monitor.refresh(); expect(h.monitor.snapshot().metrics?.marginBalance).toBe('120');
    await expect(h.runtime.createOrder({ ...order, quantity: '1' })).rejects.toMatchObject({ code: 'margin_projected_below_warning' });
    expect(h.createOrder).not.toHaveBeenCalled();
    expect(() => h.monitor.assertEntry('1', '0', 'UNVERIFIED')).toThrow('margin_unit_estimate_unavailable');
  });
});
