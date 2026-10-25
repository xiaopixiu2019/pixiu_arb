import { Decimal } from 'decimal.js';
import { z } from 'zod';
import type { TransactionFeeStore, StoredFeeTrade } from './transaction-fee-store.js';
import type { FeeBinding } from './transaction-fee-model.js';
import { managedLegs } from './managed-position-manager.js';

interface State {
  groupId?: string; transferredTo?: string; phase?: string; adoptedLeft?: string; adoptedRight?: string;
  leftQuantity?: string | null; rightQuantity?: string | null; adoptedAt?: string; verified?: boolean;
  adoptionBaseline?: Array<{ symbol: string; quantity: string; unrealizedPnl: string | null }>;
}
const stateSchema = z.object({
  groupId: z.string().optional(), transferredTo: z.string().optional(), phase: z.string().optional(),
  adoptedLeft: z.string().optional(), adoptedRight: z.string().optional(), leftQuantity: z.string().nullable().optional(), rightQuantity: z.string().nullable().optional(),
  adoptedAt: z.string().optional(), verified: z.boolean().optional(),
  adoptionBaseline: z.array(z.object({ symbol: z.string(), quantity: z.string(), unrealizedPnl: z.string().nullable() })).optional(),
});
export interface TradingTask {
  id: string; status: string; created_at: string; stopped_at: string | null; config_json: string;
  state_json: string | null; state: State; invalidState?: boolean;
  filled_left: string; filled_right: string; open_position: string;
}
export interface TradingGroup {
  id: string; tasks: TradingTask[]; tail: TradingTask; bindings: FeeBinding[]; trades: StoredFeeTrade[];
  symbols: string[]; from: number; to: number; closed: boolean; issues: string[];
  quantities: Record<string, string>; external: boolean; latestFillAt: number; executionOnly: boolean;
}
const terminal = new Set(['COMPLETED', 'STOPPED', 'CANCELLED', 'FAILED']);
export function decimal(value: unknown): Decimal | null {
  try { const n = typeof value === 'string' && value.trim() ? new Decimal(value) : null; return n?.isFinite() ? n : null; }
  catch { return null; }
}
export function readTradingTasks(fees: TransactionFeeStore, profile: string): TradingTask[] {
  const rows = fees.reportTasks(profile);
  return rows.map(row => {
    try { return { ...row, state: stateSchema.parse(row.state_json ? JSON.parse(row.state_json) : {}) }; }
    catch { return { ...row, state: {}, invalidState: true }; }
  });
}
function chainIssues(id: string, tasks: TradingTask[]): string[] {
  const seen = new Set<string>(); let task = tasks.find(t => t.id === id);
  if (!task) return ['transfer_unverified'];
  while (task) {
    if (seen.has(task.id)) return ['transfer_unverified']; seen.add(task.id);
    if (!task.state.transferredTo) break;
    const next = tasks.find(t => t.id === task!.state.transferredTo);
    if (!next || task.state.phase !== 'TRANSFERRED') return ['transfer_unverified'];
    if (!['left', 'right'].every(side => decimal(task!.state[`${side}Quantity` as 'leftQuantity'])?.eq(decimal(next.state[side === 'left' ? 'adoptedLeft' : 'adoptedRight']) ?? NaN))) return ['transfer_unverified'];
    try {
      const a = JSON.parse(task.config_json), b = JSON.parse(next.config_json);
      if (!['asset', 'leftVenue', 'rightVenue', 'leftSide', 'rightSide'].every(k => a[k] === b[k])) return ['transfer_unverified'];
    } catch { return ['transfer_unverified']; }
    if (!Number.isFinite(Date.parse(next.state.adoptedAt ?? '')) || Date.parse(task.stopped_at ?? '') < Date.parse(next.state.adoptedAt!)) return ['transfer_unverified'];
    task = next;
  }
  return seen.size === tasks.length ? [] : ['transfer_unverified'];
}
function ownedTrades(bindings: FeeBinding[], trades: StoredFeeTrade[]): StoredFeeTrade[] {
  return trades.filter(t => bindings.some(b => b.venue === t.exchange_type && b.order_id === t.order_id && b.symbol === t.symbol && b.client_order_id === t.text));
}
function orderIssues(fees: TransactionFeeStore, tasks: TradingTask[], bindings: FeeBinding[], trades: StoredFeeTrade[]): string[] {
  const issues: string[] = [];
  for (const b of bindings) {
    const fills = trades.filter(t => t.exchange_type === b.venue && t.order_id === b.order_id);
    if (!b.symbol || !decimal(b.quantity)?.eq(fills.reduce((n, t) => n.plus(decimal(t.qty) ?? NaN), new Decimal(0)))) issues.push('fill_coverage_incomplete');
  }
  for (const t of tasks) {
    const orders = fees.db.prepare('SELECT remote_order_id,venue,state,executed_quantity FROM execution_orders WHERE strategy_id=?').all(t.id) as Array<{ remote_order_id: string | null; venue: string; state: string; executed_quantity: string }>;
    if (orders.some(o => ['PENDING_SUBMIT', 'PENDING_CANCEL'].includes(o.state))) issues.push('order_reconciliation_pending');
    if (terminal.has(t.status) && orders.some(o => !['FILLED', 'CANCELLED', 'REJECT', 'REJECTED', 'FAIL'].includes(o.state))) issues.push('order_reconciliation_pending');
    if (orders.some(o => !decimal(o.executed_quantity) || decimal(o.executed_quantity)!.gt(0) && !bindings.some(b => b.order_id === o.remote_order_id && b.venue === o.venue && decimal(b.quantity)?.eq(o.executed_quantity)))) issues.push('fill_coverage_incomplete');
  }
  return issues;
}
function adoptionQuantity(task: TradingTask, symbol: string): Decimal | null {
  try {
    const legs = managedLegs(JSON.parse(task.config_json)), index = legs.findIndex(leg => leg.symbol === symbol);
    if (index < 0 || !['BUY', 'SELL'].includes(legs[index].side)) return null;
    const raw = decimal(task.state.adoptionBaseline?.find(b => b.symbol === symbol)?.quantity);
    const expected = decimal(task.state[index === 0 ? 'adoptedLeft' : 'adoptedRight']);
    return raw && expected && raw.abs().eq(expected) ? raw.abs().mul(legs[index].side === 'BUY' ? 1 : -1) : null;
  } catch { return null; }
}
function buildGroup(id: string, tasks: TradingTask[], fees: TransactionFeeStore, bindings: FeeBinding[], all: StoredFeeTrade[], now: number): TradingGroup {
  const trades = ownedTrades(bindings, all);
  const root = tasks.find(t => t.id === id) ?? tasks[0], tail = tasks.find(t => !t.state.transferredTo) ?? root;
  const issues = [...chainIssues(id, tasks), ...orderIssues(fees, tasks, bindings, trades)];
  if (tasks.some(t => t.invalidState)) issues.push('invalid_evidence');
  if (!trades.length && tasks.some(t => [t.filled_left, t.filled_right, t.open_position].some(q => !decimal(q)?.isZero()))) issues.push('fill_coverage_incomplete');
  if (trades.some(t => t.conflict || !['BUY', 'SELL'].includes(t.side) || !decimal(t.qty)?.gt(0) || !decimal(t.rpnl) || !decimal(t.fee))) issues.push('invalid_trade_evidence');
  const external = [root.state.adoptedLeft, root.state.adoptedRight].some(q => decimal(q)?.gt(0));
  let executionOnly = false;
  try { executionOnly = !external && tasks.every(t => JSON.parse(t.config_json).reduceOnly === true); } catch { issues.push('invalid_evidence'); }
  const symbols = [...new Set([...bindings.flatMap(b => b.symbol ? [b.symbol] : []), ...(external ? root.state.adoptionBaseline?.map(b => b.symbol) ?? [] : [])])];
  const quantities: Record<string, string> = {};
  for (const symbol of symbols) {
    const baseline = external ? adoptionQuantity(root, symbol) : new Decimal(0);
    if (!baseline) issues.push('adopted_basis_unverified');
    quantities[symbol] = trades.filter(t => t.symbol === symbol).reduce((n, t) => n.plus((decimal(t.qty) ?? new Decimal(NaN)).mul(t.side === 'BUY' ? 1 : -1)), baseline ?? new Decimal(0)).toFixed();
    if (executionOnly) quantities[symbol] = '0'; // Execution scope reports reductions, not ownership of the pre-existing position.
  }
  const from = trades.length || external ? Math.min(external ? Date.parse(root.state.adoptedAt ?? '') : Infinity, ...trades.map(t => Number(t.create_time))) : Date.parse(root.created_at);
  const flat = Object.values(quantities).every(q => decimal(q)?.isZero());
  const closed = flat && terminal.has(tail.status) && !tail.state.transferredTo;
  const to = closed ? Date.parse(tail.stopped_at ?? '') : now;
  if (!Number.isFinite(from) || !Number.isFinite(to)) issues.push('history_incomplete');
  if (tail.state.phase === 'COMPLETED' && !flat) issues.push('fill_coverage_incomplete');
  if (!executionOnly && all.some(t => symbols.includes(t.symbol) && Number(t.create_time) >= from && Number(t.create_time) <= to && !trades.includes(t))) issues.push('ownership_unverified');
  return { id, tasks, tail, bindings, trades, symbols, from, to, closed, issues: [...new Set(issues)], quantities, external, executionOnly, latestFillAt: Math.max(from, ...trades.map(t => Number(t.create_time))) };
}
export function tradingGroups(fees: TransactionFeeStore, key: string, profile: string, now: number): TradingGroup[] {
  const groups = new Map<string, TradingTask[]>();
  for (const task of readTradingTasks(fees, profile)) {
    const id = task.state.groupId ?? task.id; groups.set(id, [...(groups.get(id) ?? []), task]);
  }
  const bindings = fees.bindings(key), trades = fees.trades(key);
  return [...groups].map(([id, tasks]) => {
    const ids = new Set(tasks.map(t => t.id));
    return buildGroup(id, tasks, fees, bindings.filter(b => ids.has(b.task_id)), trades, now);
  });
}
