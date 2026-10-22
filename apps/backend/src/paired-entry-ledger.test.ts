import { describe, expect, it } from 'vitest';
import { coverEntryBudget, entryCosts, entryLegUsage, type EntryOrder, type PairedEntryBudget } from './paired-entry-ledger.js';

const budget: PairedEntryBudget = { accountUser: 'synthetic', legs: ['A', 'B'].map((symbol, i) => ({ symbol,
  side: i === 0 ? 'SELL' : 'BUY', target: '20', leverage: '25', maintenanceRate: '0.01', price: '80',
  initialBudget: '75.68', baseline: '0', covered: {} })) as PairedEntryBudget['legs'] };
const order = (patch: Partial<EntryOrder> = {}): EntryOrder => ({ id: 'maker', remote_order_id: 'remote-maker', client_order_id: 'client-maker',
  symbol: 'A', side: 'SELL', quantity: '10', executed_quantity: '5', state: 'PARTIALLY_FILLED', reduce_only: 0, updated_at: new Date().toISOString(), ...patch });
describe('durable paired entry responsibility', () => {
  it('does not count the paired commitment as a second new task and retains unknown exposure', () => {
    const usage = entryLegUsage(budget.legs[0], [order()]);
    expect(usage.filled.toString()).toBe('5'); expect(usage.pending.toString()).toBe('5');
    expect(usage.outstanding.toString()).toBe('20');
    expect(entryLegUsage(budget.legs[0], [order({ state: 'PENDING_SUBMIT', executed_quantity: '0' })]).pending.toString()).toBe('10');
  });
  it('credits only matched official positions and exact order identity', () => {
    const positions = [{ symbol: 'A', quantity: '5' }];
    const open = [{ orderId: 'remote-maker', clientOrderId: 'client-maker', symbol: 'A', side: 'SELL', quantity: '10', executed: '5' }];
    const covered = coverEntryBudget(budget, [order()], positions, open)!;
    expect(entryLegUsage(covered.legs[0], [order()]).outstanding.toString()).toBe('10');
    expect(coverEntryBudget(budget, [order()], [], open)).toBeNull();
    expect(coverEntryBudget(budget, [order()], positions, [{ ...open[0], orderId: 'foreign' }])).toBeNull();
    expect(coverEntryBudget(budget, [order({ state: 'PENDING_SUBMIT' })], positions, open)).toBeNull();
  });
  it('returns cancelled unfilled quantity to the same task instead of discarding its remaining target', () => {
    const leg = { ...budget.legs[0], covered: { maker: '10' } };
    expect(entryLegUsage(leg, [order({ state: 'CANCELLED' })]).outstanding.toString()).toBe('15');
    expect(() => entryLegUsage(leg, [order({ quantity: '21' })])).toThrow('paired_entry_quantity_exceeded');
  });
  it('retains existing fee and initial-margin padding without inventing a prediction model', () => {
    const cost = entryCosts('20', '80', '25', '0.01', true);
    expect(cost.initial.toString()).toBe('75.68'); expect(cost.maintenance.toString()).toBe('20.8');
  });
});
