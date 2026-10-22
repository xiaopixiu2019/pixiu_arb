import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_MARGIN_POLICY, type MarginMetrics } from '@gate-crossex/shared-types';
import { marginGroupPlanDetailed } from './margin-group-plan.js';
import { CreateStrategyInputSchema, type StrategyRecord } from './trading-runtime.js';
import type { GateCrossExAccount, GateCrossExPosition } from './crossex-client.js';
import type { MarginReductionEvidence, ReductionEvidence } from './margin-reduction-evidence.js';
import type { MarketSource } from './strategy-engine.js';

const databases: Database.Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
function fixture(maximum: string | null = null) {
  const db = new Database(':memory:'); databases.push(db);
  db.exec('CREATE TABLE crossex_instruments(symbol TEXT PRIMARY KEY,lot_size TEXT,min_size TEXT,min_notional TEXT,tick_size TEXT,max_market_size TEXT)');
  const symbols = ['GATE_FUTURE_PONS_USDT', 'HYPERLIQUID_FUTURE_PONS_USDC'];
  const insert = db.prepare('INSERT INTO crossex_instruments VALUES (?,?,?,?,?,?)');
  insert.run(symbols[0], '10', '10', null, '0.0001', '10000000');
  insert.run(symbols[1], '1', '1', '10', '0.000001', maximum);
  const record = { id: 'synthetic', config: CreateStrategyInputSchema.parse({ kind: 'position', asset: 'PONS',
    leftVenue: 'GATE', rightVenue: 'HYPERLIQUID', leftSide: 'SELL', rightSide: 'BUY', entryBps: '10',
    totalAmount: '1800', perOrderQuantity: '900', executionMethod: 'MAKER_TAKER', makerLeg: 'left', management: { perOrderQuantity: '900' } }) } as StrategyRecord;
  const positions = symbols.map((symbol, i) => ({ symbol, position_side: i === 0 ? 'SHORT' : 'LONG', position_qty: '1800' })) as GateCrossExPosition[];
  const facts: ReductionEvidence = { initial: '1000', maintenance: '1000', initialRelease: '5', maintenanceRelease: '10', cost: '1',
    cap: '36', apr: '-1', firstLeg: 0, checkedAt: Date.now(), initialReleaseByLeg: ['2.5', '2.5'], maintenanceReleaseByLeg: ['5', '5'] };
  const inspectGroup = vi.fn(() => ({ ok: true as const, evidence: facts }));
  const evidence = { inspectGroup } as unknown as MarginReductionEvidence;
  const markets: MarketSource = { market: symbol => ({ symbol, venue: symbol === symbols[0] ? 'GATE' : 'HYPERLIQUID',
    asset: 'PONS', lastPrice: '1', bidPrice: '1', askPrice: '1', bidSize: '10', askSize: '10', open24h: '1', high24h: '1', low24h: '1',
    volume24h: '100', quoteVolume24h: '100', fundingRate: '0', nextFundingAt: new Date().toISOString(),
    openInterest: '1000', openInterestValue: '1000', source: 'gate_crossex_websocket',
    updatedAt: new Date().toISOString(), receivedAt: new Date().toISOString() }) };
  const metrics = { marginBalance: '1000', initialMargin: '1000', maintenanceMargin: '1000' } as MarginMetrics;
  const policy = { ...DEFAULT_MARGIN_POLICY, maintenance: { warn: 200, reduce: 150, recover: 300 } };
  const plan = () => marginGroupPlanDetailed(db, evidence, markets, {} as GateCrossExAccount, record, positions, metrics, policy);
  return { db, symbols, record, inspectGroup, plan };
}
describe('optional reported market size caps', () => {
  it('plans a bounded legal batch when the successful symbol response reports null', () => {
    const h = fixture();
    expect(h.plan()).toMatchObject({ ok: true, plan: { target: '70', quantity: '70' } });
    expect(h.inspectGroup.mock.calls[0]).toBeDefined();
  });
  it('still obeys an explicit venue maximum', () => {
    expect(fixture('20').plan()).toMatchObject({ ok: true, plan: { quantity: '20' } });
  });
  it('keeps task and batch caps when neither leg reports a maximum', () => {
    const h = fixture(); h.db.prepare('UPDATE crossex_instruments SET max_market_size=NULL').run();
    h.record.config.management!.perOrderQuantity = '10';
    expect(h.plan()).toMatchObject({ ok: true, plan: { quantity: '10' } });
  });
  it.each(['0', '-1', '', 'NaN', 'Infinity', 'invalid'])('rejects a malformed or nonpositive supplied maximum %s', maximum => {
    const h = fixture(maximum); expect(h.plan().ok).toBe(false); expect(h.inspectGroup).not.toHaveBeenCalled();
  });
  it('rejects a missing instrument record', () => {
    const h = fixture(); h.db.prepare('DELETE FROM crossex_instruments WHERE symbol=?').run(h.symbols[1]);
    expect(h.plan()).toMatchObject({ ok: false, reason: 'margin_quantity_rules_unavailable' });
  });
  it.each([['min_size', '40'], ['min_notional', '100'], ['lot_size', '0']])('preserves %s validation', (field, value) => {
    const h = fixture(); h.record.config.management!.perOrderQuantity = '30';
    h.db.prepare(`UPDATE crossex_instruments SET ${field}=? WHERE symbol=?`).run(value, h.symbols[1]);
    expect(h.plan().ok).toBe(false);
  });
  it('reports the minimum legal recovery quantity when notional exceeds the arithmetic target', () => {
    const h = fixture(); h.db.prepare('UPDATE crossex_instruments SET min_notional=? WHERE symbol=?').run('100', h.symbols[1]);
    expect(h.plan()).toMatchObject({ ok: true, plan: { target: '100', quantity: '100' } });
  });
});
