import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { assertCancellationIdentity, confirmedOrderTerminal, reconcileMissingCancellation } from './cancellation-proof.js';
import { GateApiError, type GateCrossExOrder } from './crossex-client.js';
import type { ExecutionOrder } from './trading-runtime.js';

const local: ExecutionOrder = { id: 'local-1', remoteOrderId: 'remote-1', clientOrderId: 'client-1',
  symbol: 'GATE_FUTURE_BTC_USDT', venue: 'GATE', side: 'SELL', type: 'LIMIT', timeInForce: 'POC',
  quantity: '0.88', price: '100', reduceOnly: true, state: 'PENDING_CANCEL', executedQuantity: '0.58',
  executedAveragePrice: '100', failureReason: null, strategyId: 'PAIR-TEST', strategyLeg: 'left',
  strategyClip: 'exit', createdAt: '', updatedAt: '' };
const remote = (overrides: Partial<GateCrossExOrder> = {}) => ({ order_id: 'remote-1', text: 'client-1',
  symbol: local.symbol, side: local.side, type: local.type, time_in_force: local.timeInForce,
  reduce_only: 'true', price: '100', qty: '0.88', executed_qty: '0.88', state: 'FILLED', reason: '', ...overrides } as GateCrossExOrder);

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(10000); });
afterEach(() => { vi.useRealTimers(); });

function scenario() {
  let current = { ...local }; const listeners = new Set<(o: ExecutionOrder) => void>();
  const apply = vi.fn((r: GateCrossExOrder) => { current = { ...current, state: r.state, executedQuantity: r.executed_qty }; return current; });
  const query = vi.fn(async () => remote());
  const error = new GateApiError(404, 'TRADE_ORDER_NOT_FOUND_ERROR');
  const input = { original: local, error, deadline: Date.now() + 1000, current: () => current, query, apply,
    listen: (fn: (o: ExecutionOrder) => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; } };
  const push = (state: string, executedQuantity: string) => {
    current = { ...current, state, executedQuantity }; for (const fn of listeners) fn(current);
  };
  return { input, query, apply, push, listeners, error };
}

it.each(['REMOTE_NOT_FOUND', 'UNKNOWN', '', 'EXPIRED'])('never accepts %s as confirmed termination', state => {
  expect(confirmedOrderTerminal({ ...local, state })).toBe(false);
});
it.each(['NaN', '-1', '0.5', '0.89'])('rejects an invalid full-fill quantity %s', executedQuantity => {
  expect(confirmedOrderTerminal({ ...local, state: 'FILLED', executedQuantity })).toBe(false);
});
it('retains partial fills on a confirmed cancellation', () => {
  expect(confirmedOrderTerminal({ ...local, state: 'CANCELLED' })).toBe(true);
  expect(() => assertCancellationIdentity(local, remote({ state: 'CANCELLED', executed_qty: '0.6' }))).not.toThrow();
});
it.each(['REJECT', 'REJECTED', 'FAIL'])('preserves the known zero-fill %s outcome and its reason', state => {
  expect(confirmedOrderTerminal({ ...local, state, executedQuantity: '0', failureReason: 'post_only_reject' })).toBe(true);
  expect(confirmedOrderTerminal({ ...local, state, executedQuantity: '0', failureReason: null })).toBe(false);
});
it.each([{ order_id: 'foreign' }, { text: 'foreign' }, { client_order_id: 'foreign' }, { symbol: 'OTHER' },
  { side: 'BUY' }, { type: 'MARKET' }, { time_in_force: 'IOC' }, { reduce_only: 'false' }, { qty: '1' },
  { executed_qty: '0.57' }, { executed_qty: 'NaN' }, { executed_qty: '0.89' }, { executed_qty: '0.6' },
  { price: '99' }, { state: 'REMOTE_NOT_FOUND' }, { state: 'UNKNOWN' }])('rejects conflicting remote evidence %j', change => {
  expect(() => assertCancellationIdentity(local, remote(change))).toThrow();
});
it('accepts a private terminal push during a stalled query, then discards its late response', async () => {
  const h = scenario(); let release!: (r: GateCrossExOrder) => void;
  h.query.mockImplementation(() => new Promise(resolve => { release = resolve; }));
  const result = reconcileMissingCancellation(h.input);
  h.push('FILLED', '0.88'); await expect(result).resolves.toMatchObject({ state: 'FILLED' });
  release(remote({ state: 'OPEN', executed_qty: '0.58' })); await Promise.resolve();
  expect(h.apply).not.toHaveBeenCalled(); expect(h.listeners.size).toBe(0); expect(vi.getTimerCount()).toBe(0);
});
it('times out a hung read and never applies its late success', async () => {
  const h = scenario(); let release!: (r: GateCrossExOrder) => void;
  h.query.mockImplementation(() => new Promise(resolve => { release = resolve; }));
  const result = expect(reconcileMissingCancellation(h.input)).rejects.toBe(h.error);
  await vi.advanceTimersByTimeAsync(1000); await result;
  release(remote()); await Promise.resolve(); expect(h.apply).not.toHaveBeenCalled(); expect(h.listeners.size).toBe(0);
});
it('does not extend the deadline on repeated missing-order responses', async () => {
  const h = scenario(); h.query.mockRejectedValue(new GateApiError(404, 'ORDER_NOT_FOUND'));
  const result = expect(reconcileMissingCancellation(h.input)).rejects.toBe(h.error);
  await vi.advanceTimersByTimeAsync(1000); await result;
  expect(h.query).toHaveBeenCalledTimes(4); expect(h.apply).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
});
it('recovers delayed order details with one application and no remaining observer', async () => {
  const h = scenario(); h.query.mockRejectedValueOnce(new GateApiError(404, 'ORDER_NOT_FOUND'));
  const result = reconcileMissingCancellation(h.input); await vi.advanceTimersByTimeAsync(250);
  await expect(result).resolves.toMatchObject({ state: 'FILLED', executedQuantity: '0.88' });
  expect(h.query).toHaveBeenCalledTimes(2); expect(h.apply).toHaveBeenCalledTimes(1); expect(h.listeners.size).toBe(0);
});
it('rejects identity conflicts without applying any returned evidence', async () => {
  const h = scenario(); h.query.mockResolvedValue(remote({ order_id: 'foreign' }));
  await expect(reconcileMissingCancellation(h.input)).rejects.toThrow('cancel_reconciliation_evidence_conflict');
  expect(h.apply).not.toHaveBeenCalled(); expect(h.listeners.size).toBe(0);
});
it('cannot accept a push after the deadline even before an overdue timer runs', async () => {
  const h = scenario(); h.query.mockImplementation(() => new Promise(() => {}));
  const result = expect(reconcileMissingCancellation(h.input)).rejects.toBe(h.error);
  vi.setSystemTime(h.input.deadline + 1); h.push('FILLED', '0.88'); await result;
  expect(h.apply).not.toHaveBeenCalled(); expect(h.listeners.size).toBe(0); expect(vi.getTimerCount()).toBe(0);
});
