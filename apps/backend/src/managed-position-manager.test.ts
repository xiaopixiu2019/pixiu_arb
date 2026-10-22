import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { openDatabase } from './database.js';
import { MemoryCredentialVault, DEFAULT_CREDENTIAL_PROFILE } from './credential-vault.js';
import { TradingSession } from './trading-session.js';
import { CreateStrategyInputSchema, TradingRuntime, isTerminalOrderState } from './trading-runtime.js';
import { ManagedPositionManager, managedLegs, type ManagedAccountFacts } from './managed-position-manager.js';
import { readManagedState, managedRiskReason, hasManagedClaims } from './managed-position-store.js';
import type { CrossExOrderRequest, GateCrossExOrder, GateCrossExPosition, TradingCrossExGateway } from './crossex-client.js';
import { GateApiError, GateCrossExClient } from './crossex-client.js';
import { RequestNotDispatchedError } from './authenticated-scheduler.js';
import type { LiveMarket } from './market-hub.js';
import { MarginRiskMonitor } from './margin-risk-monitor.js';
import { MarginRiskStore } from './margin-risk-store.js';
import { ownedQuoteSymbols } from './owned-market-demand.js';

const directories: string[] = [];
const managers: ManagedPositionManager[] = [];
const databases: ReturnType<typeof openDatabase>[] = [];
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-24T00:00:00Z')); });
afterEach(async () => {
  for (const manager of managers.splice(0)) await manager.stop();
  for (const db of databases.splice(0)) db.close();
  vi.useRealTimers();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

async function harness(asset = 'BTC', leftVenue = 'BINANCE', book?: { bid: string; ask: string }) {
  const dir = mkdtempSync(join(tmpdir(), 'managed-position-test-')); directories.push(dir);
  const db = openDatabase(join(dir, 'test.sqlite'), resolve('../../migrations')); databases.push(db);
  const session = new TradingSession(); session.set('live');
  const vault = new MemoryCredentialVault(); await vault.set(DEFAULT_CREDENTIAL_PROFILE, { apiKey: 'fake', apiSecret: 'fake' });
  const created: CrossExOrderRequest[] = [];
  const cancelled: string[] = [];
  const remote = new Map<string, GateCrossExOrder>();
  let cancelHeld = false, failSubmit = false;
  let submitWait: (() => Promise<void>) | null = null;
  const gateway = {
    async createOrder(_credentials: unknown, input: CrossExOrderRequest, beforeDispatch?: () => void) {
      await submitWait?.();
      try { beforeDispatch?.(); } catch (error) { throw new RequestNotDispatchedError(error instanceof Error ? error.message : 'guard_changed'); }
      created.push(input);
      if (failSubmit) throw new Error('synthetic network timeout');
      const id = `remote-${created.length}`;
      remote.set(id, { ...input, order_id: id, state: 'OPEN', executed_qty: '0', executed_avg_price: '100', reason: '', update_time: String(Date.now()) } as GateCrossExOrder);
      return { order_id: id };
    },
    async cancelOrder(_credentials: unknown, id: string) {
      cancelled.push(id);
      if (!cancelHeld) remote.set(id, { ...remote.get(id)!, state: 'CANCELLED', update_time: String(Date.now()) });
      return { order_id: id };
    },
    async queryOrder(_credentials: unknown, id: string) { return remote.get(id)!; },
  } as unknown as TradingCrossExGateway;
  const runtime = new TradingRuntime(db, session, vault, gateway);
  const config = CreateStrategyInputSchema.parse({ kind: 'position', asset, leftVenue, rightVenue: 'OKX',
    leftSide: 'BUY', rightSide: 'SELL', entryBps: '0', totalAmount: '100', perOrderQuantity: '10', executionMethod: 'TAKER_TAKER',
    management: { perOrderQuantity: '10', durationSeconds: 2, intervalSeconds: 0, makerWaitSeconds: 5 } });
  const legs = managedLegs(config);
  for (const leg of legs) db.prepare(`INSERT INTO crossex_instruments
    (symbol, exchange_type, business_type, state, min_size, lot_size, tick_size, max_num_orders, default_leverage, delist_time, fetched_at)
    VALUES (?, ?, 'FUTURE', 'live', '1', '1', '0.01', '100', '1', '0', ?)`).run(leg.symbol, leg.symbol.split('_')[0], new Date().toISOString());
  let quantities = ['0', '0'], unavailable = false, missingFunding = false, account = 'account-1';
  let read: (() => Promise<ManagedAccountFacts>) | null = null;
  const missingQuotes = new Set<string>();
  const facts = (): ManagedAccountFacts => ({ positions: legs.flatMap((leg, i) => quantities[i] === '0' ? [] : [{ symbol: leg.symbol,
    position_side: leg.side === 'BUY' ? 'LONG' : 'SHORT', position_qty: quantities[i] } as GateCrossExPosition]),
    openOrders: [...remote.values()].filter((o) => !isTerminalOrderState(o.state)) });
  const sources = { activeAccount: () => account,
    account: async () => { if (unavailable) throw new Error('synthetic account read failed'); return read ? read() : facts(); },
    funding: (symbol: string) => missingFunding ? null : ({ rate8h: symbol === legs[0].symbol ? '0.002' : '0', fetchedAt: Date.now() }),
    refreshFunding: async () => undefined, riskPause: vi.fn() };
  const manager = new ManagedPositionManager(db, session, runtime, { market: (symbol) => missingQuotes.has(symbol) ? null : ({
    symbol, source: 'gate_crossex_websocket', bidPrice: book?.bid ?? (symbol === legs[0].symbol ? '100' : '99'), askPrice: book?.ask ?? (symbol === legs[0].symbol ? '101' : '100'),
    updatedAt: new Date().toISOString(), receivedAt: new Date().toISOString() } as LiveMarket) }, sources);
  managers.push(manager);
  async function task(id = 'PAIR-TEST', full = true, executionMethod = config.executionMethod) {
    const taskConfig = CreateStrategyInputSchema.parse({ ...config, executionMethod,
      ...(executionMethod === 'MAKER_TAKER' ? { makerLeg: 'left' } : {}) });
    await manager.reserve(id, taskConfig, account);
    db.prepare(`INSERT INTO execution_strategies (id, kind, environment, status, config_json, progress,
      filled_quantity, filled_left, filled_right, open_position, credential_profile_id, created_at, updated_at)
      VALUES (?, 'position', 'live', 'RUNNING', ?, 100, '100', '100', '100', '0', ?, ?, ?)`)
      .run(id, JSON.stringify(taskConfig), account, new Date().toISOString(), new Date().toISOString());
    manager.initialize(id, account);
    if (full) { quantities = ['100', '100']; manager.handoff(id, '100'); }
    return id;
  }
  function ack(index: number, state: string, filled: string) {
    const id = `remote-${index}`;
    remote.set(id, { ...remote.get(id)!, state, executed_qty: filled, update_time: String(Date.now()) });
    runtime.ingestPrivateEvent({ channel: 'order', payload: { order_id: id, state, executed_qty: filled, executed_avg_price: '100', update_time: String(Date.now()) } });
  }
  return { db, session, vault, gateway, runtime, manager, sources, config, legs, created, cancelled, remote, task, ack, facts,
    quantities: (a: string, b: string) => { quantities = [a, b]; },
    unavailable: (value = true) => { unavailable = value; }, missingFunding: (value: boolean) => { missingFunding = value; },
    setRead: (value: typeof read) => { read = value; }, changeAccount: () => { account = 'account-2'; },
    missingQuote: (symbol: string, missing = true) => { if (missing) missingQuotes.add(symbol); else missingQuotes.delete(symbol); },
    holdCancel: () => { cancelHeld = true; }, failSubmit: () => { failSubmit = true; },
    setSubmitWait: (wait: (() => Promise<void>) | null) => { submitWait = wait; } };
}

describe('generic adopted position groups and explicit stop intent', () => {
  it('keeps public data demand during a hard risk pause but withdraws it for explicit KEEP', async () => {
    const h = await harness(), id = await h.task();
    h.manager.failAll('managed_order_unresolved');
    expect(ownedQuoteSymbols(h.db)).toEqual(h.legs.map(leg => leg.symbol).sort());
    h.manager.beginStop(id, false); expect(ownedQuoteSymbols(h.db)).toEqual([]);
  });
  it('records recovery only when both quotes and funding return, retaining the original failure window', async () => {
    const h = await harness(), id = await h.task(); h.missingQuote(h.legs[0].symbol);
    await h.manager.tick(); const since = readManagedState(h.db, id)?.signalMissingSince;
    h.missingQuote(h.legs[0].symbol, false); h.missingFunding(true); await h.manager.tick();
    expect(readManagedState(h.db, id)?.signalMissingSince).toBe(since);
    expect(h.db.prepare("SELECT count(*) n FROM audit_events WHERE type='managed_signal_recovered'").get()).toEqual({ n: 0 });
    h.missingFunding(false); await h.manager.tick(); await h.manager.tick();
    const event = h.db.prepare("SELECT payload_json FROM audit_events WHERE type='managed_signal_recovered'").all() as Array<{ payload_json: string }>;
    expect(event).toHaveLength(1); expect(JSON.parse(event[0].payload_json).startedAt).toBe(since);
    expect(readManagedState(h.db, id)?.conditionSince).toBe(Date.now());
  });
  it('preserves an unfilled entry and its claims during a transient margin read hold', async () => {
    const h = await harness(); const id = await h.task('PAIR-MARGIN-READ', false);
    h.db.prepare("UPDATE execution_strategies SET filled_quantity='0',filled_left='0',filled_right='0',progress=0 WHERE id=?").run(id);
    h.manager.holdForMarginRead();
    expect(readManagedState(h.db, id)?.phase).toBe('OPENING');
    expect(managedRiskReason(h.db)).toBe('managed_account_rechecking');
    await h.manager.tick();
    expect(h.runtime.getStrategy(id).status).toBe('RUNNING');
    expect(h.db.prepare('SELECT count(*) n FROM managed_position_claims WHERE strategy_id=?').get(id)).toEqual({ n: 2 });
    expect(h.created).toHaveLength(0);
  });
  it('uses the same Hyperliquid rules for a reduce-only maker exit without expanding quantity', async () => {
    const h = await harness('XMR', 'HYPERLIQUID', { bid: '538.838', ask: '538.839' });
    h.db.prepare("UPDATE crossex_instruments SET tick_size='0.001' WHERE symbol=?").run(h.legs[0].symbol);
    const id = await h.task(); await h.manager.tick(); h.manager.requestExit(id); await h.manager.tick();
    expect(h.created).toHaveLength(1);
    expect(h.created[0]).toMatchObject({ symbol: h.legs[0].symbol, side: 'SELL', type: 'LIMIT',
      time_in_force: 'POC', reduce_only: 'true', qty: '10', price: '538.84' });
    expect(readManagedState(h.db, id)?.exitRequested).toBe(true);
  });
  it('rechecks minimum notional at the adjusted Hyperliquid exit price without increasing size', async () => {
    const h = await harness('XMR', 'HYPERLIQUID', { bid: '27.0271', ask: '27.0272' });
    h.config.leftSide = 'SELL'; h.config.rightSide = 'BUY';
    h.legs[0].side = 'SELL'; h.legs[1].side = 'BUY';
    h.config.management!.perOrderQuantity = '0.37';
    h.db.prepare("UPDATE crossex_instruments SET tick_size='0.0001',lot_size='0.001',min_size='0.001',min_notional='10' WHERE symbol=?").run(h.legs[0].symbol);
    h.db.prepare("UPDATE crossex_instruments SET lot_size='0.001',min_size='0.001' WHERE symbol=?").run(h.legs[1].symbol);
    const id = await h.task(); await h.manager.tick(); h.manager.requestExit(id); await h.manager.tick();
    expect(h.created).toEqual([]);
    expect(h.runtime.getStrategy(id)).toMatchObject({ status: 'PAUSED', management: { phase: 'RISK_PAUSED' } });
    expect(managedRiskReason(h.db)).toContain('managed_order_below_minimum_notional');
    expect(readManagedState(h.db, id)).toMatchObject({ leftQuantity: '100', rightQuantity: '100' });
  });
  async function partialEntry() {
    const h = await harness(); const id = await h.task('PAIR-PARTIAL', false, 'MAKER_TAKER');
    h.db.prepare("UPDATE execution_strategies SET filled_quantity='50',filled_left='50',filled_right='50',progress=50 WHERE id=?").run(id);
    for (const [i, leg] of h.legs.entries()) {
      await h.runtime.createOrder({ symbol: leg.symbol, side: leg.side, type: 'LIMIT', timeInForce: 'POC', quantity: '50', price: '100' },
        { strategyId: id, strategyLeg: i ? 'right' : 'left', feePhase: 'entry' });
      h.ack(i + 1, 'FILLED', '50');
    }
    h.quantities('50', '50'); h.manager.failAll('Maker cancellation confirmation expired'); h.session.set('live');
    return { h, id };
  }
  it('resumes balanced partial entry without creating an exit intent or resetting progress', async () => {
    const { h, id } = await partialEntry(); const resumed = await h.manager.resume(id, 'account-1');
    expect(resumed).toMatchObject({ status: 'RUNNING', filledLeft: '50', filledRight: '50', progress: 50,
      management: { phase: 'OPENING', exitRequested: false, verified: false } });
    expect(h.created).toHaveLength(2); expect(managedRiskReason(h.db)).toBeNull();
  });
  it.each(['unexplained reduction', 'unequal', 'unknown history', 'reduction history', 'ledger mismatch'])('keeps partial entry locked on %s', async scenario => {
    const { h, id } = await partialEntry();
    if (scenario === 'unexplained reduction') h.quantities('40', '40');
    if (scenario === 'unequal') h.quantities('50', '40');
    if (scenario === 'unknown history') h.db.prepare("UPDATE execution_orders SET failure_reason='REMOTE_ORDER_NOT_FOUND' WHERE strategy_id=?").run(id);
    if (scenario === 'reduction history') h.db.prepare('UPDATE execution_orders SET reduce_only=1 WHERE strategy_id=?').run(id);
    if (scenario === 'ledger mismatch') h.db.prepare("UPDATE execution_strategies SET filled_left='40' WHERE id=?").run(id);
    await expect(h.manager.resume(id, 'account-1')).rejects.toBeInstanceOf(Error);
    expect(h.runtime.getStrategy(id)).toMatchObject({ status: 'PAUSED', management: { exitRequested: false } });
    expect(managedRiskReason(h.db)).not.toBeNull(); expect(h.created).toHaveLength(2);
  });
  it('rejects a changed exit intent during partial entry review', async () => {
    const { h, id } = await partialEntry(); let finish!: (facts: ManagedAccountFacts) => void;
    h.setRead(() => new Promise(resolve => { finish = resolve; }));
    const pending = h.manager.resume(id, 'account-1');
    h.db.prepare("UPDATE managed_positions SET state_json=json_set(state_json,'$.exitRequested',1) WHERE strategy_id=?").run(id);
    finish(h.facts()); await expect(pending).rejects.toMatchObject({ code: 'managed_review_changed' });
    expect(managedRiskReason(h.db)).not.toBeNull();
  });
  it('keeps adopted holdings separate from the remaining entry target', async () => {
    const { h, id } = await partialEntry();
    h.db.prepare("UPDATE managed_positions SET state_json=json_set(state_json,'$.adoptedLeft','200','$.adoptedRight','200') WHERE strategy_id=?").run(id);
    h.quantities('250', '250');
    expect((await h.manager.resume(id, 'account-1')).management).toMatchObject({ phase: 'OPENING', leftQuantity: '250', rightQuantity: '250' });
    expect(h.runtime.getStrategy(id).filledQuantity).toBe('50');
  });
  it('monitors a fully filled entry without adding or exiting', async () => {
    const { h, id } = await partialEntry();
    const record = h.runtime.getStrategy(id);
    h.db.prepare('UPDATE execution_strategies SET config_json=? WHERE id=?').run(JSON.stringify({ ...record.config, totalAmount: '50' }), id);
    expect((await h.manager.resume(id, 'account-1')).management).toMatchObject({ phase: 'MONITORING', exitRequested: false, verified: true });
    expect(h.created).toHaveLength(2);
  });
  it('rejects a stale displayed action before clearing the risk lock', async () => {
    const { h, id } = await partialEntry();
    await expect(h.manager.resume(id, 'account-1', 'MONITORING')).rejects.toMatchObject({ code: 'managed_resume_action_changed' });
    expect(managedRiskReason(h.db)).not.toBeNull(); expect(h.runtime.getStrategy(id).status).toBe('PAUSED');
  });
  it('preserves an explicit exit on a partially filled entry', async () => {
    const { h, id } = await partialEntry();
    h.db.prepare("UPDATE managed_positions SET state_json=json_set(state_json,'$.exitRequested',json('true')) WHERE strategy_id=?").run(id);
    expect((await h.manager.resume(id, 'account-1', 'EXITING')).management).toMatchObject({ phase: 'EXITING', exitRequested: true });
  });
  it('rejects account facts invalidated by a position push during resume', async () => {
    const { h, id } = await partialEntry(); const stale = h.facts(); let finish!: (facts: ManagedAccountFacts) => void;
    h.setRead(() => new Promise(resolve => { finish = resolve; })); const pending = h.manager.resume(id, 'account-1');
    h.manager.notifyPosition({ symbol: h.legs[0].symbol, position_qty: '40', update_time: String(Date.now()) });
    finish(stale); await expect(pending).rejects.toMatchObject({ code: 'managed_review_changed' });
    expect(managedRiskReason(h.db)).not.toBeNull(); expect(h.runtime.getStrategy(id).status).toBe('PAUSED');
    expect(h.created).toHaveLength(2);
  });
  it('explicitly resumes a verified never-filled cancelled entry into its original opening intent', async () => {
    const h = await harness(); const id = await h.task('PAIR-ENTRY', false, 'MAKER_TAKER');
    h.db.prepare("UPDATE execution_strategies SET filled_quantity='0',filled_left='0',filled_right='0',progress=0 WHERE id=?").run(id);
    await h.runtime.createOrder({ symbol: h.legs[0].symbol, side: 'BUY', type: 'LIMIT', timeInForce: 'POC', quantity: '10', price: '100' },
      { strategyId: id, strategyLeg: 'left', feePhase: 'entry' }); h.ack(1, 'CANCELLED', '0');
    h.manager.failAll('managed_recovery_unresolved_orders'); h.session.set('live');
    const resumed = await h.manager.resume(id, 'account-1');
    expect(resumed).toMatchObject({ id, status: 'RUNNING', management: { phase: 'OPENING', exitRequested: false, verified: false } });
    expect(hasManagedClaims(h.db)).toBe(true); expect(h.created).toHaveLength(1); expect(managedRiskReason(h.db)).toBeNull();
  });

  it('refuses a manual resume if a different risk is raised while fresh facts are awaited', async () => {
    const h = await harness(); const id = await h.task(); h.manager.failAll('managed_recovery_unresolved_orders'); h.session.set('live');
    let complete!: (facts: ManagedAccountFacts) => void;
    h.setRead(() => new Promise(resolve => { complete = resolve; })); const pending = h.manager.resume(id, 'account-1');
    h.manager.failAll('new_verified_risk');
    h.db.prepare("UPDATE managed_risk_lock SET reason='new_verified_risk'").run();
    complete(h.facts()); await expect(pending).rejects.toMatchObject({ code: 'managed_review_changed' });
    expect(managedRiskReason(h.db)).toBe('new_verified_risk'); expect(h.runtime.getStrategy(id).status).toBe('PAUSED');
  });

  it.each(['keep', 'executed', 'unconfirmed_history'])('never reopens an entry with %s responsibility', async scenario => {
    const h = await harness(); const id = await h.task('PAIR-ENTRY', false, 'MAKER_TAKER');
    h.db.prepare("UPDATE execution_strategies SET filled_quantity='0',filled_left='0',filled_right='0',progress=0 WHERE id=?").run(id);
    await h.runtime.createOrder({ symbol: h.legs[0].symbol, side: 'BUY', type: 'LIMIT', timeInForce: 'POC', quantity: '10', price: '100' },
      { strategyId: id, strategyLeg: 'left', feePhase: 'entry' }); h.ack(1, 'CANCELLED', '0');
    h.manager.failAll('managed_recovery_unresolved_orders');
    if (scenario === 'keep') h.db.prepare("UPDATE managed_positions SET state_json=json_set(state_json,'$.stopIntent','KEEP') WHERE strategy_id=?").run(id);
    if (scenario === 'executed') {
      h.db.prepare("UPDATE execution_orders SET executed_quantity='1' WHERE strategy_id=?").run(id); h.quantities('1', '0');
    }
    if (scenario === 'unconfirmed_history') h.db.prepare("UPDATE execution_orders SET failure_reason='REMOTE_ORDER_NOT_FOUND' WHERE strategy_id=?").run(id);
    h.session.set('live');
    if (scenario === 'keep') expect((await h.manager.resume(id, 'account-1')).management?.phase).toBe('MONITORING');
    else {
      await expect(h.manager.resume(id, 'account-1')).rejects.toMatchObject({ code: 'managed_entry_resume_unverified' });
      expect(managedRiskReason(h.db)).not.toBeNull();
      expect(readManagedState(h.db, id)?.exitRequested).toBe(false);
    }
    expect(h.created).toHaveLength(1);
  });

  it.each(['OPEN', 'CANCELLED'])('background refreshes an owned zero-fill entry quote (%s) without a global recheck', async state => {
    const h = await harness(); const id = await h.task('PAIR-ENTRY', false, 'MAKER_TAKER'); await h.manager.tick();
    const original = h.facts(); let complete!: (facts: ManagedAccountFacts) => void;
    const marginFacts = vi.fn(); h.manager.setMarginFacts(marginFacts);
    h.setRead(() => new Promise(resolve => { complete = resolve; })); const pending = h.manager.tick();
    await h.runtime.createOrder({ symbol: h.legs[0].symbol, side: 'BUY', type: 'LIMIT', timeInForce: 'POC', quantity: '10', price: '100' },
      { strategyId: id, strategyLeg: 'left', feePhase: 'entry' });
    h.ack(1, state, '0');
    try { expect(managedRiskReason(h.db)).toBeNull(); expect(readManagedState(h.db, id)?.reason).toBeNull(); }
    finally { complete(original); await pending; }
    expect(marginFacts).not.toHaveBeenCalled();
    h.setRead(null); await h.manager.tick();
    expect(managedRiskReason(h.db)).toBeNull(); expect(h.runtime.getStrategy(id).status).toBe('RUNNING');
    expect(h.created).toHaveLength(1); expect(marginFacts).toHaveBeenCalledTimes(1);
    vi.setSystemTime(Date.now() + 26_000); await h.manager.tick(); expect(managedRiskReason(h.db)).toBeNull();
  });

  it('retains the fixed 25-second deadline if normal entry updates prevent every fresh account read', async () => {
    const h = await harness(); const id = await h.task('PAIR-ENTRY', false, 'MAKER_TAKER'); await h.manager.tick();
    const initial = Date.now(); const marginFacts = vi.fn(); h.manager.setMarginFacts(marginFacts);
    for (let attempt = 0; attempt < 4; attempt++) {
      let complete!: (facts: ManagedAccountFacts) => void;
      h.setRead(() => new Promise(resolve => { complete = resolve; })); const pending = h.manager.tick();
      vi.setSystemTime(initial + (attempt + 1) * 5000);
      await h.runtime.createOrder({ symbol: h.legs[0].symbol, side: 'BUY', type: 'LIMIT', timeInForce: 'POC', quantity: '10', price: '100' },
        { strategyId: id, strategyLeg: 'left', feePhase: 'entry' });
      h.ack(attempt + 1, 'CANCELLED', '0'); complete(h.facts()); await pending;
      expect(managedRiskReason(h.db)).toBeNull();
    }
    expect(marginFacts).not.toHaveBeenCalled(); h.setRead(null); vi.setSystemTime(initial + 30_001); await h.manager.tick();
    expect(managedRiskReason(h.db)).toBe('managed_account_recovery_expired');
    expect(h.runtime.getStrategy(id).status).toBe('PAUSED'); expect(h.created).toHaveLength(4); expect(hasManagedClaims(h.db)).toBe(true);
  });

  it('does not use a normal entry update to clear a real read-failure lock', async () => {
    const h = await harness(); const id = await h.task('PAIR-ENTRY', false, 'MAKER_TAKER'); h.missingFunding(true); await h.manager.tick();
    const order = await h.runtime.createOrder({ symbol: h.legs[0].symbol, side: 'BUY', type: 'LIMIT', timeInForce: 'POC', quantity: '10', price: '100' },
      { strategyId: id, strategyLeg: 'left', feePhase: 'entry' });
    let cancelAt: number | null = null; const cancellations: Array<Promise<unknown>> = []; h.holdCancel();
    h.manager.setEntryRecoveryController({ cancel: () => {
      if (cancelAt !== null) return; cancelAt = Date.now(); cancellations.push(h.runtime.cancelOrder(order.id));
    }, evidence: () => cancelAt === null ? null : { startedAt: cancelAt, deadline: cancelAt + 25000 } });
    h.unavailable(); await h.manager.tick(); await Promise.all(cancellations); h.unavailable(false);
    vi.setSystemTime(Date.now() + 2000);
    let complete!: (facts: ManagedAccountFacts) => void;
    h.setRead(() => new Promise(resolve => { complete = resolve; })); const pending = h.manager.tick(); h.ack(1, 'OPEN', '0');
    complete(h.facts()); await pending; expect(managedRiskReason(h.db)).toBe('managed_account_rechecking');
    h.setRead(null); h.ack(1, 'CANCELLED', '0'); await h.manager.tick();
    expect(managedRiskReason(h.db)).toBe('managed_account_rechecking');
    await h.manager.tick(); expect(managedRiskReason(h.db)).toBeNull();
    expect(h.created).toHaveLength(1); expect(h.cancelled).toEqual(['remote-1']);
  });

  it('still globally rechecks a confirmed fill during an entry account read', async () => {
    const h = await harness(); const id = await h.task('PAIR-ENTRY', false, 'MAKER_TAKER'); await h.manager.tick();
    await h.runtime.createOrder({ symbol: h.legs[0].symbol, side: 'BUY', type: 'LIMIT', timeInForce: 'POC', quantity: '10', price: '100' },
      { strategyId: id, strategyLeg: 'left', feePhase: 'entry' });
    let complete!: (facts: ManagedAccountFacts) => void;
    h.setRead(() => new Promise(resolve => { complete = resolve; })); const pending = h.manager.tick();
    h.ack(1, 'PARTIALLY_FILLED', '5'); h.quantities('5', '0');
    try { expect(managedRiskReason(h.db)).toBe('managed_account_rechecking'); } finally { complete(h.facts()); await pending; }
    expect(h.created).toHaveLength(1); expect(h.runtime.getOrder(h.runtime.listOrders()[0].id).executedQuantity).toBe('5');
  });

  it('never treats a quote as normal after its ownership no longer matches the task', async () => {
    const h = await harness(); const id = await h.task('PAIR-ENTRY', false, 'MAKER_TAKER'); await h.manager.tick();
    await h.runtime.createOrder({ symbol: h.legs[0].symbol, side: 'BUY', type: 'LIMIT', timeInForce: 'POC', quantity: '10', price: '100' },
      { strategyId: id, strategyLeg: 'left', feePhase: 'entry' });
    let complete!: (facts: ManagedAccountFacts) => void;
    h.setRead(() => new Promise(resolve => { complete = resolve; })); const pending = h.manager.tick();
    h.db.prepare('UPDATE managed_position_claims SET strategy_id = ? WHERE symbol = ?').run('PAIR-OTHER', h.legs[0].symbol);
    h.ack(1, 'OPEN', '0');
    try { expect(managedRiskReason(h.db)).toBe('managed_account_rechecking'); } finally { complete(h.facts()); await pending; }
    expect(h.created).toHaveLength(1);
  });

  it('pairs a confirmed exit before REST settlement but gates the next batch on actual holdings', async () => {
    const h = await harness(); const id = await h.task(); await h.manager.tick();
    h.manager.beginStop(id, true); await h.manager.finishStop(id); await h.manager.tick();
    expect(h.created).toHaveLength(1); h.ack(1, 'FILLED', '10'); await h.manager.waitForIdle();
    expect(h.created).toHaveLength(2); expect(h.created[1]).toMatchObject({ type: 'MARKET', qty: '10', reduce_only: 'true' });
    h.ack(2, 'FILLED', '10'); await h.manager.waitForIdle();
    await h.manager.tick(); await h.manager.tick();
    expect(readManagedState(h.db, id)?.reason).toBe('managed_positions_settlement_pending');
    expect(managedRiskReason(h.db)).toBeNull(); expect(h.created).toHaveLength(2);
    h.quantities('90', '90'); await h.manager.tick();
    expect(readManagedState(h.db, id)?.protectionIncident).toBeUndefined();
    expect(readManagedState(h.db, id)?.positionSettlementSince).toBeUndefined();
  });

  it('pairs a confirmed ordinary exit before a slow position REST read finishes', async () => {
    const h = await harness(), id = await h.task(); await h.manager.tick();
    h.manager.requestExit(id); await h.manager.tick(); expect(h.created).toHaveLength(1);
    let release!: (facts: ManagedAccountFacts) => void;
    h.setRead(() => new Promise(resolve => { release = resolve; })); const reading = h.manager.tick();
    h.ack(1, 'PARTIALLY_FILLED', '3');
    try {
      for (let i = 0; i < 20; i++) await Promise.resolve();
      expect(managedRiskReason(h.db)).toBeNull();
      expect(h.created).toHaveLength(2);
      expect(h.created[1]).toMatchObject({ type: 'MARKET', reduce_only: 'true', qty: '3' });
      h.ack(1, 'PARTIALLY_FILLED', '3');
      for (let i = 0; i < 10; i++) await Promise.resolve();
      expect(h.created).toHaveLength(2);
    } finally { h.setRead(null); release(h.facts()); await reading; }
  });
  it('does not turn a late duplicate trade proof for an already verified holding into account recovery', async () => {
    const h = await harness(), id = await h.task('PAIR-LATE', false);
    for (const [index, leg] of h.legs.entries()) await h.runtime.createOrder({ symbol: leg.symbol, side: leg.side,
      type: 'MARKET', quantity: '10' }, { strategyId: id, strategyLeg: index === 0 ? 'left' : 'right' });
    h.ack(1, 'FILLED', '10'); h.ack(2, 'FILLED', '10'); h.quantities('10', '10'); h.manager.handoff(id, '10'); await h.manager.tick();
    let release!: (facts: ManagedAccountFacts) => void;
    h.setRead(() => new Promise(resolve => { release = resolve; })); const reading = h.manager.tick();
    try {
      h.runtime.ingestPrivateEvent({ channel: 'usertrades', payload: { transaction_id: 'late-trade', order_id: 'remote-1',
        symbol: h.legs[0].symbol, exchange_type: 'BINANCE', side: 'BUY', qty: '10', price: '100', fee: '0', create_time: String(Date.now()) } });
      expect(managedRiskReason(h.db)).toBeNull(); expect(h.created).toHaveLength(2);
    } finally { h.setRead(null); release(h.facts()); await reading; }
  });
  it('never enlarges a below-minimum partial exit into a full opposite-leg reduction', async () => {
    const h = await harness(), id = await h.task(); await h.manager.tick();
    h.db.prepare('UPDATE crossex_instruments SET lot_size=?,min_size=? WHERE symbol=?').run('0.01', '0.01', h.legs[0].symbol);
    h.manager.requestExit(id); await h.manager.tick(); h.ack(1, 'PARTIALLY_FILLED', '0.1'); await h.manager.waitForIdle();
    expect(h.created).toHaveLength(1); expect(readManagedState(h.db, id)?.reason).toBe('managed_pairing_below_minimum');
    h.ack(1, 'PARTIALLY_FILLED', '1'); await h.manager.waitForIdle();
    expect(h.created).toHaveLength(2); expect(h.created[1]).toMatchObject({ qty: '1', reduce_only: 'true' });
  });
  it('pairs late confirmed fills through a normal settlement wait without clearing that wait for new batches', async () => {
    const h = await harness(), id = await h.task(); await h.manager.tick(); h.manager.requestExit(id); await h.manager.tick();
    h.ack(1, 'PARTIALLY_FILLED', '3'); await h.manager.waitForIdle(); h.ack(2, 'FILLED', '3'); await h.manager.waitForIdle();
    await h.manager.tick(); await h.manager.tick();
    expect(readManagedState(h.db, id)?.positionSettlementSince).toBeDefined();
    h.ack(1, 'CANCELLED', '5'); await h.manager.waitForIdle();
    expect(h.created).toHaveLength(3); expect(h.created[2]).toMatchObject({ qty: '2', reduce_only: 'true' });
    expect(readManagedState(h.db, id)?.positionSettlementSince).toBeDefined(); expect(managedRiskReason(h.db)).toBeNull();
  });
  it('rechecks official account freshness at the actual queued exit dispatch', async () => {
    const h = await harness(), id = await h.task(); await h.manager.tick(); h.manager.requestExit(id); await h.manager.tick();
    const observedAt = Date.now(); h.manager.setMarginMonitor({ blockIncident: vi.fn(), snapshot: () => ({ fresh: Date.now() - observedAt <= 5000, incidentId: null }) } as unknown as MarginRiskMonitor);
    let release!: () => void; h.setSubmitWait(() => new Promise<void>(resolve => { release = resolve; }));
    h.ack(1, 'PARTIALLY_FILLED', '3'); for (let i = 0; i < 20; i++) await Promise.resolve();
    expect(release).toBeDefined(); vi.setSystemTime(Date.now() + 6000); release(); await h.manager.waitForIdle();
    expect(h.created).toHaveLength(1); expect(h.runtime.getStrategy(id).status).toBe('PAUSED');
  });
  it('rolls back incident registration if managed batch persistence fails before submission', async () => {
    const h = await harness(); const id = await h.task(); h.missingFunding(true);
    h.setRead(async () => ({ ...h.facts(), positions: h.facts().positions.map(p => ({ ...p, margin_mode: 'CROSS' })) }));
    await h.manager.tick(); const store = new MarginRiskStore(h.db), incident = store.startIncident('atomic-test', Date.now());
    h.manager.setMarginMonitor({ snapshot: () => ({ incidentId: incident.id }), blockIncident: vi.fn(), assertFirstLeg: vi.fn(),
      planBatch: () => { store.saveIncident('atomic-test', { ...incident, batch: { id: 'atomic-batch', firstLeg: 0,
        strategyId: id, before: '100', target: '90', at: Date.now() } }); return '10'; },
      preparedBatch: () => ({ version: 2, id: 'atomic-batch', incidentId: incident.id, before: '100', quantity: '10', firstLeg: 0 }),
    } as unknown as MarginRiskMonitor);
    h.db.exec(`CREATE TRIGGER reject_batch BEFORE UPDATE ON managed_positions
      WHEN json_extract(NEW.state_json, '$.marginBatch.id') IS NOT NULL BEGIN SELECT RAISE(ABORT, 'synthetic_batch_persist_failure'); END`);
    await h.manager.tick();
    expect(h.created).toHaveLength(0); expect(store.incident('atomic-test')?.batch).toBeNull();
    expect(readManagedState(h.db, id)?.marginBatch).toBeUndefined();
    expect(managedRiskReason(h.db)).toBe('synthetic_batch_persist_failure');
  });
  it('never rounds a confirmed 0.6 margin imbalance to a one-unit pairing order', async () => {
    const h = await harness(); const id = await h.task(); h.missingFunding(true);
    h.setRead(async () => ({ ...h.facts(), positions: h.facts().positions.map(p => ({ ...p, margin_mode: 'CROSS' })) }));
    await h.manager.tick();
    h.db.prepare("UPDATE crossex_instruments SET lot_size = '0.1', min_size = '0.1' WHERE symbol = ?").run(h.legs[0].symbol);
    h.manager.setMarginMonitor({ planBatch: () => '10', preparedBatch: () => ({ version: 2, id: 'precision-batch',
      incidentId: 'incident', before: '100', quantity: '10', firstLeg: 0 }), assertFirstLeg: vi.fn(),
      snapshot: () => ({ incidentId: 'incident' }), blockIncident: vi.fn() } as unknown as MarginRiskMonitor);
    await h.manager.tick(); h.ack(1, 'CANCELLED', '0.6'); h.quantities('99.4', '100');
    await h.manager.tick(); await h.manager.tick();
    expect(h.created).toHaveLength(1); expect(managedRiskReason(h.db)).toBe('margin_partial_untradeable');
    expect(readManagedState(h.db, id)?.marginBatch?.id).toBe('precision-batch');
  });
  it('locks balanced external reductions and keeps the incident until explicit review', async () => {
    const h = await harness(); const id = await h.task(); await h.manager.tick();
    h.quantities('90', '90'); await h.manager.tick();
    expect(h.created).toHaveLength(0); expect(managedRiskReason(h.db)).toBe('managed_external_reduction');
    expect(readManagedState(h.db, id)?.protectionIncident).toMatchObject({ before: ['100', '100'] });
    h.session.set('live'); await h.manager.resume(id, 'account-1');
    expect(readManagedState(h.db, id)?.protectionIncident).toBeNull();
    await h.manager.tick(); expect(h.created).toHaveLength(0); expect(managedRiskReason(h.db)).toBeNull();
  });
  it('registers persisted catalog-only managed legs after restart without a browser watcher', async () => {
    const h = await harness('ZHIPU'); const id = await h.task(); await h.manager.tick(); await h.manager.stop();
    const known = new Set<string>();
    const ensureMarket = vi.fn((symbol: string) => { known.add(symbol); return true; });
    const restarted = new ManagedPositionManager(h.db, h.session, h.runtime, {
      ensureMarket, market: (symbol) => known.has(symbol) ? ({ symbol, source: 'gate_crossex_websocket',
        bidPrice: '100', askPrice: '101', updatedAt: new Date().toISOString(), receivedAt: new Date().toISOString() } as LiveMarket) : null,
    }, h.sources); managers.push(restarted);
    await restarted.tick();
    expect([...known].sort()).toEqual(h.legs.map((leg) => leg.symbol).sort());
    expect(readManagedState(h.db, id)?.signalReason).toBeNull();
    expect(readManagedState(h.db, id)?.spreadBps).not.toBeNull();
    expect(h.created).toHaveLength(0);
  });
  it('never expands a partially filled margin batch to full liquidation to meet minimum size', async () => {
    const h = await harness(); const id = await h.task(); h.missingFunding(true);
    h.setRead(async () => ({ ...h.facts(), positions: h.facts().positions.map((p) => ({ ...p, margin_mode: 'CROSS' })) }));
    await h.manager.tick(); h.db.prepare("UPDATE crossex_instruments SET min_size = '5'").run();
    h.manager.setMarginMonitor({ preparedBatch: () => ({ version: 2, id: 'test-batch', incidentId: 'incident', firstLeg: 0, before: '100', quantity: '10' }), assertFirstLeg: vi.fn(), planBatch: () => '10', snapshot: () => ({ incidentId: 'incident' }), blockIncident: vi.fn() } as unknown as MarginRiskMonitor);
    await h.manager.tick(); expect(h.created[0].qty).toBe('10');
    h.ack(1, 'CANCELLED', '1'); h.quantities('99', '100'); await h.manager.tick(); await h.manager.tick();
    expect(h.created).toHaveLength(1); expect(readManagedState(h.db, id)?.phase).toBe('RISK_PAUSED');
    expect(managedRiskReason(h.db)).toBe('margin_partial_untradeable');
  });
  it.each(['IMR', 'MMR'] as const)('reduces an authorized %s group in paired batches and stops after fresh recovery', async (cause) => {
    const h = await harness(); const id = await h.task();
    h.missingFunding(true);
    const fullFacts = () => ({ ...h.facts(), positions: h.facts().positions.map((p) => ({ ...p, margin_mode: 'CROSS', initial_margin: '100', maintenance_margin: '10' })) });
    h.setRead(async () => fullFacts()); await h.manager.tick();
    let balance = 120, maintenance = 10, marginNow = Date.now();
    const monitor = new MarginRiskMonitor(new MarginRiskStore(h.db), {
      context: () => 'account-1', live: () => h.session.liveTradingEnabled, now: () => marginNow,
      reviewReady: () => h.runtime.listOpenOrders().length === 0, settlementReady: () => true,
      proposal: () => ({ quantity: '10', target: '10', apr: '0', firstLeg: 0, initial: '200', maintenance: '20' }),
      groups: () => [{ id, strategyId: id, asset: 'BTC', phase: 'MONITORING', eligible: true, authorized: false, reason: null }], uncovered: () => [],
      account: async () => ({ profileId: 'account-1', userId: 'synthetic', label: 'Test', account: {
        available_margin: String(balance - 100), margin_balance: String(balance), initial_margin: '100', maintenance_margin: String(maintenance),
        initial_margin_rate: String(balance / 100), maintenance_margin_rate: String(balance / maintenance),
        account_mode: 'CROSS_EXCHANGE', exchange_type: 'CROSSEX', position_mode: 'SINGLE', update_time: String(Date.now()), assets: [],
      } }),
    });
    await monitor.refresh(); monitor.savePolicy({ ...monitor.snapshot().policy, protectedGroupIds: [id] });
    if (cause === 'IMR') balance = 104; else maintenance = 90;
    await monitor.refresh(); expect(monitor.snapshot().protection?.cause).toBe(cause); h.manager.setMarginMonitor(monitor);
    await h.manager.tick(); expect(h.created).toHaveLength(1);
    expect(h.created[0]).toMatchObject({ symbol: h.legs[0].symbol, qty: '10', reduce_only: 'true', type: 'MARKET' });
    h.ack(1, 'FILLED', '10'); h.quantities('90', '100'); await h.manager.tick(); await h.manager.tick();
    expect(h.created[1]).toMatchObject({ symbol: h.legs[1].symbol, qty: '10', reduce_only: 'true' });
    h.ack(2, 'FILLED', '10'); h.quantities('90', '90'); await h.manager.tick(); balance = 115; maintenance = 10; await h.manager.tick();
    marginNow += 2000; await monitor.refresh(); await h.manager.tick();
    expect(monitor.snapshot().incidentId).not.toBeNull();
    marginNow += 2000; await monitor.refresh();
    expect(h.created).toHaveLength(2); expect(monitor.snapshot().incidentId).toBeNull();
    expect(monitor.snapshot().entryBlocked).toBe(true); expect(readManagedState(h.db, id)?.exitRequested).toBe(false);
    await monitor.stop();
  });
  it('never replays an uncertain margin submission and retains a global pause', async () => {
    const h = await harness(); const id = await h.task(); h.missingFunding(true);
    h.setRead(async () => ({ ...h.facts(), positions: h.facts().positions.map((p) => ({ ...p, margin_mode: 'CROSS' })) }));
    await h.manager.tick();
    const blockIncident = vi.fn();
    h.manager.setMarginMonitor({ preparedBatch: () => ({ version: 2, id: 'test-batch', incidentId: 'incident', firstLeg: 0, before: '100', quantity: '10' }), assertFirstLeg: vi.fn(), planBatch: () => '10', snapshot: () => ({ incidentId: 'incident' }), blockIncident } as unknown as MarginRiskMonitor);
    h.failSubmit(); await h.manager.tick(); await h.manager.tick();
    expect(h.created).toHaveLength(1); expect(h.session.current).toBe('readonly');
    expect(readManagedState(h.db, id)?.phase).toBe('RISK_PAUSED'); expect(blockIncident).toHaveBeenCalled();
  });
  it('never lets margin protection override KEEP or missing cross-margin evidence', async () => {
    const h = await harness(); const id = await h.task(); h.missingFunding(true); await h.manager.tick();
    const planBatch = vi.fn(() => '10');
    h.manager.setMarginMonitor({ planBatch, snapshot: () => ({ incidentId: null }), blockIncident: vi.fn() } as unknown as MarginRiskMonitor);
    await h.manager.tick(); expect(planBatch).not.toHaveBeenCalled();
    h.manager.beginStop(id, false); await h.manager.finishStop(id); await h.manager.tick();
    expect(h.created).toHaveLength(0);
  });
  it.each(['BTC', 'HYPE', 'SIREN', 'ETH'])('adopts %s and monitors baseline plus additional fills', async (asset) => {
    const h = await harness(asset); h.config.management!.adoptExisting = true;
    h.quantities('25', '25'); const id = await h.task('PAIR-ADOPT', false);
    expect(readManagedState(h.db, id)).toMatchObject({ adoptedLeft: '25', adoptedRight: '25', groupId: id });
    h.quantities('125', '125'); h.manager.handoff(id, '100'); await h.manager.tick();
    expect(h.runtime.getStrategy(id)).toMatchObject({ filledQuantity: '100', management: {
      phase: 'MONITORING', leftQuantity: '125', rightQuantity: '125' } });
    h.quantities('120', '125'); await h.manager.tick();
    expect(h.created[0]).toMatchObject({ symbol: h.legs[1].symbol, qty: '5', reduce_only: 'true' });
  });
  it('rejects unbalanced adoption without creating any order or orphan reservation', async () => {
    const h = await harness(); h.config.management!.adoptExisting = true; h.quantities('25', '24');
    await expect(h.task()).rejects.toMatchObject({ code: 'managed_adoption_unbalanced' });
    expect(h.created).toHaveLength(0); expect(hasManagedClaims(h.db)).toBe(false);
  });
  it('stops without closing by default and retains holdings and control across restart', async () => {
    const h = await harness(); const id = await h.task(); await h.manager.tick();
    h.manager.beginStop(id, false); await h.manager.finishStop(id);
    await h.manager.tick();
    expect(h.created).toHaveLength(0);
    expect(h.runtime.getStrategy(id)).toMatchObject({ status: 'STOPPED', management: {
      phase: 'STOPPED', stopIntent: 'KEEP', leftQuantity: '100', rightQuantity: '100' } });
    expect(hasManagedClaims(h.db)).toBe(true);
    await expect(h.runtime.createOrder({ symbol: h.legs[0].symbol, side: 'BUY', type: 'MARKET', quantity: '1' }))
      .rejects.toMatchObject({ code: 'managed_position_owned' });
  });
  it('explicit close includes adopted and newly filled positions', async () => {
    const h = await harness(); h.config.management!.adoptExisting = true; h.quantities('25', '25');
    const id = await h.task('PAIR-EXIT', false); h.quantities('125', '125');
    h.manager.beginStop(id, true); await h.manager.finishStop(id); await h.manager.tick();
    expect(readManagedState(h.db, id)).toMatchObject({ exitRequested: true, stopIntent: 'EXIT', maxLeft: '125', maxRight: '125' });
    expect(h.created[0]).toMatchObject({ qty: '10', reduce_only: 'true' });
  });
  it('reuses a stopped group identity without replaying the previous entry', async () => {
    const h = await harness(); const previous = await h.task(); await h.manager.tick();
    h.manager.beginStop(previous, false); await h.manager.finishStop(previous);
    h.config.management!.adoptExisting = true;
    const next = await h.task('PAIR-NEXT', false);
    expect(readManagedState(h.db, next)).toMatchObject({ groupId: previous, adoptedLeft: '100' });
    expect(readManagedState(h.db, previous)).toMatchObject({ phase: 'TRANSFERRED', transferredTo: next });
    await expect(h.manager.resume(previous, 'account-1')).rejects.toMatchObject({ code: 'managed_group_transferred' });
  });
  it('cancels only attributable orders on the selected legs before adopting', async () => {
    const h = await harness(); h.config.management!.adoptExisting = true; h.quantities('25', '25');
    const first = await h.runtime.createOrder({ symbol: h.legs[0].symbol, side: 'BUY', type: 'LIMIT', price: '100', quantity: '5' });
    const second = await h.runtime.createOrder({ symbol: h.legs[1].symbol, side: 'SELL', type: 'LIMIT', price: '100', quantity: '5' });
    const other = await h.runtime.createOrder({ symbol: 'GATE_FUTURE_ETH_USDT', side: 'BUY', type: 'LIMIT', price: '100', quantity: '5' });
    const id = await h.task('PAIR-ORDERS', false);
    expect(h.runtime.getOrder(first.id).state).toBe('CANCELLED'); expect(h.runtime.getOrder(second.id).state).toBe('CANCELLED');
    expect(h.runtime.getOrder(other.id)).toEqual(other); expect(h.created).toHaveLength(3);
    expect(readManagedState(h.db, id)?.adoptedLeft).toBe('25');
  });
  it('does not equate symmetric unknown remote orders with balanced holdings', async () => {
    const h = await harness(); h.config.management!.adoptExisting = true;
    for (const [i, leg] of h.legs.entries()) h.remote.set(`unknown-${i}`, { symbol: leg.symbol, order_id: `unknown-${i}`, state: 'OPEN', qty: '10', side: leg.side } as GateCrossExOrder);
    await expect(h.task()).rejects.toMatchObject({ code: 'managed_adoption_unknown_order' });
    expect(h.created).toHaveLength(0); expect(hasManagedClaims(h.db)).toBe(false);
  });
  it('retains the previous controller when additional launch preparation fails', async () => {
    const h = await harness(); const original = await h.task(); await h.manager.tick(); h.config.management!.adoptExisting = true;
    await expect(h.manager.reserve('PAIR-FAIL', h.config, 'account-1', async () => { throw new Error('quote failure'); })).rejects.toThrow('quote failure');
    expect(h.db.prepare('SELECT DISTINCT strategy_id FROM managed_position_claims').all()).toEqual([{ strategy_id: original }]);
    expect(readManagedState(h.db, original)?.phase).toBe('MONITORING');
  });
  it('continues donor protection and interrupts adoption while its preparation is pending', async () => {
    const h = await harness(); const original = await h.task(); await h.manager.tick(); h.config.management!.adoptExisting = true;
    let release!: () => void;
    const launch = h.manager.reserve('PAIR-WAIT', h.config, 'account-1', () => new Promise<void>((resolve) => { release = resolve; }));
    h.quantities('100', '80'); await h.manager.tick();
    expect(h.created[0]).toMatchObject({ qty: '20', reduce_only: 'true' });
    release(); await expect(launch).rejects.toMatchObject({ code: 'managed_adoption_interrupted' });
    expect(h.db.prepare('SELECT DISTINCT strategy_id FROM managed_position_claims').all()).toEqual([{ strategy_id: original }]);
  });
  it('does not release reservations to overlapping concurrent launch requests', async () => {
    const h = await harness(); h.config.management!.adoptExisting = true;
    let release!: () => void;
    const first = h.manager.reserve('PAIR-FIRST', h.config, 'account-1', () => new Promise<void>((r) => { release = r; }));
    await expect(h.manager.reserve('PAIR-SECOND', h.config, 'account-1')).rejects.toMatchObject({ code: 'managed_position_owned' });
    release(); await first;
    expect(h.db.prepare('SELECT DISTINCT strategy_id FROM managed_position_reservations').all()).toEqual([{ strategy_id: 'PAIR-FIRST' }]);
    h.manager.abortReservation('PAIR-FIRST');
  });
  it('protects adopted exposure during opening and clears the incident only on explicit resume', async () => {
    const h = await harness(); h.config.management!.adoptExisting = true; h.quantities('25', '25');
    const id = await h.task('PAIR-PARTIAL', false);
    h.db.prepare("UPDATE execution_strategies SET filled_left='0', filled_right='0' WHERE id=?").run(id);
    const halt = vi.fn(async () => undefined); h.manager.setEntryController(halt);
    h.quantities('25', '20'); await h.manager.tick(); await h.manager.tick();
    expect(halt).toHaveBeenCalledTimes(1);
    await h.manager.tick(); expect(h.created[0]).toMatchObject({ qty: '5', reduce_only: 'true' });
    h.ack(1, 'FILLED', '5'); h.quantities('20', '20'); await h.manager.tick(); await h.manager.tick();
    expect(managedRiskReason(h.db)).toBe('managed_entry_exposure_changed');
    h.session.set('live'); await h.manager.resume(id, 'account-1'); await h.manager.tick(); await h.manager.tick();
    expect(managedRiskReason(h.db)).toBeNull(); expect(readManagedState(h.db, id)?.phase).toBe('MONITORING');
  });
  it('persists KEEP before an interrupted stop and does not reactivate it after restart', async () => {
    const h = await harness(); const id = await h.task(); await h.manager.tick(); h.manager.beginStop(id, false);
    await h.manager.stop();
    const restored = new ManagedPositionManager(h.db, h.session, h.runtime, { market: () => null }, h.sources); managers.push(restored);
    await restored.tick(); expect(h.created).toHaveLength(0);
    expect(h.runtime.getStrategy(id).status).toBe('PAUSED');
    expect(readManagedState(h.db, id)).toMatchObject({ phase: 'STOPPING', stopIntent: 'KEEP', exitRequested: false });
    await restored.finishStop(id); expect(h.runtime.getStrategy(id).status).toBe('STOPPED');
  });
  it('latches economic exit during additional entry and halts entry before any reduction', async () => {
    const h = await harness(); h.config.management!.adoptExisting = true; h.quantities('25', '25');
    const id = await h.task('PAIR-DWELL', false); h.db.prepare("UPDATE execution_strategies SET filled_left='0', filled_right='0' WHERE id=?").run(id);
    const halt = vi.fn(async () => undefined); h.manager.setEntryController(halt);
    await h.manager.tick(); vi.setSystemTime(Date.now() + 2100); await h.manager.tick();
    expect(halt).toHaveBeenCalledTimes(1); expect(h.created).toHaveLength(0);
    expect(readManagedState(h.db, id)?.exitRequested).toBe(true);
    await h.manager.tick(); expect(h.created[0]).toMatchObject({ qty: '10', reduce_only: 'true' });
  });
  it('cannot resume a flat stopped task into later external holdings', async () => {
    const h = await harness(); const id = await h.task(); await h.manager.tick();
    h.quantities('0', '0'); h.manager.beginStop(id, false); await h.manager.finishStop(id);
    expect(h.runtime.getStrategy(id).status).toBe('COMPLETED'); expect(hasManagedClaims(h.db)).toBe(false);
    h.quantities('200', '200'); await expect(h.manager.resume(id, 'account-1')).rejects.toMatchObject({ code: 'managed_group_released' });
    await h.manager.tick(); expect(h.created).toHaveLength(0);
  });
  it('a user stop interrupts pending takeover and keeps the original holdings', async () => {
    const h = await harness(); const id = await h.task(); await h.manager.tick(); h.config.management!.adoptExisting = true;
    await h.manager.reserve('PAIR-NEW', h.config, 'account-1');
    h.manager.beginStop(id, false); await h.manager.finishStop(id);
    await expect(h.manager.recheckReservation('PAIR-NEW', h.config, 'account-1')).rejects.toMatchObject({ code: 'managed_adoption_interrupted' });
    expect(readManagedState(h.db, id)?.phase).toBe('STOPPED'); expect(h.created).toHaveLength(0);
  });
  it('cannot restore an old owner when adoption commits while resume is awaiting facts', async () => {
    const h = await harness(); const old = await h.task(); await h.manager.tick();
    h.manager.beginStop(old, false); await h.manager.finishStop(old);
    let release!: (facts: ManagedAccountFacts) => void;
    h.setRead(() => new Promise((resolve) => { release = resolve; }));
    const pending = h.manager.resume(old, 'account-1');
    h.setRead(null); h.config.management!.adoptExisting = true;
    const current = await h.task('PAIR-REPLACED', false);
    release(h.facts()); await expect(pending).rejects.toMatchObject({ code: 'managed_group_released' });
    expect(h.runtime.getStrategy(old).status).toBe('STOPPED');
    expect(h.db.prepare('SELECT DISTINCT strategy_id FROM managed_position_claims').all()).toEqual([{ strategy_id: current }]);
  });
  it('blocks restored entry before any new order when adopted holdings changed during downtime', async () => {
    const h = await harness(); h.config.management!.adoptExisting = true; h.quantities('25', '25');
    const id = await h.task('PAIR-RESTART', false); h.db.prepare("UPDATE execution_strategies SET filled_left='0', filled_right='0' WHERE id=?").run(id);
    h.session.set('readonly'); h.quantities('25', '20');
    await expect(h.manager.validateForActivation()).rejects.toMatchObject({ code: 'managed_restart_position_mismatch' });
    expect(h.runtime.getStrategy(id).status).toBe('PAUSED'); expect(h.created).toHaveLength(0);
  });
  it('recognizes the same group when A/B display order is reversed without changing real directions', async () => {
    const h = await harness(); const old = await h.task(); await h.manager.tick();
    h.config.management!.adoptExisting = true;
    h.config.leftVenue = 'OKX'; h.config.rightVenue = 'BINANCE'; h.config.leftSide = 'SELL'; h.config.rightSide = 'BUY';
    const next = await h.task('PAIR-SWAPPED', false);
    expect(readManagedState(h.db, next)).toMatchObject({ groupId: old, adoptedLeft: '100', adoptedRight: '100' });
    expect(readManagedState(h.db, old)?.phase).toBe('TRANSFERRED'); expect(h.created).toHaveLength(0);
  });
});

describe('managed lifecycle using the real order runtime and isolated database', () => {
  it.each(['unknown', 'not-sent', 'rejected', 'confirmed-ws'] as const)(
    'classifies a cancellation failure before changing global authority (%s)', async outcome => {
      const h = await harness();
      const order = await h.runtime.createOrder({ symbol: h.legs[0].symbol, side: 'SELL', type: 'MARKET', quantity: '1', reduceOnly: true });
      vi.spyOn(h.gateway, 'cancelOrder').mockImplementation(async () => {
        if (outcome === 'confirmed-ws') h.ack(1, 'CANCELLED', '0');
        if (outcome === 'not-sent') throw new RequestNotDispatchedError('revoked');
        throw new GateApiError(outcome === 'rejected' ? 400 : 0, outcome === 'rejected' ? 'REJECTED' : 'NETWORK_ERROR');
      });
      await expect(h.runtime.cancelOrder(order.id)).rejects.toThrow();
      const actual = h.runtime.getOrder(order.id);
      if (outcome === 'unknown') {
        expect(actual).toMatchObject({ state: 'PENDING_CANCEL', failureReason: 'ORDER_CANCELLATION_UNKNOWN' });
        expect(managedRiskReason(h.db)).toBe('managed_order_unresolved'); expect(h.session.current).toBe('readonly');
      } else {
        expect(actual.failureReason).not.toBe('ORDER_CANCELLATION_UNKNOWN');
        expect(actual.state).toBe(outcome === 'not-sent' ? 'NEW' : outcome === 'confirmed-ws' ? 'CANCELLED' : 'PENDING_CANCEL');
        expect(managedRiskReason(h.db)).toBeNull(); expect(h.session.current).toBe('live');
      }
    },
  );
  it('blocks an already queued write synchronously when another submit becomes unknown without an account read', async () => {
    vi.useRealTimers(); const h = await harness();
    let release!: () => void, started!: () => void, requests = 0;
    const held = new Promise<void>(resolve => { release = resolve; });
    const firstStarted = new Promise<void>(resolve => { started = resolve; });
    const client = new GateCrossExClient(async (url, init) => {
      expect(new URL(String(url)).hostname).toBe('synthetic.invalid'); requests++;
      if (requests === 1) { started(); await held; throw new Error('synthetic lost response'); }
      const body = JSON.parse(String(init!.body)) as CrossExOrderRequest;
      return new Response(JSON.stringify({ order_id: 'synthetic-second', text: body.text }));
    }, Date.now, 'https://synthetic.invalid/api/v4', 0);
    h.gateway.createOrder = client.createOrder.bind(client);
    const first = h.runtime.createOrder({ symbol: h.legs[0].symbol, side: 'SELL', type: 'MARKET', quantity: '1', reduceOnly: true });
    const rejected = expect(first).rejects.toMatchObject({ label: 'NETWORK_ERROR' }); await firstStarted;
    const second = h.runtime.createOrder({ symbol: h.legs[1].symbol, side: 'BUY', type: 'MARKET', quantity: '1', reduceOnly: true });
    const blocked = expect(second).rejects.toMatchObject({ code: 'managed_global_risk_paused' });
    await vi.waitFor(() => expect(h.runtime.listOpenOrders()).toHaveLength(2)); release();
    await Promise.all([rejected, blocked]); expect(requests).toBe(1);
    expect(h.session.current).toBe('readonly'); expect(managedRiskReason(h.db)).toBe('managed_order_unresolved');
    expect(h.runtime.listOpenOrders()).toEqual([expect.objectContaining({ state: 'PENDING_SUBMIT', failureReason: 'ORDER_SUBMISSION_UNKNOWN' })]);
  });
  it('does not invent exit intent for an unfilled opening task while account reads recover', async () => {
    const h = await harness(); const id = await h.task('PAIR-EMPTY', false);
    h.db.prepare("UPDATE execution_strategies SET filled_left='0',filled_right='0',filled_quantity='0',progress=0 WHERE id=?").run(id);
    h.unavailable(); await h.manager.tick();
    vi.setSystemTime(Date.now() + 3000); await h.manager.tick();
    expect(readManagedState(h.db, id)).toMatchObject({ phase: 'OPENING', exitRequested: false, conditionSince: null });
    h.unavailable(false); vi.setSystemTime(Date.now() + 2000); await h.manager.tick(); await h.manager.tick();
    expect(managedRiskReason(h.db)).toBeNull();
    expect(h.runtime.getStrategy(id).status).toBe('RUNNING');
    expect(readManagedState(h.db, id)).toMatchObject({ phase: 'OPENING', exitRequested: false });
    expect(h.created).toHaveLength(0);
  });
  it.each([401, 403])('immediately distinguishes HTTP %i authorization failure from transient reads', async status => {
    const h = await harness(); await h.task();
    h.setRead(async () => { throw new GateApiError(status, 'UNAUTHORIZED', undefined, { endpoint: '/crossex/positions', phase: 'request' }); });
    await h.manager.tick();
    expect(managedRiskReason(h.db)).toBe('managed_account_authorization_failed');
    expect(h.session.current).toBe('readonly'); expect(h.created).toHaveLength(0);
    const row = h.db.prepare("SELECT payload_json FROM audit_events WHERE type='managed_account_read_fault'").get() as { payload_json: string };
    expect(JSON.parse(row.payload_json)).toMatchObject({ status, fatal: true, endpoint: '/crossex/positions' });
  });
  it('observes and latches exit signals during a hung recovery read without changing its phase or placing orders', async () => {
    const h = await harness(); const id = await h.task(); await h.manager.tick();
    h.unavailable(); await h.manager.tick(); h.unavailable(false);
    vi.setSystemTime(Date.now() + 2000); h.setRead(() => new Promise(() => undefined));
    const pending = h.manager.tick();
    expect(readManagedState(h.db, id)).toMatchObject({ phase: 'MONITORING', exitRequested: true, reason: 'managed_account_rechecking' });
    h.missingFunding(true); vi.setSystemTime(Date.now() + 1000); void h.manager.tick();
    expect(readManagedState(h.db, id)).toMatchObject({ phase: 'MONITORING', exitRequested: true, conditionSince: null, fundingAprPct: null });
    expect(h.created).toHaveLength(0); h.session.set('readonly'); await pending;
  });
  it('rejects live activation with an expired persisted temporary lock', async () => {
    const h = await harness(); await h.task(); h.unavailable(); await h.manager.tick();
    h.session.set('readonly'); vi.setSystemTime(Date.now() + 25001);
    await expect(h.manager.validateForActivation()).rejects.toMatchObject({ code: 'managed_account_recovery_expired' });
    expect(h.session.current).toBe('readonly'); expect(h.created).toHaveLength(0);
  });
  it('uses the whole fixed recovery window for three temporary read failures', async () => {
    const h = await harness(); const id = await h.task(); await h.manager.tick(); const start = Date.now();
    h.missingFunding(true); h.unavailable();
    for (const elapsed of [0, 2000, 4000]) {
      vi.setSystemTime(start + elapsed); await h.manager.tick();
      expect(managedRiskReason(h.db)).toBe('managed_account_rechecking');
    }
    h.unavailable(false); vi.setSystemTime(start + 8000); await h.manager.tick();
    expect(managedRiskReason(h.db)).toBe('managed_account_rechecking');
    vi.setSystemTime(start + 10000); await h.manager.tick();
    expect(managedRiskReason(h.db)).toBeNull(); expect(h.runtime.getStrategy(id).status).toBe('RUNNING');
    expect(h.created).toHaveLength(0);
  });
  it('does not create a recovery lock from a failure arriving after readonly', async () => {
    const h = await harness(); await h.task(); let reject!: (error: Error) => void;
    h.setRead(() => new Promise((_, fail) => { reject = fail; })); const pending = h.manager.tick();
    h.session.set('readonly'); reject(new Error('synthetic late failure')); await pending;
    expect(managedRiskReason(h.db)).toBeNull(); expect(h.created).toHaveLength(0);
  });
  it('enforces the recovery deadline while an account read remains in flight', async () => {
    const h = await harness(); await h.task(); h.unavailable(); await h.manager.tick();
    const start = Date.now(); h.unavailable(false); vi.setSystemTime(start + 24000);
    h.setRead(() => new Promise(() => undefined)); const pending = h.manager.tick();
    await vi.advanceTimersByTimeAsync(1001);
    expect(managedRiskReason(h.db)).toBe('managed_account_recovery_expired');
    await pending; expect(h.created).toHaveLength(0);
  });
  it('continues monitoring after entry and trims only the confirmed excess', async () => {
    const h = await harness(); const id = await h.task(); await h.manager.tick();
    expect(h.runtime.getStrategy(id)).toMatchObject({ status: 'RUNNING', management: { phase: 'MONITORING' } });
    h.quantities('100', '80'); await h.manager.tick();
    expect(h.created).toHaveLength(1);
    expect(h.created[0]).toMatchObject({ side: 'SELL', type: 'MARKET', reduce_only: 'true', qty: '20' });
    h.ack(1, 'FILLED', '20'); h.quantities('80', '80');
    await h.manager.tick(); await h.manager.tick();
    expect(readManagedState(h.db, id)).toMatchObject({ phase: 'RISK_PAUSED', leftQuantity: '80', rightQuantity: '80' });
    expect(h.created).toHaveLength(1);
  });
  it('protects a reduction during handoff and finishes only after fresh flat evidence', async () => {
    const h = await harness(); const id = await h.task(); h.quantities('0', '100');
    await h.manager.tick(); expect(h.created[0]).toMatchObject({ side: 'BUY', qty: '100', reduce_only: 'true' });
    h.ack(1, 'FILLED', '100'); h.quantities('0', '0');
    await h.manager.tick(); await h.manager.tick();
    expect(h.runtime.getStrategy(id).status).toBe('COMPLETED'); expect(hasManagedClaims(h.db)).toBe(false);
    await h.manager.tick(); expect(h.created).toHaveLength(1);
  });
  it('blocks new risk during a transient read failure and resumes after two matching fresh reads', async () => {
    const h = await harness(); const id = await h.task(); await h.manager.tick();
    h.unavailable(); await h.manager.tick();
    expect(managedRiskReason(h.db)).toBe('managed_account_rechecking');
    expect(h.runtime.getStrategy(id).status).toBe('RUNNING');
    expect(readManagedState(h.db, id)?.conditionSince).not.toBeNull();
    await expect(h.runtime.createOrder({ symbol: 'GATE_FUTURE_ETH_USDT', side: 'BUY', type: 'MARKET', quantity: '1' }))
      .rejects.toMatchObject({ code: 'managed_account_rechecking' });
    h.unavailable(false); vi.setSystemTime(Date.now() + 2000); await h.manager.tick();
    expect(managedRiskReason(h.db)).toBe('managed_account_rechecking');
    await h.manager.tick();
    expect(managedRiskReason(h.db)).toBeNull();
    expect(h.runtime.getStrategy(id).status).toBe('RUNNING');
  });
  it.each([4900, 5200])('invalidates a normal zero-fill exit cancellation at %i ms without a global lock', async elapsed => {
    const h = await harness(); const id = await h.task(); await h.manager.tick();
    h.manager.requestExit(id); await h.manager.tick(); expect(h.created).toHaveLength(1);
    const marginFacts = vi.fn(); h.manager.setMarginFacts(marginFacts);
    let complete!: (v: ManagedAccountFacts) => void;
    h.setRead(() => new Promise(resolve => { complete = resolve; }));
    const pending = h.manager.tick(); vi.setSystemTime(Date.now() + elapsed);
    h.ack(1, 'CANCELLED', '0');
    expect(managedRiskReason(h.db)).toBeNull();
    complete(h.facts()); await pending;
    expect(managedRiskReason(h.db)).toBeNull(); expect(marginFacts).not.toHaveBeenCalled();
    expect(h.session.current).toBe('live'); expect(h.runtime.getStrategy(id).status).toBe('RUNNING');
    h.setRead(null); await h.manager.tick();
    expect(marginFacts).toHaveBeenCalledTimes(1); expect(managedRiskReason(h.db)).toBeNull();
  });

  it('does not count successful but invalidated reads as failures or extend the first recheck deadline', async () => {
    const h = await harness(); const id = await h.task(); await h.manager.tick();
    const initial = Date.now(); let complete!: (v: ManagedAccountFacts) => void;
    h.setRead(() => new Promise(resolve => { complete = resolve; }));
    for (let attempt = 0; attempt < 4; attempt++) {
      const pending = h.manager.tick(); vi.setSystemTime(initial + (attempt + 1) * 5000);
      h.manager.notifyPosition({ symbol: h.legs[0].symbol, position_qty: '100', update_time: Date.now() });
      h.manager.notifyPosition({ symbol: h.legs[0].symbol, position_qty: '99', update_time: Date.now() + 1 });
      complete(h.facts()); await pending;
      expect(managedRiskReason(h.db)).toBe('managed_account_rechecking');
    }
    const lock = h.db.prepare('SELECT created_at FROM managed_risk_lock').get() as { created_at: string };
    expect(Date.parse(lock.created_at)).toBe(initial + 5000);
    h.setRead(null); vi.setSystemTime(initial + 30001); await h.manager.tick();
    expect(managedRiskReason(h.db)).toBe('managed_account_recovery_expired');
    expect(h.runtime.getStrategy(id).status).toBe('PAUSED'); expect(h.created).toHaveLength(0);
  });

  it('rejects an in-flight read that crosses the fixed recovery deadline', async () => {
    const h = await harness(); await h.task(); await h.manager.tick(); h.unavailable(); await h.manager.tick();
    const initial = Date.now(); h.unavailable(false); let complete!: (v: ManagedAccountFacts) => void;
    h.setRead(() => new Promise(resolve => { complete = resolve; }));
    vi.setSystemTime(initial + 24000); const pending = h.manager.tick(); vi.setSystemTime(initial + 26000);
    complete(h.facts()); await pending;
    expect(managedRiskReason(h.db)).toBe('managed_account_recovery_expired'); expect(h.created).toHaveLength(0);
  });
  it('coalesces a burst of snapshot invalidations into one read and never clears an existing hard lock', async () => {
    const h = await harness(); const id = await h.task(); await h.manager.tick();
    let complete!: (v: ManagedAccountFacts) => void;
    const reads = vi.fn(() => new Promise<ManagedAccountFacts>(resolve => { complete = resolve; })); h.setRead(reads);
    const pending = h.manager.tick();
    for (let i = 0; i < 10; i++) h.manager.notifyPosition({ symbol: h.legs[0].symbol, position_qty: String(100 - i), update_time: Date.now() + i });
    await vi.advanceTimersByTimeAsync(200); expect(reads).toHaveBeenCalledTimes(1);
    complete(h.facts()); await pending; expect(h.created).toHaveLength(0);
    h.manager.failAll('managed_order_unresolved'); h.setRead(null); h.session.set('live'); await h.manager.tick();
    expect(managedRiskReason(h.db)).toBe('managed_order_unresolved');
    expect(h.runtime.getStrategy(id).status).toBe('PAUSED'); expect(h.created).toHaveLength(0);
  });
  it('does not treat repeated failed snapshots as flat and retains claims through global pause', async () => {
    const h = await harness(); const id = await h.task(); h.unavailable();
    for (let attempt = 0; attempt < 3; attempt++) { vi.setSystemTime(Date.now() + 2000); await h.manager.tick(); }
    expect(h.runtime.getStrategy(id).status).toBe('RUNNING');
    vi.setSystemTime(Date.now() + 25001); await h.manager.tick();
    expect(h.runtime.getStrategy(id).status).toBe('PAUSED'); expect(h.session.current).toBe('readonly');
    expect(hasManagedClaims(h.db)).toBe(true); expect(h.created).toHaveLength(0);
  });
  it('cancels a resting exit maker once and replaces it only after terminal proof and account recovery', async () => {
    const h = await harness(); const id = await h.task(); await h.manager.tick();
    h.manager.requestExit(id); await h.manager.tick(); expect(h.created).toHaveLength(1);
    h.unavailable(); await h.manager.tick();
    h.ack(1, 'CANCELLED', '0'); h.unavailable(false); vi.setSystemTime(Date.now() + 2000);
    await h.manager.tick(); expect(managedRiskReason(h.db)).toBe('managed_account_rechecking');
    expect(h.created).toHaveLength(1);
    await h.manager.tick(); expect(managedRiskReason(h.db)).toBeNull();
    expect(h.runtime.getStrategy(id).status).toBe('RUNNING');
    expect(h.created).toHaveLength(2); expect(h.cancelled).toEqual(['remote-1']);
    expect(h.remote.get('remote-1')?.state).toBe('CANCELLED');
  });
  it('escalates when a recheck stays unconfirmed past the recovery window', async () => {
    const h = await harness(); const id = await h.task(); await h.manager.tick();
    h.unavailable(); await h.manager.tick(); h.unavailable(false);
    vi.setSystemTime(Date.now() + 26_000); await h.manager.tick();
    expect(managedRiskReason(h.db)).toBe('managed_account_recovery_expired');
    expect(h.runtime.getStrategy(id).status).toBe('PAUSED');
  });
  it('latches AND dwell and resets on missing funding', async () => {
    const h = await harness(); const id = await h.task(); await h.manager.tick();
    expect(readManagedState(h.db, id)?.conditionSince).not.toBeNull();
    h.missingFunding(true); vi.setSystemTime(Date.now() + 3000); await h.manager.tick();
    expect(readManagedState(h.db, id)?.conditionSince).toBeNull();
    expect(readManagedState(h.db, id)?.reason).toBe(`managed_funding_unavailable:${h.legs[0].symbol}`);
    h.missingFunding(false); await h.manager.tick(); vi.setSystemTime(Date.now() + 2100); await h.manager.tick();
    expect(readManagedState(h.db, id)?.exitRequested).toBe(true);
    h.missingFunding(true); await h.manager.tick(); expect(h.created[0]).toMatchObject({ type: 'LIMIT', time_in_force: 'POC', reduce_only: 'true', qty: '10' });
  });
  it('matches a partial maker fill immediately without waiting for maker cancellation', async () => {
    const h = await harness(); const id = await h.task(); await h.manager.tick(); h.manager.requestExit(id); await h.manager.tick();
    h.ack(1, 'PARTIALLY_FILLED', '3'); h.quantities('97', '100'); await h.manager.tick();
    expect(h.created[1]).toMatchObject({ symbol: h.legs[1].symbol, type: 'MARKET', side: 'BUY', qty: '3', reduce_only: 'true' });
    expect(h.remote.get('remote-1')?.state).toBe('PARTIALLY_FILLED');
  });
  it('uses cancellation start time, not old maker creation time', async () => {
    const h = await harness(); const id = await h.task(); await h.manager.tick(); h.manager.requestExit(id); await h.manager.tick();
    vi.setSystemTime(Date.now() + 6000); await h.manager.tick();
    expect(managedRiskReason(h.db)).toBeNull();
    await h.manager.tick(); await h.manager.tick(); await h.manager.tick();
    expect(managedRiskReason(h.db)).toBeNull(); expect(h.created).toHaveLength(2);
  });
  it('retains market fallback authorization and sends market clips after confirmed cancellation', async () => {
    const h = await harness(); h.config.management!.marketFallback = true;
    const id = await h.task(); await h.manager.tick(); h.manager.requestExit(id); await h.manager.tick();
    vi.setSystemTime(Date.now() + 6000); await h.manager.tick(); await h.manager.tick(); await h.manager.tick(); await h.manager.tick();
    expect(h.created[1]).toMatchObject({ type: 'MARKET', reduce_only: 'true' });
  });
  it('fails closed on ambiguous submission and never replays it', async () => {
    const h = await harness(); await h.task(); h.failSubmit(); h.quantities('100', '80'); await h.manager.tick();
    expect(h.created).toHaveLength(1); expect(h.runtime.listOpenOrders()[0]?.state).toBe('PENDING_SUBMIT');
    await h.manager.tick(); expect(h.created).toHaveLength(1); expect(h.session.current).toBe('readonly');
  });
  it('bounds even a gateway that ignores abort and ignores its late result', async () => {
    const h = await harness(); const id = await h.task(); await h.manager.tick();
    let resolveRead!: (facts: ManagedAccountFacts) => void;
    h.setRead(() => new Promise((resolve) => { resolveRead = resolve; }));
    const tick = h.manager.tick(); await vi.advanceTimersByTimeAsync(8001); await tick;
    expect(managedRiskReason(h.db)).toBe('managed_account_rechecking');
    h.quantities('0', '0'); resolveRead(h.facts()); await Promise.resolve();
    expect(h.runtime.getStrategy(id).status).toBe('RUNNING'); expect(hasManagedClaims(h.db)).toBe(true);
    expect(readManagedState(h.db, id)?.leftQuantity).not.toBe('0');
  });
  it('rejects ordinary orders on claimed symbols and preserves the remaining ownership cap on resume', async () => {
    const h = await harness(); const id = await h.task(); await h.manager.tick(); h.quantities('80', '80'); await h.manager.tick();
    await expect(h.runtime.createOrder({ symbol: h.legs[0].symbol, side: 'BUY', type: 'MARKET', quantity: '1' })).rejects.toMatchObject({ code: 'managed_global_risk_paused' });
    h.quantities('90', '90'); await h.manager.tick(); h.session.set('live');
    await expect(h.manager.resume(id, 'account-1')).rejects.toMatchObject({ code: 'managed_position_increased' });
    expect(managedRiskReason(h.db)).not.toBeNull();
  });
  it('rejects overlapping starts, pre-existing holdings and invalid exit clips', async () => {
    const h = await harness(); const id = await h.task();
    await expect(h.manager.reserve('PAIR-OTHER', h.config, 'account-1')).rejects.toMatchObject({ code: 'managed_position_owned' });
    expect(readManagedState(h.db, id)).toBeDefined();
  });
  it('identifies the missing exit quote without treating it as a satisfied signal', async () => {
    const h = await harness(); const id = await h.task(); await h.manager.tick();
    h.missingQuote(h.legs[1].symbol); await h.manager.waitForIdle(); await h.manager.tick();
    expect(readManagedState(h.db, id)).toMatchObject({ spreadBps: null, fundingAprPct: null,
      conditionSince: null, reason: `managed_quote_unavailable:${h.legs[1].symbol}` });
  });
  it('does not adopt existing positions during launch', async () => {
    const h = await harness(); h.quantities('10', '10');
    await expect(h.task()).rejects.toMatchObject({ code: 'managed_existing_position' });
    expect(hasManagedClaims(h.db)).toBe(false);
  });
  it('rejects an untradeable exit clip before accepting the task', async () => {
    const h = await harness(); h.config.management!.perOrderQuantity = '0.5';
    await expect(h.task()).rejects.toMatchObject({ code: 'managed_order_below_minimum_size' });
    expect(hasManagedClaims(h.db)).toBe(false);
  });
  it('ignores duplicate and older position events', async () => {
    const h = await harness(); await h.task(); await h.manager.tick();
    const snapshotReads = vi.spyOn(h.sources, 'account');
    h.manager.notifyPosition({ symbol: h.legs[0].symbol, position_qty: '100', update_time: String(Date.now()) });
    await vi.advanceTimersByTimeAsync(150);
    const reads = snapshotReads.mock.calls.length;
    h.manager.notifyPosition({ symbol: h.legs[0].symbol, position_qty: '0', update_time: String(Date.now() - 1000) });
    await vi.advanceTimersByTimeAsync(150);
    expect(snapshotReads.mock.calls).toHaveLength(reads); expect(h.created).toHaveLength(0);
  });
  it('wakes again and requires two matching reads after a position event invalidates an in-flight read', async () => {
    const h = await harness(); await h.task(); await h.manager.tick();
    let resolveRead!: (facts: ManagedAccountFacts) => void;
    h.setRead(() => new Promise((resolve) => { resolveRead = resolve; })); const tick = h.manager.tick();
    h.manager.notifyPosition({ symbol: h.legs[1].symbol, position_qty: '100', update_time: String(Date.now()) });
    h.setRead(null); resolveRead(h.facts()); await tick; await vi.advanceTimersByTimeAsync(200);
    expect(h.created).toHaveLength(0); expect(managedRiskReason(h.db)).toBe('managed_account_rechecking');
    await h.manager.tick(); expect(managedRiskReason(h.db)).toBeNull(); expect(h.created).toHaveLength(0);
  });
  it('does not clear the recovery lock for an unexplained external reduction', async () => {
    const h = await harness(); const id = await h.task(); await h.manager.tick();
    h.unavailable(); await h.manager.tick(); h.unavailable(false); h.quantities('100', '80');
    vi.setSystemTime(Date.now() + 2000); await h.manager.tick();
    expect(managedRiskReason(h.db)).toBe('managed_external_reduction');
    expect(h.runtime.getStrategy(id).status).toBe('PAUSED'); expect(h.created).toHaveLength(0);
  });
  it('waits for a known partial margin batch then recovers only after terminal facts', async () => {
    const h = await harness(); const id = await h.task(); await h.manager.tick(); h.missingFunding(true);
    const order = await h.runtime.createOrder({ symbol: h.legs[0].symbol, side: 'SELL', type: 'MARKET', quantity: '10', reduceOnly: true },
      { strategyId: id, strategyLeg: 'left', strategyClip: 'margin:recovery-batch', feePhase: 'adjustment' });
    h.db.prepare("UPDATE managed_positions SET state_json=json_set(state_json,'$.phase','BALANCING','$.pendingOrderId',?,'$.marginBatch',json(?)) WHERE strategy_id=?")
      .run(order.id, JSON.stringify({ version: 2, id: 'recovery-batch', before: '100', quantity: '10', firstLeg: 0, incidentId: 'synthetic' }), id);
    h.ack(1, 'PARTIALLY_FILLED', '2'); h.quantities('98', '100'); h.unavailable(); await h.manager.tick();
    h.unavailable(false); vi.setSystemTime(Date.now() + 2000); await h.manager.tick();
    expect(managedRiskReason(h.db)).toBe('managed_account_rechecking');
    expect(h.runtime.getStrategy(id).status).toBe('RUNNING'); expect(h.created).toHaveLength(1);
    h.ack(1, 'CANCELLED', '2'); await h.manager.tick(); await h.manager.tick();
    expect(managedRiskReason(h.db)).toBeNull(); await h.manager.tick();
    expect(h.created[1]).toMatchObject({ side: 'BUY', qty: '2', reduce_only: 'true' });
  });
  it('does not confuse an old own maker with a foreign order after 100 unrelated orders', async () => {
    const h = await harness(); const id = await h.task(); await h.manager.tick(); h.manager.requestExit(id); await h.manager.tick();
    for (let i = 0; i < 101; i++) await h.runtime.createOrder({ symbol: 'BYBIT_FUTURE_ETH_USDT', side: 'BUY', type: 'MARKET', quantity: '1' });
    await h.manager.tick(); expect(managedRiskReason(h.db)).toBeNull();
  });
  it('checks live permission again after credential await', async () => {
    const h = await harness(); await h.task();
    const original = h.vault.get.bind(h.vault);
    vi.spyOn(h.vault, 'get').mockImplementation(async (...args) => { h.session.set('readonly'); return original(...args); });
    await expect(h.runtime.createOrder({ symbol: 'BYBIT_FUTURE_ETH_USDT', side: 'BUY', type: 'MARKET', quantity: '1' })).rejects.toMatchObject({ code: 'live_trading_locked' });
    expect(h.created).toHaveLength(0);
  });
  it('preserves exit intent when monitoring is reconstructed', async () => {
    const h = await harness(); const id = await h.task(); await h.manager.tick(); h.manager.requestExit(id);
    await h.manager.stop();
    const restored = new ManagedPositionManager(h.db, h.session, h.runtime, { market: () => null }, h.sources); managers.push(restored);
    expect(readManagedState(h.db, id)).toMatchObject({ exitRequested: true, conditionSince: null });
    h.session.set('readonly'); await restored.tick(); expect(h.created).toHaveLength(0);
  });
  it('resolves premium hedge symbols accurately', async () => {
    const h = await harness();
    expect(managedLegs({ ...h.config, kind: 'premium', asset: 'SKHY', hedgeAsset: 'SKHYNIX', rightVenue: 'HYPERLIQUID' })[1].symbol).toBe('HYPERLIQUID_FUTURE_SKHX_USDC');
  });
  it('clears only orphan launch reservations without order or strategy evidence', async () => {
    const h = await harness();
    h.db.prepare('INSERT INTO managed_position_claims VALUES (?, ?, ?)').run('account-1', 'ORPHAN', 'PAIR-ORPHAN');
    const restored = new ManagedPositionManager(h.db, h.session, h.runtime, { market: () => null }, h.sources); managers.push(restored);
    expect(hasManagedClaims(h.db)).toBe(false);
  });
  it('does not silently expand too-small reductions into an exposure-increasing order', async () => {
    const h = await harness(); const id = await h.task(); await h.manager.tick();
    h.db.prepare("UPDATE crossex_instruments SET min_size = '5'").run();
    h.quantities('100', '99'); await h.manager.tick();
    expect(h.created).toHaveLength(0);
    expect(readManagedState(h.db, id)?.phase).toBe('RISK_PAUSED');
  });
  it('requires all other claimed tasks to be balanced before clearing the global risk lock', async () => {
    const h = await harness(); const id = await h.task(); await h.manager.tick();
    const other = 'PAIR-OTHER';
    h.db.prepare(`INSERT INTO execution_strategies (id, kind, environment, status, config_json, progress, filled_quantity, filled_left, filled_right, open_position, credential_profile_id, created_at, updated_at)
      SELECT ?, kind, environment, status, config_json, progress, filled_quantity, filled_left, filled_right, open_position, credential_profile_id, created_at, updated_at FROM execution_strategies WHERE id = ?`).run(other, id);
    const otherConfig = { ...h.config, asset: 'ETH' }, otherLegs = managedLegs(otherConfig);
    h.db.prepare('UPDATE execution_strategies SET config_json = ? WHERE id = ?').run(JSON.stringify(otherConfig), other);
    h.db.prepare('INSERT INTO managed_positions VALUES (?, ?, ?, ?)').run(other, 'account-1', JSON.stringify({
      ...readManagedState(h.db, id)!, groupId: other, phase: 'MONITORING' }), new Date().toISOString());
    for (const leg of otherLegs) h.db.prepare('INSERT INTO managed_position_claims VALUES (?, ?, ?)').run('account-1', leg.symbol, other);
    h.setRead(async () => ({ ...h.facts(), positions: [...h.facts().positions,
      { symbol: otherLegs[0].symbol, position_side: 'LONG', position_qty: '100' } as GateCrossExPosition,
      { symbol: otherLegs[1].symbol, position_side: 'SHORT', position_qty: '80' } as GateCrossExPosition] }));
    h.manager.failAll('synthetic multi-task incident'); h.session.set('live');
    await expect(h.manager.resume(id, 'account-1')).rejects.toMatchObject({ code: 'managed_other_task_unbalanced' });
    expect(managedRiskReason(h.db)).not.toBeNull();
  });
  it('keeps pause state and claims when stop is requested without restored permission', async () => {
    const h = await harness(); const id = await h.task(); h.manager.failAll('test pause');
    expect(() => h.manager.requestExit(id)).toThrow('managed_review_required');
    expect(hasManagedClaims(h.db)).toBe(true);
  });
  it('supports confirmed partial protective fills without replaying the original size', async () => {
    const h = await harness(); const id = await h.task(); h.quantities('100', '80'); await h.manager.tick();
    h.ack(1, 'CANCELLED', '7'); h.quantities('93', '80'); await h.manager.tick(); await h.manager.tick();
    expect(h.created.map((o) => o.qty)).toEqual(['20', '13']);
    expect(readManagedState(h.db, id)?.phase).toBe('BALANCING');
  });
  it('rejects a stale concurrent resume instead of overwriting a new exit intent', async () => {
    const h = await harness(); const id = await h.task(); await h.manager.tick(); h.manager.failAll('test pause'); h.session.set('live');
    const resolves: Array<(facts: ManagedAccountFacts) => void> = [];
    h.setRead(() => new Promise((resolve) => { resolves.push(resolve); }));
    const first = h.manager.resume(id, 'account-1');
    const second = h.manager.resume(id, 'account-1');
    resolves[0](h.facts()); await first; h.manager.requestExit(id);
    resolves[1](h.facts()); await expect(second).rejects.toMatchObject({ code: 'strategy_not_paused' });
    expect(readManagedState(h.db, id)?.exitRequested).toBe(true);
  });
  it('blocks new orders when a locally terminal maker remains open remotely', async () => {
    const h = await harness(); const id = await h.task(); await h.manager.tick(); h.manager.requestExit(id); await h.manager.tick();
    h.ack(1, 'CANCELLED', '0');
    h.remote.set('remote-1', { ...h.remote.get('remote-1')!, state: 'OPEN' });
    await h.manager.tick(); expect(managedRiskReason(h.db)).toBe('managed_order_state_conflict');
    expect(h.created).toHaveLength(1);
  });
  it('rolls back risk unlock if restoring the task state fails', async () => {
    const h = await harness(); const id = await h.task(); await h.manager.tick(); h.manager.failAll('test pause'); h.session.set('live');
    h.db.exec("CREATE TRIGGER prevent_managed_restore BEFORE UPDATE ON managed_positions BEGIN SELECT RAISE(ABORT, 'synthetic disk failure'); END");
    await expect(h.manager.resume(id, 'account-1')).rejects.toThrow('synthetic disk failure');
    expect(managedRiskReason(h.db)).toBe('test pause'); expect(h.runtime.getStrategy(id).status).toBe('PAUSED');
  });
  it('does not enlarge a protective reduction or misreport dust when its required price is missing', async () => {
    const h = await harness(); const id = await h.task(); await h.manager.tick();
    h.db.prepare("UPDATE crossex_instruments SET min_notional='1'").run();
    h.missingQuote(h.legs[0].symbol); h.quantities('100', '80'); await h.manager.tick();
    expect(h.created).toHaveLength(0); expect(h.session.current).toBe('readonly');
    expect(readManagedState(h.db, id)?.reason).toContain('managed_market_data_unavailable');
    expect(readManagedState(h.db, id)?.reason).toContain(h.legs[0].symbol);
    expect(readManagedState(h.db, id)?.reason).not.toContain('dust');
  });
  it('waits for missing exit-maker quotes without submitting or changing the configured batch', async () => {
    const h = await harness(); const id = await h.task(); await h.manager.tick(); h.manager.requestExit(id);
    h.missingQuote(h.legs[0].symbol); await h.manager.tick();
    expect(h.created).toHaveLength(0); expect(managedRiskReason(h.db)).toBeNull();
    expect(readManagedState(h.db, id)?.exitRequested).toBe(true);
    expect(readManagedState(h.db, id)?.reason).toBe(`managed_exit_quote_unavailable:${h.legs[0].symbol}`);
  });
  it('does not place an exit maker when the opposite leg has no quote even without a notional minimum', async () => {
    const h = await harness('ZHIPU'); const id = await h.task(); await h.manager.tick(); h.manager.requestExit(id);
    h.missingQuote(h.legs[1].symbol); await h.manager.waitForIdle(); await h.manager.tick();
    expect(h.created).toHaveLength(0); expect(managedRiskReason(h.db)).toBeNull();
    expect(readManagedState(h.db, id)?.reason).toBe(`managed_exit_quote_unavailable:${h.legs[1].symbol}`);
  });
  it.each(['0', '0.65'])('cancels the resting maker on hedge quote loss with %s filled before further action', async filled => {
    const h = await harness('ZHIPU'); const id = await h.task(); await h.manager.tick(); h.manager.requestExit(id);
    await h.manager.tick(); expect(h.created).toHaveLength(1);
    h.ack(1, 'OPEN', filled); h.quantities(filled === '0' ? '100' : '99.35', '100');
    h.missingQuote(h.legs[1].symbol); await h.manager.waitForIdle(); await h.manager.tick();
    expect(h.remote.get('remote-1')?.state).toBe('CANCELLED');
    expect(h.created).toHaveLength(1); expect(managedRiskReason(h.db)).toBeNull();
    await h.manager.tick(); // terminal cancellation is reconciled before a new account snapshot
    expect(h.created).toHaveLength(1);
    await h.manager.tick();
    expect(h.created).toHaveLength(1);
    await h.manager.tick(); // cancel request, terminal confirmation, then fresh post-cancel facts
    if (filled !== '0') expect(readManagedState(h.db, id)?.phase).toBe('RISK_PAUSED');
  });
  it.each([false, true])('rechecks both exit legs after awaited credentials (market fallback=%s)', async fallback => {
    const h = await harness('ZHIPU'); h.config.management!.marketFallback = fallback;
    const id = await h.task(); await h.manager.tick(); h.manager.requestExit(id);
    if (fallback) {
      await h.manager.tick();
      vi.setSystemTime(Date.now() + 6000);
      await h.manager.tick(); await h.manager.tick(); await h.manager.tick();
      expect(readManagedState(h.db, id)?.fallback).toBe(true);
      expect(readManagedState(h.db, id)?.makerOrderId).toBeNull();
    }
    const before = h.created.length;
    vi.spyOn(h.vault, 'get').mockImplementationOnce(async () => {
      await Promise.resolve(); h.missingQuote(h.legs[1].symbol);
      return { apiKey: 'fake', apiSecret: 'fake' };
    });
    await h.manager.tick();
    expect(h.created).toHaveLength(before);
    expect(h.runtime.listOrders()).toHaveLength(before);
    expect(readManagedState(h.db, id)?.phase).toBe('RISK_PAUSED');
  });
  it('publishes PAUSED consistently and reconciles confirmed cancellation without unlocking risk', async () => {
    const h = await harness('ZHIPU'); const id = await h.task(); await h.manager.tick(); h.manager.requestExit(id);
    await h.manager.tick();
    const states: string[] = [];
    const unsubscribe = h.runtime.subscribe(event => { if (event.type === 'strategy.update') states.push((event.payload as { status: string }).status); });
    h.manager.failAll('synthetic quote loss');
    expect(states).toEqual(['PAUSED']);
    expect(readManagedState(h.db, id)?.pendingOrderIds).toHaveLength(1);
    h.ack(1, 'CANCELLED', '0.65');
    expect(readManagedState(h.db, id)).toMatchObject({ phase: 'RISK_PAUSED', makerOrderId: null, pendingOrderIds: [], exitRequested: true });
    expect(managedRiskReason(h.db)).toBe('synthetic quote loss');
    expect(h.session.current).toBe('readonly');
    unsubscribe();
  });
  it('clears economic-signal warnings when manual exit begins and after verified completion', async () => {
    const h = await harness(); const id = await h.task(); await h.manager.tick();
    h.missingQuote(h.legs[1].symbol); await h.manager.waitForIdle(); await h.manager.tick();
    expect(readManagedState(h.db, id)?.signalReason).toContain('managed_quote_unavailable');
    h.manager.beginStop(id, true); await h.manager.finishStop(id);
    expect(readManagedState(h.db, id)).toMatchObject({ reason: 'manual_exit', signalReason: null, signalMissingSince: null });
    h.quantities('0', '0'); await h.manager.tick();
    expect(readManagedState(h.db, id)).toMatchObject({ phase: 'RISK_PAUSED', reason: 'managed_external_reduction', signalReason: null });
    expect(h.created).toHaveLength(0);
  });
});
