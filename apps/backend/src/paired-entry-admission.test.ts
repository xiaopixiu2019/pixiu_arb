import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolve } from 'node:path';
import { openDatabase } from './database.js';
import { CreateStrategyInputSchema, TradingRuntime } from './trading-runtime.js';
import { MemoryCredentialVault, DEFAULT_CREDENTIAL_PROFILE } from './credential-vault.js';
import { TradingSession } from './trading-session.js';
import { createMarginRiskService } from './margin-risk-service.js';
import { initialManagedState } from './managed-position-store.js';
import { readEntryBudget } from './paired-entry-ledger.js';
import { GateApiError, type TradingCrossExGateway, type GateCrossExAccount } from './crossex-client.js';
import type { ManagedAccountFacts, ManagedPositionManager } from './managed-position-manager.js';
import type { StrategyEngine } from './strategy-engine.js';
import type { LiveMarket } from './market-hub.js';
import { Decimal } from 'decimal.js';
import { createHash } from 'node:crypto';
import { TransactionFeeStore } from './transaction-fee-store.js';
import { PairedEntryAdmission } from './paired-entry-admission.js';

const closes: Array<() => Promise<void>> = [];
afterEach(async () => { vi.restoreAllMocks(); for (const close of closes.splice(0)) await close(); vi.useRealTimers(); });
const asset = (venue: string, coin: string, initial = '0', maintenance = '0') => ({ exchange_type: venue, coin,
  balance: '0', equity: '0', upnl: '0', liability: '0', available_balance: '0',
  futures_initial_margin: initial, futures_maintenance_margin: maintenance, borrowing_initial_margin: '0', borrowing_maintenance_margin: '0' });
async function harness(split = false, initialBalance = '10000', target = '20', poolEvidence = false) {
  const db = openDatabase(':memory:', resolve('../../migrations')), session = new TradingSession(); session.set('live');
  const vault = new MemoryCredentialVault(); await vault.set(DEFAULT_CREDENTIAL_PROFILE, { apiKey: 'fake', apiSecret: 'fake' });
  const symbols = ['KRAKEN_FUTURE_HYPE_USD', 'DERIBIT_FUTURE_HYPE_USDC'];
  let price = '80', failWrite = false, dispatchAction = () => undefined; const writes: unknown[] = [];
  const staleSymbols = new Set<string>();
  const account: GateCrossExAccount = { user_id: 'synthetic', account_mode: 'CROSS_EXCHANGE', position_mode: 'SINGLE', exchange_type: 'CROSSEX',
    available_margin: initialBalance, margin_balance: initialBalance, initial_margin: '0', maintenance_margin: '0',
    initial_margin_rate: '0', maintenance_margin_rate: '0', update_time: String(Date.now()), assets: [] };
  const units: Record<string, Partial<GateCrossExAccount>> = {};
  if (poolEvidence) account.assets = [{ ...asset('CROSSEX', 'USDT'), balance: initialBalance, equity: initialBalance, available_balance: initialBalance },
    asset('KRAKEN', 'USD'), asset('DERIBIT', 'USDC')];
  const reads = { account: vi.fn(async (_credentials?: unknown, venue?: string) => {
    if (split && !venue) throw new GateApiError(400, 'MISSING_REQUIRED_PARAM');
    return split ? { ...account, ...units[venue!], account_mode: 'ISOLATED_EXCHANGE', exchange_type: venue! } : account;
  }), positions: vi.fn(async () => []),
    symbols: vi.fn(async () => symbols.map(symbol => ({ symbol, support_cross: 'true' }))),
    leverage: vi.fn(async (_c: unknown, names: string[]) => Object.fromEntries(names.map(s => [s, '25']))),
    modes: vi.fn(async () => 'CROSS'), limits: vi.fn(async (names: string[]) => names.map(symbol => ({ symbol, tiers: [{ maintenance_rate: '0.01' }] }))) };
  const managed = vi.fn(async () => ({ positions: [] as import('./crossex-client.js').GateCrossExPosition[],
    openOrders: [] as import('./crossex-client.js').GateCrossExOrder[] }));
  const valuation = vi.fn(async () => ({ USDT: '1', USD: '1', USDC: '1' }));
  const gateway = { queryAccount: reads.account, queryPositions: reads.positions, queryManagedState: managed, queryValuationRates: valuation,
    querySymbols: reads.symbols, queryLeverages: reads.leverage, queryPositionMarginMode: reads.modes, queryRiskLimits: reads.limits,
    createOrder: async (_c: unknown, input: unknown, guard?: () => void) => { dispatchAction(); guard?.(); writes.push(input);
      if (failWrite) throw new Error('synthetic response lost'); return { order_id: `order-${writes.length}` }; },
  } as unknown as TradingCrossExGateway;
  const runtime = new TradingRuntime(db, session, vault, gateway, { submitResolvePollMs: 100000 });
  // Optional only so this same regression fixture can run against the fixed pre-fix source snapshot.
  runtime.setPairedPrivateStreamLive?.(poolEvidence);
  const config = CreateStrategyInputSchema.parse({ kind: 'position', asset: 'HYPE', leftVenue: 'KRAKEN', rightVenue: 'DERIBIT',
    leftSide: 'SELL', rightSide: 'BUY', leftLeverage: '25', rightLeverage: '25', entryBps: '10', totalAmount: target, perOrderQuantity: '10',
    executionMethod: 'MAKER_TAKER', makerLeg: 'left', management: { perOrderQuantity: '10' } });
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO execution_strategies(id,kind,environment,status,config_json,credential_profile_id,created_at,updated_at)
    VALUES('PAIR-TEST','position','live','RUNNING',?,'account',?,?)`).run(JSON.stringify(config), now, now);
  db.prepare('INSERT INTO managed_positions VALUES (?,?,?,?)').run('PAIR-TEST', 'account', JSON.stringify({ ...initialManagedState(),
    phase: 'OPENING', verified: true, groupId: 'PAIR-TEST', adoptedLeft: '0', adoptedRight: '0' }), now);
  for (const symbol of symbols) db.prepare('INSERT INTO managed_position_claims VALUES(?,?,?)').run(symbol, 'account', 'PAIR-TEST');
  let observe: (facts: ManagedAccountFacts) => void = () => undefined;
  const failAll = vi.fn();
  const monitor = createMarginRiskService({ db, runtime, gateway, enforce: true, profile: () => ({ id: 'account', label: 'Synthetic' }),
    context: () => 'account:1', live: () => session.liveTradingEnabled, credentials: () => vault.get(DEFAULT_CREDENTIAL_PROFILE),
    markets: { market: symbol => ({ symbol, source: 'gate_crossex_websocket', bidPrice: price, askPrice: price,
      updatedAt: new Date(Date.now() - (staleSymbols.has(symbol) ? 60000 : 0)).toISOString(),
      receivedAt: new Date(Date.now() - (staleSymbols.has(symbol) ? 60000 : 0)).toISOString() } as LiveMarket) },
    manager: { setMarginMonitor: vi.fn(), setMarginFacts: (listener: (facts: ManagedAccountFacts) => void) => { observe = listener; }, failAll, holdForMarginRead: vi.fn() } as unknown as ManagedPositionManager,
    engine: { haltForMarginRisk: async () => undefined } as unknown as StrategyEngine });
  closes.push(async () => { session.set('readonly'); await monitor.stop(); db.close(); });
  await runtime.preparePairedEntry('PAIR-TEST', config, 'account');
  const maker = () => runtime.createOrder({ symbol: symbols[0], side: 'SELL', type: 'LIMIT', timeInForce: 'POC', quantity: '10', price },
    { strategyId: 'PAIR-TEST', strategyLeg: 'left' });
  const hedge = (quantity = '5') => runtime.createOrder({ symbol: symbols[1], side: 'BUY', type: 'MARKET', timeInForce: 'IOC', quantity },
    { strategyId: 'PAIR-TEST', strategyLeg: 'right', riskReducing: true });
  return { db, session, runtime, monitor, config, reads, writes, account, maker, hedge, symbols, staleSymbols, units, managed, valuation, failAll,
    beforeDispatch: (action: () => undefined) => { dispatchAction = action; },
    observe: (facts: ManagedAccountFacts) => observe(facts),
    price: (p: string) => { price = p; }, failWrite: () => { failWrite = true; },
    fill: (id: string, quantity: string, state = 'PARTIALLY_FILLED') => runtime.ingestPrivateEvent({ channel: 'order', payload: { order_id: id,
      state, executed_qty: quantity, executed_avg_price: price, update_time: String(Date.now()) } }) };
}

async function reflectedMaker(h: Awaited<ReturnType<typeof harness>>, balance = '84') {
  Object.assign(h.account, { margin_balance: balance, available_margin: new Decimal(balance).minus(32).toString(),
    initial_margin: '32', maintenance_margin: '8', initial_margin_rate: new Decimal(balance).div(32).toString(),
    maintenance_margin_rate: new Decimal(balance).div(8).toString(), update_time: String(Date.now()) });
  h.account.assets[1] = asset('KRAKEN', 'USD', '32', '8');
  await h.monitor.refresh();
}

function recordedFee(h: Awaited<ReturnType<typeof harness>>, fee = '0.2', pool = 'KRAKEN') {
  const store = new TransactionFeeStore(h.db), key = createHash('sha256').update('account:synthetic').digest('hex');
  const maker = h.runtime.listOrders().find(order => order.strategyLeg === 'left')!, now = Date.parse(maker.updatedAt);
  store.begin(key, 'account', now - 10000); store.rates(key, now, { USD: '1' });
  store.saveTrades(key, 'account', [{ transaction_id: 'fee-trade', order_id: maker.remoteOrderId!, text: maker.clientOrderId,
    symbol: maker.symbol, exchange_type: 'KRAKEN', business_type: 'FUTURE', side: 'SELL', qty: maker.executedQuantity, price: '80',
    fee, fee_coin: 'USD', fee_rate: new Decimal(fee).div(new Decimal(maker.executedQuantity).mul(80)).toString(), match_role: 'MAKER',
    rpnl: '0', position_mode: 'SINGLE', position_side: 'SHORT', create_time: String(now) }], now);
  store.saveBook(key, [{ id: 'fee-book', business_id: maker.remoteOrderId!, symbol: maker.symbol, statement_type: 'TRADING_FEE',
    exchange_type: pool, coin: 'USD', change: new Decimal(fee).negated().toString(), balance: new Decimal(fee).negated().toString(), create_time: String(now) }], now);
  return key;
}
async function reflectedFee(h: Awaited<ReturnType<typeof harness>>, borrowInitial = '0.2', borrowMaintenance = '0.2') {
  const initial = new Decimal('32.6').plus(borrowInitial), maintenance = new Decimal('8.6').plus(borrowMaintenance);
  Object.assign(h.account, { margin_balance: '83.8', available_margin: new Decimal('83.8').minus(initial).toString(), initial_margin: initial.toString(),
    maintenance_margin: maintenance.toString(), initial_margin_rate: new Decimal('83.8').div(initial).toString(),
    maintenance_margin_rate: new Decimal('83.8').div(maintenance).toString(), update_time: String(Date.now()) });
  h.account.assets[1] = { ...asset('KRAKEN', 'USD', '32.6', '8.6'), balance: '-0.2', available_balance: '-0.2', equity: '-0.2',
    liability: '0.2', borrowing_initial_margin: borrowInitial, borrowing_maintenance_margin: borrowMaintenance };
  await h.monitor.refresh();
}

describe('paired entry through the real order runtime', () => {
  it('does not require a fresh covered Maker quote to send the still-fresh hedge', async () => {
    vi.useFakeTimers();
    const h = await harness(); await h.maker(); h.fill('order-1', '10', 'FILLED');
    await vi.advanceTimersByTimeAsync(10);
    Object.assign(h.account, { initial_margin: '32', maintenance_margin: '8', initial_margin_rate: '312.5',
      maintenance_margin_rate: '1250', available_margin: '9968', update_time: String(Date.now()) });
    await h.monitor.refresh();
    h.observe({ positions: [{ symbol: h.symbols[0], position_side: 'SHORT', position_qty: '10' }] as ManagedAccountFacts['positions'], openOrders: [] });
    const maker = h.runtime.listOrders()[0];
    expect(readEntryBudget(h.db, 'PAIR-TEST')?.legs[0].covered[maker.id]).toBe('10');
    h.staleSymbols.add(h.symbols[0]);
    await h.hedge('5'); expect(h.writes).toHaveLength(2);
    h.staleSymbols.add(h.symbols[1]);
    await expect(h.hedge('5')).rejects.toMatchObject({ code: 'paired_entry_market_unavailable' });
    expect(h.writes).toHaveLength(2);
  });
  it('keeps all hedge admission boundaries while constructing one full snapshot per check', async () => {
    const h = await harness(); await h.maker(); h.fill('order-1', '5');
    const checks = vi.spyOn(PairedEntryAdmission.prototype, 'assertOrder');
    const snapshots = vi.spyOn(h.monitor, 'snapshot');
    for (const read of Object.values(h.reads)) read.mockClear();
    await h.hedge('5');
    expect(checks).toHaveBeenCalledTimes(5);
    expect(snapshots).toHaveBeenCalledTimes(5);
    expect(h.writes).toHaveLength(2);
    for (const read of Object.values(h.reads)) expect(read).not.toHaveBeenCalled();
  });
  it.each([
    ['not reflected', '0', '0', '84', '0', '0'],
    ['partly reflected', '16', '4', '68', '5.25', '21'],
    ['fully reflected', '32', '8', '52', '2.625', '10.5'],
  ])('consumes an affordable approved pair when the maker is %s in official funds before positions',
    async (_label, initial, maintenance, available, initialRate, maintenanceRate) => {
      const h = await harness(false, '84', '10', true);
      await h.maker(); h.fill('order-1', '10', 'FILLED');
      Object.assign(h.account, { initial_margin: initial, maintenance_margin: maintenance, available_margin: available,
        initial_margin_rate: initialRate, maintenance_margin_rate: maintenanceRate, update_time: String(Date.now()) });
      h.account.assets[1] = asset('KRAKEN', 'USD', initial, maintenance);
      await h.monitor.refresh();
      expect(h.monitor.snapshot()).toMatchObject({ fresh: true, entryBlocked: false, incidentId: null });
      for (const read of Object.values(h.reads)) read.mockClear();
      h.managed.mockClear(); h.valuation.mockClear();
      await h.hedge('10');
      expect(h.writes).toHaveLength(2);
      for (const read of Object.values(h.reads)) expect(read).not.toHaveBeenCalled();
      expect(h.managed).not.toHaveBeenCalled(); expect(h.valuation).not.toHaveBeenCalled();
    });
  it.each(['missing', 'duplicate', 'wrong-pool', 'missing-fields', 'negative-fields'])(
    'never fabricates pool coverage from incomplete official evidence (%s)', async cause => {
      const h = await harness(false, '84', '10', true); await h.maker(); h.fill('order-1', '10', 'FILLED');
      await reflectedMaker(h);
      if (cause === 'missing') h.account.assets = [];
      if (cause === 'duplicate') h.account.assets.push({ ...h.account.assets[1] });
      if (cause === 'wrong-pool') h.account.assets[1].exchange_type = 'BYBIT';
      if (cause === 'missing-fields') delete (h.account.assets[1] as Partial<GateCrossExAccount['assets'][number]>).futures_initial_margin;
      if (cause === 'negative-fields') h.account.assets[1].futures_initial_margin = '-1';
      await h.monitor.refresh();
      await expect(h.hedge('10')).rejects.toMatchObject({ code: 'margin_available_insufficient' });
      expect(h.writes).toHaveLength(1);
    });
  it('keeps the original empty-assets boundary as a refusal, rather than inventing coverage', async () => {
    const h = await harness(false, '84', '10'); await h.maker(); h.fill('order-1', '10', 'FILLED');
    Object.assign(h.account, { initial_margin: '32', maintenance_margin: '8', available_margin: '52',
      initial_margin_rate: '2.625', maintenance_margin_rate: '10.5' });
    await h.monitor.refresh();
    await expect(h.hedge('10')).rejects.toMatchObject({ code: 'margin_available_insufficient' });
    expect(h.writes).toHaveLength(1);
  });
  it('refuses real cash depletion despite a healthy current official ratio', async () => {
    const h = await harness(false, '84', '10', true); await h.maker(); h.fill('order-1', '10', 'FILLED');
    await reflectedMaker(h, '70'); expect(h.monitor.snapshot().entryBlocked).toBe(false);
    await expect(h.hedge('10')).rejects.toMatchObject({ code: 'margin_available_insufficient' });
    expect(h.writes).toHaveLength(1);
  });
  it('preserves funded same-pool concurrency by testing the conservative budget before revoking credit', async () => {
    const h = await harness(false, '10000', '10', true);
    h.symbols.push('KRAKEN_FUTURE_BTC_USD', 'DERIBIT_FUTURE_BTC_USDC');
    await h.runtime.preparePairedEntry('PAIR-TWO', { ...h.config, asset: 'BTC' }, 'account');
    expect(readEntryBudget(h.db, 'PAIR-TWO')).not.toBeNull(); expect(h.writes).toHaveLength(0);
    await h.maker(); h.fill('order-1', '10', 'FILLED'); await h.hedge('10'); expect(h.writes).toHaveLength(2);
  });
  it('a failed competing approval cannot destroy the existing task\'s second-leg credit', async () => {
    const h = await harness(false, '84', '10', true);
    h.symbols.push('KRAKEN_FUTURE_BTC_USD', 'DERIBIT_FUTURE_BTC_USDC');
    await expect(h.runtime.preparePairedEntry('PAIR-TWO', { ...h.config, asset: 'BTC' }, 'account')).rejects.toThrow('margin_available_insufficient');
    expect(readEntryBudget(h.db, 'PAIR-TWO')).toBeNull();
    await h.maker(); h.fill('order-1', '10', 'FILLED'); await reflectedMaker(h); await h.hedge('10'); expect(h.writes).toHaveLength(2);
  });
  it.each(['order', 'usertrades', 'position'])('revokes attribution for a received external %s in the same pool', async channel => {
    const h = await harness(false, '84', '10', true); await h.maker(); h.fill('order-1', '10', 'FILLED');
    await reflectedMaker(h);
    h.runtime.ingestPrivateEvent({ channel: channel as 'order', payload: { order_id: 'external', symbol: 'KRAKEN_FUTURE_BTC_USD',
      position_qty: '1', position_side: 'LONG', update_time: String(Date.now()) } });
    expect(h.failAll).toHaveBeenCalledWith('paired_entry_external_responsibility');
    await expect(h.hedge('10')).rejects.toMatchObject({ code: 'margin_available_insufficient' }); expect(h.writes).toHaveLength(1);
  });
  it('cannot keep pool attribution after a private-stream disconnect', async () => {
    const h = await harness(false, '84', '10', true); await h.maker(); h.fill('order-1', '10', 'FILLED');
    await reflectedMaker(h); h.runtime.setPairedPrivateStreamLive(false);
    await expect(h.hedge('10')).rejects.toMatchObject({ code: 'margin_available_insufficient' });
    h.runtime.setPairedPrivateStreamLive(true);
    await expect(h.hedge('10')).rejects.toMatchObject({ code: 'margin_available_insufficient' }); expect(h.writes).toHaveLength(1);
  });
  it('does not mistake old holdings in the same pool for this task\'s newly confirmed fill', async () => {
    const h = await harness(false, '1000', '10', true); h.runtime.invalidatePairedEntries();
    await reflectedMaker(h, '1000');
    h.managed.mockResolvedValue({ positions: [{ symbol: 'KRAKEN_FUTURE_BTC_USD', position_qty: '10', position_side: 'SHORT' }] as ManagedAccountFacts['positions'], openOrders: [] });
    await h.runtime.preparePairedEntry('PAIR-TEST', h.config, 'account');
    await h.maker(); h.fill('order-1', '10', 'FILLED'); await reflectedMaker(h);
    await expect(h.hedge('10')).rejects.toMatchObject({ code: 'margin_available_insufficient' }); expect(h.writes).toHaveLength(1);
  });
  it('keeps the full approved budget after cover and does not subtract the same official amount twice', async () => {
    vi.useFakeTimers(); const h = await harness(false, '84', '10', true); await h.maker(); h.fill('order-1', '10', 'FILLED');
    await vi.advanceTimersByTimeAsync(10); await reflectedMaker(h);
    h.observe({ positions: [{ symbol: h.symbols[0], position_qty: '10', position_side: 'SHORT' }] as ManagedAccountFacts['positions'], openOrders: [] });
    const maker = h.runtime.listOrders()[0]; expect(readEntryBudget(h.db, 'PAIR-TEST')?.legs[0].covered[maker.id]).toBe('10');
    await reflectedMaker(h, '70');
    await expect(h.hedge('10')).rejects.toMatchObject({ code: 'margin_available_insufficient' }); expect(h.writes).toHaveLength(1);
  });
  it('rechecks pool authority after queueing but before the actual order write', async () => {
    const h = await harness(false, '84', '10', true); await h.maker(); h.fill('order-1', '10', 'FILLED'); await reflectedMaker(h);
    h.beforeDispatch(() => { h.runtime.setPairedPrivateStreamLive(false); return undefined; });
    await expect(h.hedge('10')).rejects.toMatchObject({ code: 'margin_available_insufficient' }); expect(h.writes).toHaveLength(1);
  });
  it.each([['0.04', '0.02'], ['0.2', '0.2']])('consumes proven paid fees once while retaining official borrowing IM %s / MM %s', async (im, mm) => {
    const h = await harness(false, '84', '10', true); await h.maker(); h.fill('order-1', '10', 'FILLED');
    recordedFee(h); recordedFee(h); await reflectedFee(h, im, mm);
    expect(h.monitor.snapshot().entryBlocked).toBe(false);
    for (const read of Object.values(h.reads)) read.mockClear(); h.managed.mockClear(); h.valuation.mockClear();
    await h.hedge('5'); await h.hedge('5');
    await expect(h.hedge('1')).rejects.toThrow('paired_entry_quantity_exceeded');
    expect(h.writes).toHaveLength(3); expect(h.failAll).not.toHaveBeenCalled();
    for (const read of Object.values(h.reads)) expect(read).not.toHaveBeenCalled();
    expect(h.managed).not.toHaveBeenCalled(); expect(h.valuation).not.toHaveBeenCalled();
  });
  it.each(['missing-book', 'wrong-pool', 'cash-not-posted', 'conflicting-book'])(
    'does not consume a fee merely because the fill reports it (%s)', async cause => {
      const h = await harness(false, '84', '10', true); await h.maker(); h.fill('order-1', '10', 'FILLED');
      const key = recordedFee(h, '0.2', cause === 'wrong-pool' ? 'DERIBIT' : 'KRAKEN');
      if (cause === 'missing-book') h.db.prepare('DELETE FROM fee_book WHERE account_key=?').run(key);
      if (cause === 'conflicting-book') h.db.prepare('UPDATE fee_book SET conflict=1 WHERE account_key=?').run(key);
      await reflectedFee(h);
      if (cause === 'cash-not-posted') { h.account.assets[1].balance = '0'; await h.monitor.refresh(); }
      await expect(h.hedge('10')).rejects.toThrow('margin_projected_below_warning'); expect(h.writes).toHaveLength(1);
    });
  it('does not turn a normal own-fee asset push into a global recovery or refresh the official sample time', async () => {
    const h = await harness(false, '84', '10', true); await h.maker(); h.fill('order-1', '10', 'FILLED'); recordedFee(h); await reflectedFee(h);
    const before = h.monitor.snapshot().sampledAt;
    h.runtime.ingestPrivateEvent({ channel: 'asset', payload: h.account.assets[1] });
    expect(h.monitor.snapshot().sampledAt).toBe(before); expect(h.failAll).not.toHaveBeenCalled();
    await h.hedge('10'); expect(h.writes).toHaveLength(2);
  });
  it('does not mistake an own position push preceding its fill for an external trade', async () => {
    const h = await harness(false, '10000', '10', true); await h.maker();
    h.runtime.ingestPrivateEvent({ channel: 'position', payload: { symbol: h.symbols[0], position_qty: '10', position_side: 'SHORT', update_time: String(Date.now()) } });
    expect(h.failAll).not.toHaveBeenCalled(); h.fill('order-1', '10', 'FILLED'); await h.hedge('10'); expect(h.writes).toHaveLength(2);
  });
  it('rejects summed pool credits that exceed the official account total', async () => {
    const h = await harness(false, '84', '10', true); await h.maker(); h.fill('order-1', '10', 'FILLED'); await reflectedMaker(h);
    await h.hedge('5'); h.fill('order-2', '5', 'FILLED');
    h.account.assets[2] = asset('DERIBIT', 'USDC', '32', '8'); await h.monitor.refresh();
    await expect(h.hedge('5')).rejects.toThrow('paired_entry_pool_components_inconsistent'); expect(h.writes).toHaveLength(2);
  });
  it('never spends past the pair target across partial hedges and newer official pool totals', async () => {
    const h = await harness(false, '84', '10', true); await h.maker(); h.fill('order-1', '10', 'FILLED'); await reflectedMaker(h);
    await h.hedge('5'); h.fill('order-2', '5', 'FILLED');
    Object.assign(h.account, { initial_margin: '48', maintenance_margin: '12', available_margin: '36', initial_margin_rate: '1.75', maintenance_margin_rate: '7' });
    h.account.assets[2] = asset('DERIBIT', 'USDC', '16', '4'); await h.monitor.refresh();
    await h.hedge('5'); await expect(h.hedge('1')).rejects.toThrow('paired_entry_quantity_exceeded'); expect(h.writes).toHaveLength(3);
  });
  it.each(['position', 'future-order', 'spot-order', 'margin-order'])('revokes retained credit when REST exposes a foreign %s', async kind => {
    vi.useFakeTimers(); const h = await harness(false, '10000', '10', true); await h.maker(); h.fill('order-1', '10', 'FILLED');
    const symbol = kind === 'spot-order' ? 'KRAKEN_SPOT_BTC_USD' : kind === 'margin-order' ? 'KRAKEN_MARGIN_BTC_USD' : 'KRAKEN_FUTURE_BTC_USD';
    const foreign = kind === 'position' ? { positions: [{ symbol, position_qty: '1', position_side: 'LONG' }], openOrders: [] }
      : { positions: [], openOrders: [{ symbol, order_id: 'external', text: 'outside', side: 'BUY', qty: '1', executed_qty: '0' }] };
    h.managed.mockResolvedValue(foreign as unknown as ManagedAccountFacts); await vi.advanceTimersByTimeAsync(4001);
    await h.runtime.preparePairedEntry('PAIR-TEST', h.config, 'account');
    expect(h.failAll).toHaveBeenCalledWith('paired_entry_external_responsibility');
    await reflectedMaker(h); await expect(h.hedge('10')).rejects.toThrow('margin_available_insufficient');
  });
  it('revokes invalid new FX evidence before issuing a renewed preparation certificate', async () => {
    vi.useFakeTimers(); const h = await harness(false, '84', '10', true); await h.maker(); h.fill('order-1', '10', 'FILLED'); await reflectedMaker(h);
    await vi.advanceTimersByTimeAsync(4001); h.valuation.mockResolvedValue({ USDT: '1', USD: '0.8', USDC: '1' });
    await expect(h.runtime.preparePairedEntry('PAIR-TEST', h.config, 'account')).rejects.toThrow('margin_available_insufficient');
    await expect(h.hedge('10')).rejects.toThrow('margin_available_insufficient'); expect(h.writes).toHaveLength(1);
  });
  it('a released task cannot leave a stale pool guard on later legitimate activity', async () => {
    const h = await harness(false, '10000', '10', true);
    h.db.prepare("UPDATE paired_entry_reservations SET payload_json=json_set(payload_json,'$.released',json('true')) WHERE strategy_id='PAIR-TEST'").run();
    h.runtime.ingestPrivateEvent({ channel: 'position', payload: { symbol: 'KRAKEN_FUTURE_BTC_USD', position_qty: '1', position_side: 'LONG' } });
    expect(h.failAll).not.toHaveBeenCalled();
  });
  it.each([['0', 'NEW', '33.2', '0'], ['5', 'PARTIALLY_FILLED', '32.9', '4.3'], ['10', 'FILLED', '33.2', '0']])(
    'recognizes accepted order IM without treating %s filled as more executed quantity', async (filled, state, im, mm) => {
      const h = await harness(false, '84', '10', true); await h.maker(); h.fill('order-1', filled, state);
      Object.assign(h.account, { initial_margin: im, maintenance_margin: mm, available_margin: new Decimal(84).minus(im).toString(),
        initial_margin_rate: new Decimal(84).div(im).toString(), maintenance_margin_rate: new Decimal(mm).isZero() ? '0' : new Decimal(84).div(mm).toString() });
      h.account.assets[1] = asset('KRAKEN', 'USD', im, mm); await h.monitor.refresh();
      if (filled === '0') await expect(h.hedge('1')).rejects.toThrow('paired_entry_unconfirmed_hedge');
      else { await h.hedge(filled); await expect(h.hedge('1')).rejects.toThrow(/paired_entry_(unconfirmed_hedge|quantity_exceeded)/); }
      expect(h.writes).toHaveLength(filled === '0' ? 1 : 2);
    });
  it('does not reuse a cancelled unfilled quote\'s still-reported freeze for a replacement', async () => {
    const h = await harness(false, '84', '10', true); await h.maker(); h.fill('order-1', '0', 'CANCELLED');
    Object.assign(h.account, { initial_margin: '33.2', available_margin: '50.8', initial_margin_rate: new Decimal(84).div('33.2').toString() });
    h.account.assets[1] = asset('KRAKEN', 'USD', '33.2'); await h.monitor.refresh();
    await expect(h.maker()).rejects.toThrow('margin_available_insufficient'); expect(h.writes).toHaveLength(1);
  });
  it('a failed candidate cannot restore old pool authority after a later candidate has registered', async () => {
    const h = await harness(false, '10000', '10', true);
    h.symbols.push('KRAKEN_FUTURE_BTC_USD', 'DERIBIT_FUTURE_BTC_USDC', 'KRAKEN_FUTURE_ETH_USD', 'DERIBIT_FUTURE_ETH_USDC');
    await h.runtime.preparePairedEntry('PAIR-B', { ...h.config, asset: 'BTC' }, 'account');
    await h.runtime.preparePairedEntry('PAIR-C', { ...h.config, asset: 'ETH' }, 'account');
    h.runtime.abortPairedPreparation('PAIR-B');
    h.runtime.ingestPrivateEvent({ channel: 'position', payload: { symbol: 'KRAKEN_FUTURE_ETH_USD', position_qty: '1', position_side: 'LONG' } });
    expect(h.failAll).not.toHaveBeenCalled(); expect(readEntryBudget(h.db, 'PAIR-C')).not.toBeNull();
  });
  it('a successful ordinary reservation also invalidates earlier candidate rollback authority', async () => {
    const h = await harness(false, '10000', '10', true);
    h.symbols.push('KRAKEN_FUTURE_BTC_USD', 'DERIBIT_FUTURE_BTC_USDC', 'KRAKEN_FUTURE_ETH_USD');
    await h.runtime.preparePairedEntry('PAIR-B', { ...h.config, asset: 'BTC' }, 'account');
    await h.runtime.createOrder({ symbol: 'KRAKEN_FUTURE_ETH_USD', side: 'BUY', type: 'LIMIT', timeInForce: 'GTC', quantity: '1', price: '80' });
    h.runtime.abortPairedPreparation('PAIR-B');
    h.runtime.ingestPrivateEvent({ channel: 'order', payload: { order_id: 'order-1', symbol: 'KRAKEN_FUTURE_ETH_USD', state: 'NEW',
      executed_qty: '0', update_time: String(Date.now()) } });
    expect(h.failAll).not.toHaveBeenCalled(); expect(h.writes).toHaveLength(1);
  });
  it('does not persist an orphan commitment when contract preparation outlives its deadline', async () => {
    vi.useFakeTimers(); const h = await harness();
    h.reads.positions.mockImplementationOnce(async () => {
      vi.setSystemTime(Date.now() + 10001); await h.monitor.refresh(); return [];
    });
    await expect(h.runtime.preparePairedEntry('ORPHAN', h.config, 'account')).rejects.toMatchObject({ code: 'paired_entry_preparation_unavailable' });
    expect(readEntryBudget(h.db, 'ORPHAN')).toBeNull();
  });
  it('cleans a provisional approval on activation failure without deleting a real task budget', async () => {
    const h = await harness(); await h.runtime.preparePairedEntry('ORPHAN', h.config, 'account');
    expect(readEntryBudget(h.db, 'ORPHAN')).not.toBeNull(); h.runtime.abortPairedPreparation('ORPHAN');
    expect(readEntryBudget(h.db, 'ORPHAN')).toBeNull(); h.runtime.abortPairedPreparation('PAIR-TEST');
    expect(readEntryBudget(h.db, 'PAIR-TEST')).not.toBeNull();
  });
  it('uses a trade arriving before the order update without adding the two evidence streams twice', async () => {
    const h = await harness(); await h.maker();
    const event = { channel: 'usertrades' as const, payload: { transaction_id: 'trade-1', order_id: 'order-1',
      symbol: h.symbols[0], exchange_type: 'KRAKEN', side: 'SELL', qty: '5', price: '80', fee: '0', create_time: String(Date.now()) } };
    h.runtime.ingestPrivateEvent(event); h.runtime.ingestPrivateEvent(event);
    expect(h.runtime.listOrders()[0].executedQuantity).toBe('5'); await h.hedge(); h.fill('order-1', '5');
    await expect(h.hedge()).rejects.toMatchObject({ code: 'paired_entry_unconfirmed_hedge' }); expect(h.writes).toHaveLength(2);
  });
  it('does not re-charge a whole approved target when the first fill reaches the official account before positions', async () => {
    const h = await harness(); await h.maker(); h.fill('order-1', '5');
    Object.assign(h.account, { margin_balance: '180', initial_margin: '32', maintenance_margin: '8', available_margin: '148',
      initial_margin_rate: '5.625', maintenance_margin_rate: '22.5' });
    await h.monitor.refresh(); await h.hedge(); expect(h.writes).toHaveLength(2);
  });
  it('counts another in-flight hedge when two approved tasks share a newer depleted account snapshot', async () => {
    const h = await harness(); const second = CreateStrategyInputSchema.parse({ ...h.config, asset: 'BTC' });
    const symbols = ['KRAKEN_FUTURE_BTC_USD', 'DERIBIT_FUTURE_BTC_USDC']; h.symbols.push(...symbols);
    const now = new Date().toISOString();
    h.db.prepare(`INSERT INTO execution_strategies(id,kind,environment,status,config_json,credential_profile_id,created_at,updated_at)
      VALUES('PAIR-TWO','position','live','RUNNING',?,'account',?,?)`).run(JSON.stringify(second), now, now);
    h.db.prepare('INSERT INTO managed_positions VALUES(?,?,?,?)').run('PAIR-TWO', 'account', JSON.stringify({ ...initialManagedState(),
      phase: 'OPENING', verified: true, groupId: 'PAIR-TWO', adoptedLeft: '0', adoptedRight: '0' }), now);
    for (const symbol of symbols) h.db.prepare('INSERT INTO managed_position_claims VALUES(?,?,?)').run(symbol, 'account', 'PAIR-TWO');
    await h.runtime.preparePairedEntry('PAIR-TWO', second, 'account'); await h.maker();
    await h.runtime.createOrder({ symbol: symbols[0], side: 'SELL', type: 'LIMIT', timeInForce: 'POC', quantity: '10', price: '80' },
      { strategyId: 'PAIR-TWO', strategyLeg: 'left' });
    h.fill('order-1', '5'); h.fill('order-2', '5');
    Object.assign(h.account, { margin_balance: '100', available_margin: '100' }); await h.monitor.refresh();
    await h.hedge();
    await expect(h.runtime.createOrder({ symbol: symbols[1], side: 'BUY', type: 'MARKET', quantity: '5', timeInForce: 'IOC' },
      { strategyId: 'PAIR-TWO', strategyLeg: 'right' })).rejects.toThrow('margin_available_insufficient');
    expect(h.writes).toHaveLength(3);
  });
  it('releases only verified stopped responsibility and never lets a finished budget block later price changes', async () => {
    vi.useFakeTimers(); const h = await harness(); await h.maker(); h.fill('order-1', '5'); await h.hedge();
    h.fill('order-1', '5', 'CANCELLED'); h.fill('order-2', '5', 'FILLED');
    h.db.prepare("UPDATE execution_strategies SET status='STOPPED' WHERE id='PAIR-TEST'").run();
    expect(() => h.runtime.assertPairedCapitalMutation()).toThrow('paired_entry_funds_committed');
    await vi.advanceTimersByTimeAsync(10);
    Object.assign(h.account, { update_time: String(Date.now()), initial_margin: '32', maintenance_margin: '8',
      initial_margin_rate: '312.5', maintenance_margin_rate: '1250', available_margin: '9968' });
    await h.monitor.refresh();
    h.observe({ openOrders: [], positions: h.symbols.map((symbol, i) => ({ symbol, position_side: i === 0 ? 'SHORT' : 'LONG',
      position_qty: '5' })) as ManagedAccountFacts['positions'] });
    expect(readEntryBudget(h.db, 'PAIR-TEST')?.released).toBe(true);
    h.price('200'); expect(() => h.runtime.assertPairedCapitalMutation()).not.toThrow();
  });
  it('sends the exact confirmed hedge without any account, leverage, mode or catalog HTTP', async () => {
    const h = await harness(); await h.maker(); h.fill('order-1', '5');
    for (const read of Object.values(h.reads)) read.mockClear();
    await h.hedge(); expect(h.writes).toHaveLength(2);
    for (const read of Object.values(h.reads)) expect(read).not.toHaveBeenCalled();
    await expect(h.hedge()).rejects.toMatchObject({ code: 'paired_entry_unconfirmed_hedge' });
    expect(h.writes).toHaveLength(2);
  });
  it('retains sufficient existing padding but refuses growth beyond the approved task budget', async () => {
    const h = await harness(); await h.maker(); h.fill('order-1', '5'); h.price('84');
    await h.hedge('2'); h.price('100');
    await expect(h.hedge('3')).rejects.toMatchObject({ code: 'paired_entry_budget_exceeded' });
    expect(h.writes).toHaveLength(2); expect(readEntryBudget(h.db, 'PAIR-TEST')).not.toBeNull();
  });
  it('retains a lost submit as occupied instead of submitting the hedge twice', async () => {
    const h = await harness(); await h.maker(); h.fill('order-1', '5'); h.failWrite();
    await expect(h.hedge()).rejects.toThrow('synthetic response lost');
    expect(h.runtime.listOrders().filter(o => o.state === 'PENDING_SUBMIT')).toHaveLength(1);
    await expect(h.hedge()).rejects.toMatchObject({ code: 'paired_entry_unconfirmed_hedge' });
    expect(h.writes).toHaveLength(2);
  });
  it('refuses stale official evidence and does not refresh it synchronously on a hedge', async () => {
    vi.useFakeTimers();
    const h = await harness(); await h.maker(); h.fill('order-1', '5');
    for (const read of Object.values(h.reads)) read.mockClear();
    await vi.advanceTimersByTimeAsync(6000);
    await expect(h.hedge()).rejects.toMatchObject({ code: 'paired_entry_preparation_unavailable' });
    expect(h.writes).toHaveLength(1); for (const read of Object.values(h.reads)) expect(read).not.toHaveBeenCalled();
  });
  it('honors official available margin even when the other official ratios remain healthy', async () => {
    const h = await harness(); await h.maker(); h.fill('order-1', '5');
    h.account.available_margin = '0'; await h.monitor.refresh();
    await expect(h.hedge()).rejects.toMatchObject({ code: 'margin_available_insufficient' }); expect(h.writes).toHaveLength(1);
  });
  it.each(['{}', '{"released":false}', '{"released":1}', 'invalid-json'])(
    'does not treat unknown monitor identity or malformed responsibility as released (%s)', async payload => {
    const h = await harness(); const snapshot = h.monitor.snapshot();
    h.db.prepare('UPDATE paired_entry_reservations SET payload_json=?').run(payload);
    vi.spyOn(h.monitor, 'snapshot').mockReturnValue({ ...snapshot, accountId: null, fresh: false });
    expect(() => h.runtime.assertPairedCapitalMutation()).toThrow('paired_entry_account_unavailable');
  });
  it('uses each isolated leg account for coverage rather than the unrelated display unit', async () => {
    vi.useFakeTimers(); const h = await harness(true); await h.maker(); h.fill('order-1', '5');
    const maker = h.runtime.listOrders()[0]; await vi.advanceTimersByTimeAsync(10);
    h.units.BINANCE = { initial_margin: '100', maintenance_margin: '10', initial_margin_rate: '100', maintenance_margin_rate: '1000', update_time: String(Date.now()) };
    h.units.KRAKEN = { update_time: '0' }; await h.monitor.refresh();
    expect(h.monitor.snapshot().metrics?.exchangeType).toBe('BINANCE');
    const facts: ManagedAccountFacts = { positions: [{ symbol: h.symbols[0], position_side: 'SHORT', position_qty: '5' }] as ManagedAccountFacts['positions'],
      openOrders: [{ order_id: maker.remoteOrderId, text: maker.clientOrderId, symbol: maker.symbol, side: maker.side,
        qty: maker.quantity, executed_qty: maker.executedQuantity, state: maker.state }] as ManagedAccountFacts['openOrders'] };
    h.observe(facts); expect(readEntryBudget(h.db, 'PAIR-TEST')?.legs[0].covered).toEqual({});
    h.units.KRAKEN = { initial_margin: '32', maintenance_margin: '4', initial_margin_rate: '312.5', maintenance_margin_rate: '2500',
      available_margin: '9968', update_time: String(Date.now()) };
    await h.monitor.refresh(); h.observe(facts);
    expect(readEntryBudget(h.db, 'PAIR-TEST')?.legs[0].covered[maker.id]).toBe('10');
  });
  it('preserves the budget while invalidating executable preparation on restart or account change', async () => {
    const h = await harness(); await h.maker(); h.fill('order-1', '5'); h.runtime.invalidatePairedEntries();
    await expect(h.hedge()).rejects.toMatchObject({ code: 'paired_entry_preparation_unavailable' });
    expect(readEntryBudget(h.db, 'PAIR-TEST')?.legs[0].target).toBe('20'); expect(h.writes).toHaveLength(1);
  });
});
