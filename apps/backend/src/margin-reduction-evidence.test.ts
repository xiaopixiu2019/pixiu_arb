import { describe, expect, it, vi } from 'vitest';
import { MarginReductionEvidence } from './margin-reduction-evidence.js';
import type { GateCrossExAccount, GateCrossExPosition, TradingCrossExGateway } from './crossex-client.js';
import type { LiveMarket } from './market-hub.js';
import type { MarginRiskParameters } from './margin-risk-parameters.js';
async function fixture(parameters?: MarginRiskParameters, unavailableFx = false) {
  let context = 'one', fx = '0.98';
  const fundingAt = Date.now();
  const legs = [{ symbol: 'GATE_FUTURE_BTC_USDT', side: 'BUY' as const }, { symbol: 'HYPERLIQUID_FUTURE_BTC_USDC', side: 'SELL' as const }];
  const positions = legs.map(l => ({ symbol: l.symbol, position_qty: '10', position_side: l.side === 'BUY' ? 'LONG' : 'SHORT',
    position_value: '1000', mark_price: '100', leverage: '5', initial_margin: '200.75', maintenance_margin: '5.75',
    margin_mode: 'CROSS', upnl: '0' } as GateCrossExPosition));
  const account = { user_id: 'uid', account_mode: 'CROSS_EXCHANGE', margin_balance: '500', initial_margin: '450', maintenance_margin: '350', assets: [
    { exchange_type: 'CROSSEX', coin: 'USDT', equity: '500', liability: '0', balance: '500', available_balance: '500', upnl: '0', borrowing_initial_margin: '0', borrowing_maintenance_margin: '0' },
    { exchange_type: 'HYPERLIQUID', coin: 'USDC', equity: '500', liability: '0', balance: '500', available_balance: '500', upnl: '0', borrowing_initial_margin: '0', borrowing_maintenance_margin: '0' },
  ] } as GateCrossExAccount;
  const tiers = [{ min_risk_limit_value: '0', max_risk_limit_value: '1000000', maintenance_rate: '0.005', quick_cal_amount: '0' }];
  const gateway = { queryRiskLimits: async () => legs.map(l => ({ symbol: l.symbol, tiers })),
    queryValuationRates: async () => { if (unavailableFx) throw new Error('FX unavailable'); return { USDT: '1', USDC: fx }; }, queryFeeRates: async () => ['GATE', 'HYPERLIQUID'].map(exchange_type => ({ exchange_type, future_taker_fee: '0.0005' })) } as unknown as TradingCrossExGateway;
  const evidence = new MarginReductionEvidence(gateway, { market: symbol => ({ symbol, source: 'gate_crossex_websocket', bidPrice: '100', askPrice: '100',
    updatedAt: new Date().toISOString(), receivedAt: new Date().toISOString() } as LiveMarket) }, () => context,
  () => ({ rate8h: '0.001', fetchedAt: fundingAt }), parameters ? { read: () => parameters, subject: () => ({ profileId: 'test', userId: 'uid' }) } : undefined);
  evidence.refresh({ apiKey: 'fake', apiSecret: 'fake' }, account, positions);
  await vi.waitFor(() => expect(evidence.inspectGroup(account, positions, legs, '1').ok).toBe(true));
  return { evidence, positions, legs, account, tiers, changeContext: () => { context = 'two'; }, badFx: () => { fx = 'NaN'; } };
}
describe('planning evidence coverage', () => {
  it('uses parity for ordinary stablecoin planning when the independent FX reader is unavailable', async () => {
    const h = await fixture(undefined, true);
    expect(h.evidence.valuation()).toBeNull();
    expect(h.evidence.forGroup(h.account, h.positions, h.legs, '1')).toMatchObject({ initial: '401.5', projection: { approximate: true } });
  });
  it('does not reject supported debt and negative equity solely because the native pool is underfunded', async () => {
    const at = Date.now(), parameters: MarginRiskParameters = { version: 1, profileId: 'test', userId: 'uid',
      sourceUrl: 'https://www.gate.com/zh/help/crossex/functional/49325', checkedAt: at, validUntil: at + 60000,
      pools: ['CROSSEX:USDT', 'HYPERLIQUID:USDC'].map(key => ({ key, fxLow: key.endsWith('USDC') ? '0.98' : '1', fxHigh: key.endsWith('USDC') ? '0.98' : '1',
        debtTiers: [{ min: '0', max: '100', initialRate: '0.2', initialOffset: '0', maintenanceRate: '0.1', maintenanceOffset: '0' }],
        collateralTiers: [{ min: '0', max: '10000', rate: '1', offset: '0' }] })),
      fees: [{ symbol: 'GATE_FUTURE_BTC_USDT', pool: 'CROSSEX:USDT' }, { symbol: 'HYPERLIQUID_FUTURE_BTC_USDC', pool: 'HYPERLIQUID:USDC' }] };
    const h = await fixture(parameters);
    h.account.assets = h.account.assets.map((a, i) => ({ ...a, balance: i ? '5' : '500', available_balance: i ? '5' : '500', upnl: i ? '-6' : '0',
      equity: i ? '-1' : '500', liability: i ? '1' : '0', borrowing_initial_margin: i ? '0.2' : '0', borrowing_maintenance_margin: i ? '0.1' : '0' }));
    const result = h.evidence.inspectGroup(h.account, h.positions, h.legs, '1');
    expect(result.ok).toBe(true);
    if (result.ok) { expect(result.evidence.projection).toBeDefined(); expect(result.evidence.projection!.evaluate(['1', '1']).debts['HYPERLIQUID:USDC']).toBe('2.05'); }
    parameters.checkedAt = at - 2000; parameters.validUntil = at - 1;
    expect(h.evidence.inspectGroup(h.account, h.positions, h.legs, '1')).toMatchObject({ ok: false, reason: 'margin_projection_parameters_expired' });
  });
  it('builds a bounded estimate from complete account facts without a manual rule file', async () => {
    const h = await fixture(); h.account.assets[1] = { ...h.account.assets[1], available_balance: '0', balance: '0', upnl: '-0.3', liability: '0.3', equity: '-0.3', borrowing_initial_margin: '0.06', borrowing_maintenance_margin: '0.03' };
    expect(h.evidence.inspectGroup(h.account, h.positions, h.legs, '1')).toMatchObject({ ok: true, evidence: { projection: { approximate: true } } });
  });
  it('converts two exact legs and does not add a third same-asset position', async () => {
    const h = await fixture();
    const expected = h.evidence.forGroup(h.account, h.positions, h.legs, '1');
    expect(expected).toMatchObject({ initial: '397.485', maintenance: '11.385' });
    expect(expected?.maintenanceRelease).toBe('1.132865');
    expect(expected?.cost).toBe('2.08929');
    expect(h.evidence.forGroup(h.account, [...h.positions, { ...h.positions[0], symbol: 'OKX_FUTURE_BTC_USDT', initial_margin: '999999' }], h.legs, '1'))
      .toMatchObject({ initial: expected!.initial, maintenance: expected!.maintenance, cost: expected!.cost });
  });
  it('rejects missing rule calibration, debt and account changes', async () => {
    const h = await fixture();
    const quantities = Object.fromEntries(h.positions.map(p => [p.symbol, '10']));
    expect(h.evidence.settledPositions(h.positions, quantities)).toBe(true);
    expect(h.evidence.settledPositions([{ ...h.positions[0], maintenance_margin: '6' }, h.positions[1]], quantities)).toBe(false);
    expect(h.evidence.forGroup(h.account, [{ ...h.positions[0], maintenance_margin: '6' }, h.positions[1]], h.legs, '1')).toBeNull();
    expect(h.evidence.forGroup(h.account, [{ ...h.positions[0], initial_margin: 'NaN' }, h.positions[1]], h.legs, '1')).toBeNull();
    const debt = { ...h.account, assets: h.account.assets.map(a => ({ ...a, liability: 'NaN' })) };
    expect(h.evidence.forGroup(debt, h.positions, h.legs, '1')).toBeNull();
    h.changeContext(); expect(h.evidence.valuation()).toBeNull();
    expect(h.evidence.forGroup(h.account, h.positions, h.legs, '1')).toBeNull();
  });
  it('rejects a discontinuous risk schedule rather than assuming release monotonicity', async () => {
    const h = await fixture();
    h.tiers.push({ min_risk_limit_value: '1000000', max_risk_limit_value: '2000000', maintenance_rate: '0.01', quick_cal_amount: '0' });
    expect(h.evidence.forGroup(h.account, h.positions, h.legs, '1')).toBeNull();
  });
});
