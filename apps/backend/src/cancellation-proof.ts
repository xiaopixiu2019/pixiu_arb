import { Decimal } from 'decimal.js';
import { GateApiError, type GateCrossExOrder } from './crossex-client.js';
import type { ExecutionOrder } from './trading-runtime.js';

// REJECT is an observed CrossEx state; REJECTED is retained for older normalized evidence.
export const TERMINAL_ORDER_STATES = ['FILLED', 'CANCELLED', 'FAIL', 'REJECT', 'REJECTED'] as const;

export function confirmedOrderTerminal(order: ExecutionOrder): boolean {
  try {
    const total = new Decimal(order.quantity), filled = new Decimal(order.executedQuantity);
    if (!total.isFinite() || !total.gt(0) || !filled.isFinite() || filled.lt(0) || filled.gt(total)) return false;
    return order.state === 'FILLED' ? filled.eq(total) : order.state === 'CANCELLED'
      || ['FAIL', 'REJECT', 'REJECTED'].includes(order.state) && filled.isZero() && !!order.failureReason?.trim();
  } catch { return false; }
}

export function assertCancellationIdentity(local: ExecutionOrder, remote: GateCrossExOrder): void {
  const clients = [remote.text?.trim(), remote.client_order_id?.trim()].filter(Boolean);
  const quantity = new Decimal(remote.qty), filled = new Decimal(remote.executed_qty);
  if (!local.remoteOrderId || remote.order_id !== local.remoteOrderId
    || clients.some(client => client !== local.clientOrderId) || remote.symbol !== local.symbol || remote.side !== local.side
    || remote.type !== local.type || remote.time_in_force !== local.timeInForce
    || remote.reduce_only !== String(local.reduceOnly) || !quantity.eq(local.quantity)
    || local.type === 'LIMIT' && (local.price === null || !new Decimal(remote.price).eq(local.price))
    || !filled.isFinite() || filled.lt(local.executedQuantity) || filled.gt(quantity)
    || remote.state === 'FILLED' && !filled.eq(quantity)
    || ['FAIL', 'REJECT', 'REJECTED'].includes(remote.state) && (!filled.isZero() || !remote.reason?.trim())
    || !['NEW', 'OPEN', 'PARTIALLY_FILLED', ...TERMINAL_ORDER_STATES].includes(remote.state))
    throw new Error('cancel_reconciliation_evidence_conflict');
}

/** Read/push evidence only. A missing order is never permission to replay a write. */
export function reconcileMissingCancellation(input: {
  original: ExecutionOrder; error: unknown; deadline: number;
  current: () => ExecutionOrder;
  query: () => Promise<GateCrossExOrder>;
  apply: (remote: GateCrossExOrder) => ExecutionOrder;
  listen: (callback: (order: ExecutionOrder) => void) => () => void;
}): Promise<ExecutionOrder> {
  return new Promise((resolve, reject) => {
    let done = false, pollTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (order?: ExecutionOrder, error = input.error) => {
      if (done) return;
      done = true; clearTimeout(deadlineTimer); clearTimeout(pollTimer); unsubscribe();
      if (order) resolve(order); else reject(error);
    };
    const inspect = (order: ExecutionOrder) => {
      if (Date.now() >= input.deadline) { finish(); return; }
      if (order.id === input.original.id && order.remoteOrderId === input.original.remoteOrderId
        && order.clientOrderId === input.original.clientOrderId && order.quantity === input.original.quantity
        && confirmedOrderTerminal(order) && new Decimal(order.executedQuantity).gte(input.original.executedQuantity)) finish(order);
    };
    const unsubscribe = input.listen(inspect);
    const deadlineTimer = setTimeout(() => finish(), Math.max(0, input.deadline - Date.now()));
    const poll = async () => {
      if (done || Date.now() >= input.deadline) { finish(); return; }
      inspect(input.current()); if (done) return;
      try {
        const remote = await input.query();
        if (done || Date.now() >= input.deadline) { finish(); return; }
        assertCancellationIdentity(input.current(), remote);
        inspect(input.apply(remote));
      } catch (error) {
        if (done) return;
        if (!(error instanceof GateApiError) || !['ORDER_NOT_FOUND', 'TRADE_ORDER_NOT_FOUND_ERROR'].includes(error.label)) {
          finish(undefined, error instanceof GateApiError ? input.error : error); return;
        }
      }
      if (!done) pollTimer = setTimeout(() => void poll(), 250);
    };
    if (Date.now() >= input.deadline) finish();
    else { inspect(input.current()); if (!done) void poll(); }
  });
}
