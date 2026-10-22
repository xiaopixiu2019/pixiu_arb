import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMarginRiskService } from './margin-risk-service.js';
import { afterAll } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type Database from 'better-sqlite3';
import { loadConfig } from './config.js';
import { openDatabase } from './database.js';
import { DEFAULT_CREDENTIAL_PROFILE, MemoryCredentialVault, type GateCredentials } from './credential-vault.js';
import { GateApiError, GateCrossExClient, type CrossExOrderRequest, type GateCrossExAccount, type GateCrossExOrder, type GateCrossExPosition, type GateCrossExPortfolio, type GateCrossExRiskLimit, type GateCrossExSymbol, type GateFeeRate, type GateOrderActionResponse, type TradingCrossExGateway } from './crossex-client.js';
import type { LiveMarket } from './market-hub.js';
import { StrategyEngine, type MarketSource, type StrategyEngineOptions } from './strategy-engine.js';
import { ManagedPositionManager } from './managed-position-manager.js';
import { waitForStrategyQuotes } from './strategy-quote-readiness.js';
import { TradingRuntime, isTerminalOrderState } from './trading-runtime.js';
import { TradingSession } from './trading-session.js';
import { MarginRiskMonitor } from './margin-risk-monitor.js';
import { MarginRiskStore } from './margin-risk-store.js';
import { RequestNotDispatchedError } from './authenticated-scheduler.js';
import { PairedEntryPool } from './paired-entry-pool.js';
import { Decimal } from 'decimal.js';
import { seedPairedPerformanceHistory, PAIRED_PERFORMANCE_SCALE } from './test-support/paired-performance.js';
import { MarginReductionEvidence } from './margin-reduction-evidence.js';

const pairedLatencySamples: number[] = [];
let pairedAdmissionQueryCount = 0;
let pairedPoolProofSamples = 0;
let pairedPositionAheadSamples = 0;
const pairedBenchmark = process.env.GCT_BENCH_PAIRED === '1';
afterAll(() => {
  if (!pairedBenchmark) return;
  const values = [...pairedLatencySamples].sort((a, b) => a - b);
  const report = { synthetic: true, scope: 'confirmed fill through engine, managed controller, admission and real CrossEx client to injected fetch; held REST and shared 100ms pacing',
    samples: values.length, p95Ms: values[Math.ceil(values.length * 0.95) - 1], p99Ms: values[Math.ceil(values.length * 0.99) - 1],
    maximumMs: values.at(-1), extraAdmissionHttp: pairedAdmissionQueryCount, poolProofSamples: pairedPoolProofSamples,
    positionAheadSamples: pairedPositionAheadSamples, scale: PAIRED_PERFORMANCE_SCALE };
  const output = resolve(process.env.GCT_BENCH_REPORT ?? '../../data/benchmarks/paired-execution-latency.json');
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, JSON.stringify(report, null, 2));
  expect(report.samples).toBe(100); expect(report.extraAdmissionHttp).toBe(0);
  expect(report.poolProofSamples).toBe(100);
  expect(report.positionAheadSamples).toBe(50);
  expect(report.p95Ms).toBeLessThanOrEqual(200); expect(report.p99Ms).toBeLessThanOrEqual(500);
});

class ScriptedGateway implements TradingCrossExGateway {
  readonly createdOrders: Array<CrossExOrderRequest & { remoteId: string }> = [];
  readonly createAttempts: CrossExOrderRequest[] = [];
  readonly cancelledOrders: string[] = [];
  readonly leverageUpdates: Array<{ symbol: string; leverage: string }> = [];
  readonly leverageQueries: string[][] = [];
  readonly accountQueries: Array<string | null> = [];
  positions: GateCrossExPortfolio['positions'] = [];
  leverages: Record<string, string> = {};
  riskLimits: Record<string, GateCrossExRiskLimit['tiers']> = {};
  availableMargin = '1000000';
  accountAssets: GateCrossExAccount['assets'] = [];
  accountMode: 'CROSS_EXCHANGE' | 'ISOLATED_EXCHANGE' = 'CROSS_EXCHANGE';
  isolatedAvailableMargins: Record<string, string> = {};
  holdCancellations = false;
  private readonly failCreateBudget = new Map<string, number>();
  private readonly remoteStates = new Map<string, string>();
  private sequence = 0;

  failCreate(symbol: string, times: number): void {
    this.failCreateBudget.set(symbol, (this.failCreateBudget.get(symbol) ?? 0) + times);
  }

  async queryAccount(_credentials: GateCredentials, exchangeType?: string): Promise<GateCrossExAccount> {
    this.accountQueries.push(exchangeType ?? null);
    if (this.accountMode === 'ISOLATED_EXCHANGE' && exchangeType === undefined) {
      throw new GateApiError(400, 'MISSING_REQUIRED_PARAM');
    }
    const normalizedExchange = exchangeType?.toUpperCase() ?? 'CROSSEX';
    const availableMargin = this.accountMode === 'ISOLATED_EXCHANGE'
      ? this.isolatedAvailableMargins[normalizedExchange] ?? '0'
      : this.availableMargin;
    return {
      available_margin: availableMargin, margin_balance: availableMargin, initial_margin: '0',
      maintenance_margin: '0', initial_margin_rate: '0', maintenance_margin_rate: '0',
      position_mode: 'SINGLE', account_mode: this.accountMode, exchange_type: normalizedExchange,
      update_time: String(Date.now()), assets: this.accountAssets,
    };
  }
  async queryPositions(): Promise<GateCrossExPortfolio['positions']> { return this.positions; }
  async queryPortfolio(): Promise<GateCrossExPortfolio> { throw new GateApiError(0, 'NOT_SCRIPTED'); }
  async querySymbols(): Promise<GateCrossExSymbol[]> { return []; }
  async queryRiskLimits(symbols: string[]): Promise<GateCrossExRiskLimit[]> {
    return symbols.map((symbol) => ({
      symbol,
      tiers: this.riskLimits[symbol] ?? [{
        tier: '1', min_risk_limit_value: '0', max_risk_limit_value: '1000000000',
        quick_cal_amount: '0', leverage_max: '200', maintenance_rate: '0.001',
      }],
    }));
  }
  async queryLeverages(_credentials: GateCredentials, symbols: string[]): Promise<Record<string, string>> {
    this.leverageQueries.push([...symbols]);
    return Object.fromEntries(symbols.flatMap((symbol) => (
      this.leverages[symbol] === undefined ? [] : [[symbol, this.leverages[symbol]]]
    )));
  }
  async setLeverage(_credentials: GateCredentials, symbol: string, leverage: string): Promise<{ symbol: string; leverage: string }> {
    this.leverageUpdates.push({ symbol, leverage });
    this.leverages[symbol] = leverage;
    return { symbol, leverage };
  }
  async queryFeeRates(): Promise<GateFeeRate[]> { return []; }
  async queryOrder(_credentials: GateCredentials, orderId: string): Promise<GateCrossExOrder> {
    const created = this.createdOrders.find((order) => order.remoteId === orderId);
    if (!created) throw new GateApiError(404, 'ORDER_NOT_FOUND');
    const state = this.remoteStates.get(orderId) ?? 'OPEN';
    return {
      order_id: orderId,
      text: created.text ?? '',
      symbol: created.symbol,
      side: created.side,
      type: created.type,
      attribute: created.time_in_force === 'POC' ? 'POST_ONLY' : 'NORMAL',
      exchange_type: created.symbol.split('_')[0] ?? 'GATE',
      business_type: 'FUTURE',
      qty: created.qty ?? '0',
      quote_qty: '0',
      price: created.price ?? '0',
      time_in_force: created.time_in_force,
      state,
      executed_qty: '0',
      executed_amount: '0',
      executed_avg_price: '0',
      fee_coin: 'USDT',
      fee: '0',
      reduce_only: String(created.reduce_only),
      leverage: '0',
      reason: '',
      last_executed_qty: '0',
      last_executed_price: '0',
      last_executed_amount: '0',
      position_side: 'NONE',
      create_time: String(Date.now()),
      update_time: String(Date.now()),
    };
  }

  async createOrder(_credentials: GateCredentials, order: CrossExOrderRequest, beforeDispatch?: () => void): Promise<GateOrderActionResponse> {
    try { beforeDispatch?.(); } catch (error) { throw new RequestNotDispatchedError(error instanceof Error ? error.message : 'guard_changed'); }
    this.createAttempts.push({ ...order });
    const budget = order.symbol ? this.failCreateBudget.get(order.symbol) ?? 0 : 0;
    if (order.symbol && budget > 0) {
      this.failCreateBudget.set(order.symbol, budget - 1);
      throw new GateApiError(400, 'TRADE_INSUFFICIENT_AVAILABLE_MARGIN_ERROR');
    }
    this.sequence += 1;
    const remoteId = `remote-${this.sequence}`;
    this.createdOrders.push({ ...order, remoteId });
    this.remoteStates.set(remoteId, 'OPEN');
    return { order_id: remoteId, text: order.text ?? '' };
  }

  async cancelOrder(_credentials: GateCredentials, orderId: string): Promise<GateOrderActionResponse> {
    this.cancelledOrders.push(orderId);
    if (!this.holdCancellations) this.remoteStates.set(orderId, 'CANCELLED');
    return { order_id: orderId, text: '' };
  }
}

function futuresPosition(
  symbol: string,
  side: 'LONG' | 'SHORT',
  quantity: string,
): GateCrossExPortfolio['positions'][number] {
  return {
    position_id: `position-${symbol}`,
    symbol,
    position_side: side,
    initial_margin: '0',
    maintenance_margin: '0',
    position_qty: quantity,
    position_value: '0',
    upnl: '0',
    upnl_rate: '0',
    entry_price: '0',
    mark_price: '0',
    leverage: '5',
    max_leverage: '20',
    risk_limit: '0',
    fee: '0',
    funding_fee: '0',
    funding_time: '0',
    create_time: '0',
    update_time: '0',
    closed_pnl: '0',
  };
}

class StubMarkets implements MarketSource {
  prepareQuotes?: (symbols: string[]) => Promise<void>;
  private readonly markets = new Map<string, LiveMarket>();
  private state: ReturnType<NonNullable<MarketSource['connectionState']>> = 'healthy';

  constructor(private readonly database: Database.Database) {}

  set(
    symbol: string,
    bid: string,
    ask: string,
    updatedAt = new Date().toISOString(),
    receivedAt = updatedAt,
  ): void {
    const [venue = 'GATE', , asset = 'BTC'] = symbol.split('_');
    this.markets.set(symbol, {
      symbol, venue: venue as LiveMarket['venue'], asset, lastPrice: bid, bidPrice: bid, bidSize: '10',
      askPrice: ask, askSize: '10', open24h: bid, high24h: ask, low24h: bid, volume24h: '100',
      quoteVolume24h: '100000', fundingRate: '0.0001', nextFundingAt: new Date(Date.now() + 3_600_000).toISOString(),
      openInterest: '1000', openInterestValue: '1000000', receivedAt, updatedAt,
      source: 'gate_crossex_websocket',
    });
    this.database.prepare(`INSERT OR IGNORE INTO crossex_instruments (
      symbol, exchange_type, business_type, state, min_size, min_notional, lot_size,
      tick_size, max_num_orders, max_market_size, max_limit_size, contract_size,
      liquidation_fee, default_leverage, delist_time, fetched_at
    ) VALUES (?, ?, 'FUTURE', 'live', '0.00000001', NULL, '0.00000001', '0.01', '100', NULL, NULL, NULL, NULL, '1', '0', ?)`)
      .run(symbol, venue, new Date().toISOString());
  }

  market(symbol: string): LiveMarket | null { return this.markets.get(symbol) ?? null; }
  connectionState(): ReturnType<NonNullable<MarketSource['connectionState']>> { return this.state; }
  setConnectionState(state: ReturnType<NonNullable<MarketSource['connectionState']>>): void { this.state = state; }
}

interface Harness {
  session: TradingSession;
  manager?: ManagedPositionManager;
  database: Database.Database;
  runtime: TradingRuntime;
  engine: StrategyEngine;
  gateway: ScriptedGateway;
  vault: MemoryCredentialVault;
  markets: StubMarkets;
  directory: string;
}

const harnesses: Harness[] = [];

async function createHarness(engineOptions: StrategyEngineOptions = {}): Promise<Harness> {
  const directory = mkdtempSync(join(tmpdir(), 'gate-crossex-engine-'));
  const config = loadConfig({
    GCT_DATA_DIR: directory,
    GCT_MIGRATIONS_DIR: resolve(process.cwd(), '../../migrations'),
  });
  const session = new TradingSession();
  session.set('live');
  const database = openDatabase(config.databasePath, config.migrationsDir);
  const vault = new MemoryCredentialVault();
  await vault.set(DEFAULT_CREDENTIAL_PROFILE, { apiKey: 'engine-key', apiSecret: 'engine-secret' });
  const gateway = new ScriptedGateway();
  const runtime = new TradingRuntime(database, session, vault, gateway);
  const markets = new StubMarkets(database);
  const engine = new StrategyEngine(database, session, runtime, markets, {
    tickIntervalMs: 20, orderTimeoutMs: 400, requoteIntervalMs: 10, repairCooldownMs: 0,
    ...engineOptions,
  });
  const harness = { database, runtime, engine, gateway, vault, markets, directory, session };
  harnesses.push(harness);
  return harness;
}

async function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('condition not reached in time');
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
  }
}

function ackOrder(
  runtime: TradingRuntime,
  remoteId: string,
  state: string,
  executedQty: string,
  avgPrice: string,
  reason?: string,
): void {
  runtime.ingestPrivateEvent({ channel: 'order', payload: {
    order_id: remoteId, state, executed_qty: executedQty, executed_avg_price: avgPrice,
    ...(reason ? { reason } : {}), update_time: String(Date.now()),
  } });
}

function ingestFill(runtime: TradingRuntime, remoteId: string, symbol: string, side: 'BUY' | 'SELL', qty: string, price: string, realizedPnl = '0'): void {
  runtime.ingestPrivateEvent({ channel: 'usertrades', payload: {
    transaction_id: `txn-${remoteId}-${qty}-${Math.random().toString(36).slice(2, 8)}`, order_id: remoteId,
    symbol, exchange_type: symbol.split('_')[0] ?? 'GATE', side, qty, price, fee: '0.01', rpnl: realizedPnl,
    match_role: 'TAKER', create_time: String(Date.now()),
  } });
}

function seedFilledStrategyOrder(
  database: Database.Database,
  strategyId: string,
  id: string,
  symbol: string,
  side: 'BUY' | 'SELL',
  quantity: string,
  leg: 'left' | 'right',
): void {
  const now = new Date().toISOString();
  database.prepare(`INSERT INTO execution_orders (
    id, client_order_id, environment, symbol, venue, side, order_type, time_in_force,
    quantity, price, reduce_only, state, executed_quantity, executed_average_price,
    created_at, updated_at, strategy_id, strategy_leg
  ) VALUES (?, ?, 'live', ?, ?, ?, 'MARKET', 'IOC', ?, NULL, 0, 'FILLED', ?, '54', ?, ?, ?, ?)`)
    .run(id, `${id}-client`, symbol, symbol.split('_')[0], side, quantity, quantity, now, now, strategyId, leg);
}

afterEach(async () => {
  for (const harness of harnesses.splice(0)) {
    await harness.manager?.stop();
    await harness.engine.stop();
    harness.database.close();
    rmSync(harness.directory, { recursive: true, force: true });
  }
});

const takerTakerConfig = {
  kind: 'position', asset: 'BTC', leftVenue: 'BINANCE', rightVenue: 'OKX', leftSide: 'SELL', rightSide: 'BUY',
  entryBps: '10', totalAmount: '0.2', perOrderQuantity: '0.1', reduceOnly: false, executionMethod: 'TAKER_TAKER',
} as const;

async function managedCroHarness() {
  const h = await createHarness();
  const symbols = ['KRAKEN_FUTURE_CRO_USD', 'GATE_FUTURE_CRO_USDT'];
  h.markets.set(symbols[0], '0', '0'); h.markets.set(symbols[1], '0.0624', '0.0625');
  h.database.prepare("UPDATE crossex_instruments SET min_size='10', lot_size='10', min_notional='1' WHERE symbol=?").run(symbols[0]);
  h.manager = new ManagedPositionManager(h.database, h.session, h.runtime, h.markets, {
    activeAccount: () => 'account-1', account: async () => ({ positions: h.gateway.positions, openOrders: [] }),
    funding: () => null, refreshFunding: async () => undefined, riskPause: () => { void h.engine.pauseForManagedRisk(); },
  });
  h.engine.setPositionManager(h.manager);
  const config = { ...takerTakerConfig, asset: 'CRO', leftVenue: 'KRAKEN', rightVenue: 'GATE',
    perOrderQuantity: '500', totalAmount: '1000', management: { perOrderQuantity: '500' } };
  let prepared = 0, released = 0;
  const prepare = (refresh: () => void) => {
    h.markets.prepareQuotes = (selected) => {
      prepared += 1;
      return waitForStrategyQuotes({ market: (s) => h.markets.market(s), connectionState: () => h.markets.connectionState(),
        watchQuotes: () => () => { released += 1; }, requestQuoteRefresh: refresh }, selected, () => h.session.liveTradingEnabled, 150);
    };
  };
  return { h, symbols, config, prepare, counts: () => ({ prepared, released }),
    launch: () => h.engine.startStrategy(config, { profileId: 'account-1', label: 'Test' }) };
}

async function managedDeferralHarness(executionMethod: 'MAKER_TAKER' | 'TAKER_TAKER', options: StrategyEngineOptions = {}, beforeStart?: (h: Harness) => void,
  managerNow?: () => number) {
  const h = await createHarness(options);
  h.markets.set('BINANCE_FUTURE_BTC_USDT', '110', '111'); h.markets.set('OKX_FUTURE_BTC_USDT', '99', '100');
  const facts = async () => ({ positions: h.gateway.positions, openOrders: (await Promise.all(h.gateway.createdOrders
    .map(order => h.gateway.queryOrder({ apiKey: 'fake', apiSecret: 'fake' }, order.remoteId))))
    .filter(order => !isTerminalOrderState(order.state)) });
  let read: (() => ReturnType<typeof facts>) | null = null;
  h.manager = new ManagedPositionManager(h.database, h.session, h.runtime, h.markets, {
    activeAccount: () => 'account-1', account: async () => read ? read() : facts(),
    funding: () => null, refreshFunding: async () => undefined, riskPause: () => { void h.engine.pauseForManagedRisk(); },
    now: managerNow,
  });
  h.engine.setPositionManager(h.manager);
  beforeStart?.(h);
  const record = await h.engine.startStrategy({ ...takerTakerConfig, executionMethod, makerLeg: 'left',
    management: { perOrderQuantity: '0.1' } }, { profileId: 'account-1', label: 'Synthetic' });
  return { h, record, facts, setRead: (value: typeof read) => { read = value; } };
}

async function pendingProgressHarness(now?: () => number) {
  let monitor!: MarginRiskMonitor;
  const result = await managedDeferralHarness('MAKER_TAKER', {}, h => {
    h.gateway.leverages = { BINANCE_FUTURE_BTC_USDT: '1', OKX_FUTURE_BTC_USDT: '1' };
    h.runtime.setPairedPrivateStreamLive(true);
    h.gateway.accountAssets = [{ exchange_type: 'CROSSEX', coin: 'USDT', balance: h.gateway.availableMargin, available_balance: h.gateway.availableMargin,
      equity: h.gateway.availableMargin, upnl: '0', liability: '0', borrowing_initial_margin: '0', borrowing_maintenance_margin: '0',
      futures_initial_margin: '0', futures_maintenance_margin: '0' }];
    const account = h.gateway.queryAccount.bind(h.gateway);
    h.gateway.queryAccount = async (...args) => ({ ...await account(...args), user_id: 'synthetic-user' });
    h.gateway.querySymbols = async () => ['BINANCE_FUTURE_BTC_USDT', 'OKX_FUTURE_BTC_USDT'].map(symbol => ({ symbol, support_cross: 'true' })) as GateCrossExSymbol[];
    Object.assign(h.gateway, { queryPositionMarginMode: async () => 'CROSS', queryManagedState: async () => ({ positions: h.gateway.positions, openOrders: [] }) });
    monitor = createMarginRiskService({ db: h.database, gateway: h.gateway, runtime: h.runtime, manager: h.manager!, engine: h.engine,
      markets: h.markets, context: () => 'account-1:1', profile: () => ({ id: 'account-1', label: 'Synthetic' }),
      credentials: () => h.vault.get(DEFAULT_CREDENTIAL_PROFILE), live: () => h.session.liveTradingEnabled, enforce: true });
  }, now);
  return { ...result, monitor };
}

describe('pre-submit account recheck deferral', () => {
  it.each(['position', 'REST'])('keeps %s-ahead entry progress pending without global recheck or a new Maker', async source => {
    const { h, record, monitor, setRead } = await pendingProgressHarness();
    let release: ((facts: { positions: GateCrossExPosition[]; openOrders: GateCrossExOrder[] }) => void) | undefined;
    let reading: Promise<void> | undefined;
    try {
      await h.engine.tick(); const position = futuresPosition('BINANCE_FUTURE_BTC_USDT', 'SHORT', '0.05');
      h.gateway.positions = [position];
      if (source === 'position') { h.runtime.ingestPrivateEvent({ channel: 'position', payload: position }); h.manager!.notifyPosition(position); }
      await h.manager!.tick(); await h.manager!.tick();
      expect(h.runtime.getStrategy(record.id).management?.phase).toBe('OPENING');
      expect(h.manager!.entryProgressPending(record.id)).toBe(true); expect(h.runtime.pairedEntryReady(record.id)).toBe(true);
      await expect(h.runtime.createOrder({ symbol: 'BINANCE_FUTURE_BTC_USDT', side: 'SELL', type: 'LIMIT', timeInForce: 'POC', quantity: '0.05', price: '110' },
        { strategyId: record.id, strategyLeg: 'left' })).rejects.toMatchObject({ code: 'managed_account_rechecking' });
      expect(h.gateway.createdOrders).toHaveLength(1); expect(h.database.prepare('SELECT reason FROM managed_risk_lock').get()).toBeUndefined();
      setRead(() => new Promise(resolve => { release = resolve; })); reading = h.manager!.tick();
      ackOrder(h.runtime, 'remote-1', 'PARTIALLY_FILLED', '0.05', '111');
      await waitFor(() => h.gateway.createdOrders.length === 2);
      expect(h.gateway.createdOrders[1]).toMatchObject({ type: 'MARKET', side: 'BUY', qty: '0.05' });
      ingestFill(h.runtime, 'remote-1', 'BINANCE_FUTURE_BTC_USDT', 'SELL', '0.05', '111');
      expect(h.runtime.getOrder(h.runtime.listOrders().find(order => order.remoteOrderId === 'remote-1')!.id).executedQuantity).toBe('0.05');
      expect(h.database.prepare('SELECT reason FROM managed_risk_lock').get()).toBeUndefined();
      ackOrder(h.runtime, 'remote-2', 'FILLED', '0.05', '100');
    } finally { h.session.set('readonly'); setRead(null); release?.({ positions: h.gateway.positions, openOrders: [] }); await reading; await monitor.stop(); }
  });
  it('an old REST snapshot cannot erase pending entry progress before cancellation without a fill', async () => {
    const { h, record, monitor } = await pendingProgressHarness();
    try {
      await h.engine.tick(); h.manager!.notifyPosition(futuresPosition('BINANCE_FUTURE_BTC_USDT', 'SHORT', '0.05'));
      await h.manager!.tick(); await h.manager!.tick(); // REST still contains the original empty holdings.
      expect(h.manager!.entryProgressPending(record.id)).toBe(true); expect(h.runtime.pairedMakerReady(record.id)).toBe(false);
      ackOrder(h.runtime, 'remote-1', 'CANCELLED', '0', '0');
      expect(h.session.current).toBe('readonly');
      expect(h.database.prepare('SELECT reason FROM managed_risk_lock').get()).toEqual({ reason: 'managed_entry_progress_unconfirmed' });
      await h.engine.tick(); expect(h.gateway.createdOrders).toHaveLength(1);
    } finally { await monitor.stop(); }
  });
  it('blocks an already queued Maker at actual dispatch after position-ahead evidence and still sends the confirmed hedge', async () => {
    const { h, record, monitor } = await pendingProgressHarness(); await h.engine.tick();
    const original = h.gateway.createOrder.bind(h.gateway);
    let release!: () => void, started!: () => void, writes = 0;
    const held = new Promise<void>(resolve => { release = resolve; }), reading = new Promise<void>(resolve => { started = resolve; });
    const client = new GateCrossExClient(async (url, init) => {
      expect(new URL(String(url)).hostname).toBe('synthetic.invalid');
      if (String(url).includes('/leverage')) { started(); await held; return new Response(JSON.stringify({ OKX_FUTURE_BTC_USDT: '1' })); }
      writes += 1;
      return new Response(JSON.stringify(await original({ apiKey: 'fake', apiSecret: 'fake' }, JSON.parse(String(init!.body)) as CrossExOrderRequest)));
    }, Date.now, 'https://synthetic.invalid/api/v4', 100);
    h.gateway.createOrder = client.createOrder.bind(client);
    const slow = client.queryLeverages({ apiKey: 'fake', apiSecret: 'fake' }, ['OKX_FUTURE_BTC_USDT']);
    try {
      await reading;
      const queued = h.runtime.createOrder({ symbol: 'BINANCE_FUTURE_BTC_USDT', side: 'SELL', type: 'LIMIT', timeInForce: 'POC', quantity: '0.05', price: '110' },
        { strategyId: record.id, strategyLeg: 'left' }).catch(error => error);
      await waitFor(() => h.runtime.listOrders().length === 2); expect(writes).toBe(0);
      const position = futuresPosition('BINANCE_FUTURE_BTC_USDT', 'SHORT', '0.05');
      h.runtime.ingestPrivateEvent({ channel: 'position', payload: position }); h.manager!.notifyPosition(position);
      expect(await queued).toMatchObject({ code: 'managed_account_rechecking' }); expect(writes).toBe(0);
      expect(h.runtime.listOrders().some(order => order.state === 'FAIL' && order.failureReason === 'ORDER_NOT_DISPATCHED')).toBe(true);
      ackOrder(h.runtime, 'remote-1', 'PARTIALLY_FILLED', '0.05', '111');
      await waitFor(() => h.gateway.createdOrders.length === 2);
      expect(writes).toBe(1); expect(h.gateway.createdOrders[1]).toMatchObject({ type: 'MARKET', qty: '0.05' });
      expect(h.database.prepare('SELECT reason FROM managed_risk_lock').get()).toBeUndefined();
      ackOrder(h.runtime, 'remote-2', 'FILLED', '0.05', '100');
    } finally { h.session.set('readonly'); release(); await slow; await monitor.stop(); }
  });
  it('expires unconfirmed entry progress on the original active timer without awaiting another message or REST completion', async () => {
    let clock = Date.now(); const timers = vi.spyOn(globalThis, 'setTimeout');
    const { h, monitor } = await pendingProgressHarness(() => clock);
    try {
      await h.engine.tick(); h.manager!.notifyPosition(futuresPosition('BINANCE_FUTURE_BTC_USDT', 'SHORT', '0.05'));
      const deadline = timers.mock.calls.find(([, delay]) => delay === 25000);
      expect(deadline).toBeDefined();
      clock += 20000;
      h.manager!.notifyPosition({ ...futuresPosition('BINANCE_FUTURE_BTC_USDT', 'SHORT', '0.08'), update_time: String(clock) });
      clock += 5001; (deadline![0] as () => void)();
      expect(h.session.current).toBe('readonly');
      expect(h.database.prepare('SELECT reason FROM managed_risk_lock').get()).toEqual({ reason: 'managed_account_recovery_expired' });
      expect(h.gateway.createdOrders).toHaveLength(1);
    } finally { timers.mockRestore(); await monitor.stop(); }
  });
  function launchMonitor(h: Harness) {
    const monitor = new MarginRiskMonitor(new MarginRiskStore(h.database), {
      context: () => 'account-1', live: () => h.session.liveTradingEnabled, uncovered: () => [],
      groups: () => h.runtime.listStrategies().filter(s => s.management).map(s => ({ id: s.management!.groupId ?? s.id,
        strategyId: s.id, asset: s.config.asset, phase: s.management!.phase, eligible: false, authorized: false, reason: null })),
      account: async () => ({ profileId: 'account-1', userId: 'synthetic-user', label: 'Test', account: await h.gateway.queryAccount({ apiKey: 'fake', apiSecret: 'fake' }) }),
    });
    h.manager!.setMarginMonitor(monitor); return monitor;
  }
  it('atomically authorizes a newly launched managed group before its first order', async () => {
    let monitor!: MarginRiskMonitor;
    const { h, record } = await managedDeferralHarness('MAKER_TAKER', {}, h => { monitor = launchMonitor(h); });
    const snapshot = monitor.snapshot();
    expect(snapshot.accountId).not.toBe('account-1');
    expect(snapshot.policy.protectedGroupIds).toEqual([record.management!.groupId]);
    expect(snapshot.groups[0]).toMatchObject({ authorized: true, eligible: false, phase: 'OPENING' });
    expect(h.gateway.createdOrders).toHaveLength(0);
    h.session.set('readonly'); await h.engine.prepareForLiveActivation(); h.session.set('live');
    monitor.store.savePolicy(snapshot.accountId!, { ...snapshot.policy, protectedGroupIds: [] });
    h.engine.activatePersistedStrategies('account-1'); await h.manager!.tick();
    expect(monitor.snapshot().policy.protectedGroupIds).toEqual([]);
    await monitor.stop();
  });
  it('rolls back task, claims and launch grant together when authorization persistence fails', async () => {
    let harness!: Harness;
    await expect(managedDeferralHarness('MAKER_TAKER', {}, h => {
      harness = h; launchMonitor(h);
      h.database.exec("CREATE TRIGGER reject_launch_grant BEFORE UPDATE OF policy_json ON margin_risk_accounts BEGIN SELECT RAISE(ABORT,'synthetic grant persistence failure'); END");
    })).rejects.toThrow('synthetic grant persistence failure');
    expect(harness.runtime.listStrategies()).toHaveLength(0);
    expect(harness.database.prepare('SELECT COUNT(*) n FROM managed_position_claims').get()).toEqual({ n: 0 });
    expect(harness.database.prepare('SELECT COUNT(*) n FROM managed_position_reservations').get()).toEqual({ n: 0 });
    expect(harness.gateway.createdOrders).toHaveLength(0);
  });
  it.each(['policy', 'mode', 'initial-read'])('rejects a launch whose %s permission changed during preparation', async cause => {
    let harness!: Harness;
    await expect(managedDeferralHarness('MAKER_TAKER', {}, h => {
      harness = h; const monitor = launchMonitor(h);
      if (cause === 'initial-read') {
        const account = monitor.sources.account;
        monitor.sources.account = async signal => { const result = await account(signal); h.session.set('readonly'); h.session.set('live'); return result; };
      }
      h.markets.prepareQuotes = async () => {
        if (cause === 'mode') { h.session.set('readonly'); h.session.set('live'); }
        else if (cause === 'policy') { const s = monitor.snapshot(); monitor.store.savePolicy(s.accountId!, { ...s.policy, notificationsEnabled: false }); }
      };
    })).rejects.toMatchObject({ code: cause === 'policy' ? 'margin_policy_conflict' : 'margin_launch_context_changed' });
    expect(harness.runtime.listStrategies()).toHaveLength(0);
    expect(harness.gateway.createdOrders).toHaveLength(0);
    expect(harness.database.prepare('SELECT COUNT(*) n FROM managed_position_claims').get()).toEqual({ n: 0 });
  });
  it('cancels an existing maker once during account recovery and resumes only its confirmed partial-fill hedge', async () => {
    const { h, record, setRead } = await managedDeferralHarness('MAKER_TAKER'); await h.engine.tick();
    h.gateway.holdCancellations = true;
    setRead(async () => { throw new GateApiError(500, 'INTERNAL'); }); await h.manager!.tick();
    await waitFor(() => h.gateway.cancelledOrders.length === 1);
    await h.manager!.tick(); await h.engine.tick();
    expect(h.gateway.createdOrders).toHaveLength(1); expect(h.gateway.cancelledOrders).toEqual(['remote-1']);
    const query = h.gateway.queryOrder.bind(h.gateway);
    h.gateway.queryOrder = async (...args) => {
      const order = await query(...args);
      return args[1] === 'remote-1' ? { ...order, state: 'CANCELLED', executed_qty: '0.05', executed_avg_price: '110' } : order;
    };
    ackOrder(h.runtime, 'remote-1', 'CANCELLED', '0.05', '110');
    h.gateway.positions = [futuresPosition('BINANCE_FUTURE_BTC_USDT', 'SHORT', '0.05')];
    setRead(null); await new Promise(resolve => setTimeout(resolve, 2050));
    await h.manager!.tick(); await h.manager!.tick();
    expect(h.database.prepare('SELECT reason FROM managed_risk_lock').get()).toBeUndefined();
    const completing = h.engine.tick(); await waitFor(() => h.gateway.createdOrders.length === 2);
    expect(h.gateway.createdOrders).toHaveLength(2);
    expect(h.runtime.listOrders().find(o => o.remoteOrderId === 'remote-2')).toMatchObject({ strategyId: record.id, strategyLeg: 'right', quantity: '0.05' });
    h.gateway.positions.push(futuresPosition('OKX_FUTURE_BTC_USDT', 'LONG', '0.05'));
    ackOrder(h.runtime, 'remote-2', 'FILLED', '0.05', '100'); await completing;
    expect(h.gateway.cancelledOrders).toEqual(['remote-1']);
  });
  it('expires maker confirmation even while another actor is waiting for taker execution', async () => {
    let now = Date.now(); const { h } = await managedDeferralHarness('MAKER_TAKER', { now: () => now });
    await h.engine.tick(); h.gateway.holdCancellations = true;
    now += 100; h.markets.set('BINANCE_FUTURE_BTC_USDT', '120', '121', new Date(now).toISOString());
    h.markets.set('OKX_FUTURE_BTC_USDT', '99', '100', new Date(now).toISOString());
    await h.engine.tick(); await waitFor(() => h.gateway.cancelledOrders.length === 1);
    h.markets.set('BINANCE_FUTURE_ETH_USDT', '120', '121', new Date(now).toISOString());
    h.markets.set('OKX_FUTURE_ETH_USDT', '99', '100', new Date(now).toISOString());
    await h.engine.startStrategy({ ...takerTakerConfig, asset: 'ETH' }, { profileId: 'account-1', label: 'Synthetic' });
    const blocked = h.engine.tick(); await waitFor(() => h.gateway.createdOrders.length === 3);
    now += 25_001; const checking = h.engine.tick();
    try {
      await waitFor(() => Boolean(h.database.prepare('SELECT reason FROM managed_risk_lock').get()), 100);
      expect(h.gateway.createAttempts).toHaveLength(3);
    } finally {
      h.gateway.holdCancellations = false;
      for (const order of h.gateway.createdOrders) ackOrder(h.runtime, order.remoteId, 'CANCELLED', '0', '0');
      await blocked; await checking;
    }
  });

  it('hedges a confirmed partial fill while maker cancellation is still pending', async () => {
    const { h } = await managedDeferralHarness('MAKER_TAKER'); await h.engine.tick();
    h.gateway.holdCancellations = true; await new Promise(resolve => setTimeout(resolve, 12));
    h.markets.set('BINANCE_FUTURE_BTC_USDT', '120', '121'); await h.engine.tick();
    await waitFor(() => h.gateway.cancelledOrders.length === 1);
    const query = h.gateway.queryOrder.bind(h.gateway);
    h.gateway.queryOrder = async (...args) => {
      const order = await query(...args);
      return args[1] === 'remote-1' ? { ...order, state: 'PARTIALLY_FILLED', executed_qty: '0.05', executed_avg_price: '110' } : order;
    };
    h.gateway.positions = [futuresPosition('BINANCE_FUTURE_BTC_USDT', 'SHORT', '0.05')];
    ackOrder(h.runtime, 'remote-1', 'PARTIALLY_FILLED', '0.05', '110');
    await h.manager!.tick(); await h.manager!.tick();
    const pending = h.engine.tick(); await waitFor(() => h.gateway.createdOrders.length === 2);
    expect(h.gateway.createdOrders[1]).toMatchObject({ symbol: 'OKX_FUTURE_BTC_USDT', type: 'MARKET', qty: '0.05' });
    expect(h.runtime.listOrders().find(o => o.remoteOrderId === 'remote-1')?.state).toBe('PENDING_CANCEL');
    h.gateway.positions.push(futuresPosition('OKX_FUTURE_BTC_USDT', 'LONG', '0.05'));
    ackOrder(h.runtime, 'remote-2', 'FILLED', '0.05', '100'); await pending;
    h.gateway.queryOrder = query; h.gateway.holdCancellations = false;
    ackOrder(h.runtime, 'remote-1', 'CANCELLED', '0.05', '110');
    expect(h.gateway.createdOrders.filter(o => o.symbol === 'BINANCE_FUTURE_BTC_USDT')).toHaveLength(1);
  });

  it('continues the existing hedge monitor while another task awaits maker cancellation', async () => {
    const { h, record } = await managedDeferralHarness('MAKER_TAKER');
    h.markets.set('GATE_FUTURE_PONS_USDT', '1', '1.01'); h.markets.set('HYPERLIQUID_FUTURE_PONS_USDC', '1', '1.01');
    h.gateway.positions = [futuresPosition('GATE_FUTURE_PONS_USDT', 'SHORT', '100'), futuresPosition('HYPERLIQUID_FUTURE_PONS_USDC', 'LONG', '100')];
    const other = await h.engine.startStrategy({ ...takerTakerConfig, asset: 'PONS', leftVenue: 'GATE', rightVenue: 'HYPERLIQUID',
      totalAmount: '1', perOrderQuantity: '1', management: { adoptExisting: true, perOrderQuantity: '1' } }, { profileId: 'account-1', label: 'Synthetic' });
    h.manager!.handoff(other.id, '0'); await h.manager!.tick(); await h.engine.tick();
    h.gateway.holdCancellations = true; await new Promise(resolve => setTimeout(resolve, 12));
    h.markets.set('BINANCE_FUTURE_BTC_USDT', '120', '121'); await h.engine.tick();
    await waitFor(() => h.gateway.cancelledOrders.length === 1); await h.manager!.tick();
    expect(h.runtime.getStrategy(record.id).status).toBe('RUNNING');
    expect(h.runtime.getStrategy(other.id)).toMatchObject({ status: 'RUNNING', management: { phase: 'MONITORING', leftQuantity: '100', rightQuantity: '100' } });
    expect(h.database.prepare('SELECT * FROM managed_risk_lock').get()).toBeUndefined();
    h.gateway.holdCancellations = false; ackOrder(h.runtime, 'remote-1', 'CANCELLED', '0', '0');
  });

  it('hard-pauses a lost cancellation without replay and does not resume on its later terminal push', async () => {
    let now = Date.now(); const { h, record } = await managedDeferralHarness('MAKER_TAKER', { now: () => now });
    await h.engine.tick(); let attempts = 0;
    h.gateway.cancelOrder = async () => { attempts++; throw new GateApiError(0, 'NETWORK_ERROR'); };
    now += 100; h.markets.set('BINANCE_FUTURE_BTC_USDT', '120', '121', new Date(now).toISOString());
    h.markets.set('OKX_FUTURE_BTC_USDT', '99', '100', new Date(now).toISOString());
    const tick = h.engine.tick();
    try {
      await waitFor(() => h.session.current === 'readonly');
      expect(attempts).toBe(1); expect(h.gateway.createdOrders).toHaveLength(1);
      expect(h.runtime.getStrategy(record.id).status).toBe('PAUSED');
      expect(h.database.prepare('SELECT reason FROM managed_risk_lock').get()).toEqual({ reason: 'managed_order_unresolved' });
    } finally { ackOrder(h.runtime, 'remote-1', 'CANCELLED', '0', '0'); await tick; }
    expect(h.runtime.listOpenOrders()).toHaveLength(0);
    await h.engine.tick(); expect(h.gateway.createdOrders).toHaveLength(1);
    expect(h.session.current).toBe('readonly');
  });

  it('keeps maker cancellation pending past the taker timeout without blocking other ticks, then continues after confirmation', async () => {
    let now = Date.now(); const { h, record } = await managedDeferralHarness('MAKER_TAKER', { now: () => now, orderTimeoutMs: 50 });
    await h.engine.tick(); const order = h.runtime.listOrders()[0]; h.gateway.holdCancellations = true;
    now += 100; h.markets.set('BINANCE_FUTURE_BTC_USDT', '120', '121', new Date(now).toISOString());
    h.markets.set('OKX_FUTURE_BTC_USDT', '99', '100', new Date(now).toISOString());
    await h.engine.tick(); await waitFor(() => h.gateway.cancelledOrders.length === 1);
    now += 20_300; await h.engine.tick();
    expect(h.runtime.getStrategy(record.id).status).toBe('RUNNING');
    expect(h.database.prepare('SELECT * FROM managed_risk_lock').get()).toBeUndefined();
    expect(h.gateway.createdOrders).toHaveLength(1); expect(h.gateway.cancelledOrders).toEqual(['remote-1']);
    ackOrder(h.runtime, 'remote-1', 'CANCELLED', '0', '0');
    h.markets.set('BINANCE_FUTURE_BTC_USDT', '120', '121', new Date(now).toISOString());
    h.markets.set('OKX_FUTURE_BTC_USDT', '99', '100', new Date(now).toISOString());
    await h.engine.tick();
    expect(h.runtime.getOrder(order.id).state).toBe('CANCELLED'); expect(h.gateway.createdOrders).toHaveLength(2);
    expect(h.runtime.getStrategy(record.id).status).toBe('RUNNING');
  });

  it('rechecks temporary order-read failures without a hard pause or a premature replacement', async () => {
    let now = Date.now(); const { h, record } = await managedDeferralHarness('MAKER_TAKER', { now: () => now });
    await h.engine.tick(); const query = h.gateway.queryOrder.bind(h.gateway); let failures = 2, reads = 0;
    h.gateway.queryOrder = async (...args) => { reads++; if (failures-- > 0) throw new GateApiError(0, 'NETWORK_ERROR'); return query(...args); };
    now += 100; h.markets.set('BINANCE_FUTURE_BTC_USDT', '120', '121', new Date(now).toISOString());
    h.markets.set('OKX_FUTURE_BTC_USDT', '99', '100', new Date(now).toISOString());
    for (let i = 0; i < 3; i++) { now += 100; await h.engine.tick(); await new Promise(resolve => setTimeout(resolve, 5)); }
    expect(reads).toBeGreaterThanOrEqual(3); expect(h.runtime.getStrategy(record.id).status).toBe('RUNNING');
    expect(h.database.prepare('SELECT * FROM managed_risk_lock').get()).toBeUndefined();
    expect(h.gateway.cancelledOrders).toEqual(['remote-1']);
  });

  it('enforces one fixed maker confirmation deadline even when quotes disappear and reads stay in flight', async () => {
    let now = Date.now(); const { h, record } = await managedDeferralHarness('MAKER_TAKER', { now: () => now });
    await h.engine.tick(); const query = h.gateway.queryOrder.bind(h.gateway); let finish!: () => void;
    const held = new Promise<void>(resolve => { finish = resolve; });
    h.gateway.queryOrder = async (...args) => { await held; return query(...args); };
    now += 100; h.markets.set('BINANCE_FUTURE_BTC_USDT', '120', '121', new Date(now).toISOString());
    h.markets.set('OKX_FUTURE_BTC_USDT', '99', '100', new Date(now).toISOString());
    try {
      const first = h.engine.tick(); await waitFor(() => Boolean(finish));
      await Promise.race([first, new Promise((_, reject) => setTimeout(() => reject(new Error('maker blocked all ticks')), 80))]);
      now += 25_001; const paused = h.engine.tick(); finish(); await paused;
      expect(h.runtime.getStrategy(record.id).status).toBe('PAUSED');
      expect(h.database.prepare('SELECT reason FROM managed_risk_lock').get()).toBeTruthy();
      expect(h.gateway.createAttempts).toHaveLength(1);
    } finally { h.gateway.queryOrder = query; finish(); }
  });

  it('reattaches the original entry actor after explicit zero-fill risk recovery', async () => {
    const { h, record } = await managedDeferralHarness('MAKER_TAKER'); await h.engine.tick();
    const order = h.runtime.listOrders()[0]; await h.runtime.cancelOrder(order.id); await h.runtime.refreshOrderFromRemote(order.id);
    h.manager!.failAll('managed_recovery_unresolved_orders'); await h.engine.pauseForManagedRisk(); h.session.set('live');
    const resumed = await h.engine.resumeStrategy(record.id, 'account-1');
    expect(resumed).toMatchObject({ id: record.id, status: 'RUNNING', management: { phase: 'OPENING', exitRequested: false } });
    await new Promise(resolve => setTimeout(resolve, 6)); await h.engine.tick();
    expect(h.gateway.createdOrders).toHaveLength(2); expect(h.runtime.listStrategies()).toHaveLength(1);
    expect(h.runtime.listOrders()[1]).toMatchObject({ strategyId: record.id, strategyLeg: 'left', quantity: '0.1' });
  });
  it('reattaches only running entry tasks when a live activation finishes temporary account recovery', async () => {
    const { h, record, setRead } = await managedDeferralHarness('MAKER_TAKER');
    setRead(async () => { throw new Error('temporary read failure'); }); await h.manager!.tick();
    h.session.set('readonly'); setRead(null); await h.engine.prepareForLiveActivation();
    h.session.set('live'); h.engine.activatePersistedStrategies('account-1');
    expect(h.engine.listActiveStrategyIds()).not.toContain(record.id);
    await new Promise(resolve => setTimeout(resolve, 2050));
    await h.manager!.tick(); await h.manager!.tick();
    expect(h.database.prepare('SELECT reason FROM managed_risk_lock').get()).toBeUndefined();
    expect(h.engine.listActiveStrategyIds()).toEqual([record.id]);
    await h.engine.tick(); expect(h.gateway.createdOrders).toHaveLength(1);
  });
  it('continues only the remaining target after partial entry recovery and rejects a duplicate resume', async () => {
    const { h, record } = await managedDeferralHarness('MAKER_TAKER');
    seedFilledStrategyOrder(h.database, record.id, 'history-left', 'BINANCE_FUTURE_BTC_USDT', 'SELL', '0.1', 'left');
    seedFilledStrategyOrder(h.database, record.id, 'history-right', 'OKX_FUTURE_BTC_USDT', 'BUY', '0.1', 'right');
    h.database.prepare('UPDATE execution_orders SET remote_order_id=id WHERE strategy_id=?').run(record.id);
    h.database.prepare("UPDATE execution_strategies SET filled_quantity='0.1',filled_left='0.1',filled_right='0.1',progress=50 WHERE id=?").run(record.id);
    h.gateway.positions = [futuresPosition('BINANCE_FUTURE_BTC_USDT', 'SHORT', '0.1'), futuresPosition('OKX_FUTURE_BTC_USDT', 'LONG', '0.1')];
    h.manager!.failAll('Maker cancellation confirmation expired'); await h.engine.pauseForManagedRisk(); h.session.set('live');
    const resumed = await h.engine.resumeStrategy(record.id, 'account-1', 'OPENING');
    expect(resumed).toMatchObject({ filledQuantity: '0.1', management: { phase: 'OPENING', exitRequested: false } });
    await expect(h.engine.resumeStrategy(record.id, 'account-1', 'OPENING')).rejects.toMatchObject({ code: 'strategy_not_paused' });
    await h.engine.tick();
    expect(h.gateway.createdOrders).toHaveLength(1);
    expect(h.gateway.createdOrders[0]).toMatchObject({ side: 'SELL', qty: '0.1', reduce_only: 'false' });
    expect(h.engine.listActiveStrategyIds()).toEqual([record.id]);
  });

  it('keeps an existing hedge monitoring through 100 confirmed zero-fill entry quote lifecycles', async () => {
    const { h, record, facts, setRead } = await managedDeferralHarness('MAKER_TAKER');
    h.markets.set('GATE_FUTURE_PONS_USDT', '1', '1.01'); h.markets.set('HYPERLIQUID_FUTURE_PONS_USDC', '1', '1.01');
    h.gateway.positions = [futuresPosition('GATE_FUTURE_PONS_USDT', 'SHORT', '100'), futuresPosition('HYPERLIQUID_FUTURE_PONS_USDC', 'LONG', '100')];
    const other = await h.engine.startStrategy({ ...takerTakerConfig, asset: 'PONS', leftVenue: 'GATE', rightVenue: 'HYPERLIQUID',
      totalAmount: '1', perOrderQuantity: '1', management: { adoptExisting: true, perOrderQuantity: '1' } }, { profileId: 'account-1', label: 'Synthetic' });
    h.manager!.handoff(other.id, '0'); await h.manager!.tick();
    for (let attempt = 0; attempt < 100; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 6)); const old = await facts();
      let complete!: (value: Awaited<ReturnType<typeof facts>>) => void;
      setRead(() => new Promise(resolve => { complete = resolve; })); const reading = h.manager!.tick();
      await h.engine.tick(); expect(h.gateway.createdOrders).toHaveLength(attempt + 1);
      const order = h.runtime.listOpenOrders(record.id)[0];
      await h.runtime.cancelOrder(order.id); await h.runtime.refreshOrderFromRemote(order.id);
      complete(old); await reading; setRead(null); await h.manager!.tick();
      expect(h.runtime.getStrategy(record.id)).toMatchObject({ status: 'RUNNING', management: { phase: 'OPENING', reason: null } });
      expect(h.runtime.getStrategy(other.id)).toMatchObject({ status: 'RUNNING', management: { phase: 'MONITORING', leftQuantity: '100', rightQuantity: '100' } });
      expect(h.database.prepare('SELECT reason FROM managed_risk_lock').get()).toBeUndefined();
    }
    expect(h.runtime.strategyLogs(other.id).filter(log => log.event === 'Account recheck started')).toHaveLength(0);
    expect(h.gateway.createAttempts).toHaveLength(100); expect(h.gateway.positions).toHaveLength(2);
  });

  it('repairs a fill racing a managed reprice instead of immediately replacing the old quote', async () => {
    const { h } = await managedDeferralHarness('MAKER_TAKER'); await h.engine.tick();
    await new Promise(resolve => setTimeout(resolve, 12)); h.markets.set('BINANCE_FUTURE_BTC_USDT', '120', '121');
    const cancel = h.gateway.cancelOrder.bind(h.gateway);
    h.gateway.cancelOrder = async (...args) => {
      const result = await cancel(...args); ackOrder(h.runtime, 'remote-1', 'CANCELLED', '0.05', '110');
      h.gateway.positions = [futuresPosition('BINANCE_FUTURE_BTC_USDT', 'SHORT', '0.05')]; return result;
    };
    const pending = h.engine.tick(); await waitFor(() => h.gateway.createdOrders.length === 2);
    expect(h.gateway.createdOrders[1]).toMatchObject({ symbol: 'OKX_FUTURE_BTC_USDT', type: 'MARKET', qty: '0.05' });
    h.gateway.positions.push(futuresPosition('OKX_FUTURE_BTC_USDT', 'LONG', '0.05'));
    ackOrder(h.runtime, 'remote-2', 'FILLED', '0.05', '100'); await pending;
    expect(h.gateway.createdOrders.filter(order => order.symbol === 'BINANCE_FUTURE_BTC_USDT')).toHaveLength(1);
  });

  it('never replaces a managed quote when the old cancellation remains unconfirmed', async () => {
    let now = Date.now(); const { h, record } = await managedDeferralHarness('MAKER_TAKER', { now: () => now, orderTimeoutMs: 50 });
    await h.engine.tick(); expect(h.gateway.createdOrders).toHaveLength(1);
    h.gateway.holdCancellations = true; now += 100;
    h.markets.set('BINANCE_FUTURE_BTC_USDT', '120', '121', new Date(now).toISOString());
    h.markets.set('OKX_FUTURE_BTC_USDT', '99', '100', new Date(now).toISOString());
    await h.engine.tick();
    await waitFor(() => h.gateway.cancelledOrders.length > 0);
    now += 25_001; await h.engine.tick();
    expect(h.gateway.createAttempts).toHaveLength(1);
    expect(h.runtime.getStrategy(record.id).status).toBe('PAUSE_PENDING_REMOTE');
    expect(h.runtime.listOrders()[0]).toMatchObject({ remoteOrderId: 'remote-1', state: 'PENDING_CANCEL', executedQuantity: '0' });
    expect(h.gateway.cancelledOrders).toEqual(['remote-1']);
    expect(h.database.prepare('SELECT reason FROM managed_risk_lock').get()).toBeTruthy();
    ackOrder(h.runtime, 'remote-1', 'CANCELLED', '0', '0');
    await h.engine.tick();
    await waitFor(() => h.runtime.getStrategy(record.id).status === 'PAUSED');
    expect(h.database.prepare('SELECT reason FROM managed_risk_lock').get()).toBeTruthy();
    expect(h.gateway.createAttempts).toHaveLength(1);
  });

  it.each(['MAKER_TAKER', 'TAKER_TAKER'] as const)('does not count five local %s blocks as exchange failures', async method => {
    let clock = Date.now(); const { h, record } = await managedDeferralHarness(method, { now: () => clock });
    const create = h.runtime.createOrder.bind(h.runtime);
    h.runtime.createOrder = async (...args) => {
      h.database.prepare('INSERT OR REPLACE INTO managed_risk_lock VALUES (1, ?, ?)')
        .run('managed_account_rechecking', new Date().toISOString());
      return create(...args);
    };
    for (let attempt = 0; attempt < 5; attempt++) {
      // Isolated completion of the preceding recheck; no production lock is modified.
      h.database.exec('DELETE FROM managed_risk_lock'); clock += 70_000;
      h.markets.set('BINANCE_FUTURE_BTC_USDT', '110', '111', new Date(clock).toISOString());
      h.markets.set('OKX_FUTURE_BTC_USDT', '99', '100', new Date(clock).toISOString());
      await h.engine.tick();
      expect(h.runtime.getStrategy(record.id).status).toBe('RUNNING');
    }
    expect(h.gateway.createAttempts).toHaveLength(0); expect(h.runtime.listOrders()).toHaveLength(0);
    expect(h.runtime.strategyLogs(record.id).filter(log => /quote rejected|submission failed|risk pause/i.test(log.event))).toEqual([]);
  });

  it('resumes a new maker after two actual matching reads, without a rejection cooldown or duplicate submit', async () => {
    const { h, record, facts, setRead } = await managedDeferralHarness('MAKER_TAKER');
    await h.manager!.tick(); let finish!: (value: Awaited<ReturnType<typeof facts>>) => void;
    setRead(() => new Promise(resolve => { finish = resolve; })); const pending = h.manager!.tick();
    const create = h.runtime.createOrder.bind(h.runtime);
    h.runtime.createOrder = async (...args) => {
      h.manager!.notifyPosition({ symbol: 'BINANCE_FUTURE_BTC_USDT', position_qty: '0', update_time: Date.now() });
      return create(...args);
    };
    await h.engine.tick(); expect(h.gateway.createAttempts).toHaveLength(0);
    setRead(null); finish(await facts()); await pending;
    await h.manager!.tick(); expect(h.database.prepare('SELECT reason FROM managed_risk_lock').get()).toBeTruthy();
    await h.manager!.tick(); expect(h.database.prepare('SELECT reason FROM managed_risk_lock').get()).toBeUndefined();
    h.runtime.createOrder = create; await h.engine.tick();
    expect(h.gateway.createAttempts).toHaveLength(1); expect(h.gateway.createdOrders).toHaveLength(1);
    expect(h.runtime.getStrategy(record.id).status).toBe('RUNNING');
    expect(h.runtime.strategyLogs(record.id).filter(log => log.event === 'Maker quote rejected')).toEqual([]);
  });

  it('keeps an existing adopted hedge monitoring while a new task waits for account rechecks', async () => {
    let clock = Date.now(); const { h, record } = await managedDeferralHarness('MAKER_TAKER', { now: () => clock });
    h.markets.set('GATE_FUTURE_PONS_USDT', '1', '1.01'); h.markets.set('HYPERLIQUID_FUTURE_PONS_USDC', '1', '1.01');
    h.gateway.positions = [futuresPosition('GATE_FUTURE_PONS_USDT', 'SHORT', '100'),
      futuresPosition('HYPERLIQUID_FUTURE_PONS_USDC', 'LONG', '100')];
    const other = await h.engine.startStrategy({ ...takerTakerConfig, asset: 'PONS', leftVenue: 'GATE', rightVenue: 'HYPERLIQUID',
      totalAmount: '1', perOrderQuantity: '1', management: { adoptExisting: true, perOrderQuantity: '1' } },
    { profileId: 'account-1', label: 'Synthetic' });
    h.manager!.handoff(other.id, '0'); await h.manager!.tick();
    const create = h.runtime.createOrder.bind(h.runtime);
    h.runtime.createOrder = async (...args) => {
      h.database.prepare('INSERT OR REPLACE INTO managed_risk_lock VALUES (1, ?, ?)')
        .run('managed_account_rechecking', new Date().toISOString()); return create(...args);
    };
    for (let attempt = 0; attempt < 5; attempt++) {
      h.database.exec('DELETE FROM managed_risk_lock'); clock += 70_000;
      h.markets.set('BINANCE_FUTURE_BTC_USDT', '110', '111', new Date(clock).toISOString());
      h.markets.set('OKX_FUTURE_BTC_USDT', '99', '100', new Date(clock).toISOString()); await h.engine.tick();
      expect(h.runtime.getStrategy(record.id).status).toBe('RUNNING');
      expect(h.runtime.getStrategy(other.id)).toMatchObject({ status: 'RUNNING', management: { phase: 'MONITORING', leftQuantity: '100', rightQuantity: '100' } });
    }
    expect(h.gateway.createAttempts).toHaveLength(0); expect(h.gateway.positions).toHaveLength(2);
  });

  it('still pauses after five real exchange rejections even with a local deferral between them', async () => {
    let clock = Date.now(); const { h, record } = await managedDeferralHarness('MAKER_TAKER', { now: () => clock });
    h.gateway.failCreate('BINANCE_FUTURE_BTC_USDT', 5);
    const refresh = () => {
      clock += 70_000;
      h.markets.set('BINANCE_FUTURE_BTC_USDT', '110', '111', new Date(clock).toISOString());
      h.markets.set('OKX_FUTURE_BTC_USDT', '99', '100', new Date(clock).toISOString());
    };
    for (let attempt = 0; attempt < 4; attempt++) { refresh(); await h.engine.tick(); }
    const create = h.runtime.createOrder.bind(h.runtime);
    h.runtime.createOrder = async (...args) => {
      h.database.prepare('INSERT OR REPLACE INTO managed_risk_lock VALUES (1, ?, ?)')
        .run('managed_account_rechecking', new Date().toISOString());
      return create(...args);
    };
    refresh(); await h.engine.tick();
    expect(h.runtime.getStrategy(record.id).status).toBe('RUNNING'); expect(h.gateway.createAttempts).toHaveLength(4);
    h.database.exec('DELETE FROM managed_risk_lock'); h.runtime.createOrder = create; refresh(); await h.engine.tick();
    expect(h.gateway.createAttempts).toHaveLength(5); expect(h.runtime.getStrategy(record.id).status).toBe('PAUSED');
    expect(h.session.current).toBe('readonly');
  });

  it('keeps a confirmed maker fill and defers its hedge without consuming three repair attempts', async () => {
    const { h, record } = await managedDeferralHarness('MAKER_TAKER'); await h.engine.tick();
    const create = h.runtime.createOrder.bind(h.runtime);
    h.runtime.createOrder = async (...args) => {
      h.database.prepare('INSERT OR REPLACE INTO managed_risk_lock VALUES (1, ?, ?)')
        .run('managed_account_rechecking', new Date().toISOString());
      return create(...args);
    };
    h.gateway.positions = [futuresPosition('BINANCE_FUTURE_BTC_USDT', 'SHORT', '0.05')];
    ackOrder(h.runtime, 'remote-1', 'PARTIALLY_FILLED', '0.05', '111');
    ingestFill(h.runtime, 'remote-1', 'BINANCE_FUTURE_BTC_USDT', 'SELL', '0.05', '111');
    for (let attempt = 0; attempt < 5; attempt++) {
      h.database.exec('DELETE FROM managed_risk_lock'); await h.engine.tick();
      expect(h.runtime.getStrategy(record.id).status).toBe('RUNNING');
    }
    expect(h.gateway.createAttempts).toHaveLength(1); expect(h.runtime.listOrders()).toHaveLength(1);
    expect(h.runtime.strategyLogs(record.id).filter(log => log.event === 'Hedge order failed')).toEqual([]);
    h.database.exec('DELETE FROM managed_risk_lock'); h.runtime.createOrder = create;
    const resume = h.engine.tick(); await waitFor(() => h.gateway.createdOrders.length === 2);
    expect(h.gateway.createdOrders[1]).toMatchObject({ symbol: 'OKX_FUTURE_BTC_USDT', qty: '0.05' });
    ackOrder(h.runtime, 'remote-2', 'FILLED', '0.05', '100'); await resume;
    expect(h.gateway.createAttempts).toHaveLength(2);
  });

  it('does not discard an accepted taker leg when the second leg is deferred', async () => {
    const { h, record, facts, setRead } = await managedDeferralHarness('TAKER_TAKER');
    const create = h.runtime.createOrder.bind(h.runtime);
    let firstAccepted!: () => void;
    const first = new Promise<void>(resolve => { firstAccepted = resolve; });
    h.runtime.createOrder = async (...args) => {
      if (args[1]?.strategyLeg === 'left') {
        const order = await create(...args);
        h.database.prepare('INSERT OR REPLACE INTO managed_risk_lock VALUES (1, ?, ?)')
          .run('managed_account_rechecking', new Date().toISOString());
        firstAccepted(); return order;
      }
      await first; return create(...args);
    };
    const pending = h.engine.tick(); await waitFor(() => h.gateway.createdOrders.length === 1);
    h.gateway.positions = [futuresPosition('BINANCE_FUTURE_BTC_USDT', 'SHORT', '0.1')];
    ackOrder(h.runtime, 'remote-1', 'FILLED', '0.1', '110'); await pending;
    expect(h.runtime.listOrders()).toHaveLength(1); expect(h.runtime.listOrders()[0]).toMatchObject({ state: 'FILLED', executedQuantity: '0.1' });
    expect(h.gateway.createAttempts).toHaveLength(1);
    h.markets.set('BINANCE_FUTURE_BTC_USDT', '99', '100'); // No additional entry clip is eligible.
    h.runtime.createOrder = create; setRead(async () => ({ ...await facts(), openOrders: [] }));
    await h.manager!.tick(); await h.manager!.tick();
    const repair = h.engine.tick(); await waitFor(() => h.gateway.createdOrders.length === 2);
    expect(h.gateway.createdOrders[1]).toMatchObject({ symbol: 'OKX_FUTURE_BTC_USDT', qty: '0.1' });
    ackOrder(h.runtime, 'remote-2', 'FILLED', '0.1', '100'); await repair;
    expect(h.gateway.createAttempts).toHaveLength(2);
    expect(h.gateway.createdOrders.filter(order => order.symbol === 'BINANCE_FUTURE_BTC_USDT')).toHaveLength(1);
    expect(h.runtime.getStrategy(record.id).filledQuantity).toBe('0.1');
  });

  it('retains a submitted order with a lost reply and never replays it as a pre-submit deferral', async () => {
    const { h, record } = await managedDeferralHarness('MAKER_TAKER');
    const send = h.gateway.createOrder.bind(h.gateway);
    h.gateway.createOrder = async (...args) => { await send(...args); throw new Error('synthetic lost submit reply'); };
    h.gateway.queryOrder = async () => { throw new GateApiError(503, 'SYNTHETIC_READ_UNAVAILABLE'); };
    await h.engine.tick();
    expect(h.runtime.listOrders()).toHaveLength(1); expect(h.runtime.listOrders()[0].state).toBe('PENDING_SUBMIT');
    for (let attempt = 0; attempt < 5; attempt++) await h.engine.tick();
    expect(h.gateway.createAttempts).toHaveLength(1); expect(h.gateway.createdOrders).toHaveLength(1);
    expect(h.runtime.listOrders()).toHaveLength(1);
    expect(h.runtime.strategyLogs(record.id).some(log => log.event === 'Maker quote placed')).toBe(false);
    expect(h.runtime.strategyLogs(record.id).some(log => log.event === 'Maker quote rejected')).toBe(true);
  });

  it('keeps a timed close slice pending when every close order is blocked before submission', async () => {
    let now = Date.now();
    const h = await createHarness({ now: () => now }); const symbol = 'BINANCE_FUTURE_BTC_USDT'; h.markets.set(symbol, '100', '101');
    h.gateway.positions = [futuresPosition(symbol, 'LONG', '0.1')];
    const record = await h.engine.startStrategy({ kind: 'position', asset: 'BTC', leftVenue: 'BINANCE', rightVenue: 'BINANCE',
      leftSide: 'SELL', rightSide: 'BUY', totalAmount: '0.1', perOrderQuantity: '0.1', reduceOnly: true, executionMethod: 'TAKER_TAKER',
      closePlan: { orderCount: 2, intervalSeconds: 1, targets: [{ symbol, side: 'SELL', quantity: '0.1', positionSide: 'NONE' }] } });
    now = Date.parse(record.createdAt) + 100;
    const create = h.runtime.createOrder.bind(h.runtime);
    h.runtime.createOrder = async (...args) => {
      h.database.prepare('INSERT OR REPLACE INTO managed_risk_lock VALUES (1, ?, ?)')
        .run('managed_account_rechecking', new Date().toISOString()); return create(...args);
    };
    for (let attempt = 0; attempt < 5; attempt++) {
      h.database.exec('DELETE FROM managed_risk_lock'); await h.engine.tick();
      expect(h.runtime.getStrategy(record.id)).toMatchObject({ status: 'RUNNING', progress: 0 });
    }
    expect(h.gateway.createAttempts).toHaveLength(0);
    h.database.exec('DELETE FROM managed_risk_lock'); h.runtime.createOrder = create;
    const resumed = h.engine.tick(); await waitFor(() => h.gateway.createdOrders.length === 1);
    ackOrder(h.runtime, 'remote-1', 'FILLED', '0.05', '100'); await resumed;
    expect(h.runtime.getStrategy(record.id)).toMatchObject({ status: 'RUNNING', progress: 50 });
    now += 1_000;
    const finalSlice = h.engine.tick(); await waitFor(() => h.gateway.createdOrders.length === 2);
    ackOrder(h.runtime, 'remote-2', 'FILLED', '0.05', '100'); await finalSlice;
    expect(h.runtime.getStrategy(record.id).status).toBe('COMPLETED'); expect(h.gateway.createAttempts).toHaveLength(2);
  });

  it('does not consume residual exit repair attempts when both close legs are locally deferred', async () => {
    const h = await createHarness(); h.markets.set('GATE_FUTURE_SKHY_USDT', '229.9', '230'); h.markets.set('GATE_FUTURE_SKHYNIX_USDT', '1700', '1700');
    const record = await h.engine.startStrategy({ kind: 'premium', asset: 'SKHY', hedgeAsset: 'SKHYNIX', adrRatio: '10',
      hedgeMode: 'SHARE_RATIO', leftVenue: 'GATE', rightVenue: 'GATE', leftSide: 'SELL', rightSide: 'BUY',
      entryPremiumPct: '35', takeProfitPremiumPct: '24', maxPosition: '0.3', perOrderQuantity: '0.1', reduceOnly: false, executionMethod: 'TAKER_TAKER' });
    for (let clip = 0; clip < 2; clip++) {
      const pending = h.engine.tick(); await waitFor(() => h.gateway.createdOrders.length === (clip + 1) * 2);
      ackOrder(h.runtime, `remote-${clip * 2 + 1}`, 'FILLED', '0.1', '229.9');
      ackOrder(h.runtime, `remote-${clip * 2 + 2}`, 'FILLED', '0.01', '1700'); await pending;
    }
    const create = h.runtime.createOrder.bind(h.runtime);
    h.runtime.createOrder = async (...args) => {
      h.database.prepare('INSERT OR REPLACE INTO managed_risk_lock VALUES (1, ?, ?)')
        .run('managed_account_rechecking', new Date().toISOString()); return create(...args);
    };
    h.markets.set('GATE_FUTURE_SKHY_USDT', '143.78', '143.8');
    for (let attempt = 0; attempt < 5; attempt++) {
      h.database.exec('DELETE FROM managed_risk_lock'); await h.engine.tick();
      expect(h.runtime.getStrategy(record.id).status).toBe('RUNNING');
    }
    expect(h.gateway.createAttempts).toHaveLength(4); expect(h.runtime.getStrategy(record.id).openPosition).toBe('0.2');
    h.database.exec('DELETE FROM managed_risk_lock'); h.runtime.createOrder = create;
    const resumed = h.engine.tick(); await waitFor(() => h.gateway.createdOrders.length === 6);
    expect(h.gateway.createdOrders.slice(4).every(order => order.reduce_only === 'true')).toBe(true);
    ackOrder(h.runtime, 'remote-5', 'FILLED', '0.1', '143.8'); ackOrder(h.runtime, 'remote-6', 'FILLED', '0.01', '1700');
    await waitFor(() => h.gateway.createdOrders.length === 8);
    expect(h.gateway.createdOrders.slice(6)).toEqual(expect.arrayContaining([
      expect.objectContaining({ symbol: 'GATE_FUTURE_SKHY_USDT', qty: '0.1', reduce_only: 'true' }),
      expect.objectContaining({ symbol: 'GATE_FUTURE_SKHYNIX_USDT', qty: '0.01', reduce_only: 'true' }),
    ]));
    ackOrder(h.runtime, 'remote-7', 'FILLED', '0.1', '143.8'); ackOrder(h.runtime, 'remote-8', 'FILLED', '0.01', '1700'); await resumed;
    expect(h.gateway.createAttempts).toHaveLength(8); expect(h.runtime.getStrategy(record.id).openPosition).toBe('0');
  });
});

describe('strategy engine', () => {
  it.each([false, true])('retains order responsibility through a margin fault and uncertain maker cancellation, partial=%s', async partial => {
    vi.useFakeTimers(); let monitor!: MarginRiskMonitor, broken = false, activeHarness: Harness | undefined;
    try {
      const { h, record } = await managedDeferralHarness('MAKER_TAKER', {}, h => {
        const query = h.gateway.queryAccount.bind(h.gateway);
        h.gateway.queryAccount = async (...args) => { if (broken) throw new GateApiError(503, 'TEMPORARY'); return { ...await query(...args), user_id: 'synthetic' }; };
        monitor = createMarginRiskService({ db: h.database, gateway: h.gateway, runtime: h.runtime, manager: h.manager!, engine: h.engine,
          markets: h.markets, context: () => 'account-1:1', profile: () => ({ id: 'account-1', label: 'Synthetic' }),
          credentials: async () => ({ apiKey: 'synthetic', apiSecret: 'synthetic' }), live: () => true, enforce: false });
      });
      activeHarness = h;
      await h.engine.tick(); expect(h.gateway.createdOrders).toHaveLength(1);
      h.gateway.holdCancellations = true; broken = true; await monitor.refresh();
      if (partial) {
        ackOrder(h.runtime, 'remote-1', 'PARTIALLY_FILLED', '0.05', '110');
        h.gateway.positions = [futuresPosition('BINANCE_FUTURE_BTC_USDT', 'SHORT', '0.05')];
        const query = h.gateway.queryOrder.bind(h.gateway);
        h.gateway.queryOrder = async (...args) => ({ ...await query(...args), executed_qty: '0.05' });
      }
      await vi.advanceTimersByTimeAsync(1); await h.manager!.tick(); const checking = h.engine.tick(); await vi.advanceTimersByTimeAsync(500); await checking;
      const start = h.database.prepare('SELECT created_at FROM managed_risk_lock').get();
      await vi.advanceTimersByTimeAsync(24000); await monitor.refresh();
      expect(h.database.prepare('SELECT created_at FROM managed_risk_lock').get()).toEqual(start);
      await vi.advanceTimersByTimeAsync(1001); broken = false; await monitor.refresh(); h.session.set('live'); let finalDone = false; const finalTick = h.engine.tick().finally(() => { finalDone = true; });
      for (let i = 0; i < 20 && !finalDone; i++) await vi.advanceTimersByTimeAsync(500);
      expect(finalDone).toBe(true); await finalTick;
      expect(h.gateway.createdOrders).toHaveLength(1); expect(h.gateway.cancelledOrders).toHaveLength(1);
      expect(h.database.prepare('SELECT reason FROM managed_risk_lock').get()).toBeTruthy();
      expect(h.database.prepare('SELECT count(*) n FROM managed_position_claims WHERE strategy_id=?').get(record.id)).toEqual({ n: 2 });
      expect(h.runtime.listOrders()[0].executedQuantity).toBe(partial ? '0.05' : '0');
    } finally {
      // Resolve only the synthetic order after all safety assertions, so shutdown never waits on a frozen clock.
      if (activeHarness) {
        activeHarness.gateway.holdCancellations = false;
        ackOrder(activeHarness.runtime, 'remote-1', 'CANCELLED', partial ? '0.05' : '0', '110');
        const stop = activeHarness.engine.stop(); await vi.advanceTimersByTimeAsync(1000); await stop;
      }
      await monitor?.stop(); vi.useRealTimers();
    }
  });
  it('risk-pauses an owned residual when native identity expires inside repair admission with no min-notional', async () => {
    let expired = false;
    const { h, record } = await managedDeferralHarness('TAKER_TAKER', {}, h => {
      const market = h.markets.market.bind(h.markets);
      h.markets.market = symbol => { const q = market(symbol); return q ? { ...q, source: 'native_venue', nativeSymbol: symbol,
        nativeValidUntil: Date.now() + (expired ? -1 : 60000) } : q; };
    });
    seedFilledStrategyOrder(h.database, record.id, 'repair-owned-left', 'BINANCE_FUTURE_BTC_USDT', 'SELL', '0.1', 'left');
    h.gateway.positions = [futuresPosition('BINANCE_FUTURE_BTC_USDT', 'SHORT', '0.1')];
    expect(h.database.prepare('SELECT min_notional FROM crossex_instruments WHERE symbol=?').get('OKX_FUTURE_BTC_USDT')).toEqual({ min_notional: null });
    h.runtime.setMarginAdmission(async () => { await Promise.resolve(); expired = true; });
    await h.engine.tick();
    expect(h.gateway.createdOrders).toHaveLength(0);
    expect(h.runtime.listOrders()).toEqual([expect.objectContaining({ id: 'repair-owned-left', state: 'FILLED', executedQuantity: '0.1' })]);
    expect(h.database.prepare('SELECT reason FROM managed_risk_lock').get()).toEqual({ reason: 'strategy_repair_quote_unavailable' });
    expect(h.database.prepare('SELECT count(*) n FROM managed_position_claims WHERE strategy_id=?').get(record.id)).toEqual({ n: 2 });
    expired = false; h.session.set('live'); await h.engine.tick();
    expect(h.gateway.createdOrders).toHaveLength(0);
    expect(h.runtime.getStrategy(record.id).management?.phase).toBe('RISK_PAUSED');
  });
  it.each(['padding', 'trim'])('retains terminal residual responsibility when native identity expires before %s submission', async stage => {
    const h = await createHarness(); let expired = false;
    h.markets.set('BINANCE_FUTURE_BTC_USDT', '54.2', '54.3'); h.markets.set('OKX_FUTURE_BTC_USDT', '54', '54.1');
    const market = h.markets.market.bind(h.markets);
    h.markets.market = symbol => { const q = market(symbol); return q ? { ...q, source: 'native_venue', nativeSymbol: symbol,
      nativeValidUntil: Date.now() + (expired ? -1 : 60000) } : q; };
    h.database.prepare("UPDATE crossex_instruments SET min_size='0.01', min_notional='5', lot_size='0.01'").run();
    const record = await h.engine.startStrategy({ ...takerTakerConfig, totalAmount: '1', perOrderQuantity: '1', executionMethod: 'MAKER_TAKER', makerLeg: 'right' });
    seedFilledStrategyOrder(h.database, record.id, 'pad-left', 'BINANCE_FUTURE_BTC_USDT', 'SELL', '1', 'left');
    seedFilledStrategyOrder(h.database, record.id, 'pad-right', 'OKX_FUTURE_BTC_USDT', 'BUY', '1.03', 'right');
    const getCredentials = h.vault.get.bind(h.vault);
    h.vault.get = async (...args) => {
      const credentials = await getCredentials(...args);
      if (stage === 'padding' || h.gateway.createdOrders.length === 1) expired = true;
      return credentials;
    };
    const tick = h.engine.tick();
    if (stage === 'trim') {
      await waitFor(() => h.gateway.createdOrders.length === 1);
      ackOrder(h.runtime, 'remote-1', 'FILLED', '0.11', '54.1');
    }
    await tick;
    expect(expired).toBe(true);
    expect(h.gateway.createdOrders).toHaveLength(stage === 'padding' ? 0 : 1);
    expect(h.runtime.getStrategy(record.id).status).toBe('PAUSED');
    expect(h.runtime.listOrders().filter(o => o.state === 'FILLED')).toHaveLength(stage === 'padding' ? 2 : 3);
    if (stage === 'trim') expect(h.runtime.listOrders().find(o => o.remoteOrderId === 'remote-1')).toMatchObject({ state: 'FILLED', executedQuantity: '0.11' });
    expired = false; h.session.set('live'); await h.engine.tick();
    expect(h.gateway.createdOrders).toHaveLength(stage === 'padding' ? 0 : 1);
  });
  it('blocks both native taker legs if quote metadata expires during asynchronous admission', async () => {
    let expired = false;
    const { h } = await managedDeferralHarness('TAKER_TAKER', {}, h => {
      const market = h.markets.market.bind(h.markets);
      h.markets.market = symbol => { const q = market(symbol); return q ? { ...q, source: 'native_venue', nativeSymbol: symbol,
        nativeValidUntil: Date.now() + (expired ? -1 : 60000) } : q; };
      h.markets.setConnectionState('reconnecting');
    });
    h.runtime.setMarginAdmission(async () => { expired = true; });
    await h.engine.tick(); expect(h.gateway.createdOrders).toHaveLength(0); expect(h.runtime.listOrders()).toHaveLength(0);
  });
  it.each([false, true])('uses native quotes at the real order boundary and rejects metadata expiring during admission: %s', async expire => {
    let expired = false;
    const { h } = await managedDeferralHarness('MAKER_TAKER', {}, h => {
      const market = h.markets.market.bind(h.markets);
      h.markets.market = symbol => { const q = market(symbol); return q ? { ...q, source: 'native_venue',
        nativeSymbol: symbol.startsWith('BINANCE') ? 'BTCUSDT' : 'BTC-USDT-SWAP', nativeValidUntil: Date.now() + (expired ? -1 : 60000) } : q; };
      h.markets.setConnectionState('reconnecting');
    });
    h.runtime.setMarginAdmission(async () => { if (expire) expired = true; });
    await h.engine.tick();
    expect(h.gateway.createdOrders).toHaveLength(expire ? 0 : 1);
    if (!expire) expect(h.gateway.createdOrders[0]).toMatchObject({ symbol: 'BINANCE_FUTURE_BTC_USDT', qty: '0.1', reduce_only: 'false' });
  });
  it.each(['authorization', 'identity', 'expired'])('never auto-resumes a margin %s fault', async fault => {
    vi.useFakeTimers(); let monitor!: MarginRiskMonitor, broken = false;
    try {
      const { h, record } = await managedDeferralHarness('MAKER_TAKER', {}, h => {
        const query = h.gateway.queryAccount.bind(h.gateway);
        h.gateway.queryAccount = async (...args) => {
          if (broken && fault !== 'identity') throw new GateApiError(fault === 'authorization' ? 403 : 503, 'UNAVAILABLE');
          return { ...await query(...args), user_id: broken ? 'wrong-user' : 'synthetic-user' };
        };
        monitor = createMarginRiskService({ db: h.database, gateway: h.gateway, runtime: h.runtime, manager: h.manager!, engine: h.engine,
          markets: h.markets, context: () => 'account-1:1', profile: () => ({ id: 'account-1', label: 'Synthetic' }),
          credentials: async () => ({ apiKey: 'synthetic', apiSecret: 'synthetic' }), live: () => true, enforce: false });
      });
      broken = true; await monitor.refresh();
      if (fault === 'expired') await vi.advanceTimersByTimeAsync(25001);
      broken = false; await monitor.refresh(); h.session.set('live'); await h.manager!.tick(); await h.engine.tick();
      expect(h.gateway.createdOrders).toHaveLength(0);
      expect(h.database.prepare('SELECT reason FROM managed_risk_lock').get()).toBeTruthy();
      expect(h.runtime.getStrategy(record.id).management?.phase).toBe('RISK_PAUSED');
      expect(h.database.prepare('SELECT count(*) n FROM managed_position_claims WHERE strategy_id=?').get(record.id)).toEqual({ n: 2 });
    } finally { await monitor?.stop(); vi.useRealTimers(); }
  });
  it('continues the original unfilled target after a fourteen-second margin read fault and two new margin observations', async () => {
    vi.useFakeTimers(); let monitor!: MarginRiskMonitor, failed = false;
    try {
      const { h, record } = await managedDeferralHarness('MAKER_TAKER', {}, h => {
        const query = h.gateway.queryAccount.bind(h.gateway);
        h.gateway.queryAccount = async (...args) => {
          if (failed) throw new GateApiError(200, 'NETWORK_ERROR', undefined, { endpoint: '/crossex/accounts', phase: 'body' });
          return { ...await query(...args), user_id: 'synthetic-user' };
        };
        monitor = createMarginRiskService({ db: h.database, gateway: h.gateway, runtime: h.runtime, manager: h.manager!, engine: h.engine,
          markets: h.markets, context: () => 'account-1:1', profile: () => ({ id: 'account-1', label: 'Synthetic' }),
          credentials: async () => ({ apiKey: 'synthetic', apiSecret: 'synthetic' }), live: () => true, enforce: false });
      });
      const group = h.runtime.getStrategy(record.id).management?.groupId;
      failed = true; await monitor.refresh(); await h.engine.tick();
      expect(h.gateway.createdOrders).toHaveLength(0);
      expect(h.runtime.getStrategy(record.id).management?.phase).toBe('OPENING');
      await vi.advanceTimersByTimeAsync(14000); failed = false;
      await monitor.refresh(); await h.manager!.tick(); await h.manager!.tick();
      expect(h.database.prepare('SELECT reason FROM managed_risk_lock').get()).toMatchObject({ reason: 'managed_account_rechecking' });
      await vi.advanceTimersByTimeAsync(2001); await monitor.refresh(); await h.manager!.tick();
      expect(h.database.prepare('SELECT reason FROM managed_risk_lock').get()).toBeUndefined();
      h.markets.set('BINANCE_FUTURE_BTC_USDT', '110', '111'); h.markets.set('OKX_FUTURE_BTC_USDT', '99', '100');
      await h.engine.tick();
      expect(h.gateway.createdOrders).toHaveLength(1);
      expect(h.gateway.createdOrders[0]).toMatchObject({ qty: '0.1', reduce_only: 'false' });
      expect(h.runtime.getStrategy(record.id)).toMatchObject({ status: 'RUNNING', filledQuantity: '0', management: { phase: 'OPENING', groupId: group } });
      expect(h.database.prepare('SELECT count(*) n FROM managed_position_claims WHERE strategy_id=?').get(record.id)).toEqual({ n: 2 });
    } finally { await monitor?.stop(); vi.useRealTimers(); }
  });
  it('globally pauses when a margin cancellation races a one-sided fill', async () => {
    const h = await createHarness();
    h.manager = new ManagedPositionManager(h.database, h.session, h.runtime, h.markets, {
      activeAccount: () => null, account: async () => ({ positions: [], openOrders: [] }), funding: () => null,
      refreshFunding: async () => undefined, riskPause: () => undefined,
    }); h.engine.setPositionManager(h.manager);
    h.markets.set('BINANCE_FUTURE_BTC_USDT', '99', '100'); h.markets.set('OKX_FUTURE_BTC_USDT', '99', '100');
    const record = await h.engine.startStrategy(takerTakerConfig);
    const first = await h.runtime.createOrder({ symbol: 'BINANCE_FUTURE_BTC_USDT', side: 'SELL', type: 'LIMIT', price: '101', quantity: '0.1' }, { strategyId: record.id, strategyLeg: 'left' });
    await h.runtime.createOrder({ symbol: 'OKX_FUTURE_BTC_USDT', side: 'BUY', type: 'LIMIT', price: '99', quantity: '0.1' }, { strategyId: record.id, strategyLeg: 'right' });
    const query = h.gateway.queryOrder.bind(h.gateway);
    h.gateway.queryOrder = async (credentials, id) => ({ ...await query(credentials, id), executed_qty: id === first.remoteOrderId ? '0.1' : '0', executed_avg_price: '100' });
    await expect(h.engine.haltForMarginRisk()).rejects.toMatchObject({ code: 'margin_cancel_exposure_changed' });
    expect(h.session.current).toBe('readonly');
    expect(h.database.prepare('SELECT reason FROM managed_risk_lock').get()).toMatchObject({ reason: 'margin_cancel_exposure_changed' });
    expect(h.gateway.createdOrders).toHaveLength(2);
  });
  it('budgets increased margin on existing holdings before automatically lowering leverage', async () => {
    const h = await createHarness(); h.gateway.availableMargin = '20';
    h.gateway.positions = [{ ...futuresPosition('BINANCE_FUTURE_BTC_USDT', 'SHORT', '1'), leverage: '100', position_value: '10000', initial_margin: '100' }];
    await expect(h.runtime.prepareStrategyMargin([{ symbol: 'BINANCE_FUTURE_BTC_USDT', venue: 'BINANCE', side: 'SELL',
      leverage: '50', estimatedPrice: '10000', estimatedQuantity: '0.001' }])).rejects.toMatchObject({ code: 'insufficient_strategy_margin' });
    expect(h.gateway.leverageUpdates).toEqual([]);
  });
  it('persists an ordinary margin pause through later ticks and live reactivation', async () => {
    const h = await createHarness();
    h.markets.set('BINANCE_FUTURE_BTC_USDT', '99', '100'); h.markets.set('OKX_FUTURE_BTC_USDT', '99', '100');
    const record = await h.engine.startStrategy(takerTakerConfig);
    await h.engine.haltForMarginRisk(); await h.engine.tick();
    expect(h.runtime.getStrategy(record.id).status).toBe('PAUSED');
    h.engine.activatePersistedStrategies(); await h.engine.tick();
    expect(h.runtime.getStrategy(record.id).status).toBe('PAUSED'); expect(h.engine.listActiveStrategyIds()).not.toContain(record.id);
    expect(h.gateway.createdOrders).toHaveLength(0);
  });
  it('prepares delayed CRO quotes before validating the managed exit clip', async () => {
    const { h, symbols, prepare, launch, counts } = await managedCroHarness();
    prepare(() => { setTimeout(() => h.markets.set(symbols[0], '0.0627', '0.0628'), 20); });
    const record = await launch();
    expect(record.status).toBe('RUNNING');
    expect(counts()).toEqual({ prepared: 1, released: 1 });
    expect(h.gateway.createdOrders).toHaveLength(0);
  });
  it.each(['missing', 'expired', 'delayed', 'other-leg'] as const)('rejects %s managed entry quotes as unavailable and releases claims', async (scenario) => {
    const { h, symbols, prepare, launch, counts } = await managedCroHarness();
    const old = new Date(Date.now() - 20000).toISOString();
    if (scenario === 'expired') h.markets.set(symbols[0], '0.0627', '0.0628', old, old);
    if (scenario === 'delayed') h.markets.set(symbols[0], '0.0627', '0.0628', new Date(Date.now() - 5000).toISOString(), new Date().toISOString());
    if (scenario === 'other-leg') { h.markets.set(symbols[0], '0.0627', '0.0628'); h.markets.set(symbols[1], '0', '0'); }
    prepare(() => undefined);
    await expect(launch()).rejects.toMatchObject({ code: 'strategy_market_data_unavailable', label: symbols[scenario === 'other-leg' ? 1 : 0] });
    expect(counts()).toEqual({ prepared: 1, released: 1 });
    expect(h.database.prepare('SELECT count(*) n FROM managed_position_claims').get()).toEqual({ n: 0 });
    expect(h.runtime.listStrategies()).toHaveLength(0);
    expect(h.gateway.createdOrders).toHaveLength(0); expect(h.gateway.leverageUpdates).toHaveLength(0);
  });
  it('cancels managed quote preparation when trading is locked', async () => {
    const { h, prepare, launch } = await managedCroHarness();
    prepare(() => { setTimeout(() => h.session.set('readonly'), 20); });
    await expect(launch()).rejects.toMatchObject({ code: 'live_trading_locked' });
    expect(h.database.prepare('SELECT count(*) n FROM managed_position_claims').get()).toEqual({ n: 0 });
    expect(h.gateway.createdOrders).toHaveLength(0); expect(h.gateway.leverageUpdates).toHaveLength(0);
  });
  it('hands a managed target to persistent monitoring and blocks overlapping legacy starts', async () => {
    const h = await createHarness();
    h.markets.set('BINANCE_FUTURE_BTC_USDT', '100150', '100151');
    h.markets.set('OKX_FUTURE_BTC_USDT', '99999', '100000');
    h.manager = new ManagedPositionManager(h.database, h.session, h.runtime, h.markets, {
      activeAccount: () => 'account-1', account: async () => ({ positions: h.gateway.positions, openOrders: [] }),
      funding: () => null, refreshFunding: async () => undefined, riskPause: () => { void h.engine.pauseForManagedRisk(); },
    });
    h.engine.setPositionManager(h.manager);
    const record = await h.engine.startStrategy({ ...takerTakerConfig, totalAmount: '0.1', management: { perOrderQuantity: '0.1' } }, { profileId: 'account-1', label: 'Test' });
    await expect(h.engine.startStrategy(takerTakerConfig)).rejects.toMatchObject({ code: 'managed_position_owned' });
    const tick = h.engine.tick(); await waitFor(() => h.gateway.createdOrders.length === 2);
    h.gateway.positions = [futuresPosition('BINANCE_FUTURE_BTC_USDT', 'SHORT', '0.1'), futuresPosition('OKX_FUTURE_BTC_USDT', 'LONG', '0.1')];
    ackOrder(h.runtime, 'remote-1', 'FILLED', '0.1', '100150'); ackOrder(h.runtime, 'remote-2', 'FILLED', '0.1', '100000');
    await tick; await h.manager.tick();
    expect(h.runtime.getStrategy(record.id)).toMatchObject({ status: 'RUNNING', management: { phase: 'MONITORING' }, openPosition: '0.1' });
    expect(h.engine.listActiveStrategyIds()).not.toContain(record.id);
    await h.engine.tick(); expect(h.gateway.createdOrders).toHaveLength(2);
    await h.engine.stopStrategy(record.id);
    expect(h.runtime.getStrategy(record.id)).toMatchObject({ status: 'STOPPED', management: { phase: 'STOPPED', exitRequested: false } });
    expect(h.gateway.createdOrders).toHaveLength(2);
    await h.engine.stopStrategy(record.id, true);
    expect(h.runtime.getStrategy(record.id)).toMatchObject({ status: 'RUNNING', management: { phase: 'EXITING', exitRequested: true } });
  });
  it('executes only the addition, hands off actual combined holdings, and keeps them on default Stop', async () => {
    const h = await createHarness();
    const symbols = ['BINANCE_FUTURE_BTC_USDT', 'OKX_FUTURE_BTC_USDT'];
    h.markets.set(symbols[0], '100150', '100151'); h.markets.set(symbols[1], '99999', '100000');
    h.gateway.positions = [futuresPosition(symbols[0], 'SHORT', '0.2'), futuresPosition(symbols[1], 'LONG', '0.2')];
    h.manager = new ManagedPositionManager(h.database, h.session, h.runtime, h.markets, {
      activeAccount: () => 'account-1', account: async () => ({ positions: h.gateway.positions, openOrders: [] }),
      funding: () => null, refreshFunding: async () => undefined, riskPause: () => { void h.engine.pauseForManagedRisk(); },
    });
    h.engine.setPositionManager(h.manager);
    const record = await h.engine.startStrategy({ ...takerTakerConfig, totalAmount: '0.1',
      management: { adoptExisting: true, perOrderQuantity: '0.1' } }, { profileId: 'account-1', label: 'Test' });
    expect(record.management).toMatchObject({ adoptedLeft: '0.2', adoptedRight: '0.2' });
    const tick = h.engine.tick(); await waitFor(() => h.gateway.createdOrders.length === 2);
    expect(h.gateway.createdOrders.map((o) => o.qty)).toEqual(['0.1', '0.1']);
    h.gateway.positions = [futuresPosition(symbols[0], 'SHORT', '0.3'), futuresPosition(symbols[1], 'LONG', '0.3')];
    ackOrder(h.runtime, 'remote-1', 'FILLED', '0.1', '100150'); ackOrder(h.runtime, 'remote-2', 'FILLED', '0.1', '100000');
    await tick; await h.manager.tick();
    expect(h.runtime.getStrategy(record.id)).toMatchObject({ filledQuantity: '0.1', progress: 100, openPosition: '0.3',
      management: { phase: 'MONITORING', leftQuantity: '0.3', rightQuantity: '0.3' } });
    await h.engine.stopStrategy(record.id); await h.manager.tick(); await h.engine.tick();
    expect(h.runtime.getStrategy(record.id)).toMatchObject({ status: 'STOPPED', openPosition: '0.3' });
    expect(h.gateway.createdOrders).toHaveLength(2);
    await h.engine.resumeStrategy(record.id, 'account-1'); await h.manager.tick(); await h.engine.tick();
    expect(h.runtime.getStrategy(record.id).management?.phase).toBe('MONITORING'); expect(h.gateway.createdOrders).toHaveLength(2);
  });
  it('closes a position in the requested number of timed reduce-only slices', async () => {
    let now = Date.now();
    const { engine, runtime, gateway, markets } = await createHarness({ now: () => now });
    const symbol = 'BINANCE_FUTURE_BTC_USDT';
    markets.set(symbol, '100000', '100001', new Date(now).toISOString());
    gateway.positions = [futuresPosition(symbol, 'LONG', '0.1')];

    const record = await engine.startStrategy({
      kind: 'position', asset: 'BTC', leftVenue: 'BINANCE', rightVenue: 'BINANCE',
      leftSide: 'SELL', rightSide: 'BUY', totalAmount: '0.1', perOrderQuantity: '0.03',
      reduceOnly: true, executionMethod: 'TAKER_TAKER',
      closePlan: {
        orderCount: 3,
        intervalSeconds: 5,
        targets: [{ symbol, side: 'SELL', quantity: '0.1', positionSide: 'NONE' }],
      },
    });
    expect(record).toMatchObject({ status: 'RUNNING', kind: 'position', config: { closePlan: { orderCount: 3, intervalSeconds: 5 } } });

    // Strategy timestamps use the wall clock. Anchor the injected clock after creation so slower
    // runners cannot leave the first close slice scheduled in the future.
    now = Date.parse(record.createdAt) + 100;
    const firstTick = engine.tick();
    await waitFor(() => gateway.createdOrders.length === 1);
    expect(gateway.createdOrders[0]).toMatchObject({ symbol, side: 'SELL', qty: '0.03333333', reduce_only: 'true' });
    ackOrder(runtime, 'remote-1', 'FILLED', '0.03333333', '100000');
    await firstTick;

    now += 4_999;
    await engine.tick();
    expect(gateway.createdOrders).toHaveLength(1);

    now += 1;
    const secondTick = engine.tick();
    await waitFor(() => gateway.createdOrders.length === 2);
    expect(gateway.createdOrders[1]?.qty).toBe('0.03333333');
    ackOrder(runtime, 'remote-2', 'FILLED', '0.03333333', '100000');
    await secondTick;

    now += 5_000;
    const finalTick = engine.tick();
    await waitFor(() => gateway.createdOrders.length === 3);
    expect(gateway.createdOrders[2]?.qty).toBe('0.03333334');
    ackOrder(runtime, 'remote-3', 'FILLED', '0.03333334', '100000');
    await finalTick;

    expect(runtime.getStrategy(record.id)).toMatchObject({ status: 'COMPLETED', progress: 100, filledQuantity: '3' });
    expect(runtime.listOrders().filter((order) => order.strategyId === record.id).every((order) => order.reduceOnly)).toBe(true);
  });

  it('submits every Close all target together in each timed slice', async () => {
    let now = Date.now();
    const { engine, runtime, gateway, markets } = await createHarness({ now: () => now });
    const longSymbol = 'BINANCE_FUTURE_BTC_USDT';
    const shortSymbol = 'OKX_FUTURE_BTC_USDT';
    markets.set(longSymbol, '100000', '100001', new Date(now).toISOString());
    markets.set(shortSymbol, '99999', '100000', new Date(now).toISOString());
    gateway.positions = [futuresPosition(longSymbol, 'LONG', '0.1'), futuresPosition(shortSymbol, 'SHORT', '0.2')];
    const record = await engine.startStrategy({
      kind: 'position', asset: 'BTC', leftVenue: 'BINANCE', rightVenue: 'OKX',
      leftSide: 'SELL', rightSide: 'BUY', totalAmount: '0.1', perOrderQuantity: '0.1',
      reduceOnly: true, executionMethod: 'TAKER_TAKER',
      closePlan: {
        orderCount: 2,
        intervalSeconds: 3,
        targets: [
          { symbol: longSymbol, side: 'SELL', quantity: '0.1', positionSide: 'NONE' },
          { symbol: shortSymbol, side: 'BUY', quantity: '0.2', positionSide: 'NONE' },
        ],
      },
    });

    now = Date.parse(record.createdAt) + 100;
    const firstTick = engine.tick();
    await waitFor(() => gateway.createdOrders.length === 2);
    expect(gateway.createdOrders).toEqual(expect.arrayContaining([
      expect.objectContaining({ symbol: longSymbol, side: 'SELL', qty: '0.05', reduce_only: 'true' }),
      expect.objectContaining({ symbol: shortSymbol, side: 'BUY', qty: '0.1', reduce_only: 'true' }),
    ]));
    ackOrder(runtime, 'remote-1', 'FILLED', '0.05', '100000');
    ackOrder(runtime, 'remote-2', 'FILLED', '0.1', '100000');
    await firstTick;

    now += 3_000;
    const secondTick = engine.tick();
    await waitFor(() => gateway.createdOrders.length === 4);
    ackOrder(runtime, 'remote-3', 'FILLED', '0.05', '100000');
    ackOrder(runtime, 'remote-4', 'FILLED', '0.1', '100000');
    await secondTick;

    expect(runtime.getStrategy(record.id)).toMatchObject({ status: 'COMPLETED', progress: 100 });
    expect(new Set(runtime.listOrders().filter((order) => order.strategyId === record.id).map((order) => order.strategyClip)))
      .toEqual(new Set(['close-0', 'close-1']));
  });

  it('routes the canonical SKHYNIX asset through Hyperliquid native SKHX', async () => {
    const { engine, gateway, markets } = await createHarness();
    markets.set('GATE_FUTURE_SKHYNIX_USDT', '1081', '1082');
    markets.set('HYPERLIQUID_FUTURE_SKHX_USDC', '1080', '1081');

    const record = await engine.startStrategy({
      ...takerTakerConfig,
      asset: 'SKHYNIX',
      leftVenue: 'GATE',
      rightVenue: 'HYPERLIQUID',
      entryBps: '1000',
    });

    expect(record.status).toBe('RUNNING');
    expect(gateway.leverageQueries.flat()).toContain('HYPERLIQUID_FUTURE_SKHX_USDC');
    expect(gateway.leverageQueries.flat()).not.toContain('HYPERLIQUID_FUTURE_SKHYNIX_USDC');
  });

  it('refuses to start strategies while live trading is locked', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'gate-crossex-engine-locked-'));
    const config = loadConfig({ GCT_DATA_DIR: directory, GCT_MIGRATIONS_DIR: resolve(process.cwd(), '../../migrations') });
    const database = openDatabase(config.databasePath, config.migrationsDir);
    const vault = new MemoryCredentialVault();
    const gateway = new ScriptedGateway();
    // A freshly constructed session is 'unset': the boot state before anyone accepts the disclaimer.
    const lockedSession = new TradingSession();
    const runtime = new TradingRuntime(database, lockedSession, vault, gateway);
    const markets = new StubMarkets(database);
    markets.set('BINANCE_FUTURE_BTC_USDT', '100000', '100001');
    markets.set('OKX_FUTURE_BTC_USDT', '99900', '99901');
    const engine = new StrategyEngine(database, lockedSession, runtime, markets);
    await expect(engine.startStrategy(takerTakerConfig)).rejects.toMatchObject({ code: 'live_trading_locked' });
    await engine.stop();
    database.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it('rejects auto strategies whose take profit is not below entry', async () => {
    const { engine, markets } = await createHarness();
    markets.set('BINANCE_FUTURE_BTC_USDT', '100000', '100001');
    markets.set('OKX_FUTURE_BTC_USDT', '99900', '99901');
    await expect(engine.startStrategy({
      ...takerTakerConfig, kind: 'auto', maxPosition: '0.2', takeProfitBps: '10',
    })).rejects.toMatchObject({ code: 'take_profit_must_be_below_entry' });
  });

  it('rejects a strategy when a per-order clip is below a selected exchange minimum', async () => {
    const { engine, database, markets } = await createHarness();
    markets.set('BINANCE_FUTURE_BTC_USDT', '100000', '100001');
    markets.set('OKX_FUTURE_BTC_USDT', '99900', '99901');
    database.prepare("UPDATE crossex_instruments SET min_size = '0.2', lot_size = '0.1' WHERE symbol = 'OKX_FUTURE_BTC_USDT'").run();

    await expect(engine.startStrategy(takerTakerConfig)).rejects.toMatchObject({
      code: 'strategy_order_below_minimum_size',
      label: 'OKX_FUTURE_BTC_USDT: 0.1 < 0.2',
    });
  });

  it('rejects a final target remainder that would create an undersized order', async () => {
    const { engine, database, markets } = await createHarness();
    markets.set('BINANCE_FUTURE_BTC_USDT', '100000', '100001');
    markets.set('OKX_FUTURE_BTC_USDT', '99900', '99901');
    database.prepare("UPDATE crossex_instruments SET min_size = '0.1', lot_size = '0.1' WHERE symbol LIKE '%_FUTURE_BTC_USDT'").run();

    await expect(engine.startStrategy({ ...takerTakerConfig, totalAmount: '0.15' })).rejects.toMatchObject({
      code: 'strategy_order_below_minimum_size',
    });
  });

  it('rejects a configured clip below the instrument minimum notional', async () => {
    const { engine, database, markets } = await createHarness();
    markets.set('BINANCE_FUTURE_BTC_USDT', '54.2', '54.3');
    markets.set('OKX_FUTURE_BTC_USDT', '54', '54.1');
    database.prepare("UPDATE crossex_instruments SET min_size = '0.01', min_notional = '5', lot_size = '0.01' WHERE symbol LIKE '%_FUTURE_BTC_USDT'").run();

    await expect(engine.startStrategy({
      ...takerTakerConfig, totalAmount: '0.09', perOrderQuantity: '0.09',
    })).rejects.toMatchObject({
      code: 'strategy_order_below_minimum_notional', statusCode: 400,
    });
  });

  it('rejects a paired strategy when its full target exceeds available margin', async () => {
    const { engine, runtime, gateway, markets } = await createHarness();
    gateway.availableMargin = '10000';
    markets.set('BINANCE_FUTURE_BTC_USDT', '100000', '100001');
    markets.set('OKX_FUTURE_BTC_USDT', '99999', '100000');

    await expect(engine.startStrategy({
      ...takerTakerConfig,
      totalAmount: '10',
      perOrderQuantity: '0.005',
      leftLeverage: '5',
      rightLeverage: '12',
    })).rejects.toMatchObject({ code: 'insufficient_strategy_margin', statusCode: 409 });

    expect(runtime.listStrategies()).toHaveLength(0);
    expect(gateway.leverageUpdates).toHaveLength(0);
    expect(gateway.createdOrders).toHaveLength(0);
  });

  it('uses unified available margin without applying venue asset-row caps in cross-exchange mode', async () => {
    const { engine, gateway, markets } = await createHarness();
    gateway.availableMargin = '100000';
    gateway.accountAssets = [
      {
        coin: 'USDT', exchange_type: 'BINANCE', balance: '0', upnl: '0', equity: '0',
        futures_initial_margin: '0', futures_maintenance_margin: '0', borrowing_initial_margin: '0',
        borrowing_maintenance_margin: '0', available_balance: '0', liability: '0',
      },
      {
        coin: 'USDT', exchange_type: 'OKX', balance: '1', upnl: '0', equity: '1',
        futures_initial_margin: '0', futures_maintenance_margin: '0', borrowing_initial_margin: '0',
        borrowing_maintenance_margin: '0', available_balance: '1', liability: '0',
      },
    ];
    markets.set('BINANCE_FUTURE_BTC_USDT', '100000', '100001');
    markets.set('OKX_FUTURE_BTC_USDT', '99999', '100000');

    const record = await engine.startStrategy(takerTakerConfig);

    expect(record.status).toBe('RUNNING');
  });

  it('queries and enforces each selected account top-level margin in isolated mode', async () => {
    const { engine, runtime, gateway, markets } = await createHarness();
    gateway.accountMode = 'ISOLATED_EXCHANGE';
    gateway.isolatedAvailableMargins = { BINANCE: '100000', OKX: '1' };
    markets.set('BINANCE_FUTURE_BTC_USDT', '100000', '100001');
    markets.set('OKX_FUTURE_BTC_USDT', '99999', '100000');

    await expect(engine.startStrategy(takerTakerConfig)).rejects.toMatchObject({
      code: 'insufficient_strategy_margin', statusCode: 409,
    });

    expect(gateway.accountQueries).toEqual([null, 'BINANCE', 'OKX']);
    expect(runtime.listStrategies()).toHaveLength(0);
  });

  it('executes a taker-taker paired position clip by clip and completes at the target', async () => {
    const { engine, runtime, gateway, markets } = await createHarness();
    // Sell BINANCE at 100050 bid, buy OKX at 100000 ask: spread = 50/100000 = 5 bps < 10 bps entry.
    markets.set('BINANCE_FUTURE_BTC_USDT', '100050', '100051');
    markets.set('OKX_FUTURE_BTC_USDT', '99999', '100000');
    const record = await engine.startStrategy(takerTakerConfig);
    expect(record.status).toBe('RUNNING');

    await engine.tick();
    expect(gateway.createdOrders).toHaveLength(0);

    // Widen the spread beyond the 10 bps entry threshold.
    markets.set('BINANCE_FUTURE_BTC_USDT', '100150', '100151');
    const firstTick = engine.tick();
    await waitFor(() => gateway.createdOrders.length === 2);
    const [leftOrder, rightOrder] = gateway.createdOrders;
    expect(leftOrder).toMatchObject({ symbol: 'BINANCE_FUTURE_BTC_USDT', side: 'SELL', type: 'MARKET', time_in_force: 'IOC', qty: '0.1' });
    expect(rightOrder).toMatchObject({ symbol: 'OKX_FUTURE_BTC_USDT', side: 'BUY', type: 'MARKET', time_in_force: 'IOC', qty: '0.1' });
    ackOrder(runtime, 'remote-1', 'FILLED', '0.1', '100150');
    ackOrder(runtime, 'remote-2', 'FILLED', '0.1', '100000');
    await firstTick;

    const midway = runtime.getStrategy(record.id);
    expect(midway.status).toBe('RUNNING');
    expect(midway.filledQuantity).toBe('0.1');
    expect(midway.progress).toBe(50);

    const secondTick = engine.tick();
    await waitFor(() => gateway.createdOrders.length === 4);
    ackOrder(runtime, 'remote-3', 'FILLED', '0.1', '100150');
    ackOrder(runtime, 'remote-4', 'FILLED', '0.1', '100000');
    await secondTick;
    await waitFor(() => runtime.getStrategy(record.id).status === 'COMPLETED');

    const completed = runtime.getStrategy(record.id);
    expect(completed.filledQuantity).toBe('0.2');
    expect(completed.progress).toBe(100);
    const strategyOrders = runtime.listOrders().filter((order) => order.strategyId === record.id);
    expect(strategyOrders).toHaveLength(4);
    expect(new Set(strategyOrders.map((order) => order.strategyLeg))).toEqual(new Set(['left', 'right']));
    await engine.tick();
    expect(gateway.createdOrders).toHaveLength(4);
  });

  it('coalesces overlapping ticks into a single latest follow-up pass', async () => {
    const { engine, runtime, gateway, markets } = await createHarness();
    markets.set('BINANCE_FUTURE_BTC_USDT', '100150', '100151');
    markets.set('OKX_FUTURE_BTC_USDT', '99999', '100000');
    const record = await engine.startStrategy({ ...takerTakerConfig, totalAmount: '1' });

    const first = engine.tick();
    await waitFor(() => gateway.createdOrders.length === 2);
    const superseded = Array.from({ length: 12 }, () => engine.tick());
    ackOrder(runtime, 'remote-1', 'FILLED', '0.1', '100150');
    ackOrder(runtime, 'remote-2', 'FILLED', '0.1', '100000');

    await waitFor(() => gateway.createdOrders.length === 4);
    ackOrder(runtime, 'remote-3', 'FILLED', '0.1', '100150');
    ackOrder(runtime, 'remote-4', 'FILLED', '0.1', '100000');
    await Promise.all([first, ...superseded]);

    expect(gateway.createdOrders).toHaveLength(4);
    expect(runtime.getStrategy(record.id).filledQuantity).toBe('0.2');
  });

  it('hedges the filled leg when the opposite taker leg fails to submit', async () => {
    const { engine, runtime, gateway, markets } = await createHarness();
    markets.set('BINANCE_FUTURE_BTC_USDT', '100150', '100151');
    markets.set('OKX_FUTURE_BTC_USDT', '99999', '100000');
    gateway.failCreate('OKX_FUTURE_BTC_USDT', 1);
    const record = await engine.startStrategy(takerTakerConfig);

    const firstTick = engine.tick();
    await waitFor(() => gateway.createdOrders.length === 1);
    ackOrder(runtime, 'remote-1', 'FILLED', '0.1', '100150');
    await firstTick;

    // The left leg filled 0.1 SELL with no right leg. The engine must repair by buying the lagging leg.
    const repairTick = engine.tick();
    await waitFor(() => gateway.createdOrders.length === 2);
    const repair = gateway.createdOrders[1];
    expect(repair).toMatchObject({ symbol: 'OKX_FUTURE_BTC_USDT', side: 'BUY', type: 'MARKET', qty: '0.1' });
    ackOrder(runtime, 'remote-2', 'FILLED', '0.1', '100010');
    await repairTick;

    const strategy = runtime.getStrategy(record.id);
    expect(strategy.status).toBe('RUNNING');
    expect(strategy.filledQuantity).toBe('0.1');
    const logs = runtime.strategyLogs(record.id);
    expect(logs.some((log) => log.event === 'Hedging filled quantity')).toBe(true);
  });

  it('splits a router-rejected hedge into smaller clips and reports the upstream reason', async () => {
    const { engine, runtime, gateway, markets } = await createHarness();
    markets.set('BINANCE_FUTURE_BTC_USDT', '100150', '100151');
    markets.set('OKX_FUTURE_BTC_USDT', '99999', '100000');
    const record = await engine.startStrategy({ ...takerTakerConfig, totalAmount: '0.1' });
    const routerFailure = JSON.stringify({
      label: 'NOT_BEST_ACCOUNT_ROUTER',
      message: 'All trading channels are currently busy. Consider reducing the order amount.',
    });

    const firstTick = engine.tick();
    await waitFor(() => gateway.createdOrders.length === 2);
    ackOrder(runtime, 'remote-1', 'FILLED', '0.1', '100150');
    ackOrder(runtime, 'remote-2', 'FAIL', '0', '0', routerFailure);

    // The first repair follows Gate's explicit advice and halves the rejected 0.1 order.
    await waitFor(() => gateway.createdOrders.length === 3);
    expect(gateway.createdOrders[2]).toMatchObject({
      symbol: 'OKX_FUTURE_BTC_USDT', side: 'BUY', type: 'MARKET', qty: '0.05',
    });
    ackOrder(runtime, 'remote-3', 'FILLED', '0.05', '100000');
    await firstTick;

    // A successful split resets the failure budget; the remaining 0.05 can finish the hedge.
    const secondRepair = engine.tick();
    await waitFor(() => gateway.createdOrders.length === 4);
    expect(gateway.createdOrders[3]).toMatchObject({
      symbol: 'OKX_FUTURE_BTC_USDT', side: 'BUY', type: 'MARKET', qty: '0.05',
    });
    ackOrder(runtime, 'remote-4', 'FILLED', '0.05', '100000');
    await secondRepair;
    await waitFor(() => runtime.getStrategy(record.id).status === 'COMPLETED');

    expect(runtime.strategyLogs(record.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({ event: 'Right leg fail', result: expect.stringContaining('NOT_BEST_ACCOUNT_ROUTER') }),
      expect.objectContaining({ event: 'Hedging filled quantity', result: expect.stringContaining('split after router rejected 0.1') }),
    ]));
  });

  it('pauses after repeated failed hedge attempts instead of trading blind', async () => {
    const { engine, runtime, gateway, markets } = await createHarness();
    markets.set('BINANCE_FUTURE_BTC_USDT', '100150', '100151');
    markets.set('OKX_FUTURE_BTC_USDT', '99999', '100000');
    // The right leg rejects the clip submission and every hedge-repair attempt after it.
    gateway.failCreate('OKX_FUTURE_BTC_USDT', 10);
    const record = await engine.startStrategy(takerTakerConfig);

    const firstTick = engine.tick();
    await waitFor(() => gateway.createdOrders.length === 1);
    ackOrder(runtime, 'remote-1', 'FILLED', '0.1', '100150');
    await firstTick;

    for (let attempt = 0; attempt < 4; attempt += 1) {
      await engine.tick();
      if (runtime.getStrategy(record.id).status === 'PAUSED') break;
    }

    const paused = runtime.getStrategy(record.id);
    expect(paused.status).toBe('PAUSED');
    expect(runtime.strategyLogs(record.id).some((log) => log.event === 'Strategy paused')).toBe(true);
    // A paused strategy must not submit anything further.
    await engine.tick();
    expect(gateway.createdOrders).toHaveLength(1);
  });

  it('manually resumes a paused strategy only on its active account', async () => {
    const { engine, runtime, markets } = await createHarness();
    markets.set('BINANCE_FUTURE_BTC_USDT', '100150', '100151');
    markets.set('OKX_FUTURE_BTC_USDT', '99999', '100000');
    const record = await engine.startStrategy(takerTakerConfig, {
      profileId: DEFAULT_CREDENTIAL_PROFILE,
      label: 'Primary Trading',
    });
    expect(engine.pauseRunningStrategiesForCredentialChange(DEFAULT_CREDENTIAL_PROFILE)).toBe(1);
    expect(runtime.getStrategy(record.id).status).toBe('PAUSED');

    await expect(engine.resumeStrategy(record.id, 'another-account')).rejects.toMatchObject({
      code: 'strategy_account_not_active', statusCode: 409,
    });
    expect(runtime.getStrategy(record.id).status).toBe('PAUSED');

    await expect(engine.resumeStrategy(record.id, DEFAULT_CREDENTIAL_PROFILE)).resolves.toMatchObject({
      id: record.id, status: 'RUNNING',
    });
    expect(engine.listActiveStrategyIds()).toEqual([record.id]);
    expect(runtime.strategyLogs(record.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({ event: 'Strategy resumed', condition: 'Manual resume' }),
    ]));
    await expect(engine.resumeStrategy(record.id, DEFAULT_CREDENTIAL_PROFILE)).rejects.toMatchObject({
      code: 'strategy_not_paused', statusCode: 409,
    });
  });

  it.each(Array.from({ length: pairedBenchmark ? 100 : 1 }, (_, i) => i))('dispatches a prepared managed hedge while position REST is held, with zero new admission queries (%i)', async sample => {
    let monitor!: MarginRiskMonitor;
    const mode = vi.fn(async () => 'CROSS' as const);
    const { h, setRead } = await managedDeferralHarness('MAKER_TAKER', {}, h => {
      seedPairedPerformanceHistory(h.database);
      for (const [index, asset] of ['ETH', 'SOL'].entries()) {
        const left = `${index === 0 ? 'HYPERLIQUID' : 'DERIBIT'}_FUTURE_${asset}_USDC`, right = `KRAKEN_FUTURE_${asset}_USD`;
        h.markets.set(left, '100', '100'); h.markets.set(right, '100', '100');
        for (const [i, symbol] of [left, right].entries()) {
          h.gateway.positions.push({ ...futuresPosition(symbol, i ? 'LONG' : 'SHORT', '10'), initial_margin: '200.75',
            maintenance_margin: '1.75', mark_price: '100', position_value: '1000', leverage: '5', margin_mode: 'CROSS', upnl: '0' });
          h.database.prepare('UPDATE crossex_instruments SET max_market_size=? WHERE symbol=?').run('100', symbol);
        }
      }
      h.gateway.leverages = { BINANCE_FUTURE_BTC_USDT: '1', OKX_FUTURE_BTC_USDT: '1' };
      h.runtime.setPairedPrivateStreamLive(true);
      h.gateway.accountAssets = [{ exchange_type: 'CROSSEX', coin: 'USDT', balance: h.gateway.availableMargin, available_balance: h.gateway.availableMargin,
        equity: h.gateway.availableMargin, upnl: '0', liability: '0', borrowing_initial_margin: '0', borrowing_maintenance_margin: '0',
        futures_initial_margin: '0', futures_maintenance_margin: '0' }];
      for (const [venue, coin, count] of [['HYPERLIQUID', 'USDC', 1], ['DERIBIT', 'USDC', 1], ['KRAKEN', 'USD', 2]] as const) {
        h.gateway.accountAssets.push({ exchange_type: venue, coin, balance: '1000', equity: '1000',
          available_balance: new Decimal(1000).minus(new Decimal('200.75').mul(count)).toString(), upnl: '0', liability: '0',
          borrowing_initial_margin: '0', borrowing_maintenance_margin: '0', futures_initial_margin: new Decimal('200.75').mul(count).toString(),
          futures_maintenance_margin: new Decimal('1.75').mul(count).toString() });
      }
      h.gateway.accountAssets[0].balance = h.gateway.accountAssets[0].equity = h.gateway.accountAssets[0].available_balance = new Decimal(h.gateway.availableMargin).minus(3000).toString();
      h.gateway.queryFeeRates = async () => ['HYPERLIQUID', 'DERIBIT', 'KRAKEN'].map(exchange_type => ({
        exchange_type, future_taker_fee: '0.0005', future_maker_fee: '0.0002' })) as GateFeeRate[];
      Object.assign(h.gateway, { queryValuationRates: async () => ({ USDT: '1', USDC: '1', USD: '1' }) });
      const account = h.gateway.queryAccount.bind(h.gateway);
      h.gateway.queryAccount = async (...args) => {
        const raw = await account(...args), im = new Decimal(h.gateway.accountAssets[0].futures_initial_margin).plus(803).toString();
        return { ...raw, user_id: 'synthetic-user', initial_margin: im, maintenance_margin: '7', available_margin: new Decimal(raw.margin_balance).minus(im).toString(),
          initial_margin_rate: new Decimal(im).isZero() ? '0' : new Decimal(raw.margin_balance).div(im).toString(),
          maintenance_margin_rate: new Decimal(raw.margin_balance).div(7).toString() };
      };
      h.gateway.querySymbols = async () => ['BINANCE_FUTURE_BTC_USDT', 'OKX_FUTURE_BTC_USDT']
        .map(symbol => ({ symbol, support_cross: 'true' })) as GateCrossExSymbol[];
      Object.assign(h.gateway, { queryPositionMarginMode: mode, queryManagedState: async () => ({ positions: h.gateway.positions, openOrders: [] }) });
      monitor = createMarginRiskService({ db: h.database, gateway: h.gateway, runtime: h.runtime, manager: h.manager!, engine: h.engine,
        markets: h.markets, context: () => 'account-1:1', profile: () => ({ id: 'account-1', label: 'Synthetic' }),
        credentials: () => h.vault.get(DEFAULT_CREDENTIAL_PROFILE), live: () => h.session.liveTradingEnabled, enforce: true });
    });
    const originalCreate = h.gateway.createOrder.bind(h.gateway);
    let dispatchedAt = 0;
    let releaseTransport!: () => void, transportStarted!: () => void;
    const heldTransport = new Promise<void>(resolve => { releaseTransport = resolve; });
    const startedTransport = new Promise<void>(resolve => { transportStarted = resolve; });
    const client = new GateCrossExClient(async (input, init) => {
      const url = new URL(String(input)); expect(url.hostname).toBe('synthetic.invalid');
      if (url.pathname.endsWith('/leverage')) {
        transportStarted(); await heldTransport;
        return new Response(JSON.stringify({ OKX_FUTURE_BTC_USDT: '1' }));
      }
      expect(url.pathname).toBe('/api/v4/crossex/orders');
      dispatchedAt = performance.now();
      return new Response(JSON.stringify(await originalCreate({ apiKey: 'synthetic', apiSecret: 'synthetic' },
        JSON.parse(String(init!.body)) as CrossExOrderRequest)));
    }, Date.now, 'https://synthetic.invalid/api/v4', 100);
    h.gateway.createOrder = client.createOrder.bind(client);
    let release: ((facts: { positions: GateCrossExPosition[]; openOrders: GateCrossExOrder[] }) => void) | undefined;
    let reading: Promise<void> | undefined;
    let transportRead: Promise<unknown> | undefined;
    const poolChecks = vi.spyOn(PairedEntryPool.prototype, 'costs');
    const groupChecks = vi.spyOn(MarginReductionEvidence.prototype, 'inspectGroup');
    try {
      await h.engine.tick(); expect(h.gateway.createdOrders).toHaveLength(1);
      h.gateway.accountAssets[0].futures_initial_margin = new Decimal(h.gateway.createdOrders[0].qty!).mul(h.gateway.createdOrders[0].price!).mul('1.0015').toString();
      await monitor.refresh();
      await waitFor(() => monitor.snapshot().groups.filter(g => g.strategyId.startsWith('MONITOR-') && g.eligible && g.readiness?.status === 'ready').length === 2);
      transportRead = client.queryLeverages({ apiKey: 'synthetic', apiSecret: 'synthetic' }, ['OKX_FUTURE_BTC_USDT']);
      await startedTransport;
      const reads = [vi.spyOn(h.gateway, 'queryAccount'), vi.spyOn(h.gateway, 'queryPositions'), vi.spyOn(h.gateway, 'queryLeverages'), vi.spyOn(h.gateway, 'queryRiskLimits'), vi.spyOn(h.gateway, 'querySymbols'), mode];
      reads.forEach(read => read.mockClear());
      poolChecks.mockClear();
      setRead(() => new Promise(resolve => { release = resolve; })); reading = h.manager!.tick();
      if (sample % 2 === 0) {
        const ahead = futuresPosition('BINANCE_FUTURE_BTC_USDT', 'SHORT', '0.05');
        h.runtime.ingestPrivateEvent({ channel: 'position', payload: ahead }); h.manager!.notifyPosition(ahead);
        expect(h.runtime.pairedMakerReady(h.runtime.listOrders().find(order => order.remoteOrderId === 'remote-1')!.strategyId!)).toBe(false);
        pairedPositionAheadSamples += 1;
      }
      groupChecks.mockClear();
      const start = performance.now(); ackOrder(h.runtime, 'remote-1', 'PARTIALLY_FILLED', '0.05', '111');
      await waitFor(() => h.gateway.createdOrders.length === 2);
      const elapsed = dispatchedAt - start; pairedLatencySamples.push(elapsed); expect(elapsed).toBeGreaterThan(0); expect(elapsed).toBeLessThan(500);
      expect(h.gateway.createdOrders[1]).toMatchObject({ side: 'BUY', qty: '0.05', type: 'MARKET' });
      expect(groupChecks.mock.results.some(r => r.type === 'return' && r.value.ok && r.value.evidence.projection)).toBe(true);
      pairedAdmissionQueryCount += reads.reduce((sum, read) => sum + read.mock.calls.length, 0);
      reads.forEach(read => expect(read).not.toHaveBeenCalled());
      expect(poolChecks.mock.results.some(result => result.type === 'return'
        && result.value.costs.some(cost => cost.creditedInitial?.gt(0)))).toBe(true);
      pairedPoolProofSamples += 1;
      expect(h.database.prepare('SELECT reason FROM managed_risk_lock').get()).toBeUndefined();
      ackOrder(h.runtime, 'remote-2', 'FILLED', '0.05', '100');
    } finally {
      h.session.set('readonly'); setRead(null); release?.({ positions: h.gateway.positions, openOrders: [] });
      releaseTransport(); await transportRead; await reading; await monitor.stop();
      poolChecks.mockRestore();
      groupChecks.mockRestore();
    }
  });

  it('hard-pauses the real managed engine on a fee-budget fault from the pool accounting boundary', async () => {
    let monitor!: MarginRiskMonitor;
    const { h, record } = await managedDeferralHarness('MAKER_TAKER', {}, h => {
      h.gateway.leverages = { BINANCE_FUTURE_BTC_USDT: '1', OKX_FUTURE_BTC_USDT: '1' };
      const account = h.gateway.queryAccount.bind(h.gateway);
      h.gateway.queryAccount = async (...args) => ({ ...await account(...args), user_id: 'synthetic-user' });
      h.gateway.querySymbols = async () => ['BINANCE_FUTURE_BTC_USDT', 'OKX_FUTURE_BTC_USDT'].map(symbol => ({ symbol, support_cross: 'true' })) as GateCrossExSymbol[];
      Object.assign(h.gateway, { queryPositionMarginMode: async () => 'CROSS' });
      monitor = createMarginRiskService({ db: h.database, gateway: h.gateway, runtime: h.runtime, manager: h.manager!, engine: h.engine,
        markets: h.markets, context: () => 'account-1:1', profile: () => ({ id: 'account-1', label: 'Synthetic' }),
        credentials: () => h.vault.get(DEFAULT_CREDENTIAL_PROFILE), live: () => h.session.liveTradingEnabled, enforce: true });
    });
    await h.engine.tick(); expect(h.gateway.createdOrders).toHaveLength(1);
    const pool = vi.spyOn(PairedEntryPool.prototype, 'costs').mockImplementation(() => { throw new Error('paired_entry_fee_budget_exceeded'); });
    try {
      ackOrder(h.runtime, 'remote-1', 'PARTIALLY_FILLED', '0.05', '111');
      await waitFor(() => h.session.current === 'readonly');
      expect(h.database.prepare('SELECT reason FROM managed_risk_lock').get()).toEqual({ reason: 'paired_entry_fee_budget_exceeded' });
      expect(h.runtime.getStrategy(record.id).management?.phase).toBe('RISK_PAUSED');
      for (let i = 0; i < 3; i++) await h.engine.tick();
      expect(h.gateway.createdOrders).toHaveLength(1);
    } finally { pool.mockRestore(); await monitor.stop(); }
  });

  it('rejects an old maker price if the opposite quote moves during pre-submit preparation', async () => {
    const h = await createHarness(); h.markets.set('BINANCE_FUTURE_BTC_USDT', '110', '111'); h.markets.set('OKX_FUTURE_BTC_USDT', '99', '100');
    await h.engine.startStrategy({ ...takerTakerConfig, executionMethod: 'MAKER_TAKER', makerLeg: 'left' });
    h.runtime.setMarginAdmission(async () => { h.markets.set('OKX_FUTURE_BTC_USDT', '120', '121'); });
    await h.engine.tick(); expect(h.gateway.createdOrders).toHaveLength(0); expect(h.runtime.listOrders()).toHaveLength(0);
  });

  it('rests a post-only maker quote and hedges each maker fill on the taker venue', async () => {
    const { engine, runtime, gateway, markets } = await createHarness();
    markets.set('BINANCE_FUTURE_BTC_USDT', '100000', '100001');
    markets.set('OKX_FUTURE_BTC_USDT', '99999', '100000');
    const record = await engine.startStrategy({
      ...takerTakerConfig, totalAmount: '0.2', perOrderQuantity: '0.2',
      executionMethod: 'MAKER_TAKER', makerLeg: 'left',
    });

    await engine.tick();
    await waitFor(() => gateway.createdOrders.length === 1);
    const quote = gateway.createdOrders[0];
    // SELL maker at OKX ask 100000 * (1 + 10 bps) = 100100.
    expect(quote).toMatchObject({ symbol: 'BINANCE_FUTURE_BTC_USDT', side: 'SELL', type: 'LIMIT', time_in_force: 'POC', qty: '0.2', price: '100100' });

    ackOrder(runtime, 'remote-1', 'PARTIALLY_FILLED', '0.08', '100100');
    ingestFill(runtime, 'remote-1', 'BINANCE_FUTURE_BTC_USDT', 'SELL', '0.08', '100100');
    await waitFor(() => gateway.createdOrders.length === 2);
    const hedge = gateway.createdOrders[1];
    expect(hedge).toMatchObject({ symbol: 'OKX_FUTURE_BTC_USDT', side: 'BUY', type: 'MARKET', time_in_force: 'IOC', qty: '0.08' });
    ackOrder(runtime, 'remote-2', 'FILLED', '0.08', '100005');
    await waitFor(() => runtime.getStrategy(record.id).filledQuantity === '0.08');

    ackOrder(runtime, 'remote-1', 'FILLED', '0.2', '100100');
    await waitFor(() => gateway.createdOrders.length === 3);
    expect(gateway.createdOrders[2]).toMatchObject({ symbol: 'OKX_FUTURE_BTC_USDT', side: 'BUY', qty: '0.12' });
    ackOrder(runtime, 'remote-3', 'FILLED', '0.12', '100008');
    await waitFor(() => runtime.getStrategy(record.id).status === 'COMPLETED');
    expect(runtime.getStrategy(record.id).filledQuantity).toBe('0.2');
  });

  it('joins the maker best bid when it is within the configured buy-price boundary', async () => {
    const { engine, gateway, markets } = await createHarness();
    markets.set('BINANCE_FUTURE_BTC_USDT', '100', '100.01');
    markets.set('OKX_FUTURE_BTC_USDT', '100.01', '100.02');
    await engine.startStrategy({
      ...takerTakerConfig, entryBps: '-3', totalAmount: '0.1', perOrderQuantity: '0.1',
      executionMethod: 'MAKER_TAKER', makerLeg: 'right',
    });

    await engine.tick();
    await waitFor(() => gateway.createdOrders.length === 1);

    // Spread ceiling = 100 × 1.0003 = 100.03. The 100.01 best bid is cheaper and can be joined.
    expect(gateway.createdOrders[0]).toMatchObject({
      symbol: 'OKX_FUTURE_BTC_USDT', side: 'BUY', type: 'LIMIT', time_in_force: 'POC', price: '100.01',
    });
  });

  it('joins the maker best ask when it is within the configured sell-price boundary', async () => {
    const { engine, gateway, markets } = await createHarness();
    markets.set('BINANCE_FUTURE_BTC_USDT', '99.98', '99.99');
    markets.set('OKX_FUTURE_BTC_USDT', '99.99', '100');
    await engine.startStrategy({
      ...takerTakerConfig, entryBps: '-3', totalAmount: '0.1', perOrderQuantity: '0.1',
      executionMethod: 'MAKER_TAKER', makerLeg: 'left',
    });

    await engine.tick();
    await waitFor(() => gateway.createdOrders.length === 1);

    // Spread floor = 100 × 0.9997 = 99.97. The 99.99 best ask is better and can be joined.
    expect(gateway.createdOrders[0]).toMatchObject({
      symbol: 'BINANCE_FUTURE_BTC_USDT', side: 'SELL', type: 'LIMIT', time_in_force: 'POC', price: '99.99',
    });
  });

  it('normalizes the final Hyperliquid maker price without changing the spread or POC intent', async () => {
    const { engine, gateway, markets, database } = await createHarness();
    markets.set('HYPERLIQUID_FUTURE_XMR_USDC', '538.79', '538.80');
    markets.set('GATE_FUTURE_XMR_USDT', '538.29', '538.30');
    database.prepare("UPDATE crossex_instruments SET tick_size='0.001',lot_size='0.001' WHERE symbol='HYPERLIQUID_FUTURE_XMR_USDC'").run();
    await engine.startStrategy({ ...takerTakerConfig, asset: 'XMR', leftVenue: 'HYPERLIQUID', rightVenue: 'GATE',
      entryBps: '10', totalAmount: '1', perOrderQuantity: '0.5', executionMethod: 'MAKER_TAKER', makerLeg: 'left' });
    await engine.tick();
    await waitFor(() => gateway.createdOrders.length === 1);
    expect(gateway.createdOrders[0]).toMatchObject({ symbol: 'HYPERLIQUID_FUTURE_XMR_USDC', side: 'SELL',
      type: 'LIMIT', time_in_force: 'POC', qty: '0.5', price: '538.84', reduce_only: 'false' });
  });
  it('sends a tiny Hyperliquid maker limit as a plain decimal instead of an exponent', async () => {
    const { engine, gateway, markets, database } = await createHarness();
    markets.set('HYPERLIQUID_FUTURE_TINY_USDC', '0.00000012', '0.00000013');
    markets.set('GATE_FUTURE_TINY_USDT', '0.00000010', '0.00000011');
    database.prepare("UPDATE crossex_instruments SET tick_size='0.00000001' WHERE symbol='HYPERLIQUID_FUTURE_TINY_USDC'").run();
    await engine.startStrategy({ ...takerTakerConfig, asset: 'TINY', leftVenue: 'HYPERLIQUID', rightVenue: 'GATE',
      entryBps: '0', totalAmount: '100000000', perOrderQuantity: '100000000', executionMethod: 'MAKER_TAKER', makerLeg: 'left' });
    await engine.tick(); await waitFor(() => gateway.createdOrders.length === 1);
    expect(gateway.createdOrders[0]).toMatchObject({ symbol: 'HYPERLIQUID_FUTURE_TINY_USDC', side: 'SELL',
      type: 'LIMIT', time_in_force: 'POC', price: '0.00000013', qty: '100000000' });
  });

  it('carries an untradeable maker residual into the next clip before the target is complete', async () => {
    const { engine, runtime, database, gateway, markets } = await createHarness();
    markets.set('BINANCE_FUTURE_BTC_USDT', '100000', '100001');
    markets.set('OKX_FUTURE_BTC_USDT', '99999', '100000');
    database.prepare("UPDATE crossex_instruments SET min_size = '0.1', lot_size = '0.1' WHERE symbol = 'BINANCE_FUTURE_BTC_USDT'").run();
    database.prepare("UPDATE crossex_instruments SET min_size = '0.01', lot_size = '0.01' WHERE symbol = 'OKX_FUTURE_BTC_USDT'").run();
    const record = await engine.startStrategy({
      ...takerTakerConfig, totalAmount: '0.2', perOrderQuantity: '0.2',
      executionMethod: 'MAKER_TAKER', makerLeg: 'right',
    });

    await engine.tick();
    await waitFor(() => gateway.createdOrders.length === 1);
    expect(gateway.createdOrders[0]).toMatchObject({ symbol: 'OKX_FUTURE_BTC_USDT', side: 'BUY', qty: '0.2' });

    // The fine-step maker fills 0.13, while the coarse taker venue can hedge only 0.1.
    ackOrder(runtime, 'remote-1', 'PARTIALLY_FILLED', '0.13', '99900');
    ingestFill(runtime, 'remote-1', 'OKX_FUTURE_BTC_USDT', 'BUY', '0.13', '99900');
    await waitFor(() => gateway.createdOrders.length === 2);
    expect(gateway.createdOrders[1]).toMatchObject({
      symbol: 'BINANCE_FUTURE_BTC_USDT', side: 'SELL', qty: '0.1', reduce_only: 'false',
    });
    ackOrder(runtime, 'remote-2', 'FILLED', '0.1', '100000');
    await waitFor(() => runtime.getStrategy(record.id).filledQuantity === '0.1');

    // Once the partial maker quote closes, keep the 0.03 residual for the next normal clip. The
    // excess maker leg quotes only 0.07, after which the coarse taker leg can execute a full 0.1.
    ackOrder(runtime, 'remote-1', 'CANCELLED', '0.13', '99900');
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 15));
    const carryTick = engine.tick();
    await waitFor(() => gateway.createdOrders.length === 3);
    expect(gateway.createdOrders[2]).toMatchObject({
      symbol: 'OKX_FUTURE_BTC_USDT', side: 'BUY', type: 'LIMIT', time_in_force: 'POC', qty: '0.07', reduce_only: 'false',
    });
    ackOrder(runtime, 'remote-3', 'FILLED', '0.07', '99900');
    await waitFor(() => gateway.createdOrders.length === 4);
    expect(gateway.createdOrders[3]).toMatchObject({
      symbol: 'BINANCE_FUTURE_BTC_USDT', side: 'SELL', type: 'MARKET', qty: '0.1', reduce_only: 'false',
    });
    ackOrder(runtime, 'remote-4', 'FILLED', '0.1', '100000');
    await carryTick;
    await waitFor(() => runtime.getStrategy(record.id).status === 'COMPLETED');

    expect(runtime.getStrategy(record.id)).toMatchObject({
      status: 'COMPLETED', filledLeft: '0.2', filledRight: '0.2', filledQuantity: '0.2', progress: 100,
    });
    expect(runtime.strategyLogs(record.id).some((log) => log.event === 'Trimming residual imbalance')).toBe(false);
  });

  it('absorbs a sub-min-notional residual in the next maker-taker clip before 100%', async () => {
    const { engine, runtime, database, gateway, markets } = await createHarness();
    markets.set('BINANCE_FUTURE_BTC_USDT', '54.2', '54.3');
    markets.set('OKX_FUTURE_BTC_USDT', '54', '54.1');
    database.prepare("UPDATE crossex_instruments SET min_size = '0.01', min_notional = '5', lot_size = '0.01' WHERE symbol LIKE '%_FUTURE_BTC_USDT'").run();
    const record = await engine.startStrategy({
      ...takerTakerConfig, totalAmount: '2', perOrderQuantity: '1',
      executionMethod: 'MAKER_TAKER', makerLeg: 'right',
    });
    seedFilledStrategyOrder(database, record.id, 'carry-left', 'BINANCE_FUTURE_BTC_USDT', 'SELL', '1', 'left');
    seedFilledStrategyOrder(database, record.id, 'carry-right', 'OKX_FUTURE_BTC_USDT', 'BUY', '1.03', 'right');

    // Progress is below 100%, so do not top up or submit the invalid 0.03 repair. The excess
    // maker leg absorbs it by quoting 0.97 in the next configured 1.00 clip.
    await engine.tick();
    await waitFor(() => gateway.createdOrders.length === 1);
    expect(gateway.createdOrders[0]).toMatchObject({
      symbol: 'OKX_FUTURE_BTC_USDT', side: 'BUY', type: 'LIMIT', time_in_force: 'POC',
      qty: '0.97', reduce_only: 'false',
    });

    ackOrder(runtime, 'remote-1', 'FILLED', '0.97', '54.05');
    await waitFor(() => gateway.createdOrders.length === 2);
    expect(gateway.createdOrders[1]).toMatchObject({
      symbol: 'BINANCE_FUTURE_BTC_USDT', side: 'SELL', type: 'MARKET', qty: '1', reduce_only: 'false',
    });
    ackOrder(runtime, 'remote-2', 'FILLED', '1', '54.2');
    await waitFor(() => runtime.getStrategy(record.id).status === 'COMPLETED');

    expect(runtime.getStrategy(record.id)).toMatchObject({
      progress: 100, filledLeft: '2', filledRight: '2', filledQuantity: '2',
    });
    expect(gateway.createdOrders.some((order) => order.qty === '0.03')).toBe(false);
  });

  it('tops up and exactly trims a sub-min-notional residual only after reaching 100%', async () => {
    const { engine, runtime, database, gateway, markets } = await createHarness();
    markets.set('BINANCE_FUTURE_BTC_USDT', '54.2', '54.3');
    markets.set('OKX_FUTURE_BTC_USDT', '54', '54.1');
    database.prepare("UPDATE crossex_instruments SET min_size = '0.01', min_notional = '5', lot_size = '0.01' WHERE symbol LIKE '%_FUTURE_BTC_USDT'").run();
    const record = await engine.startStrategy({
      ...takerTakerConfig, totalAmount: '1', perOrderQuantity: '1',
      executionMethod: 'MAKER_TAKER', makerLeg: 'right',
    });
    seedFilledStrategyOrder(database, record.id, 'terminal-left', 'BINANCE_FUTURE_BTC_USDT', 'SELL', '1', 'left');
    seedFilledStrategyOrder(database, record.id, 'terminal-right', 'OKX_FUTURE_BTC_USDT', 'BUY', '1.03', 'right');

    const repairTick = engine.tick();
    await waitFor(() => gateway.createdOrders.length === 1);
    expect(gateway.createdOrders[0]).toMatchObject({
      symbol: 'OKX_FUTURE_BTC_USDT', side: 'BUY', type: 'MARKET', qty: '0.11', reduce_only: 'false',
    });
    ackOrder(runtime, 'remote-1', 'FILLED', '0.11', '54.1');

    await waitFor(() => gateway.createdOrders.length === 2);
    expect(gateway.createdOrders[1]).toMatchObject({
      symbol: 'OKX_FUTURE_BTC_USDT', side: 'SELL', type: 'MARKET', qty: '0.14', reduce_only: 'true',
    });
    ackOrder(runtime, 'remote-2', 'FILLED', '0.14', '54');
    await repairTick;
    await waitFor(() => runtime.getStrategy(record.id).status === 'COMPLETED');

    expect(runtime.getStrategy(record.id)).toMatchObject({
      progress: 100, filledLeft: '1', filledRight: '1', filledQuantity: '1',
    });
    expect(runtime.strategyLogs(record.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({ event: 'Padding terminal residual', quantity: '0.11 BTC' }),
      expect.objectContaining({ event: 'Trimming padded residual', quantity: '0.14 BTC' }),
      expect.objectContaining({ event: 'Padded residual trim settled' }),
    ]));
  });

  it('retries the enlarged reduce-only trim without padding twice after a close failure', async () => {
    const { engine, runtime, database, gateway, markets } = await createHarness();
    markets.set('BINANCE_FUTURE_BTC_USDT', '54.2', '54.3');
    markets.set('OKX_FUTURE_BTC_USDT', '54', '54.1');
    database.prepare("UPDATE crossex_instruments SET min_size = '0.01', min_notional = '5', lot_size = '0.01' WHERE symbol LIKE '%_FUTURE_BTC_USDT'").run();
    const record = await engine.startStrategy({
      ...takerTakerConfig, totalAmount: '1', perOrderQuantity: '1',
      executionMethod: 'MAKER_TAKER', makerLeg: 'right',
    });
    seedFilledStrategyOrder(database, record.id, 'retry-left', 'BINANCE_FUTURE_BTC_USDT', 'SELL', '1', 'left');
    seedFilledStrategyOrder(database, record.id, 'retry-right', 'OKX_FUTURE_BTC_USDT', 'BUY', '1.03', 'right');

    const firstRepair = engine.tick();
    await waitFor(() => gateway.createdOrders.length === 1);
    ackOrder(runtime, 'remote-1', 'FILLED', '0.11', '54.1');
    await waitFor(() => gateway.createdOrders.length === 2);
    ackOrder(runtime, 'remote-2', 'FAIL', '0', '0', 'TEMPORARY_CLOSE_REJECTION');
    await firstRepair;

    const retry = engine.tick();
    await waitFor(() => gateway.createdOrders.length === 3);
    expect(gateway.createdOrders[2]).toMatchObject({
      symbol: 'OKX_FUTURE_BTC_USDT', side: 'SELL', type: 'MARKET', qty: '0.14', reduce_only: 'true',
    });
    expect(gateway.createdOrders.filter((order) => order.side === 'BUY')).toHaveLength(1);
    ackOrder(runtime, 'remote-3', 'FILLED', '0.14', '54');
    await retry;
    await waitFor(() => runtime.getStrategy(record.id).status === 'COMPLETED');
  });

  it('completes a full position after trimming a persisted terminal-fill residual', async () => {
    const { engine, runtime, database, gateway, markets } = await createHarness();
    markets.set('BINANCE_FUTURE_BTC_USDT', '100000', '100001');
    markets.set('OKX_FUTURE_BTC_USDT', '99999', '100000');
    database.prepare("UPDATE crossex_instruments SET min_size = '0.1', lot_size = '0.1' WHERE symbol = 'BINANCE_FUTURE_BTC_USDT'").run();
    database.prepare("UPDATE crossex_instruments SET min_size = '0.01', lot_size = '0.01' WHERE symbol = 'OKX_FUTURE_BTC_USDT'").run();
    const record = await engine.startStrategy({
      ...takerTakerConfig, totalAmount: '0.1', perOrderQuantity: '0.1',
      executionMethod: 'MAKER_TAKER', makerLeg: 'right',
    });
    const now = new Date().toISOString();
    const insertFill = database.prepare(`INSERT INTO execution_orders (
      id, client_order_id, environment, symbol, venue, side, order_type, time_in_force,
      quantity, price, reduce_only, state, executed_quantity, executed_average_price,
      created_at, updated_at, strategy_id, strategy_leg
    ) VALUES (?, ?, 'live', ?, ?, ?, 'MARKET', 'IOC', ?, NULL, 0, 'FILLED', ?, '100000', ?, ?, ?, ?)`);
    insertFill.run('seed-left', 'seed-left-client', 'BINANCE_FUTURE_BTC_USDT', 'BINANCE', 'SELL',
      '0.1', '0.1', now, now, record.id, 'left');
    insertFill.run('seed-right', 'seed-right-client', 'OKX_FUTURE_BTC_USDT', 'OKX', 'BUY',
      '0.13', '0.13', now, now, record.id, 'right');

    const repairTick = engine.tick();
    await waitFor(() => gateway.createdOrders.length === 1);
    expect(gateway.createdOrders[0]).toMatchObject({
      symbol: 'OKX_FUTURE_BTC_USDT', side: 'SELL', qty: '0.03', reduce_only: 'true',
    });
    ackOrder(runtime, 'remote-1', 'FILLED', '0.03', '100000');
    await repairTick;
    await waitFor(() => runtime.getStrategy(record.id).status === 'COMPLETED');

    expect(runtime.getStrategy(record.id)).toMatchObject({
      status: 'COMPLETED', filledLeft: '0.1', filledRight: '0.1', filledQuantity: '0.1', progress: 100,
    });
  });

  it('requotes the maker order when the taker leg moves beyond tolerance', async () => {
    const { engine, runtime, gateway, markets } = await createHarness();
    markets.set('BINANCE_FUTURE_BTC_USDT', '100000', '100001');
    markets.set('OKX_FUTURE_BTC_USDT', '99999', '100000');
    await engine.startStrategy({
      ...takerTakerConfig, executionMethod: 'MAKER_TAKER', makerLeg: 'left', perOrderQuantity: '0.2',
    });
    await engine.tick();
    await waitFor(() => gateway.createdOrders.length === 1);
    expect(gateway.createdOrders[0]?.price).toBe('100100');

    markets.set('OKX_FUTURE_BTC_USDT', '100499', '100500');
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 15));
    const requoteTick = engine.tick();
    await waitFor(() => gateway.cancelledOrders.length === 1);
    ackOrder(runtime, 'remote-1', 'CANCELLED', '0', '0');
    await requoteTick;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 15));
    await engine.tick();
    await waitFor(() => gateway.createdOrders.length === 2);
    expect(gateway.createdOrders[1]?.price).toBe('100600.5');
  });

  it('runs an auto spread bot through an entry and take-profit cycle with reduce-only exits', async () => {
    const { engine, runtime, gateway, markets } = await createHarness();
    markets.set('BINANCE_FUTURE_BTC_USDT', '100150', '100151');
    markets.set('OKX_FUTURE_BTC_USDT', '99999', '100000');
    const record = await engine.startStrategy({
      kind: 'auto', asset: 'BTC', leftVenue: 'BINANCE', rightVenue: 'OKX', leftSide: 'SELL', rightSide: 'BUY',
      entryBps: '10', takeProfitBps: '2', maxPosition: '0.1', perOrderQuantity: '0.1', reduceOnly: false,
      executionMethod: 'TAKER_TAKER',
    });

    const entryTick = engine.tick();
    await waitFor(() => gateway.createdOrders.length === 2);
    ackOrder(runtime, 'remote-1', 'FILLED', '0.1', '100150');
    ackOrder(runtime, 'remote-2', 'FILLED', '0.1', '100000');
    await entryTick;
    await waitFor(() => runtime.getStrategy(record.id).openPosition === '0.1');

    // At max position no further entries are sent even though the spread is still wide.
    await engine.tick();
    expect(gateway.createdOrders).toHaveLength(2);

    // Collapse the spread: exit spread = (BINANCE ask - OKX bid) / OKX bid ≈ 1 bp ≤ 2 bps.
    markets.set('BINANCE_FUTURE_BTC_USDT', '100009', '100010');
    markets.set('OKX_FUTURE_BTC_USDT', '100000', '100001');
    const exitTick = engine.tick();
    await waitFor(() => gateway.createdOrders.length === 4);
    const exits = gateway.createdOrders.slice(2);
    expect(exits.find((order) => order.symbol === 'BINANCE_FUTURE_BTC_USDT')).toMatchObject({ side: 'BUY', reduce_only: 'true' });
    expect(exits.find((order) => order.symbol === 'OKX_FUTURE_BTC_USDT')).toMatchObject({ side: 'SELL', reduce_only: 'true' });
    ackOrder(runtime, 'remote-3', 'FILLED', '0.1', '100010');
    ackOrder(runtime, 'remote-4', 'FILLED', '0.1', '100000');
    await exitTick;
    await waitFor(() => runtime.getStrategy(record.id).openPosition === '0');

    const strategy = runtime.getStrategy(record.id);
    expect(strategy.status).toBe('RUNNING');
    expect(strategy.filledLeft).toBe('0');
    expect(strategy.filledRight).toBe('0');
  });

  it('cancels resting maker quotes when a strategy is stopped', async () => {
    const { engine, gateway, markets } = await createHarness();
    markets.set('BINANCE_FUTURE_BTC_USDT', '100000', '100001');
    markets.set('OKX_FUTURE_BTC_USDT', '99999', '100000');
    const record = await engine.startStrategy({
      ...takerTakerConfig, executionMethod: 'MAKER_TAKER', makerLeg: 'left', perOrderQuantity: '0.2',
    });
    await engine.tick();
    await waitFor(() => gateway.createdOrders.length === 1);

    const stopped = await engine.stopStrategy(record.id);
    expect(stopped.status).toBe('STOPPED');
    expect(gateway.cancelledOrders).toEqual(['remote-1']);
    expect(engine.listActiveStrategyIds()).toEqual([]);
  });

  it('keeps a stop pending until the exchange confirms every cancellation', async () => {
    const { engine, runtime, gateway, markets } = await createHarness();
    markets.set('BINANCE_FUTURE_BTC_USDT', '100000', '100001');
    markets.set('OKX_FUTURE_BTC_USDT', '99999', '100000');
    const record = await engine.startStrategy({
      ...takerTakerConfig, executionMethod: 'MAKER_TAKER', makerLeg: 'left', perOrderQuantity: '0.2',
    });
    await engine.tick();
    await waitFor(() => gateway.createdOrders.length === 1);

    gateway.holdCancellations = true;
    await expect(engine.stopStrategy(record.id)).rejects.toThrow('strategy_stop_pending_remote');
    expect(runtime.getStrategy(record.id).status).toBe('STOP_PENDING_REMOTE');
    expect(engine.listActiveStrategyIds()).toEqual([record.id]);

    gateway.holdCancellations = false;
    // Releasing a fake delay is not an exchange acknowledgement. Deliver the actual terminal
    // fact; the runtime must not send a second DELETE to make this test become terminal.
    ackOrder(runtime, gateway.createdOrders[0].remoteId, 'CANCELLED', '0', '0');
    await engine.tick();
    expect(runtime.getStrategy(record.id).status).toBe('STOPPED');
    expect(engine.listActiveStrategyIds()).toEqual([]);
    expect(gateway.cancelledOrders).toEqual([gateway.createdOrders[0].remoteId]);
  });

  it('runs an ADR premium bot through a ratio-hedged entry and take-profit cycle', async () => {
    const { engine, runtime, gateway, markets } = await createHarness();
    // Fair ADR value = 1700 ÷ 10 = 170. SKHY bid 229.9 → executable premium ≈ 35.24% ≥ 35%.
    markets.set('GATE_FUTURE_SKHY_USDT', '229.9', '230.0');
    markets.set('GATE_FUTURE_SKHYNIX_USDT', '1700', '1700');
    const record = await engine.startStrategy({
      kind: 'premium', asset: 'SKHY', hedgeAsset: 'SKHYNIX', adrRatio: '10',
      leftVenue: 'GATE', rightVenue: 'GATE', leftSide: 'SELL', rightSide: 'BUY',
      entryPremiumPct: '35', takeProfitPremiumPct: '24', maxPosition: '0.1', perOrderQuantity: '0.1',
      reduceOnly: false, executionMethod: 'TAKER_TAKER',
    });
    expect(record.id.startsWith('PREM-')).toBe(true);

    const entryTick = engine.tick();
    await waitFor(() => gateway.createdOrders.length === 2);
    const [adrLeg, hedgeLeg] = gateway.createdOrders;
    // The hedge leg buys per-order ÷ ratio of the local listing (10 ADRs per Korean share).
    expect(adrLeg).toMatchObject({ symbol: 'GATE_FUTURE_SKHY_USDT', side: 'SELL', type: 'MARKET', qty: '0.1' });
    expect(hedgeLeg).toMatchObject({ symbol: 'GATE_FUTURE_SKHYNIX_USDT', side: 'BUY', type: 'MARKET', qty: '0.01' });
    ackOrder(runtime, 'remote-1', 'FILLED', '0.1', '229.9');
    ackOrder(runtime, 'remote-2', 'FILLED', '0.01', '1700');
    await entryTick;
    await waitFor(() => runtime.getStrategy(record.id).openPosition === '0.1');
    expect(runtime.getStrategy(record.id).progress).toBe(100);
    const entryLogs = runtime.strategyLogs(record.id);
    expect(entryLogs.filter((log) => log.event === 'Position open Executed')).toHaveLength(1);
    expect(entryLogs.some((log) => log.event === 'Left leg filled' || log.event === 'Right leg filled')).toBe(false);

    // At max position with the premium still above take profit, nothing further fires.
    await engine.tick();
    expect(gateway.createdOrders).toHaveLength(2);

    // Premium collapses: SKHY ask 210 → exit premium = 210/170 − 1 ≈ 23.5% ≤ 24%.
    markets.set('GATE_FUTURE_SKHY_USDT', '209.8', '210.0');
    const exitTick = engine.tick();
    await waitFor(() => gateway.createdOrders.length === 4);
    const exits = gateway.createdOrders.slice(2);
    expect(exits.find((order) => order.symbol === 'GATE_FUTURE_SKHY_USDT')).toMatchObject({ side: 'BUY', qty: '0.1', reduce_only: 'true' });
    expect(exits.find((order) => order.symbol === 'GATE_FUTURE_SKHYNIX_USDT')).toMatchObject({ side: 'SELL', qty: '0.01', reduce_only: 'true' });
    ackOrder(runtime, 'remote-3', 'FILLED', '0.1', '210.0');
    ackOrder(runtime, 'remote-4', 'FILLED', '0.01', '1700');
    ingestFill(runtime, 'remote-3', 'GATE_FUTURE_SKHY_USDT', 'BUY', '0.1', '210.0', '1.5');
    ingestFill(runtime, 'remote-4', 'GATE_FUTURE_SKHYNIX_USDT', 'SELL', '0.01', '1700', '0.5');
    await exitTick;
    await waitFor(() => runtime.getStrategy(record.id).openPosition === '0');
    expect(runtime.getStrategy(record.id).status).toBe('COMPLETED');
    expect(runtime.getStrategy(record.id).realizedPnl).toBe('2');
    expect(runtime.listStrategies().find((strategy) => strategy.id === record.id)?.realizedPnl).toBe('2');
    expect(engine.listActiveStrategyIds()).not.toContain(record.id);
    const exitLogs = runtime.strategyLogs(record.id);
    expect(exitLogs.filter((log) => log.event === 'Take-profit Executed')).toHaveLength(1);
    expect(exitLogs.filter((log) => log.event === 'Strategy completed')).toHaveLength(1);
    expect(exitLogs.some((log) => log.event === 'Left leg filled' || log.event === 'Right leg filled')).toBe(false);
  });

  it('reduces existing premium positions in per-order clips and stops without a take-profit cycle', async () => {
    const { engine, runtime, gateway, markets } = await createHarness();
    gateway.positions = [
      futuresPosition('GATE_FUTURE_SKHY_USDT', 'LONG', '0.2'),
      futuresPosition('GATE_FUTURE_SKHYNIX_USDT', 'SHORT', '0.02'),
    ];
    markets.set('GATE_FUTURE_SKHY_USDT', '229.9', '230.0');
    markets.set('GATE_FUTURE_SKHYNIX_USDT', '1700', '1700');
    const record = await engine.startStrategy({
      kind: 'premium', asset: 'SKHY', hedgeAsset: 'SKHYNIX', adrRatio: '10',
      leftVenue: 'GATE', rightVenue: 'GATE', leftSide: 'SELL', rightSide: 'BUY',
      entryPremiumPct: '35', maxPosition: '0.2', perOrderQuantity: '0.1',
      reduceOnly: true, executionMethod: 'TAKER_TAKER',
    });

    expect(gateway.leverageQueries).toHaveLength(0);
    expect(gateway.leverageUpdates).toHaveLength(0);
    for (let clip = 0; clip < 2; clip += 1) {
      const tick = engine.tick();
      await waitFor(() => gateway.createdOrders.length === (clip + 1) * 2);
      const [left, right] = gateway.createdOrders.slice(clip * 2, clip * 2 + 2);
      expect(left).toMatchObject({ symbol: 'GATE_FUTURE_SKHY_USDT', side: 'SELL', qty: '0.1', reduce_only: 'true' });
      expect(right).toMatchObject({ symbol: 'GATE_FUTURE_SKHYNIX_USDT', side: 'BUY', qty: '0.01', reduce_only: 'true' });
      ackOrder(runtime, `remote-${clip * 2 + 1}`, 'FILLED', '0.1', '229.9');
      ackOrder(runtime, `remote-${clip * 2 + 2}`, 'FILLED', '0.01', '1700');
      await tick;
    }

    await waitFor(() => runtime.getStrategy(record.id).status === 'COMPLETED');
    expect(runtime.getStrategy(record.id)).toMatchObject({ progress: 100, openPosition: '0' });
    expect(runtime.strategyLogs(record.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({ event: 'Reduce-only triggered' }),
      expect.objectContaining({ event: 'Reduce-only Executed' }),
      expect.objectContaining({ event: 'Strategy completed', condition: 'Reduce-only target 0.2 SKHY' }),
    ]));
    await engine.tick();
    expect(gateway.createdOrders).toHaveLength(4);
  });

  it('rejects reduce-only premium strategies that do not fit the current positions', async () => {
    const { engine, runtime, gateway, markets } = await createHarness();
    gateway.positions = [
      futuresPosition('GATE_FUTURE_SKHY_USDT', 'LONG', '0.1'),
      futuresPosition('GATE_FUTURE_SKHYNIX_USDT', 'SHORT', '0.01'),
    ];
    markets.set('GATE_FUTURE_SKHY_USDT', '229.9', '230.0');
    markets.set('GATE_FUTURE_SKHYNIX_USDT', '1700', '1700');

    await expect(engine.startStrategy({
      kind: 'premium', asset: 'SKHY', hedgeAsset: 'SKHYNIX', adrRatio: '10',
      leftVenue: 'GATE', rightVenue: 'GATE', leftSide: 'SELL', rightSide: 'BUY',
      entryPremiumPct: '35', maxPosition: '0.2', perOrderQuantity: '0.1',
      reduceOnly: true, executionMethod: 'TAKER_TAKER',
    })).rejects.toMatchObject({ code: 'reduce_only_position_unavailable', statusCode: 409 });
    expect(runtime.listStrategies()).toHaveLength(0);
    expect(gateway.createdOrders).toHaveLength(0);
  });

  it('rejects stale or transport-delayed premium legs but accepts independently timed fresh quotes', async () => {
    let now = Date.now();
    const { engine, runtime, gateway, markets } = await createHarness({ now: () => now });
    const currentTimestamp = new Date(now).toISOString();
    markets.set('GATE_FUTURE_SKHY_USDT', '144.9', '145', currentTimestamp);
    markets.set('GATE_FUTURE_SKHYNIX_USDT', '1139', '1140', currentTimestamp);
    const record = await engine.startStrategy({
      kind: 'premium', asset: 'SKHY', hedgeAsset: 'SKHYNIX', adrRatio: '10',
      leftVenue: 'GATE', rightVenue: 'GATE', leftSide: 'BUY', rightSide: 'SELL',
      entryPremiumPct: '28', takeProfitPremiumPct: '30', maxPosition: '1', perOrderQuantity: '1',
      reduceOnly: false, executionMethod: 'TAKER_TAKER',
    });
    const entryTick = engine.tick();
    await waitFor(() => gateway.createdOrders.length === 2);
    ackOrder(runtime, 'remote-1', 'FILLED', '1', '145');
    ackOrder(runtime, 'remote-2', 'FILLED', '0.1', '1140');
    await entryTick;

    // Fresh-looking objects are still unusable while the upstream feed itself is stale.
    markets.setConnectionState('stale');
    markets.set('GATE_FUTURE_SKHY_USDT', '143.78', '143.8', new Date(now).toISOString());
    markets.set('GATE_FUTURE_SKHYNIX_USDT', '1083.7', '1083.8', new Date(now).toISOString());
    await engine.tick();
    expect(gateway.createdOrders).toHaveLength(2);
    markets.setConnectionState('healthy');

    now += 5_000;
    markets.set('GATE_FUTURE_SKHY_USDT', '143.78', '143.8', new Date(now).toISOString());
    // A fresh-looking source timestamp is unusable when that frame took over three seconds to
    // reach us. The pair must not manufacture a take-profit signal from delayed transport.
    markets.set('GATE_FUTURE_SKHYNIX_USDT', '1083.7', '1083.8',
      new Date(now - 4_000).toISOString(), new Date(now).toISOString());
    await engine.tick();
    expect(gateway.createdOrders).toHaveLength(2);

    // A coherent pair that is minutes old is also unusable.
    const staleTimestamp = new Date(now - 60_000).toISOString();
    markets.set('GATE_FUTURE_SKHY_USDT', '143.78', '143.8', staleTimestamp);
    markets.set('GATE_FUTURE_SKHYNIX_USDT', '1083.7', '1083.8', staleTimestamp);
    await engine.tick();
    expect(gateway.createdOrders).toHaveLength(2);

    // Independently timed quotes are valid when each one is fresh and arrived promptly. The first
    // qualifying signal executes immediately even though their Gate source times differ by 6s.
    markets.set('GATE_FUTURE_SKHY_USDT', '143.78', '143.8', new Date(now).toISOString());
    const independentlyTimed = new Date(now - 6_000).toISOString();
    markets.set('GATE_FUTURE_SKHYNIX_USDT', '1083.7', '1083.8', independentlyTimed, independentlyTimed);
    const exitTick = engine.tick();
    await waitFor(() => gateway.createdOrders.length === 4);
    expect(gateway.createdOrders.slice(2)).toEqual(expect.arrayContaining([
      expect.objectContaining({ symbol: 'GATE_FUTURE_SKHY_USDT', side: 'SELL', reduce_only: 'true' }),
      expect.objectContaining({ symbol: 'GATE_FUTURE_SKHYNIX_USDT', side: 'BUY', reduce_only: 'true' }),
    ]));
    ackOrder(runtime, 'remote-3', 'FILLED', '1', '143.78');
    ackOrder(runtime, 'remote-4', 'FILLED', '0.1', '1083.8');
    await exitTick;
    await waitFor(() => runtime.getStrategy(record.id).status === 'COMPLETED');
  });

  it('latches take profit after a partial opening, closes all filled exposure, and never re-enters', async () => {
    const { engine, runtime, gateway, markets } = await createHarness();
    markets.set('GATE_FUTURE_SKHY_USDT', '229.9', '230.0');
    markets.set('GATE_FUTURE_SKHYNIX_USDT', '1700', '1700');
    const record = await engine.startStrategy({
      kind: 'premium', asset: 'SKHY', hedgeAsset: 'SKHYNIX', adrRatio: '10',
      leftVenue: 'GATE', rightVenue: 'GATE', leftSide: 'SELL', rightSide: 'BUY',
      entryPremiumPct: '35', takeProfitPremiumPct: '24', maxPosition: '0.3', perOrderQuantity: '0.1',
      reduceOnly: false, executionMethod: 'TAKER_TAKER',
    });

    for (let clip = 0; clip < 2; clip += 1) {
      const tick = engine.tick();
      await waitFor(() => gateway.createdOrders.length === (clip + 1) * 2);
      ackOrder(runtime, `remote-${clip * 2 + 1}`, 'FILLED', '0.1', '229.9');
      ackOrder(runtime, `remote-${clip * 2 + 2}`, 'FILLED', '0.01', '1700');
      await tick;
    }
    expect(runtime.getStrategy(record.id).openPosition).toBe('0.2');
    expect(runtime.getStrategy(record.id).progress).toBeCloseTo(66.6667, 3);

    // Take profit arrives before the configured 0.3 maximum was reached.
    markets.set('GATE_FUTURE_SKHY_USDT', '209.8', '210.0');
    const exitTick = engine.tick();
    await waitFor(() => gateway.createdOrders.length === 6);
    ackOrder(runtime, 'remote-5', 'FILLED', '0.1', '210');
    ackOrder(runtime, 'remote-6', 'FILLED', '0.01', '1700');

    // Even if the premium immediately moves back to the entry region, the latched exit must
    // reduce the remaining partial position instead of opening another clip.
    markets.set('GATE_FUTURE_SKHY_USDT', '229.9', '230.0');
    await waitFor(() => gateway.createdOrders.length === 8);
    const residualCloses = gateway.createdOrders.slice(6);
    expect(residualCloses).toEqual(expect.arrayContaining([
      expect.objectContaining({ symbol: 'GATE_FUTURE_SKHY_USDT', side: 'BUY', qty: '0.1', reduce_only: 'true' }),
      expect.objectContaining({ symbol: 'GATE_FUTURE_SKHYNIX_USDT', side: 'SELL', qty: '0.01', reduce_only: 'true' }),
    ]));
    ackOrder(runtime, 'remote-7', 'FILLED', '0.1', '230');
    ackOrder(runtime, 'remote-8', 'FILLED', '0.01', '1700');
    await exitTick;

    await waitFor(() => runtime.getStrategy(record.id).status === 'COMPLETED');
    expect(runtime.getStrategy(record.id)).toMatchObject({ openPosition: '0', progress: 100 });
    expect(engine.listActiveStrategyIds()).not.toContain(record.id);
    await engine.tick();
    expect(gateway.createdOrders).toHaveLength(8);
  });

  it('caps every take-profit follow-up at the per-order quantity instead of closing the full residual', async () => {
    const { engine, runtime, gateway, markets } = await createHarness();
    markets.set('GATE_FUTURE_SKHY_USDT', '229.9', '230.0');
    markets.set('GATE_FUTURE_SKHYNIX_USDT', '1700', '1700');
    const record = await engine.startStrategy({
      kind: 'premium', asset: 'SKHY', hedgeAsset: 'SKHYNIX', adrRatio: '10',
      leftVenue: 'GATE', rightVenue: 'GATE', leftSide: 'SELL', rightSide: 'BUY',
      entryPremiumPct: '35', takeProfitPremiumPct: '24', maxPosition: '0.4', perOrderQuantity: '0.1',
      reduceOnly: false, executionMethod: 'TAKER_TAKER',
    });

    for (let clip = 0; clip < 4; clip += 1) {
      const tick = engine.tick();
      await waitFor(() => gateway.createdOrders.length === (clip + 1) * 2);
      ackOrder(runtime, `remote-${clip * 2 + 1}`, 'FILLED', '0.1', '229.9');
      ackOrder(runtime, `remote-${clip * 2 + 2}`, 'FILLED', '0.01', '1700');
      await tick;
    }
    expect(runtime.getStrategy(record.id).openPosition).toBe('0.4');

    markets.set('GATE_FUTURE_SKHY_USDT', '209.8', '210.0');
    const exitTick = engine.tick();
    await waitFor(() => gateway.createdOrders.length === 10);
    ackOrder(runtime, 'remote-9', 'FILLED', '0.1', '210');
    ackOrder(runtime, 'remote-10', 'FILLED', '0.01', '1700');

    for (let residualClip = 0; residualClip < 3; residualClip += 1) {
      const expectedCount = 12 + residualClip * 2;
      await waitFor(() => gateway.createdOrders.length === expectedCount);
      const [left, right] = gateway.createdOrders.slice(expectedCount - 2, expectedCount);
      expect(left).toMatchObject({ symbol: 'GATE_FUTURE_SKHY_USDT', side: 'BUY', qty: '0.1', reduce_only: 'true' });
      expect(right).toMatchObject({ symbol: 'GATE_FUTURE_SKHYNIX_USDT', side: 'SELL', qty: '0.01', reduce_only: 'true' });
      ackOrder(runtime, `remote-${expectedCount - 1}`, 'FILLED', '0.1', '210');
      ackOrder(runtime, `remote-${expectedCount}`, 'FILLED', '0.01', '1700');
    }
    await exitTick;

    await waitFor(() => runtime.getStrategy(record.id).status === 'COMPLETED');
    expect(runtime.getStrategy(record.id)).toMatchObject({ progress: 100, openPosition: '0' });
    expect(gateway.createdOrders).toHaveLength(16);
  });

  it('closes the surviving leg after a take-profit leg fails instead of reopening the flat leg', async () => {
    let now = Date.now();
    const { engine, runtime, database, gateway, markets } = await createHarness({ now: () => now });
    markets.set('GATE_FUTURE_SKHY_USDT', '229.9', '230.0');
    markets.set('GATE_FUTURE_SKHYNIX_USDT', '1700', '1700');
    const record = await engine.startStrategy({
      kind: 'premium', asset: 'SKHY', hedgeAsset: 'SKHYNIX', adrRatio: '10',
      leftVenue: 'GATE', rightVenue: 'GATE', leftSide: 'SELL', rightSide: 'BUY',
      entryPremiumPct: '35', takeProfitPremiumPct: '24', maxPosition: '0.1', perOrderQuantity: '0.1',
      reduceOnly: false, executionMethod: 'TAKER_TAKER',
    });
    const entryTick = engine.tick();
    await waitFor(() => gateway.createdOrders.length === 2);
    ackOrder(runtime, 'remote-1', 'FILLED', '0.1', '229.9');
    ackOrder(runtime, 'remote-2', 'FILLED', '0.01', '1700');
    await entryTick;

    gateway.failCreate('GATE_FUTURE_SKHYNIX_USDT', 1);
    markets.set('GATE_FUTURE_SKHY_USDT', '209.8', '210.0');
    const exitTick = engine.tick();
    await waitFor(() => gateway.createdOrders.length === 3);
    ackOrder(runtime, 'remote-3', 'FILLED', '0.1', '210');
    await exitTick;
    expect(runtime.getStrategy(record.id).status).toBe('RUNNING');

    // The exit phase is recovered from durable reduce-only order history after a restart.
    await engine.stop();
    now += 5_000;
    const rearmedSession = new TradingSession();
    rearmedSession.set('live');
    const resumed = new StrategyEngine(database, rearmedSession, runtime, markets, {
      tickIntervalMs: 20, orderTimeoutMs: 400, repairCooldownMs: 0, now: () => now,
    });
    resumed.start();
    const cleanupTick = resumed.tick();
    await waitFor(() => gateway.createdOrders.length === 4);
    expect(gateway.createdOrders[3]).toMatchObject({
      symbol: 'GATE_FUTURE_SKHYNIX_USDT', side: 'SELL', qty: '0.01', reduce_only: 'true',
    });
    ackOrder(runtime, 'remote-4', 'FILLED', '0.01', '1700');
    await cleanupTick;
    await waitFor(() => runtime.getStrategy(record.id).status === 'COMPLETED');
    expect(gateway.createdOrders.filter((order) => (
      order.symbol === 'GATE_FUTURE_SKHY_USDT' && order.side === 'SELL'
    ))).toHaveLength(1);
    await resumed.stop();
  });

  it('applies both leverage settings only after the full premium capacity passes margin preflight', async () => {
    const { engine, runtime, gateway, markets } = await createHarness();
    markets.set('GATE_FUTURE_SKHY_USDT', '229.9', '230');
    markets.set('BINANCE_FUTURE_SKHYNIX_USDT', '1699', '1700');

    const record = await engine.startStrategy({
      kind: 'premium', asset: 'SKHY', hedgeAsset: 'SKHYNIX', adrRatio: '10',
      leftVenue: 'GATE', rightVenue: 'BINANCE', leftSide: 'SELL', rightSide: 'BUY',
      leftLeverage: '5', rightLeverage: '10',
      entryPremiumPct: '35', takeProfitPremiumPct: '24', maxPosition: '0.5', perOrderQuantity: '0.1',
      reduceOnly: false, executionMethod: 'TAKER_TAKER',
    });

    expect(record.config).toMatchObject({ leftLeverage: '5', rightLeverage: '10' });
    expect(gateway.leverageUpdates).toEqual([
      { symbol: 'GATE_FUTURE_SKHY_USDT', leverage: '5' },
      { symbol: 'BINANCE_FUTURE_SKHYNIX_USDT', leverage: '10' },
    ]);
    expect(runtime.strategyLogs(record.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({ event: 'Strategy started', result: expect.stringContaining('reserved margin') }),
    ]));
  });

  it('does not reapply numerically equivalent leverage settings during premium preflight', async () => {
    const { engine, gateway, markets } = await createHarness();
    gateway.leverages = {
      GATE_FUTURE_SKHY_USDT: '12.0',
      GATE_FUTURE_SKHYNIX_USDT: '15',
    };
    markets.set('GATE_FUTURE_SKHY_USDT', '155.7', '155.8');
    markets.set('GATE_FUTURE_SKHYNIX_USDT', '1180.2', '1180.3');

    const record = await engine.startStrategy({
      kind: 'premium', asset: 'SKHY', hedgeAsset: 'SKHYNIX', adrRatio: '10',
      leftVenue: 'GATE', rightVenue: 'GATE', leftSide: 'SELL', rightSide: 'BUY',
      leftLeverage: '12', rightLeverage: '15', hedgeMode: 'EQUAL_NOTIONAL',
      entryPremiumPct: '35', takeProfitPremiumPct: '24', maxPosition: '10', perOrderQuantity: '1',
      reduceOnly: false, executionMethod: 'TAKER_TAKER',
    });

    expect(record.status).toBe('RUNNING');
    expect(gateway.leverageQueries).toEqual([
      ['GATE_FUTURE_SKHY_USDT'],
      ['GATE_FUTURE_SKHYNIX_USDT'],
    ]);
    expect(gateway.leverageUpdates).toHaveLength(0);
  });

  it('rejects new premium grid strategies without persisting or ordering', async () => {
    const { engine, runtime, gateway } = await createHarness();

    await expect(engine.startStrategy({
      kind: 'premium', asset: 'SKHY', hedgeAsset: 'SKHYNIX', adrRatio: '10',
      leftVenue: 'GATE', rightVenue: 'GATE', leftSide: 'SELL', rightSide: 'BUY',
      entryPremiumPct: '35', grid: true, gridStepPct: '1', gridLevels: 5,
      perOrderQuantity: '0.1', reduceOnly: false, executionMethod: 'TAKER_TAKER',
    })).rejects.toMatchObject({ code: 'premium_grid_mode_removed', statusCode: 400 });

    expect(runtime.listStrategies()).toHaveLength(0);
    expect(gateway.createdOrders).toHaveLength(0);
  });

  it('rejects a premium strategy before persistence or leverage changes when planned margin is insufficient', async () => {
    const { engine, runtime, gateway, markets } = await createHarness();
    gateway.availableMargin = '30';
    markets.set('GATE_FUTURE_SKHY_USDT', '229.9', '230');
    markets.set('BINANCE_FUTURE_SKHYNIX_USDT', '1699', '1700');

    await expect(engine.startStrategy({
      kind: 'premium', asset: 'SKHY', hedgeAsset: 'SKHYNIX', adrRatio: '10',
      leftVenue: 'GATE', rightVenue: 'BINANCE', leftSide: 'SELL', rightSide: 'BUY',
      leftLeverage: '5', rightLeverage: '10',
      entryPremiumPct: '35', takeProfitPremiumPct: '24', maxPosition: '0.5', perOrderQuantity: '0.1',
      reduceOnly: false, executionMethod: 'TAKER_TAKER',
    })).rejects.toMatchObject({ code: 'insufficient_strategy_margin', statusCode: 409 });

    expect(runtime.listStrategies()).toHaveLength(0);
    expect(gateway.leverageUpdates).toHaveLength(0);
    expect(gateway.createdOrders).toHaveLength(0);
  });

  it('rejects a strategy whose projected position exceeds the tier allowed by selected leverage', async () => {
    const { engine, runtime, gateway, markets } = await createHarness();
    gateway.riskLimits.GATE_FUTURE_SKHY_USDT = [
      { tier: '1', min_risk_limit_value: '0', max_risk_limit_value: '100', quick_cal_amount: '0', leverage_max: '20', maintenance_rate: '0.01' },
      { tier: '2', min_risk_limit_value: '100', max_risk_limit_value: '500', quick_cal_amount: '0', leverage_max: '10', maintenance_rate: '0.02' },
    ];
    markets.set('GATE_FUTURE_SKHY_USDT', '229.9', '230');
    markets.set('BINANCE_FUTURE_SKHYNIX_USDT', '1699', '1700');

    await expect(engine.startStrategy({
      kind: 'premium', asset: 'SKHY', hedgeAsset: 'SKHYNIX', adrRatio: '10',
      leftVenue: 'GATE', rightVenue: 'BINANCE', leftSide: 'SELL', rightSide: 'BUY',
      leftLeverage: '20', rightLeverage: '10',
      entryPremiumPct: '35', takeProfitPremiumPct: '24', maxPosition: '0.5', perOrderQuantity: '0.1',
      reduceOnly: false, executionMethod: 'TAKER_TAKER',
    })).rejects.toMatchObject({ code: 'strategy_position_exceeds_leverage_limit', statusCode: 409 });

    expect(runtime.listStrategies()).toHaveLength(0);
    expect(gateway.leverageUpdates).toHaveLength(0);
    expect(gateway.createdOrders).toHaveLength(0);
  });

  it('allows a premium strategy whose maximum capacity only reduces same-venue opposite positions', async () => {
    const { engine, runtime, gateway, markets } = await createHarness();
    gateway.availableMargin = '0';
    gateway.positions = [
      futuresPosition('GATE_FUTURE_SKHY_USDT', 'SHORT', '15'),
      futuresPosition('GATE_FUTURE_SKHYNIX_USDT', 'LONG', '1.95'),
    ];
    markets.set('GATE_FUTURE_SKHY_USDT', '156.1', '156.2');
    markets.set('GATE_FUTURE_SKHYNIX_USDT', '1180.4', '1180.5');

    const record = await engine.startStrategy({
      kind: 'premium', asset: 'SKHY', hedgeAsset: 'SKHYNIX', adrRatio: '10',
      leftVenue: 'GATE', rightVenue: 'GATE', leftSide: 'BUY', rightSide: 'SELL',
      leftLeverage: '5', rightLeverage: '5', hedgeMode: 'EQUAL_NOTIONAL',
      entryPremiumPct: '35', takeProfitPremiumPct: '50', maxPosition: '15', perOrderQuantity: '1',
      reduceOnly: false, executionMethod: 'TAKER_TAKER',
    });

    expect(record.status).toBe('RUNNING');
    expect(runtime.strategyLogs(record.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({ event: 'Strategy started', result: expect.stringContaining('reserved margin 0 of 0') }),
    ]));
  });

  it('does not offset opposite positions held on another venue', async () => {
    const { engine, runtime, gateway, markets } = await createHarness();
    gateway.availableMargin = '10';
    gateway.positions = [
      futuresPosition('BINANCE_FUTURE_SKHY_USDT', 'SHORT', '15'),
      futuresPosition('BINANCE_FUTURE_SKHYNIX_USDT', 'LONG', '1.95'),
    ];
    markets.set('GATE_FUTURE_SKHY_USDT', '156.1', '156.2');
    markets.set('GATE_FUTURE_SKHYNIX_USDT', '1180.4', '1180.5');

    await expect(engine.startStrategy({
      kind: 'premium', asset: 'SKHY', hedgeAsset: 'SKHYNIX', adrRatio: '10',
      leftVenue: 'GATE', rightVenue: 'GATE', leftSide: 'BUY', rightSide: 'SELL',
      leftLeverage: '5', rightLeverage: '5', hedgeMode: 'EQUAL_NOTIONAL',
      entryPremiumPct: '35', takeProfitPremiumPct: '50', maxPosition: '15', perOrderQuantity: '1',
      reduceOnly: false, executionMethod: 'TAKER_TAKER',
    })).rejects.toMatchObject({ code: 'insufficient_strategy_margin', statusCode: 409 });

    expect(runtime.listStrategies()).toHaveLength(0);
    expect(gateway.leverageUpdates).toHaveLength(0);
  });

  it('pauses immediately and sends no further clips when both legs report insufficient margin', async () => {
    const { engine, runtime, gateway, markets } = await createHarness();
    markets.set('GATE_FUTURE_SKHY_USDT', '229.9', '230');
    markets.set('GATE_FUTURE_SKHYNIX_USDT', '1700', '1700');
    const record = await engine.startStrategy({
      kind: 'premium', asset: 'SKHY', hedgeAsset: 'SKHYNIX', adrRatio: '10',
      leftVenue: 'GATE', rightVenue: 'GATE', leftSide: 'SELL', rightSide: 'BUY',
      leftLeverage: '3', rightLeverage: '3',
      entryPremiumPct: '35', takeProfitPremiumPct: '24', maxPosition: '0.1', perOrderQuantity: '0.1',
      reduceOnly: false, executionMethod: 'TAKER_TAKER',
    });
    gateway.failCreate('GATE_FUTURE_SKHY_USDT', 10);
    gateway.failCreate('GATE_FUTURE_SKHYNIX_USDT', 10);

    await engine.tick();
    expect(runtime.getStrategy(record.id).status).toBe('PAUSED');
    const requestCount = gateway.createAttempts.length;
    await engine.tick();
    await engine.tick();

    expect(gateway.createAttempts).toHaveLength(requestCount);
    expect(runtime.strategyLogs(record.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({ event: 'Strategy paused', result: expect.stringContaining('stopped retrying') }),
    ]));
  });

  it('updates a running ADR premium bot take profit and uses it on the next tick', async () => {
    const { engine, runtime, gateway, markets } = await createHarness();
    markets.set('GATE_FUTURE_SKHY_USDT', '229.9', '230.0');
    markets.set('GATE_FUTURE_SKHYNIX_USDT', '1700', '1700');
    const record = await engine.startStrategy({
      kind: 'premium', asset: 'SKHY', hedgeAsset: 'SKHYNIX', adrRatio: '10',
      leftVenue: 'GATE', rightVenue: 'GATE', leftSide: 'SELL', rightSide: 'BUY',
      entryPremiumPct: '35', takeProfitPremiumPct: '24', maxPosition: '0.1', perOrderQuantity: '0.1',
      reduceOnly: false, executionMethod: 'TAKER_TAKER',
    });

    const entryTick = engine.tick();
    await waitFor(() => gateway.createdOrders.length === 2);
    ackOrder(runtime, 'remote-1', 'FILLED', '0.1', '229.9');
    ackOrder(runtime, 'remote-2', 'FILLED', '0.01', '1700');
    await entryTick;
    await waitFor(() => runtime.getStrategy(record.id).openPosition === '0.1');

    // 25% is above the original 24% exit, but below the newly edited 26% exit.
    markets.set('GATE_FUTURE_SKHY_USDT', '212.4', '212.5');
    await engine.tick();
    expect(gateway.createdOrders).toHaveLength(2);

    const updated = await engine.updatePremiumTakeProfit(record.id, { takeProfitPremiumPct: '26' });
    expect(updated.config.takeProfitPremiumPct).toBe('26');
    expect(runtime.strategyLogs(record.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({ event: 'Take-profit updated', condition: '24% → 26%' }),
    ]));

    const exitTick = engine.tick();
    await waitFor(() => gateway.createdOrders.length === 4);
    expect(gateway.createdOrders.slice(2)).toEqual(expect.arrayContaining([
      expect.objectContaining({ symbol: 'GATE_FUTURE_SKHY_USDT', side: 'BUY', reduce_only: 'true' }),
      expect.objectContaining({ symbol: 'GATE_FUTURE_SKHYNIX_USDT', side: 'SELL', reduce_only: 'true' }),
    ]));
    ackOrder(runtime, 'remote-3', 'FILLED', '0.1', '212.5');
    ackOrder(runtime, 'remote-4', 'FILLED', '0.01', '1700');
    await exitTick;
  });

  it('rejects invalid take-profit edits for running ADR premium bots', async () => {
    const { engine, runtime, markets } = await createHarness();
    markets.set('GATE_FUTURE_SKHY_USDT', '200', '201');
    markets.set('GATE_FUTURE_SKHYNIX_USDT', '1700', '1700');
    const record = await engine.startStrategy({
      kind: 'premium', asset: 'SKHY', hedgeAsset: 'SKHYNIX', adrRatio: '10',
      leftVenue: 'GATE', rightVenue: 'GATE', leftSide: 'SELL', rightSide: 'BUY',
      entryPremiumPct: '35', takeProfitPremiumPct: '24', maxPosition: '0.1', perOrderQuantity: '0.1',
      reduceOnly: false, executionMethod: 'TAKER_TAKER',
    });

    await expect(engine.updatePremiumTakeProfit(record.id, { takeProfitPremiumPct: '35' }))
      .rejects.toMatchObject({ code: 'take_profit_must_be_below_entry' });
    await expect(engine.updatePremiumTakeProfit(record.id, { takeProfitPremiumPct: 'not-a-number' }))
      .rejects.toMatchObject({ name: 'ZodError' });
    expect(runtime.getStrategy(record.id).config.takeProfitPremiumPct).toBe('24');
  });

  it('rejects premium bots whose take profit is on the wrong side of entry', async () => {
    const { engine, markets } = await createHarness();
    markets.set('GATE_FUTURE_SKHY_USDT', '229.9', '230.0');
    markets.set('GATE_FUTURE_SKHYNIX_USDT', '1700', '1700');
    const base = {
      kind: 'premium', asset: 'SKHY', hedgeAsset: 'SKHYNIX', adrRatio: '10',
      leftVenue: 'GATE', rightVenue: 'GATE', leftSide: 'SELL', rightSide: 'BUY',
      entryPremiumPct: '35', maxPosition: '0.2', perOrderQuantity: '0.1',
      reduceOnly: false, executionMethod: 'TAKER_TAKER',
    } as const;
    await expect(engine.startStrategy({ ...base, takeProfitPremiumPct: '36' }))
      .rejects.toMatchObject({ code: 'take_profit_must_be_below_entry' });
    await expect(engine.startStrategy({ ...base, leftSide: 'BUY', rightSide: 'SELL', entryPremiumPct: '-5', takeProfitPremiumPct: '-8' }))
      .rejects.toMatchObject({ code: 'take_profit_must_be_above_entry' });
  });

  it('repairs the hedge with a ratio-scaled order when the hedge leg fails to submit', async () => {
    const { engine, runtime, gateway, markets } = await createHarness();
    markets.set('GATE_FUTURE_SKHY_USDT', '229.9', '230.0');
    markets.set('GATE_FUTURE_SKHYNIX_USDT', '1700', '1700');
    gateway.failCreate('GATE_FUTURE_SKHYNIX_USDT', 1);
    const record = await engine.startStrategy({
      kind: 'premium', asset: 'SKHY', hedgeAsset: 'SKHYNIX', adrRatio: '10',
      leftVenue: 'GATE', rightVenue: 'GATE', leftSide: 'SELL', rightSide: 'BUY',
      entryPremiumPct: '35', takeProfitPremiumPct: '24', maxPosition: '0.2', perOrderQuantity: '0.1',
      reduceOnly: false, executionMethod: 'TAKER_TAKER',
    });

    const firstTick = engine.tick();
    await waitFor(() => gateway.createdOrders.length === 1);
    ackOrder(runtime, 'remote-1', 'FILLED', '0.1', '229.9');
    await firstTick;

    // 0.1 SKHY sold with no hedge: the repair buys 0.1 ÷ 10 = 0.01 SKHYNIX.
    const repairTick = engine.tick();
    await waitFor(() => gateway.createdOrders.length === 2);
    expect(gateway.createdOrders[1]).toMatchObject({ symbol: 'GATE_FUTURE_SKHYNIX_USDT', side: 'BUY', type: 'MARKET', qty: '0.01' });
    ackOrder(runtime, 'remote-2', 'FILLED', '0.01', '1705');
    await repairTick;
    await waitFor(() => runtime.getStrategy(record.id).filledQuantity === '0.1');
    expect(runtime.getStrategy(record.id).status).toBe('RUNNING');
  });

  it('sizes equal-notional hedges from execution prices and unwinds them proportionally', async () => {
    const { engine, runtime, gateway, markets } = await createHarness();
    markets.set('GATE_FUTURE_SKHY_USDT', '229.9', '230.0');
    markets.set('GATE_FUTURE_SKHYNIX_USDT', '1700', '1700');
    const record = await engine.startStrategy({
      kind: 'premium', asset: 'SKHY', hedgeAsset: 'SKHYNIX', adrRatio: '10', hedgeMode: 'EQUAL_NOTIONAL',
      leftVenue: 'GATE', rightVenue: 'GATE', leftSide: 'SELL', rightSide: 'BUY',
      entryPremiumPct: '35', takeProfitPremiumPct: '24', maxPosition: '0.1', perOrderQuantity: '0.1',
      reduceOnly: false, executionMethod: 'TAKER_TAKER',
    });

    const entryTick = engine.tick();
    await waitFor(() => gateway.createdOrders.length === 2);
    const [adrLeg, hedgeLeg] = gateway.createdOrders;
    expect(adrLeg).toMatchObject({ symbol: 'GATE_FUTURE_SKHY_USDT', side: 'SELL', qty: '0.1' });
    // Equal notional at execution prices: 0.1 × 229.9 ÷ 1700 ≈ 0.0135235 SKHYNIX — not 0.01.
    expect(hedgeLeg?.symbol).toBe('GATE_FUTURE_SKHYNIX_USDT');
    expect(Number(hedgeLeg?.qty)).toBeCloseTo(0.0135235, 6);
    const hedgeQty = hedgeLeg?.qty ?? '0';
    ackOrder(runtime, 'remote-1', 'FILLED', '0.1', '229.9');
    ackOrder(runtime, 'remote-2', 'FILLED', hedgeQty, '1700');
    await entryTick;
    await waitFor(() => runtime.getStrategy(record.id).openPosition === '0.1');
    expect(runtime.getStrategy(record.id).progress).toBe(100);

    // A hedged equal-notional clip must not trigger phantom repairs as prices move.
    markets.set('GATE_FUTURE_SKHY_USDT', '232.9', '233.0');
    await engine.tick();
    expect(gateway.createdOrders).toHaveLength(2);

    // Premium converges; the exit unwinds the actually-held hedge shares, not per-order ÷ ratio.
    markets.set('GATE_FUTURE_SKHY_USDT', '209.8', '210.0');
    const exitTick = engine.tick();
    await waitFor(() => gateway.createdOrders.length === 4);
    const exits = gateway.createdOrders.slice(2);
    expect(exits.find((order) => order.symbol === 'GATE_FUTURE_SKHY_USDT')).toMatchObject({ side: 'BUY', qty: '0.1', reduce_only: 'true' });
    const hedgeExit = exits.find((order) => order.symbol === 'GATE_FUTURE_SKHYNIX_USDT');
    expect(hedgeExit?.side).toBe('SELL');
    expect(Number(hedgeExit?.qty)).toBeCloseTo(Number(hedgeQty), 12);
    ackOrder(runtime, 'remote-3', 'FILLED', '0.1', '210.0');
    ackOrder(runtime, 'remote-4', 'FILLED', hedgeExit?.qty ?? '0', '1700');
    await exitTick;
    await waitFor(() => runtime.getStrategy(record.id).openPosition === '0');
    expect(runtime.getStrategy(record.id).status).toBe('COMPLETED');
  });

  it('repairs a failed equal-notional hedge with the clip-intended quantity', async () => {
    const { engine, runtime, gateway, markets } = await createHarness();
    markets.set('GATE_FUTURE_SKHY_USDT', '229.9', '230.0');
    markets.set('GATE_FUTURE_SKHYNIX_USDT', '1700', '1700');
    gateway.failCreate('GATE_FUTURE_SKHYNIX_USDT', 1);
    const record = await engine.startStrategy({
      kind: 'premium', asset: 'SKHY', hedgeAsset: 'SKHYNIX', adrRatio: '10', hedgeMode: 'EQUAL_NOTIONAL',
      leftVenue: 'GATE', rightVenue: 'GATE', leftSide: 'SELL', rightSide: 'BUY',
      entryPremiumPct: '35', takeProfitPremiumPct: '24', maxPosition: '0.1', perOrderQuantity: '0.1',
      reduceOnly: false, executionMethod: 'TAKER_TAKER',
    });

    const firstTick = engine.tick();
    await waitFor(() => gateway.createdOrders.length === 1);
    ackOrder(runtime, 'remote-1', 'FILLED', '0.1', '229.9');
    await firstTick;

    // Even though prices moved after the clip, the repair restores the clip's own intended
    // hedge (0.1 × 229.9 ÷ 1700), recovered from the failed order's requested quantity.
    markets.set('GATE_FUTURE_SKHY_USDT', '239.9', '240.0');
    const repairTick = engine.tick();
    await waitFor(() => gateway.createdOrders.length === 2);
    const repair = gateway.createdOrders[1];
    expect(repair?.symbol).toBe('GATE_FUTURE_SKHYNIX_USDT');
    expect(repair?.side).toBe('BUY');
    expect(Number(repair?.qty)).toBeCloseTo(0.0135235, 6);
    ackOrder(runtime, 'remote-2', 'FILLED', repair?.qty ?? '0', '1705');
    await repairTick;
    await waitFor(() => runtime.getStrategy(record.id).filledQuantity === '0.1');
    expect(runtime.getStrategy(record.id).status).toBe('RUNNING');
  });

  it('rejects equal-notional hedging on non-premium strategies', async () => {
    const { engine, markets } = await createHarness();
    markets.set('BINANCE_FUTURE_BTC_USDT', '100150', '100151');
    markets.set('OKX_FUTURE_BTC_USDT', '99999', '100000');
    await expect(engine.startStrategy({ ...takerTakerConfig, hedgeMode: 'EQUAL_NOTIONAL' })).rejects.toThrow();
  });

  it('keeps RUNNING strategies detached after restart until live activation reconciles them', async () => {
    const { engine, runtime, database, markets, gateway } = await createHarness();
    markets.set('BINANCE_FUTURE_BTC_USDT', '100150', '100151');
    markets.set('OKX_FUTURE_BTC_USDT', '99999', '100000');
    const record = await engine.startStrategy(takerTakerConfig);
    await engine.stop();

    const rearmedSession = new TradingSession();
    const resumed = new StrategyEngine(database, rearmedSession, runtime, markets, { tickIntervalMs: 20, orderTimeoutMs: 400 });
    resumed.start();
    expect(resumed.listActiveStrategyIds()).toEqual([]);
    rearmedSession.set('live');
    await resumed.prepareForLiveActivation();
    resumed.activatePersistedStrategies();
    expect(resumed.listActiveStrategyIds()).toEqual([record.id]);
    expect(runtime.strategyLogs(record.id).some((log) => log.event === 'Strategy resumed')).toBe(true);
    const resumeTick = resumed.tick();
    await waitFor(() => gateway.createdOrders.length === 2);
    ackOrder(runtime, 'remote-1', 'FILLED', '0.1', '100150');
    ackOrder(runtime, 'remote-2', 'FILLED', '0.1', '100000');
    await resumeTick;
    await resumed.stop();
  });

  it('prevents persisted strategies from resuming after an account credential change', async () => {
    const { engine, runtime, markets } = await createHarness();
    markets.set('BINANCE_FUTURE_BTC_USDT', '100150', '100151');
    markets.set('OKX_FUTURE_BTC_USDT', '99999', '100000');
    const record = await engine.startStrategy(takerTakerConfig, {
      profileId: 'account-primary',
      label: 'Primary Trading',
    });

    expect(record).toMatchObject({
      accountProfileId: 'account-primary',
      accountLabel: 'Primary Trading',
    });
    expect(engine.runningStrategiesForCredentialProfile('account-secondary')).toEqual([]);
    expect(engine.runningStrategiesForCredentialProfile('account-primary')).toEqual([
      expect.objectContaining({ id: record.id }),
    ]);
    expect(engine.pauseRunningStrategiesForCredentialChange('account-secondary')).toBe(0);
    expect(runtime.getStrategy(record.id).status).toBe('RUNNING');

    expect(engine.pauseRunningStrategiesForCredentialChange('account-primary')).toBe(1);
    expect(runtime.getStrategy(record.id).status).toBe('PAUSED');
    expect(engine.listActiveStrategyIds()).toEqual([]);
    engine.activatePersistedStrategies('account-primary');
    expect(engine.listActiveStrategyIds()).toEqual([]);
    expect(runtime.strategyLogs(record.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({ event: 'Strategy paused', condition: 'Account credentials changed' }),
    ]));
  });
});
