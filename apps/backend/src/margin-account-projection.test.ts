import { describe, expect, it } from 'vitest';
import { createAccountProjection } from './margin-account-projection.js';
import { MarginRiskParametersSchema } from './margin-risk-parameters.js';
import { planAccountReduction } from './margin-projection-plan.js';
import { MarginMetricsSchema, MarginPolicySchema } from '@gate-crossex/shared-types';
import type { GateCrossExAccount } from './crossex-client.js';

const at = Date.now();
export const projectionParameters = () => MarginRiskParametersSchema.parse({ version: 1, profileId: 'test', userId: 'uid',
  sourceUrl: 'https://www.gate.com/zh/help/crossex/functional/49325', checkedAt: at, validUntil: at + 60000,
  pools: ['CROSSEX:USDT', 'KRAKEN:USD'].map(key => ({ key, fxLow: '1', fxHigh: '1',
    debtTiers: [{ min: '0', max: '100', initialRate: '0.2', initialOffset: '0', maintenanceRate: '0.1', maintenanceOffset: '0' }],
    collateralTiers: [{ min: '0', max: '10000', rate: '1', offset: '0' }] })),
  fees: [{ symbol: 'GATE_FUTURE_TEST_USDT', pool: 'CROSSEX:USDT' }, { symbol: 'KRAKEN_FUTURE_TEST_USD', pool: 'KRAKEN:USD' }] });
export const projectionAccount = () => ({ user_id: 'uid', account_mode: 'CROSS_EXCHANGE', margin_balance: '100', initial_margin: '100', maintenance_margin: '60',
  assets: [{ exchange_type: 'CROSSEX', coin: 'USDT', balance: '101', available_balance: '101', upnl: '0', equity: '101', liability: '0', borrowing_initial_margin: '0', borrowing_maintenance_margin: '0' },
    { exchange_type: 'KRAKEN', coin: 'USD', balance: '5', available_balance: '5', upnl: '-6', equity: '-1', liability: '1', borrowing_initial_margin: '0.2', borrowing_maintenance_margin: '0.1' }] } as GateCrossExAccount);
const legs = () => ['GATE_FUTURE_TEST_USDT', 'KRAKEN_FUTURE_TEST_USD'].map((symbol, index) => ({ symbol, pool: index ? 'KRAKEN:USD' : 'CROSSEX:USDT',
  quantity: '4', mark: '100', leverage: '10', initial: '40.3', maintenance: '10.3', fee: '1', slip: '0',
  tiers: [{ min_risk_limit_value: '0', max_risk_limit_value: '100000', maintenance_rate: '0.025', quick_cal_amount: '0', leverage_max: '10', tier: '1' }] }));
const parameters = projectionParameters, account = projectionAccount;
const metrics = () => MarginMetricsSchema.parse({ initialPct: '100', maintenancePct: '166.666', marginBalance: '100', initialMargin: '100', maintenanceMargin: '60',
  availableMargin: '0', initialHeadroom: '-10', maintenanceHeadroom: '-20', accountMode: 'CROSS_EXCHANGE', exchangeType: 'CROSSEX', remoteUpdatedAt: String(at), assets: [] });
const create = (rules = parameters()) => createAccountProjection(account(), legs(), rules, { profileId: 'test', userId: 'uid' }, at);

describe('certified account projection', () => {
  it('accepts negative native equity without requiring debt repayment', () => {
    const p = createAccountProjection(account(), legs(), parameters(), { profileId: 'test', userId: 'uid' }, at);
    const s = p.evaluate(['0.4', '0.4']);
    expect(s.equity.toString()).toBe('99.2');
    expect(s.debts['KRAKEN:USD']).toBe('1.4');
    expect(s.initial.toString()).toBe('92.02');
    expect(s.maintenance.toString()).toBe('57.98');
  });
  it('validates observed borrowing instead of learning future rates from it', () => {
    const a = account(); a.assets[1] = { ...a.assets[1], borrowing_initial_margin: '0.1' };
    expect(() => createAccountProjection(a, legs(), parameters(), { profileId: 'test', userId: 'uid' }, at)).toThrow('margin_borrowing_calibration_failed');
  });
  it('rejects cross-account, expired and out-of-range rules', () => {
    expect(() => createAccountProjection(account(), legs(), parameters(), { profileId: 'other', userId: 'uid' }, at)).toThrow('margin_projection_account_mismatch');
    expect(() => createAccountProjection(account(), legs(), parameters(), { profileId: 'test', userId: 'uid' }, at + 60000)).toThrow('margin_projection_parameters_expired');
    const rules = parameters(); rules.pools[1].debtTiers[0].max = '1.1';
    const p = createAccountProjection(account(), legs(), rules, { profileId: 'test', userId: 'uid' }, at);
    expect(() => p.evaluate(['0.4', '0.4'])).toThrow('margin_borrowing_range_unverified');
  });
  it('uses the declared fee pool and never charges it a second time', () => {
    const rules = parameters(); rules.fees[1].pool = 'CROSSEX:USDT';
    const s = createAccountProjection(account(), legs(), rules, { profileId: 'test', userId: 'uid' }, at).evaluate(['0.4', '0.4']);
    expect(s.equity.toString()).toBe('99.2'); expect(s.debts['KRAKEN:USD']).toBe('1');
    expect(s.initial.toString()).toBe('91.94');
  });
  it('reserves both fees at a partial first leg across collateral sign and borrowing boundaries', () => {
    const rules = parameters(), a = account();
    rules.pools[0].collateralTiers[0].rate = '0.8';
    a.assets[0] = { ...a.assets[0], balance: '0.5', available_balance: '0.5', equity: '0.5' };
    const model = createAccountProjection(a, legs(), rules, { profileId: 'test', userId: 'uid' }, at);
    const first = model.evaluate(['0.8', '0']), paired = model.evaluate(['0.8', '0.8']);
    expect(first.equity.toString()).toBe('98.5'); expect(paired.equity.toString()).toBe('98.5');
    expect(first.debts['CROSSEX:USDT']).toBe('0.3'); expect(first.debts['KRAKEN:USD']).toBe('1.8');
    expect(first.initial.toString()).toBe('92.16'); expect(paired.initial.toString()).toBe('84.1');
    const points = model.checkpoints('0.8').map(Number);
    expect(points).toContain(0.5); expect(points.some(q => q < 0.5 && q > 0.49)).toBe(true);
    expect(points.some(q => q > 0.5 && q < 0.51)).toBe(true);
  });
  it('plans a bounded 10 percent batch and reaches both targets with borrowing included', () => {
    const model = create();
    const p = planAccountReduction(model, metrics(), MarginPolicySchema.parse({}), { quantity: '4', cap: '0.4', step: '0.01', minimum: '0.01' }, 1);
    expect(p.quantity).toBe('0.4'); expect(p.target).not.toBeNull();
    const end = model.evaluate([p.target!, p.target!]);
    expect(end.equity.gte(end.initial.mul('1.15')) && end.equity.gte(end.maintenance.mul('2.2'))).toBe(true);
  });
  it('does not trade a healthy account or enlarge an untradeable minimum', () => {
    const a = account(); a.margin_balance = '200';
    const m = createAccountProjection(a, legs(), parameters(), { profileId: 'test', userId: 'uid' }, at);
    expect(() => planAccountReduction(m, { ...metrics(), marginBalance: '200' }, MarginPolicySchema.parse({}), { quantity: '4', cap: '0.4', step: '0.01', minimum: '0.01' }, 0)).toThrow('margin_reduction_not_needed');
    expect(() => planAccountReduction(create(), metrics(), MarginPolicySchema.parse({}), { quantity: '4', cap: '0.4', step: '1', minimum: '1' }, 0)).toThrow('margin_no_legal_quantity');
  });
  it('rejects unsafe tier jumps at an intermediate first-leg state', () => {
    const rules = parameters(); rules.pools[1].debtTiers = [
      { min: '0', max: '1.1', initialRate: '0.2', initialOffset: '0', maintenanceRate: '0.1', maintenanceOffset: '0' },
      { min: '1.1', max: '100', initialRate: '0.2', initialOffset: '200', maintenanceRate: '0.1', maintenanceOffset: '200' },
    ];
    expect(() => planAccountReduction(create(rules), metrics(), MarginPolicySchema.parse({}), { quantity: '4', cap: '0.4', step: '0.1', minimum: '0.1' }, 1)).toThrow('margin_projection_no_safe_improvement');
  });
  it('keeps a verified incremental batch without inventing a target outside the rule range', () => {
    const rules = parameters(); rules.pools[1].debtTiers[0].max = '1.5';
    const p = planAccountReduction(create(rules), metrics(), MarginPolicySchema.parse({}), { quantity: '4', cap: '0.4', step: '0.01', minimum: '0.01' }, 1);
    expect(p.status).toBe('bounded_batch_only'); expect(p.target).toBeNull(); expect(p.quantity).toBe('0.4');
  });
  it('rejects mismatched account anchors and impossible known requirement totals', () => {
    const a = account(); a.initial_margin = '20';
    expect(() => createAccountProjection(a, legs(), parameters(), { profileId: 'test', userId: 'uid' }, at)).toThrow('margin_projection_account_calibration_failed');
    expect(() => planAccountReduction(create(), { ...metrics(), marginBalance: '101' }, MarginPolicySchema.parse({}),
      { quantity: '4', cap: '0.4', step: '0.01', minimum: '0.01' }, 0)).toThrow('margin_projection_account_changed');
  });
  it('rejects a tier that would project negative maintenance for a remaining position', () => {
    const positions = legs(); positions[0].tiers[0].quick_cal_amount = '5'; positions[0].maintenance = '5.3';
    const model = createAccountProjection(account(), positions, parameters(), { profileId: 'test', userId: 'uid' }, at);
    expect(() => model.evaluate(['3.99', '0'])).toThrow('margin_projection_position_tier_invalid');
  });
});
