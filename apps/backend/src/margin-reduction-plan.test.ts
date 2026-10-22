import { describe, expect, it } from 'vitest';
import { planMarginReduction, rankMarginCandidates, type ReductionInput } from './margin-reduction-plan.js';

const input: ReductionInput = { equity: '1000', initial: '100', maintenance: '600',
  initialRecovery: 115, maintenanceRecovery: 300, quantity: '10', cap: '1', step: '0.01', minimum: '0.01',
  initialRelease: '5', maintenanceRelease: '40', cost: '1' };
describe('bounded paired margin planning', () => {
  it('separates the independently verified recovery target from batch quantity', () => {
    expect(planMarginReduction(input)).toMatchObject({ target: '6.73', quantity: '1', status: 'target_known' });
    expect(planMarginReduction({ ...input, cap: '10' })).toMatchObject({ target: '6.73', quantity: '6.73' });
  });
  it('does not turn a 2.3% need into a ten-percent sale', () => {
    expect(planMarginReduction({ ...input, equity: '1772.63' })).toMatchObject({ quantity: '0.23' });
  });
  it('rejects costs that exhaust a currently healthy initial-margin buffer', () => {
    expect(planMarginReduction({ ...input, initial: '860', initialRelease: '0', cost: '40' })).toBeNull();
  });
  it('cannot manufacture a trade by rounding a cap up to the minimum', () => {
    expect(planMarginReduction({ ...input, cap: '0.009' })).toBeNull();
    expect(planMarginReduction({ ...input, cap: '0.009999999999999999999999' })).toBeNull();
    expect(planMarginReduction({ ...input, minimum: '2' })).toBeNull();
  });
  it('reports a group that cannot recover alone without exceeding holdings', () => {
    expect(planMarginReduction({ ...input, quantity: '2' })).toMatchObject({ target: null, quantity: '1', status: 'group_insufficient' });
  });
  it('does not sell when both objectives are already satisfied', () => {
    expect(planMarginReduction({ ...input, equity: '2000' })).toBeNull();
  });
  it.each(['NaN', 'Infinity', '-1', ''])('rejects invalid release %s', (maintenanceRelease) => {
    expect(planMarginReduction({ ...input, maintenanceRelease })).toBeNull();
  });
  it('ranks signed yields and keeps unknown distinct from zero', () => {
    const rows = ['100', '-10', '0', null, '-80', '20'].map((apr, i) => ({ id: String(i), apr, initial: '10', maintenance: String(i + 1) }));
    expect(rankMarginCandidates(rows, 'MMR').map(x => x.apr)).toEqual(['-80', '-10', '0', '20', '100', null]);
    expect(rankMarginCandidates(rows, 'IMR').map(x => x.id)).toEqual(['0', '1', '2', '3', '4', '5']);
  });
});
