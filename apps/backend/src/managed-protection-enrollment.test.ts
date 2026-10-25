import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolve } from 'node:path';
import { Decimal } from 'decimal.js';
import { openDatabase } from './database.js';
import { TradingSession } from './trading-session.js';
import { MemoryCredentialVault, DEFAULT_CREDENTIAL_PROFILE } from './credential-vault.js';
import { TradingRuntime, CreateStrategyInputSchema, isTerminalOrderState } from './trading-runtime.js';
import { ManagedPositionManager, managedLegs } from './managed-position-manager.js';
import { readManagedState, writeManagedState, managedRiskReason } from './managed-position-store.js';
import { MarginRiskStore } from './margin-risk-store.js';
import { MarginRiskMonitor } from './margin-risk-monitor.js';
import { ProtectionAuthority } from './protection-authority.js';
import type { GateCrossExOrder, GateCrossExPosition, TradingCrossExGateway, CrossExOrderRequest } from './crossex-client.js';
import type { LiveMarket } from './market-hub.js';

const cleanups: Array<() => Promise<void>> = [];
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-25T00:00:00Z')); });
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); vi.useRealTimers(); });

async function setup() {
  const db = openDatabase(':memory:', resolve('../../migrations'));
  const session = new TradingSession(); session.set('live');
  const vault = new MemoryCredentialVault(); await vault.set(DEFAULT_CREDENTIAL_PROFILE, { apiKey: 'fake', apiSecret: 'fake' });
  const submitted: CrossExOrderRequest[] = [], remote = new Map<string, GateCrossExOrder>();
  const gateway = {
    async createOrder(_credentials: unknown, input: CrossExOrderRequest, guard?: () => void) {
      guard?.(); submitted.push(input); const id = `remote-${submitted.length}`;
      remote.set(id, { ...input, order_id: id, state: 'OPEN', executed_qty: '0', executed_avg_price: '100',
        update_time: String(Date.now()), reason: '' } as GateCrossExOrder); return { order_id: id };
    },
    async queryOrder(_credentials: unknown, id: string) { return remote.get(id)!; },
    async cancelOrder(_credentials: unknown, id: string) { remote.set(id, { ...remote.get(id)!, state: 'CANCELLED' }); return { order_id: id }; },
  } as unknown as TradingCrossExGateway;
  const runtime = new TradingRuntime(db, session, vault, gateway);
  let positions: GateCrossExPosition[] = [], profile = 'profile', balance = '240';
  const manager = new ManagedPositionManager(db, session, runtime, { market: symbol => ({ symbol,
    source: 'gate_crossex_websocket', bidPrice: '100', askPrice: '101', updatedAt: new Date().toISOString(),
    receivedAt: new Date().toISOString() } as LiveMarket) }, {
    activeAccount: () => profile, account: async () => ({ positions, openOrders: [...remote.values()].filter(o => !isTerminalOrderState(o.state)) }),
    funding: () => ({ rate8h: '0', fetchedAt: Date.now() }), refreshFunding: async () => undefined, riskPause: vi.fn(),
  });
  const monitor = new MarginRiskMonitor(new MarginRiskStore(db), {
    context: () => profile, live: () => session.liveTradingEnabled, uncovered: () => [],
    account: async () => ({ profileId: profile, label: 'Synthetic', userId: 'synthetic', account: {
      user_id: 'synthetic', available_margin: balance, margin_balance: balance, initial_margin: '10', maintenance_margin: '100',
      initial_margin_rate: new Decimal(balance).div(10).toString(), maintenance_margin_rate: new Decimal(balance).div(100).toString(),
      assets: [], account_mode: 'CROSS_EXCHANGE', exchange_type: 'CROSSEX', position_mode: 'SINGLE', update_time: String(Date.now()),
    } }),
    groups: () => runtime.listStrategies().filter(r => r.config.management && !['TRANSFERRED', 'COMPLETED'].includes(r.management!.phase))
      .map(r => ({ id: r.management?.groupId ?? r.id, strategyId: r.id, asset: r.config.asset, phase: r.management!.phase,
        eligible: r.status === 'RUNNING' || manager.protection.owns(r.id), authorized: false, reason: null })),
    protectionEnabled: id => manager.protection.owns(id), protectionReady: id => manager.protection.ready(id) && !runtime.listOpenOrders().length,
    normalRecoveryAuthority: () => manager.normalMarginRecoveryAuthority(), settlementReady: () => true,
    proposal: () => ({ quantity: '10', target: '10', initial: '1', maintenance: '10', firstLeg: 0, apr: '0',
      approximate: true, parametersValidUntil: Date.now() + 60000 }),
  });
  manager.setMarginMonitor(monitor); await monitor.refresh();
  cleanups.push(async () => { await manager.stop(); await monitor.stop(); db.close(); });
  function config(asset = 'BTC', adoptExisting = false) {
    const value = CreateStrategyInputSchema.parse({ kind: 'position', asset, leftVenue: 'BINANCE', rightVenue: 'OKX', leftSide: 'BUY',
      rightSide: 'SELL', entryBps: '0', totalAmount: '100', perOrderQuantity: '10', executionMethod: 'TAKER_TAKER',
      management: { adoptExisting, perOrderQuantity: '10', durationSeconds: 60, intervalSeconds: 0, makerWaitSeconds: 5 } });
    for (const leg of managedLegs(value)) db.prepare(`INSERT OR IGNORE INTO crossex_instruments
      (symbol,exchange_type,business_type,state,min_size,lot_size,tick_size,max_num_orders,default_leverage,delist_time,fetched_at)
      VALUES (?,?,'FUTURE','live','1','1','0.01','100','1','0',?)`).run(leg.symbol, leg.symbol.split('_')[0], new Date().toISOString());
    return value;
  }
  function initialize(id: string, value: ReturnType<typeof config>) {
    db.transaction(() => {
      db.prepare(`INSERT INTO execution_strategies (id,kind,environment,status,config_json,progress,filled_quantity,filled_left,filled_right,
        open_position,credential_profile_id,created_at,updated_at) VALUES (?,'position','live','RUNNING',?,0,'0','0','0','0',?,?,?)`)
        .run(id, JSON.stringify(value), profile, new Date().toISOString(), new Date().toISOString());
      manager.initialize(id, profile);
    })();
  }
  async function launch(id: string, asset = 'BTC', adoptExisting = false) {
    const value = config(asset, adoptExisting); await manager.reserve(id, value, profile); initialize(id, value); return value;
  }
  function holdings(value: ReturnType<typeof config>, left: string, right: string) {
    const legs = managedLegs(value), symbols = new Set(legs.map(l => l.symbol));
    positions = [...positions.filter(p => !symbols.has(p.symbol)), ...legs.flatMap((l, i) => new Decimal(i ? right : left).isZero() ? [] : [{
      symbol: l.symbol, position_side: l.side === 'BUY' ? 'LONG' : 'SHORT', position_qty: i ? right : left, margin_mode: 'CROSS',
    } as GateCrossExPosition])];
  }
  async function filled(id: string, value: ReturnType<typeof config>, left: string, right: string) {
    for (const [i, leg] of managedLegs(value).entries()) {
      const qty = i ? right : left; if (new Decimal(qty).isZero()) continue;
      const order = await runtime.createOrder({ symbol: leg.symbol, side: leg.side, type: 'MARKET', quantity: qty },
        { strategyId: id, strategyLeg: i ? 'right' : 'left', feePhase: 'entry' });
      const update = { ...remote.get(order.remoteOrderId!)!, state: 'FILLED', executed_qty: qty, update_time: String(Date.now()) };
      remote.set(order.remoteOrderId!, update); runtime.ingestPrivateEvent({ channel: 'order', payload: update });
    }
    holdings(value, left, right);
  }
  async function ticks(count = 4) { for (let i = 0; i < count; i++) { await vi.advanceTimersByTimeAsync(1100); await manager.tick(); } }
  return { db, session, runtime, manager, monitor, submitted, remote, config, initialize, launch, holdings, filled, ticks,
    changeProfile: () => { profile = 'other-profile'; }, low: () => { balance = '149'; } };
}

describe('atomic launch enrollment into continuous protection', () => {
  it('rejects a mismatched launch profile as a conflict and releases its reservation', async () => {
    const h = await setup();
    await expect(h.manager.reserve('new', h.config(), 'other-profile')).rejects.toMatchObject({ code: 'protection_launch_permission_changed', statusCode: 409 });
    expect(h.db.prepare('SELECT count(*) n FROM managed_position_reservations').get()).toEqual({ n: 0 });
    expect(h.submitted).toHaveLength(0);
  });
  it('registers both scopes before any order and leaves zero holdings pending without starving live entry', async () => {
    const h = await setup(); await h.launch('new');
    expect(h.monitor.snapshot().policy.protectedGroupIds).toContain('new');
    expect(h.manager.protection.authority.grant()).toMatchObject({ enabled: true, groupIds: ['new'] });
    expect(h.submitted).toHaveLength(0); expect(h.manager.protection.needsTick()).toBe(false);
    expect(h.manager.protection.view().groups).toEqual([expect.objectContaining({ strategyId: 'new', state: 'RECONCILING', reason: 'protection_entry_in_progress' })]);
    h.manager.failAll('synthetic hard pause'); await h.ticks();
    expect(h.session.current).toBe('protect_only'); expect(h.submitted).toHaveLength(0);
    expect(h.manager.protection.view().groups[0]).toMatchObject({ state: 'RECONCILING', reason: 'protection_holdings_pending' });
    expect(h.runtime.getStrategy('new').status).toBe('PAUSED');
  });
  it('automatically watches verified holdings, survives restart without ordinary live authority, and honors KEEP', async () => {
    const h = await setup(), config = await h.launch('new'); await h.filled('new', config, '10', '10');
    h.manager.handoff('new', '10'); await h.manager.tick();
    expect(h.manager.protection.view().groups[0].state).toBe('WATCHING');
    const next = new TradingSession(), restored = new ProtectionAuthority(h.db, next, () => 'profile');
    expect(next.current).toBe('unset'); expect(restored.grant()?.groupIds).toEqual(['new']);
    h.manager.failAll('synthetic hard pause'); await h.ticks();
    expect(h.manager.protection.view().groups[0].state).toBe('WATCHING');
    h.manager.beginStop('new', false); expect(h.manager.protection.owns('new')).toBe(false);
    expect(managedRiskReason(h.db)).toBe('synthetic hard pause');
  });
  it('uses confirmed entry fills rather than target quantity to protect a paused partial first leg', async () => {
    const h = await setup(), config = await h.launch('new'); await h.filled('new', config, '7', '0');
    h.manager.failAll('synthetic entry pause'); await h.ticks(6);
    expect(h.submitted).toHaveLength(2);
    expect(h.submitted[1]).toMatchObject({ qty: '7', side: 'SELL', reduce_only: 'true' });
    expect(h.runtime.getStrategy('new').status).toBe('PAUSED');
    expect(managedRiskReason(h.db)).toBe('synthetic entry pause');
  });
  it('never replays an unknown entry order or treats unexplained holdings as authorized', async () => {
    const h = await setup(), config = await h.launch('new');
    const leg = managedLegs(config)[0];
    await h.runtime.createOrder({ symbol: leg.symbol, side: leg.side, type: 'MARKET', quantity: '7' }, { strategyId: 'new', strategyLeg: 'left' });
    h.manager.failAll('synthetic unknown entry'); h.holdings(config, '7', '0'); await h.ticks(6);
    expect(h.submitted).toHaveLength(1); expect(h.manager.protection.view().state).toBe('BLOCKED');
  });
  it('keeps one stable group across adoption and transfer and does not revive the old controller', async () => {
    const h = await setup(), config = await h.launch('old'); await h.filled('old', config, '10', '10');
    h.manager.handoff('old', '10'); await h.manager.tick(); await h.launch('next', 'BTC', true);
    expect(h.manager.protection.authority.grant()?.groupIds).toEqual(['old']);
    expect(readManagedState(h.db, 'old')?.phase).toBe('TRANSFERRED');
    expect(readManagedState(h.db, 'next')?.groupId).toBe('old');
    expect(h.manager.protection.owns('old')).toBe(false); expect(h.manager.protection.owns('next')).toBe(true);
  });
  it.each(['revocation', 'scope', 'account', 'readonly', 'storage'])('rolls back the entire launch after %s changes during preparation', async kind => {
    const h = await setup(), config = h.config(); await h.manager.reserve('new', config, 'profile');
    const before = h.monitor.snapshot().policy;
    if (kind === 'revocation') h.manager.protection.authority.revoke();
    if (kind === 'scope') h.manager.protection.authority.configure(h.monitor.snapshot().accountId!, ['unrelated'], 0, true);
    if (kind === 'account') h.changeProfile();
    if (kind === 'readonly') { h.session.set('readonly'); h.session.set('live'); }
    if (kind === 'storage') h.db.exec("CREATE TRIGGER fail_enrollment BEFORE INSERT ON continuous_protection_authority BEGIN SELECT RAISE(ABORT,'synthetic enrollment failure'); END");
    expect(() => h.initialize('new', config)).toThrow();
    expect(readManagedState(h.db, 'new')).toBeUndefined();
    expect(h.db.prepare('SELECT count(*) n FROM execution_strategies WHERE id=?').get('new')).toEqual({ n: 0 });
    expect(h.db.prepare('SELECT count(*) n FROM managed_position_claims WHERE strategy_id=?').get('new')).toEqual({ n: 0 });
    expect(h.monitor.snapshot().policy).toEqual(before); expect(h.submitted).toHaveLength(0);
    h.manager.abortReservation('new');
  });
  it('a new explicit launch enrolls only its own group after revocation, never old unrelated groups', async () => {
    const h = await setup(); await h.launch('old'); h.manager.protection.authority.revoke(); await h.launch('new', 'ETH');
    expect(h.manager.protection.authority.grant()?.groupIds).toEqual(['new']);
    expect(h.manager.protection.owns('old')).toBe(false);
    const state = readManagedState(h.db, 'new')!;
    writeManagedState(h.db, 'new', { ...state, phase: 'COMPLETED' });
    expect(h.manager.protection.records()).toHaveLength(0);
  });
  it('restores the donor and its claims when enrollment fails during transfer', async () => {
    const h = await setup(), original = await h.launch('old'); await h.filled('old', original, '10', '10');
    h.manager.handoff('old', '10'); await h.manager.tick(); h.manager.protection.authority.revoke();
    const before = readManagedState(h.db, 'old'), config = h.config('BTC', true);
    await h.manager.reserve('next', config, 'profile');
    h.db.exec("CREATE TRIGGER fail_transfer BEFORE INSERT ON continuous_protection_authority BEGIN SELECT RAISE(ABORT,'synthetic enrollment failure'); END");
    expect(() => h.initialize('next', config)).toThrow('synthetic enrollment failure');
    expect(readManagedState(h.db, 'old')).toEqual(before);
    expect(h.runtime.getStrategy('old').status).toBe('RUNNING');
    expect(h.db.prepare('SELECT DISTINCT strategy_id id FROM managed_position_claims').all()).toEqual([{ id: 'old' }]);
    expect(readManagedState(h.db, 'next')).toBeUndefined();
    h.manager.abortReservation('next');
  });
  it('captures revocation before awaiting an initial margin read', async () => {
    const h = await setup(), config = h.config(); vi.setSystemTime(Date.now() + 6000);
    const account = h.monitor.sources.account;
    h.monitor.sources.account = async signal => { h.manager.protection.authority.revoke(); return account(signal); };
    await h.manager.reserve('new', config, 'profile');
    expect(() => h.initialize('new', config)).toThrow('protection_launch_permission_changed');
    expect(readManagedState(h.db, 'new')).toBeUndefined(); expect(h.submitted).toHaveLength(0);
    h.manager.abortReservation('new');
  });
  it('does not depend on notifications and exposes older uncovered groups without granting them', async () => {
    const h = await setup(); await h.launch('old'); h.manager.protection.authority.revoke();
    h.monitor.savePolicy({ ...h.monitor.snapshot().policy, notificationsEnabled: false });
    await h.launch('new', 'ETH');
    expect(h.monitor.snapshot().policy.notificationsEnabled).toBe(false);
    expect(h.manager.protection.view().coverage).toEqual([
      { groupId: 'old', strategyId: 'old', enrolled: false, reason: 'protection_group_not_enrolled' },
      { groupId: 'new', strategyId: 'new', enrolled: true, reason: null },
    ]);
    h.manager.protection.needsTick(); expect(h.manager.protection.owns('old')).toBe(false);
  });
  it('invalidates queued capabilities on membership changes without deleting existing fill responsibility', async () => {
    const h = await setup(), config = await h.launch('old'); await h.filled('old', config, '7', '0');
    const input = { symbol: managedLegs(config)[0].symbol, side: 'SELL', type: 'MARKET', quantity: '7', reduceOnly: true };
    const token = h.manager.protection.authority.issue(input, 'old', () => undefined, Date.now() + 5000);
    await h.launch('new', 'ETH');
    expect(() => h.manager.protection.authority.validate(token, input, 'old')).toThrow('protection_permission_changed');
    h.manager.failAll('synthetic pause after enrollment'); await h.ticks(6);
    expect(h.submitted).toHaveLength(2); expect(h.submitted[1]).toMatchObject({ qty: '7', reduce_only: 'true' });
    expect(h.runtime.getStrategy('old').status).toBe('PAUSED');
  });
  it('discloses an intentional KEEP without pretending the remaining verified groups are reconciling', async () => {
    const h = await setup(), first = await h.launch('kept'); await h.filled('kept', first, '10', '10');
    h.manager.handoff('kept', '10'); await h.manager.tick();
    const second = await h.launch('watching', 'ETH'); await h.filled('watching', second, '10', '10');
    h.manager.handoff('watching', '10'); await h.manager.tick(); h.manager.beginStop('kept', false);
    const view = h.manager.protection.view();
    expect(view.coverage).toContainEqual({ groupId: 'kept', strategyId: 'kept', enrolled: false, reason: 'protection_keep' });
    expect(view.groups).toEqual([expect.objectContaining({ strategyId: 'watching', state: 'WATCHING' })]);
    expect(view.state).toBe('WATCHING');
  });
});
