import { describe, expect, it } from 'vitest';
import { createApproximation, BorrowingObservations } from './margin-approximation.js';
import type { GateCrossExAccount } from './crossex-client.js';
const venues = ['GATE', 'BINANCE', 'OKX', 'BYBIT', 'KRAKEN', 'HYPERLIQUID', 'DERIBIT'];
const coin = (v: string) => v === 'KRAKEN' ? 'USD' : ['HYPERLIQUID', 'DERIBIT'].includes(v) ? 'USDC' : 'USDT';
function setup(a = 'GATE', b = 'KRAKEN') {
  const legs = [a, b].map(venue => ({ symbol: `${venue}_FUTURE_TEST_${coin(venue)}`, pool: `${coin(venue) === 'USDT' ? 'CROSSEX' : venue}:${coin(venue)}`,
    quantity: '10', mark: '100', leverage: '10', initial: '100.75', maintenance: '20.75', fee: '0.05', slip: '1', loss: '1',
    tiers: [{ min_risk_limit_value: '0', max_risk_limit_value: '100000', quick_cal_amount: '0', maintenance_rate: '0.02', leverage_max: '10', tier: '1' }] }));
  const assets = [...new Set(legs.map(l => l.pool))].map(key => { const [exchange_type, currency] = key.split(':'); return { exchange_type, coin: currency,
    balance: '5', available_balance: '5', upnl: '-6', equity: '-1', liability: '1', borrowing_initial_margin: '0.2', borrowing_maintenance_margin: '0.1' }; });
  const account = { account_mode: 'CROSS_EXCHANGE', user_id: 'test', update_time: '1', margin_balance: '200', initial_margin: '240', maintenance_margin: '100', assets } as GateCrossExAccount;
  const history = new BorrowingObservations(); for (let n = 1; n <= 3; n++) history.observe({ ...account, update_time: String(n) }, 'profile', n * 2000);
  return { account, legs, history };
}
describe('bounded approximate margin projection', () => {
  const pairs = venues.flatMap((a, i) => venues.slice(i + 1).map(b => [a, b]));
  it.each(pairs)('supports the %s / %s pair with debt and no manual parameter file', (a, b) => {
    const h = setup(a, b), m = createApproximation(h.account, h.legs, h.history.rates(h.account, 'profile', 6000), 6000);
    const s = m.evaluate(['0.2', '0.2']);
    expect(m.approximate).toBe(true); expect(s.initial.lt(h.account.initial_margin)).toBe(true);
    expect(s.maintenance.lt(h.account.maintenance_margin)).toBe(true); expect(s.equity.lt(h.account.margin_balance)).toBe(true);
  });
  it('does not repay existing liabilities in the estimate or double count their existing requirements', () => {
    const h = setup(), m = createApproximation(h.account, h.legs, h.history.rates(h.account, 'profile', 6000), 6000);
    const zero = m.evaluate(['0', '0']); expect(zero.initial.toString()).toBe('240'); expect(zero.maintenance.toString()).toBe('100');
    expect(m.evaluate(['0.2', '0.2']).debts['KRAKEN:USD']).toBe('1');
    expect(m.evaluate(['0.2', '0']).equity.eq(m.evaluate(['0.2', '0.2']).equity)).toBe(true);
  });
  it('does not learn from repeated snapshots, stale evidence, zero debt or another account', () => {
    const h = setup(); expect(h.history.rates(h.account, 'other', 6000)['KRAKEN:USD']).toBeUndefined();
    expect(h.history.rates(h.account, 'profile', 70001)['KRAKEN:USD']).toBeUndefined();
    const one = new BorrowingObservations(); for (let i = 0; i < 3; i++) one.observe(h.account, 'profile', 6000);
    expect(one.rates(h.account, 'profile', 6000)['KRAKEN:USD']).toBeUndefined();
  });
  it('reserves a possible new borrowing requirement without interpreting no debt as a zero rate', () => {
    const h = setup(); h.account.assets = h.account.assets.map(a => ({ ...a, balance: '0.01', available_balance: '0.01', upnl: '0', equity: '0.01', liability: '0', borrowing_initial_margin: '0', borrowing_maintenance_margin: '0' }));
    const m = createApproximation(h.account, h.legs, {}, 6000);
    expect(m.evaluate(['0.2', '0.2']).initial.gt('235.97')).toBe(true);
  });
  it('rejects missing money, invalid quantities and impossible account anchors', () => {
    const h = setup();
    expect(() => createApproximation({ ...h.account, initial_margin: '1' }, h.legs, {}, 6000)).toThrow();
    expect(() => createApproximation(h.account, h.legs, {}, 6000).evaluate(['11', '0'])).toThrow();
    h.account.assets[0].liability = 'NaN'; expect(() => createApproximation(h.account, h.legs, {}, 6000)).toThrow();
  });
});
