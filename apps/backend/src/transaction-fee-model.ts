import { Decimal } from 'decimal.js';
import type { FeeMetric, FeeEvidence } from '@gate-crossex/shared-types';
import type { GateAccountBookRecord } from './crossex-client.js';
export type FeePhase = FeeEvidence['phase'];
export interface FeeEpoch { account_key: string; profile_id: string; started_at: number; covered_to: number; checked_at: number | null; book_reason: string | null; trade_reason: string | null; trades_to: number }
export interface FeeBookRow { id: string; at: number; venue: string; order_id: string; coin: string; cost: string; usd: string | null; rate: string | null; conflict: number; payload: string }
export interface FeeBinding { venue: string; order_id: string; task_id: string; task_started_at: number; phase: FeePhase; leg: string | null; client_order_id: string; symbol?: string | null; quantity?: string | null; order_at?: number | null }
export function strictDecimal(value: string): Decimal {
  if (!/^-?\d+(?:\.\d+)?$/.test(value)) throw new Error('invalid_fee_amount');
  const result = new Decimal(value); if (!result.isFinite()) throw new Error('invalid_fee_amount'); return result;
}
export function feeBookRecord(record: GateAccountBookRecord, rate: string | null): FeeBookRow {
  const at = Number(record.create_time);
  if (record.statement_type !== 'TRADING_FEE' || !Number.isSafeInteger(at) || at < 0 || !/^[A-Z0-9]{1,20}$/.test(record.coin) || !record.id || !record.business_id) throw new Error('invalid_fee_record');
  const cost = strictDecimal(record.change).negated();
  const validRate = rate !== null && strictDecimal(rate).gt(0) ? rate : null;
  return { id: record.id, at, venue: record.exchange_type, order_id: record.business_id, coin: record.coin, cost: cost.toFixed(),
    usd: validRate ? cost.mul(validRate).toFixed() : null, rate: validRate, conflict: 0, payload: JSON.stringify(record) };
}
export function feeMetric(rows: FeeBookRow[], reason: string | null = null, extraPending = 0): FeeMetric {
  const valued = rows.filter((r) => r.usd !== null && !r.conflict);
  const pending = rows.length - valued.length + extraPending;
  const amount = valued.length ? valued.reduce((sum, r) => sum.plus(r.usd!), new Decimal(0)).toFixed() : pending || reason ? null : '0';
  return { amount, status: pending || reason ? amount === null ? 'unavailable' : 'partial' : 'ready', pending,
    reason: reason ?? (pending ? 'fee_evidence_pending' : null) };
}
export function feeExpenses(rows: FeeBookRow[], phase: FeePhase | 'rebates', bindings: Map<string, FeeBinding>): string | null {
  const selected = rows.filter((r) => phase === 'rebates' ? strictDecimal(r.cost).lt(0)
    : strictDecimal(r.cost).gte(0) && (bindings.get(feeOrderKey(r.venue, r.order_id))?.phase ?? 'unknown') === phase);
  return feeMetric(selected).amount === null ? null : selected.filter((r) => r.usd !== null && !r.conflict)
    .reduce((sum, r) => sum.plus(phase === 'rebates' ? new Decimal(r.usd!).negated() : r.usd!), new Decimal(0)).toFixed();
}
export function feeOrderKey(venue: string, order: string): string { return JSON.stringify([venue, order]); }
