import { Decimal } from 'decimal.js';
import { describe, expect, it } from 'vitest';
import { DEFAULT_MARGIN_POLICY, type MarginMetrics } from '@gate-crossex/shared-types';
import type { AccountProjection } from './margin-account-projection.js';
import { planAccountReduction, marginExecutionCapacity } from './margin-projection-plan.js';

const policy = DEFAULT_MARGIN_POLICY;
function linear(equity = '1000', initial = '1000', maintenance = '1000', im = '2.5', mm = '5'): AccountProjection {
  return { parametersId: 'synthetic', validUntil: Date.now() + 5000, feeRules: [], linearWithin: () => true,
    checkpoints: q => ['0', q], evaluate: qs => {
      const a = new Decimal(qs[0]), b = new Decimal(qs[1]);
      return { equity: new Decimal(equity).minus(Decimal.max(a, b)), initial: new Decimal(initial).minus(a.plus(b).mul(im)),
        maintenance: new Decimal(maintenance).minus(a.plus(b).mul(mm)), debts: {} };
    } };
}
function before(m: AccountProjection): MarginMetrics {
  const p = m.evaluate(['0', '0']);
  return { marginBalance: p.equity.toString(), initialMargin: p.initial.toString(), maintenanceMargin: p.maintenance.toString() } as MarginMetrics;
}
const size = { quantity: '100', cap: '90', step: '10', minimum: '10' };
describe('recovery target with executable batches', () => {
  it('plans the recovery target instead of spending an arbitrary maximum', () => {
    const m = linear();
    expect(planAccountReduction(m, before(m), policy, size, 0)).toMatchObject({ target: '60', quantity: '60' });
    const small = linear('2100');
    expect(planAccountReduction(small, before(small), policy, size, 0)).toMatchObject({ target: '10', quantity: '10' });
  });
  it('keeps a smaller safe first leg when the full recovery quantity is unsafe', () => {
    const m = linear('100', '99', '70', '0.6', '0.7');
    expect(planAccountReduction(m, before(m), policy, { quantity: '50', cap: '50', step: '1', minimum: '1' }, 0))
      .toMatchObject({ target: '37', quantity: '2' });
    expect(marginExecutionCapacity(m, before(m), '50', '1')).toBe('2');
  });
  it('uses tier boundaries rather than enumerating every quantity step', () => {
    let calls = 0;
    const m: AccountProjection = { ...linear(), linearWithin: upper => new Decimal(upper).lte(100),
      checkpoints: q => ['0', ...(new Decimal(q).gt(100) ? ['100'] : []), q], evaluate: qs => {
        calls++; const q = qs.map(v => new Decimal(v));
        return { equity: new Decimal(1000).minus(Decimal.max(...q).mul('0.1')),
          initial: q.reduce((s, v) => s.minus(Decimal.min(v, 100).mul('0.2')).minus(Decimal.max(v.minus(100), 0).mul('0.1')), new Decimal(500)),
          maintenance: q.reduce((s, v) => s.minus(v.mul('0.2')), new Decimal(600)), debts: {} };
      } };
    expect(planAccountReduction(m, before(m), policy, { quantity: '1000', cap: '500', step: '0.01', minimum: '0.01' }, 0))
      .toMatchObject({ target: '410.26', quantity: '410.26' });
    expect(calls).toBeLessThan(2048);
  });
  it('keeps the full target visible when a genuine order cap requires multiple batches', () => {
    const m = linear();
    expect(planAccountReduction(m, before(m), policy, { ...size, cap: '30' }, 0)).toMatchObject({ target: '60', quantity: '30' });
  });
  it('keeps fine-step planned quantities in plain decimal notation', () => {
    const base = linear(), m = { ...base, evaluate: (qs: [string, string]) =>
      base.evaluate(qs.map(q => new Decimal(q).mul('100000000').toFixed()) as [string, string]) };
    expect(planAccountReduction(m, before(m), policy, { quantity: '0.000001', cap: '0.0000009', step: '0.00000001', minimum: '0.00000001' }, 0))
      .toMatchObject({ target: '0.00000058', quantity: '0.00000058' });
    const previous = m.evaluate(['0.00000057', '0.00000057']);
    expect(previous.equity.lt(previous.maintenance.mul('2.2'))).toBe(true);
  });
  it('keeps verified progress without fabricating a target beyond an unavailable model range', () => {
    const original = linear('100', '99', '70', '0.6', '0.7');
    const m = { ...original, linearWithin: (upper: string) => new Decimal(upper).lte(20), evaluate: (qs: [string, string]) => {
      if (qs.some(q => new Decimal(q).gt(20))) throw new Error('margin_borrowing_range_unverified');
      return original.evaluate(qs);
    } };
    expect(planAccountReduction(m, before(m), policy, { quantity: '50', cap: '50', step: '1', minimum: '1' }, 0))
      .toMatchObject({ status: 'bounded_batch_only', target: null, quantity: '2' });
  });
  it('does not reduce a healthy account or exceed an untradeable minimum', () => {
    const m = linear('2300');
    expect(() => planAccountReduction(m, before(m), policy, size, 0)).toThrow('margin_reduction_not_needed');
    const other = linear();
    expect(() => planAccountReduction(other, before(other), policy, { ...size, cap: '9' }, 0)).toThrow('margin_no_legal_quantity');
  });
  it.each(['5', '15', '16', '20', '50', '80'])('finds the earliest recovery before a later tier reverses the ratio, cap %s', cap => {
    const m: AccountProjection = { ...linear(), linearWithin: () => false,
      checkpoints: upper => ['0', ...['19.999999999999', '20', '20.000000000001'].filter(q => new Decimal(q).lt(upper)), upper],
      evaluate: qs => { const a = new Decimal(qs[0]), b = new Decimal(qs[1]), q = Decimal.max(a, b);
        return { equity: new Decimal(1000).minus(q), initial: new Decimal(500).minus(a.plus(b).mul('2.5')),
          maintenance: new Decimal(600).minus(a.plus(b).mul(5)).plus(q.gte(20) ? 300 : 0), debts: {} }; } };
    const result = planAccountReduction(m, before(m), policy, { quantity: '90', cap, step: '1', minimum: '1' }, 0);
    const recovered = (q: number) => { const p = m.evaluate([String(q), String(q)]); return p.equity.gte(p.initial.mul('1.15')) && p.equity.gte(p.maintenance.mul('2.2')); };
    const target = Array.from({ length: 90 }, (_, i) => i + 1).find(recovered)!;
    expect(target).toBe(16); expect(result.target).toBe(String(target));
    expect(result.quantity).toBe(Decimal.min(cap, target).toString());
    expect(recovered(20)).toBe(false);
  });
  it('matches exhaustive legal-quantity and intermediate-fill checks on 81 linear cases', () => {
    for (const equity of ['100', '110', '150']) for (const left of ['0.4', '0.6', '1.2'])
      for (const right of ['0.4', '0.6', '1.2']) for (const cap of [2, 5, 20]) {
        const m: AccountProjection = { ...linear(), evaluate: qs => {
          const a = new Decimal(qs[0]), b = new Decimal(qs[1]);
          return { equity: new Decimal(equity).minus(Decimal.max(a, b)), initial: new Decimal(99).minus(a.mul(left)).minus(b.mul(right)),
            maintenance: new Decimal(70).minus(a.plus(b).mul('0.7')), debts: {} };
        } };
        const quantities = Array.from({ length: 20 }, (_, i) => i + 1), anchor = before(m);
        const restored = (n: number) => { const s = m.evaluate([String(n), String(n)]); return s.equity.gte(s.initial.mul('1.15')) && s.equity.gte(s.maintenance.mul('2.2')); };
        const target = quantities.find(restored);
        const improves = (n: number) => {
          const s = m.evaluate([String(n), String(n)]), reqs = [s.initial, s.maintenance];
          return [99, 70].every((old, i) => new Decimal(equity).gte(new Decimal(old).mul(i ? '2.2' : '1.15'))
            ? s.equity.gte(reqs[i].mul(i ? '2.2' : '1.15')) : s.equity.mul(old).gte(reqs[i].mul(equity)))
            && [99, 70].some((old, i) => s.equity.mul(old).gt(reqs[i].mul(equity)));
        };
        const firstSafe = (n: number, first: number) => quantities.filter(q => q <= n).every(q => {
          const s = m.evaluate(first ? ['0', String(q)] : [String(q), '0']);
          return [99, 70].every((old, i) => {
            const prior = new Decimal(old).minus(equity), next = (i ? s.maintenance : s.initial).minus(s.equity);
            return prior.lt(0) ? next.lte(0) : next.lt(prior);
          });
        });
        const expected = quantities.filter(q => q <= cap && (!target || q <= target) && improves(q) && (firstSafe(q, 0) || firstSafe(q, 1))).at(-1);
        const plan = () => planAccountReduction(m, anchor, policy, { quantity: '20', cap: String(cap), step: '1', minimum: '1' }, 0);
        if (expected === undefined) expect(plan).toThrow('margin_projection_no_safe_improvement');
        else expect(plan()).toMatchObject({ target: target ? String(target) : null, quantity: String(expected), firstLeg: firstSafe(expected, 0) ? 0 : 1 });
      }
  });
});
