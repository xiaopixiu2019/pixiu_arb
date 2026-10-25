import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolve } from 'node:path';
import { openDatabase } from './database.js';
import { MarginRiskStore } from './margin-risk-store.js';
import { MarginRiskMonitor, type MarginAccountRead } from './margin-risk-monitor.js';

const databases: ReturnType<typeof openDatabase>[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
function harness() {
  const db = openDatabase(':memory:', resolve('../../migrations')); databases.push(db);
  let now = 1_800_000_000_000, context = 'profile:1', fail = false, balance = 120;
  let pending: Promise<MarginAccountRead> | null = null;
  const account = (): MarginAccountRead => ({ profileId: 'profile', userId: 'synthetic-uid', label: 'Test', account: {
    margin_balance: String(balance), available_margin: String(balance - 100), initial_margin: '100', maintenance_margin: '10',
    initial_margin_rate: String(balance / 100), maintenance_margin_rate: String(balance / 10), assets: [],
    account_mode: 'CROSS_EXCHANGE', exchange_type: 'CROSSEX', position_mode: 'SINGLE', update_time: String(now),
  } });
  const store = new MarginRiskStore(db);
  const monitor = new MarginRiskMonitor(store, { now: () => now, context: () => context, live: () => false,
    reviewReady: () => true, settlementReady: () => true,
    groups: () => [], uncovered: () => [], account: async () => { if (fail) throw new Error('test outage'); return pending ?? account(); } });
  return { db, store, monitor, account, advance: (ms: number) => { now += ms; }, balance: (n: number) => { balance = n; },
    fail: () => { fail = true; }, changeContext: () => { context = 'profile:2'; }, pending: (p: Promise<MarginAccountRead> | null) => { pending = p; } };
}

it('does not generate group plans when no margin incident exists and still evaluates a later incident',async()=>{
  const h=harness();await h.monitor.refresh();
  const record={id:'s',config:{management:{perOrderQuantity:'10'}},management:{leftQuantity:'10'}} as unknown as Parameters<typeof h.monitor.planBatch>[0];
  const groups=vi.spyOn(h.monitor.sources,'groups');
  expect(h.monitor.planBatch(record,[],[record],'1',null)).toBeNull();expect(groups).not.toHaveBeenCalled();
  h.monitor.sources.live=()=>true;h.balance(50);h.advance(2000);await h.monitor.refresh();groups.mockClear();
  expect(h.monitor.planBatch(record,[],[record],'1',null)).toBeNull();expect(groups).toHaveBeenCalled();
});
describe('normal margin recovery authority', () => {
  function automatic(h: ReturnType<typeof harness>) {
    h.monitor.sources.live = () => true;
    h.monitor.sources.groups = () => [{ id: 'g', strategyId: 's', asset: 'TEST', phase: 'MONITORING', eligible: true, authorized: true, reason: null }];
    Object.assign(h.monitor.sources, { normalRecoveryAuthority: () => 'same-process-control' });
  }
  it('automatically releases only a new live incident after two recovered reads', async () => {
    const h = harness(); automatic(h); await h.monitor.refresh();
    h.balance(104); h.advance(2000); await h.monitor.refresh();
    expect(h.monitor.snapshot().entryBlocked).toBe(true);
    h.balance(200); h.advance(2000); await h.monitor.refresh();
    expect(h.monitor.snapshot().entryBlocked).toBe(true);
    h.advance(2000); await h.monitor.refresh();
    expect(h.monitor.snapshot().incidentId).toBeNull(); expect(h.monitor.snapshot().entryBlocked).toBe(false);
    expect(h.store.events(h.monitor.snapshot().accountId!).some(e => e.kind === 'entry_auto_recovered')).toBe(true);
  });
  it.each(['authority', 'policy', 'blocked', 'old-latch', 'restart', 'revoked-restored', 'blocked-revalidated'])('retains manual review after %s', async cause => {
    const h = harness(); automatic(h); await h.monitor.refresh(); const key = h.monitor.snapshot().accountId!;
    if (cause === 'old-latch') h.store.latch(key, true);
    h.balance(104); h.advance(2000); await h.monitor.refresh();
    if (cause === 'authority') Object.assign(h.monitor.sources, { normalRecoveryAuthority: () => 'changed-control' });
    if (cause === 'policy') h.monitor.savePolicy({ ...h.monitor.snapshot().policy, reminderMinutes: 11 });
    if (cause === 'blocked') h.monitor.blockIncident('synthetic hard fault');
    if (cause === 'revoked-restored') h.monitor.invalidateNormalRecovery();
    if (cause === 'blocked-revalidated') {
      h.monitor.blockIncident('synthetic hard fault');
      h.store.saveIncident(key, { ...h.store.incident(key)!, blocked: null });
    }
    const monitor = cause === 'restart' ? new MarginRiskMonitor(h.store, h.monitor.sources) : h.monitor;
    h.balance(200); h.advance(2000); await monitor.refresh(); h.advance(2000); await monitor.refresh();
    expect(monitor.snapshot().entryBlocked).toBe(true);
  });
  it('resets confirmations after a relapse and handles an MMR-only trigger', async () => {
    const h = harness(); automatic(h); h.balance(200); await h.monitor.refresh();
    h.monitor.savePolicy({ ...h.monitor.snapshot().policy, maintenance: { warn: 1110, reduce: 1100, recover: 1120 } });
    h.balance(109); h.advance(2000); await h.monitor.refresh();
    expect(h.store.incident(h.monitor.snapshot().accountId!)?.cause).toBe('MMR');
    h.balance(120); h.advance(2000); await h.monitor.refresh();
    h.balance(111); h.advance(2000); await h.monitor.refresh();
    h.balance(120); h.advance(2000); await h.monitor.refresh(); expect(h.monitor.snapshot().entryBlocked).toBe(true);
    h.advance(2000); await h.monitor.refresh(); expect(h.monitor.snapshot().entryBlocked).toBe(false);
  });
});

describe('margin monitoring and persisted incidents', () => {
  it('reuses one full snapshot only inside one synchronous entry check', async () => {
    const h = harness(); await h.monitor.refresh();
    const snapshot = vi.spyOn(h.monitor, 'snapshot');
    let escaped!: (initial?: string, maintenance?: string, venue?: string) => void;
    h.monitor.withEntrySnapshot(check => {
      escaped = check.assertEntry;
      check.assertEntry('1', '0.1'); check.assertEntry('2', '0.2');
      expect(check.snapshot.fresh).toBe(true);
    });
    expect(snapshot).toHaveBeenCalledTimes(1);
    expect(() => escaped('1', '0.1')).toThrow('margin_check_expired');
    h.monitor.withEntrySnapshot(check => check.assertEntry('1', '0.1'));
    expect(snapshot).toHaveBeenCalledTimes(2);
  });
  it.each(['time', 'context', 'responsibility'])('rejects a check that changes %s before returning', async cause => {
    const h = harness(); await h.monitor.refresh();
    expect(() => h.monitor.withEntrySnapshot(check => {
      check.assertEntry('1', '0.1');
      if (cause === 'time') h.advance(5001);
      else if (cause === 'context') h.changeContext();
      else h.db.prepare("INSERT INTO audit_events VALUES ('changed','now','synthetic',NULL,'{}')").run();
    })).toThrow(cause === 'time' ? 'margin_data_stale' : 'margin_check_changed');
  });
  it('does not permit an asynchronous entry check or let its escaped guard authorize later', async () => {
    const h = harness(); await h.monitor.refresh();
    let escaped!: () => void;
    expect(() => h.monitor.withEntrySnapshot(async check => { escaped = check.assertEntry; })).toThrow('margin_check_async');
    await Promise.resolve();
    expect(() => escaped()).toThrow('margin_check_expired');
  });
  it('rejects a regressed official response without replacing the last newer account evidence', async () => {
    const h = harness(), older = h.account(); await h.monitor.refresh();
    h.advance(2000); h.balance(130); await h.monitor.refresh(); const newer = h.monitor.snapshot();
    h.pending(Promise.resolve(older)); await h.monitor.refresh();
    expect(h.monitor.snapshot()).toMatchObject({ fresh: false, reason: 'margin_account_version_regressed',
      sampledAt: newer.sampledAt, metrics: { marginBalance: '130', remoteUpdatedAt: newer.metrics!.remoteUpdatedAt } });
    expect(h.monitor.readFailureRequiresReview()).toBe(true);
  });
  it('registers the recovery-sized first batch and never expands an already persisted batch', async () => {
    const h = harness(); h.monitor.sources.live = () => true;
    h.monitor.sources.groups = () => [{ id: 'g', strategyId: 's', asset: 'TEST', phase: 'MONITORING', eligible: true, authorized: false, reason: null }];
    await h.monitor.refresh(); h.monitor.savePolicy({ ...h.monitor.snapshot().policy, protectedGroupIds: ['g'] });
    h.balance(104); h.advance(2000); await h.monitor.refresh();
    h.monitor.sources.proposal = () => ({ quantity: '600', target: '600', initial: '50', maintenance: '5', firstLeg: 0, apr: '0', approximate: true });
    const record = { id: 's', config: { management: { perOrderQuantity: '900' } }, management: { groupId: 'g', leftQuantity: '1800' } } as unknown as Parameters<typeof h.monitor.planBatch>[0];
    expect(h.monitor.planBatch(record, [], [record], '10', null)).toBe('600');
    const key = h.monitor.snapshot().accountId!, batch = h.store.incident(key)!.batch;
    h.monitor.sources.proposal = () => ({ quantity: '900', target: '900', initial: '50', maintenance: '5', firstLeg: 0, apr: '0', approximate: true });
    expect(h.monitor.planBatch(record, [], [record], '10', null)).toBeNull();
    expect(h.store.incident(key)!.batch).toEqual(batch);
  });
  it('registers a launched group before an incident while leaving execution eligibility separate', async () => {
    const h = harness(); h.monitor.sources.live = () => true;
    let phase = 'OPENING';
    h.monitor.sources.groups = () => [{ id: 'stable-group', strategyId: 'new-task', asset: 'TEST', phase,
      eligible: phase === 'MONITORING', authorized: false, reason: null }];
    await h.monitor.refresh(); const policy = h.monitor.snapshot().policy;
    h.monitor.authorizeLaunchedGroup('profile', 'new-task', 'stable-group', h.monitor.captureLaunchAuthorization('profile'));
    expect(h.monitor.snapshot().policy).toEqual({ ...policy, revision: policy.revision + 1, protectedGroupIds: ['stable-group'] });
    expect(h.monitor.snapshot().groups[0]).toMatchObject({ authorized: true, eligible: false });
    h.monitor.authorizeLaunchedGroup('profile', 'new-task', 'stable-group', h.monitor.captureLaunchAuthorization('profile'));
    expect(h.monitor.snapshot().policy.revision).toBe(policy.revision + 1);
    h.balance(104); h.advance(2000); await h.monitor.refresh(); phase = 'MONITORING';
    expect(h.monitor.snapshot().effectivePolicy.protectedGroupIds).toEqual(['stable-group']);
    expect(h.monitor.snapshot().groups[0]).toMatchObject({ authorized: true, eligible: true });
    h.monitor.savePolicy({ ...h.monitor.snapshot().policy, protectedGroupIds: [] });
    h.advance(2000); await h.monitor.refresh();
    expect(h.monitor.snapshot().groups[0].authorized).toBe(false);
    expect(h.monitor.snapshot().effectivePolicy.protectedGroupIds).toEqual(['stable-group']);
  });
  it.each(['profile', 'owner', 'stale', 'context', 'locked', 'incident', 'full'])('rejects invalid launch authority (%s) without changing policy', async cause => {
    const h = harness(); h.monitor.sources.live = () => true;
    h.monitor.sources.groups = () => [{ id: 'g', strategyId: 's', asset: 'TEST', phase: 'OPENING', eligible: false, authorized: false, reason: null }];
    await h.monitor.refresh(); const key = h.monitor.snapshot().accountId!;
    const token = h.monitor.captureLaunchAuthorization('profile');
    if (cause === 'full') h.store.savePolicy(key, { ...h.store.policy(key), protectedGroupIds: Array.from({ length: 100 }, (_, i) => `old-${i}`) });
    if (cause === 'stale') h.advance(5001);
    if (cause === 'context') h.changeContext();
    if (cause === 'locked') h.monitor.sources.live = () => false;
    if (cause === 'incident') { h.balance(104); h.advance(2000); await h.monitor.refresh(); }
    const before = h.store.policy(key);
    expect(() => h.monitor.authorizeLaunchedGroup(cause === 'profile' ? 'other' : 'profile', cause === 'owner' ? 'other' : 's', 'g', cause === 'full' ? h.monitor.captureLaunchAuthorization('profile') : token)).toThrowError(/^margin_/);
    expect(h.store.policy(key)).toEqual(before);
  });
  it('keeps cost reservations across incident completion, store restart and account isolation', async () => {
    const h = harness(); await h.monitor.refresh(); const key = h.monitor.snapshot().accountId!;
    h.store.reserveCost(key, { batchId: 'pending', amount: '15', originalAmount: '15', quantity: '1', legs: [] }, 1);
    h.store.saveIncident(key, null);
    expect(new MarginRiskStore(h.db).reservedCost(key)).toBe('15'); expect(h.store.reservedCost('other')).toBe('0');
    expect(h.monitor.snapshot().metrics?.marginBalance).toBe('120');
    expect(h.monitor.snapshot().costAccounting).toEqual({ pendingBatches: 1, reserved: '15' });
    expect(() => h.monitor.assertEntry()).toThrow('margin_projected_below_warning');
    h.store.latch(key, true); expect(() => h.monitor.resumeEntries()).toThrow('margin_recovery_not_confirmed');
  });
  it('does not freeze an accounted batch on a 60-second fee delay and advances size only after two reads', async () => {
    const h = harness(); await h.monitor.refresh(); h.balance(104); await h.monitor.refresh();
    const key = h.monitor.snapshot().accountId!, incident = h.store.incident(key)!;
    h.store.saveIncident(key, { ...incident, settlement: { quantities: {}, completedAt: h.monitor.snapshot().sampledAt!, remoteAfter: '0', approximate: true, batchId: 'b', strategyId: 's' } });
    h.store.reserveCost(key, { batchId: 'b', quantity: '0.2', amount: '0.4', originalAmount: '0.4', legs: [],
      quantities: {}, completedAt: h.monitor.snapshot().sampledAt!, remoteAfter: '0' }, 1);
    h.monitor.sources.costProof = () => ({ amount: '0.02', settled: false, exceeded: false });
    h.advance(2001); await h.monitor.refresh(); expect(h.store.incident(key)?.completedBatches?.s).toBeUndefined();
    h.advance(26000); await h.monitor.refresh();
    expect(h.store.incident(key)?.blocked).toBeNull(); expect(h.store.incident(key)?.completedBatches?.s).toBe(1);
    expect(h.store.reservedCost(key)).toBe('0.02');
    h.advance(2001); await h.monitor.refresh(); expect(h.store.incident(key)?.completedBatches?.s).toBe(1);
    h.monitor.sources.settlementReady = () => false; await h.monitor.refresh();
    h.monitor.sources.settlementReady = () => true; h.advance(2001); await h.monitor.refresh(); h.advance(2001); await h.monitor.refresh();
    expect(h.store.incident(key)?.completedBatches?.s).toBe(1);
    h.monitor.sources.costProof = () => ({ amount: '0', settled: true, exceeded: false });
    await h.monitor.refresh(); expect(h.store.pendingCosts(key)).toHaveLength(0);
  });
  it('retains a global review lock when proven execution costs exceed the budget', async () => {
    const h = harness(); await h.monitor.refresh(); const key = h.monitor.snapshot().accountId!, fail = vi.fn();
    h.store.reserveCost(key, { batchId: 'b', quantity: '1', amount: '1', originalAmount: '1', legs: [], completedAt: 1, remoteAfter: '0', quantities: {} }, 1);
    h.monitor.sources.costProof = () => ({ amount: '2', settled: false, exceeded: true }); h.monitor.sources.onUnexplainedCost = fail;
    await h.monitor.refresh(); await h.monitor.refresh();
    expect(h.store.incident(key)?.blocked).toBe('margin_execution_cost_exceeded'); expect(h.store.reservedCost(key)).toBe('1');
    expect(fail).toHaveBeenCalledTimes(1); expect(h.monitor.snapshot().entryBlocked).toBe(true);
    h.monitor.sources.costProof = () => ({ amount: '2', settled: true, exceeded: true }); await h.monitor.refresh();
    expect(h.store.reservedCost(key)).toBe('0'); expect(h.store.incident(key)?.blocked).toBe('margin_execution_cost_exceeded');
  });
  it('pins parameter proof before network submission and retains expired responsibilities', async () => {
    const h = harness(); await h.monitor.refresh(); h.balance(104); await h.monitor.refresh();
    h.monitor.sources.live = () => true;
    h.monitor.sources.groups = () => [{ id: 'g', strategyId: 's', asset: 'TEST', phase: 'MONITORING', eligible: true, authorized: true, reason: null }];
    const key = h.monitor.snapshot().accountId!, policy = h.store.policy(key);
    h.store.savePolicy(key, { ...policy, protectedGroupIds: ['g'] });
    const old = h.store.incident(key)!; h.store.saveIncident(key, { ...old, policy: h.store.policy(key) });
    const expiry = h.monitor.snapshot().sampledAt! + 1000;
    h.monitor.sources.proposal = () => ({ quantity: '1', target: '2', initial: '50', maintenance: '5', firstLeg: 0, apr: null, parametersId: 'proof', parametersValidUntil: expiry });
    h.monitor.sources.parametersId = () => 'proof';
    const record = { id: 's', config: { management: { perOrderQuantity: '1' } }, management: { groupId: 'g', leftQuantity: '10' } } as unknown as Parameters<typeof h.monitor.planBatch>[0];
    expect(h.monitor.planBatch(record, [], [record], '0.01', '10')).toBe('1');
    const id = h.store.incident(key)!.batch!.id!;
    expect(() => h.monitor.assertFirstLeg('s', id)).not.toThrow();
    h.monitor.sources.parametersId = () => 'changed';
    expect(() => h.monitor.assertFirstLeg('s', id)).toThrow('margin_projection_evidence_changed');
    h.monitor.sources.parametersId = () => 'proof'; h.advance(1001);
    expect(() => h.monitor.assertFirstLeg('s', id)).toThrow('margin_projection_evidence_changed');
    expect(h.store.incident(key)?.batch?.id).toBe(id);
  });
  it('never recovers a certified batch before borrowing and fee settlement proof arrives', async () => {
    const h = harness(); await h.monitor.refresh(); h.balance(104); await h.monitor.refresh();
    const key = h.monitor.snapshot().accountId!, incident = h.store.incident(key)!;
    h.store.saveIncident(key, { ...incident, settlement: { quantities: {}, remoteAfter: '0', completedAt: h.monitor.snapshot().sampledAt!, batchId: 'b', parametersId: 'rules' } });
    h.monitor.sources.settlementReady = (_q, proof) => !proof?.parametersId;
    h.balance(200); h.advance(2001); await h.monitor.refresh(); h.advance(2001); await h.monitor.refresh();
    expect(h.store.incident(key)?.recovery).toBeNull(); expect(h.store.latched(key)).toBe(true);
    h.advance(25001); await h.monitor.refresh();
    expect(h.store.incident(key)?.blocked).toBe('margin_borrowing_settlement_unverified');
    h.monitor.sources.settlementReady = () => true;
    await h.monitor.refresh(); h.advance(2001); await h.monitor.refresh();
    expect(h.store.incident(key)?.recovery?.confirmations).toBe(2);
    expect(h.store.incident(key)?.blocked).toBe('margin_borrowing_settlement_unverified');
    expect(h.store.latched(key)).toBe(true);
    h.monitor.resumeEntries(); expect(h.store.incident(key)).toBeNull(); expect(h.store.latched(key)).toBe(false);
  });
  it('does not clear a blocked batch through the explicit review route', async () => {
    const h = harness(); await h.monitor.refresh(); h.balance(104); await h.monitor.refresh();
    const key = h.monitor.snapshot().accountId!, incident = h.store.incident(key)!;
    h.store.saveIncident(key, { ...incident, blocked: 'unknown_order', batch: { strategyId: 's', before: '10', target: '9', at: 1 } });
    h.balance(200); await h.monitor.refresh();
    expect(() => h.monitor.resumeEntries()).toThrow('margin_recovery_not_confirmed');
    expect(h.store.incident(key)?.batch).not.toBeNull();
  });
  it('resets recovery on a second low observation and pins the MMR cause', async () => {
    const h = harness(); await h.monitor.refresh(); h.balance(14); await h.monitor.refresh();
    expect(h.monitor.snapshot().protection?.cause).toBe('MMR');
    h.balance(120); h.advance(2000); await h.monitor.refresh();
    expect(h.monitor.snapshot().protection?.confirmations).toBe(1);
    h.balance(104); h.advance(2000); await h.monitor.refresh();
    expect(h.monitor.snapshot().protection).toMatchObject({ cause: 'MMR', confirmations: 0 });
    h.balance(120); h.advance(2000); await h.monitor.refresh();
    expect(h.monitor.snapshot().incidentId).not.toBeNull();
  });
  it('applies removals immediately without changing incident thresholds or adding new authority', async () => {
    const h = harness();
    h.monitor.sources.groups = () => ['a', 'b'].map(id => ({ id, strategyId: id, asset: id, phase: 'MONITORING', eligible: true, authorized: false, reason: null }));
    await h.monitor.refresh(); h.monitor.savePolicy({ ...h.monitor.snapshot().policy, protectedGroupIds: ['a'] });
    h.balance(104); await h.monitor.refresh();
    h.monitor.savePolicy({ ...h.monitor.snapshot().policy, protectedGroupIds: ['b'] });
    expect(h.monitor.snapshot().groups.map(g => g.authorized)).toEqual([false, false]);
  });
  it('carries missing-time evidence across minute and coarser bucket boundaries', async () => {
    const h = harness(); await h.monitor.refresh(); const key = h.monitor.snapshot().accountId!;
    h.advance(119000); await h.monitor.refresh();
    expect(h.store.history(key, 24, Number(h.account().account.update_time)).points[1].gapBefore).toBe(true);
    h.advance(9 * 60000); await h.monitor.refresh();
    expect(h.store.history(key, 168, Number(h.account().account.update_time)).points.at(-1)?.gapBefore).toBe(true);
  });
  it('rejects an in-flight pre-batch snapshot before accepting post-batch recovery', async () => {
    const h = harness(); await h.monitor.refresh(); h.balance(104); await h.monitor.refresh();
    const key = h.monitor.snapshot().accountId!, incident = h.store.incident(key)!;
    h.store.saveIncident(key, { ...incident, batch: { strategyId: 's', before: '100', target: '90', at: Date.now() } });
    let resolveOld!: (value: MarginAccountRead) => void;
    h.pending(new Promise((resolve) => { resolveOld = resolve; }));
    const old = h.monitor.refresh();
    let resolveNew!: (value: MarginAccountRead) => void;
    const postBatch = new Promise<MarginAccountRead>((resolve) => { resolveNew = resolve; });
    h.monitor.batchComplete('s', '90'); h.pending(postBatch);
    h.balance(200); resolveOld(h.account()); await old;
    expect(h.monitor.snapshot().fresh).toBe(false); expect(h.store.incident(key)).not.toBeNull();
    h.balance(115); resolveNew(h.account()); await h.monitor.refresh();
    expect(h.monitor.snapshot().fresh).toBe(true); expect(h.store.incident(key)).not.toBeNull();
    h.pending(null); h.advance(2000); await h.monitor.refresh();
    expect(h.monitor.snapshot().protection?.confirmations).toBe(1);
    h.advance(2000); await h.monitor.refresh(); expect(h.store.incident(key)).toBeNull();
  });
  it('expires without browser traffic and blocks entries on failed reads', async () => {
    const h = harness(); await h.monitor.refresh(); expect(h.monitor.snapshot().fresh).toBe(true);
    h.advance(5001); expect(() => h.monitor.assertEntry()).toThrow('margin_data_stale');
    h.fail(); await h.monitor.refresh(); expect(h.monitor.snapshot()).toMatchObject({ fresh: false, status: 'unavailable', entryBlocked: true });
  });
  it('pins active thresholds and requires explicit entry review after recovery', async () => {
    const h = harness(); await h.monitor.refresh(); h.balance(104); h.advance(2000); await h.monitor.refresh();
    const s = h.monitor.snapshot(); expect(s.incidentId).not.toBeNull(); expect(s.status).toBe('blocked');
    h.monitor.savePolicy({ ...s.policy, initial: { warn: 120, reduce: 110, recover: 130 } });
    expect(h.monitor.snapshot().effectivePolicy.initial.recover).toBe(115);
    h.balance(115); h.advance(2000); await h.monitor.refresh();
    expect(h.monitor.snapshot().incidentId).not.toBeNull();
    h.advance(2000); await h.monitor.refresh();
    expect(h.monitor.snapshot().incidentId).toBeNull(); expect(h.monitor.snapshot().entryBlocked).toBe(true);
    expect(() => h.monitor.resumeEntries()).toThrow('margin_recovery_not_confirmed');
    h.balance(130); h.advance(2000); await h.monitor.refresh(); h.monitor.resumeEntries();
    expect(h.monitor.snapshot().entryBlocked).toBe(false);
  });
  it('does not accept a delayed response after credential context changes', async () => {
    const h = harness(); await h.monitor.refresh();
    let resolveRead!: (value: MarginAccountRead) => void;
    h.pending(new Promise((resolve) => { resolveRead = resolve; }));
    const read = h.monitor.refresh(); h.changeContext(); resolveRead(h.account()); await read;
    expect(h.monitor.snapshot()).toMatchObject({ accountId: null, fresh: false, metrics: null });
  });
  it('retains intraminute minima and gaps without replacing missing data by zero', async () => {
    const h = harness(); await h.monitor.refresh(); const key = h.monitor.snapshot().accountId!;
    h.balance(104); h.advance(2000); await h.monitor.refresh();
    h.balance(120); h.advance(2000); await h.monitor.refresh();
    expect(h.store.history(key, 24, h.account().account.update_time ? Number(h.account().account.update_time) : 0).points[0]).toMatchObject({ initialMin: '104', initialMax: '120' });
    h.fail(); h.advance(2000); await h.monitor.refresh();
    const history = h.store.history(key, 1, Number(h.account().account.update_time));
    expect(history.points.at(-1)).toMatchObject({ valid: false, initialPct: null });
    expect(h.store.history(key, 24, Number(h.account().account.update_time)).points[0]).toMatchObject({ initialMin: '104', hasGap: true });
  });
  it('preserves policy and reduction latch across store reconstruction', async () => {
    const h = harness(); await h.monitor.refresh(); const s = h.monitor.snapshot();
    h.monitor.savePolicy(s.policy); h.balance(104); h.advance(2000); await h.monitor.refresh();
    const reopened = new MarginRiskStore(h.db);
    expect(reopened.policy(s.accountId!).revision).toBe(1);
    expect(reopened.incident(s.accountId!)).not.toBeNull(); expect(reopened.latched(s.accountId!)).toBe(true);
  });
});
