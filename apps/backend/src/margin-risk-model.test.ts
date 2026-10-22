import { describe, expect, it } from 'vitest';
import { MarginPolicySchema } from '@gate-crossex/shared-types';
import { marginBelow, marginMetrics, marginRecovered, projectedMarginAllowed } from './margin-risk-model.js';
import type { GateCrossExAccount } from './crossex-client.js';

const policy = MarginPolicySchema.parse({});
const account = (balance = '110'): GateCrossExAccount => ({ available_margin: '10', margin_balance: balance,
  initial_margin: '100', maintenance_margin: '10', initial_margin_rate: String(Number(balance) / 100),
  maintenance_margin_rate: String(Number(balance) / 10), account_mode: 'CROSS_EXCHANGE', exchange_type: 'CROSSEX',
  position_mode: 'SINGLE', update_time: '1', assets: [] });
describe('official coverage ratios and independent thresholds', () => {
  it('keeps official futures pool amounts and never turns missing amounts into zero', () => {
    const a = { coin: 'USDT', exchange_type: 'CROSSEX', balance: '110', upnl: '0', equity: '110', available_balance: '10',
      liability: '0', borrowing_initial_margin: '0', borrowing_maintenance_margin: '0', futures_initial_margin: '100', futures_maintenance_margin: '10' };
    expect(marginMetrics({ ...account(), assets: [a] }, policy).assets[0]).toMatchObject({ futuresInitialMargin: '100', futuresMaintenanceMargin: '10' });
    const missing = { ...a } as Partial<typeof a>; delete missing.futures_initial_margin;
    expect(marginMetrics({ ...account(), assets: [missing as typeof a] }, policy).assets[0].futuresInitialMargin).toBeUndefined();
  });
  it('uses strict warning and reduction boundaries and inclusive recovery', () => {
    expect(marginBelow(marginMetrics(account('110'), policy), policy, 'warn')).toBe(false);
    expect(marginBelow(marginMetrics(account('109.99'), policy), policy, 'warn')).toBe(true);
    expect(marginBelow(marginMetrics(account('105'), policy), policy, 'reduce')).toBe(false);
    expect(marginBelow(marginMetrics(account('104.99'), policy), policy, 'reduce')).toBe(true);
    expect(marginRecovered(marginMetrics(account('115'), policy), policy)).toBe(true);
    expect(marginRecovered(marginMetrics(account('114.99'), policy), policy)).toBe(false);
  });
  it('does not report zero requirements as a dangerous zero or negative equity as safe', () => {
    const empty = { ...account(), initial_margin: '0', maintenance_margin: '0', initial_margin_rate: '0', maintenance_margin_rate: '0' };
    expect(marginMetrics(empty, policy).initialPct).toBeNull();
    expect(marginBelow(marginMetrics({ ...empty, margin_balance: '-1' }, policy), policy, 'reduce')).toBe(true);
  });
  it('rejects malformed and internally inconsistent exchange data', () => {
    for (const value of ['', 'NaN', 'Infinity']) expect(() => marginMetrics({ ...account(), margin_balance: value }, policy)).toThrow();
    expect(() => marginMetrics({ ...account(), initial_margin_rate: '110' }, policy)).toThrow('margin_ratio_inconsistent');
  });
  it('blocks projected exposure before the present ratio crosses a warning', () => {
    expect(projectedMarginAllowed(marginMetrics(account('120'), policy), policy, '10', '1')).toBe(false);
    expect(projectedMarginAllowed(marginMetrics(account('120'), policy), policy, '5', '1')).toBe(true);
  });
  it('validates all user thresholds and preserves the maintenance defaults', () => {
    expect(policy.maintenance).toEqual({ warn: 200, reduce: 150, recover: 220 });
    expect(MarginPolicySchema.safeParse({ initial: { warn: 110, reduce: 110, recover: 115 } }).success).toBe(false);
    expect(MarginPolicySchema.safeParse({ initial: { warn: 110, reduce: 100, recover: 115 } }).success).toBe(false);
  });
});
