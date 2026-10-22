import { Decimal } from 'decimal.js';
import type { TaskPnlComponent } from '@gate-crossex/shared-types';
import { pnlComponent, type PnlEntry } from './task-performance-model.js';
import type { PnlBook } from './task-performance-store.js';
import type { TransactionFeeStore } from './transaction-fee-store.js';
import { decimal, type TradingGroup } from './task-trading-groups.js';
const types = new Map<string, PnlEntry['kind']>([['TRANSACTION', 'price'], ['TRADING_FEE', 'fees'], ['FUNDING_FEE', 'funding'], ['LIQUIDATION_FEE', 'other'], ['BANKRUPT_COMPENSATION', 'other'], ['INTEREST_ISOLATED', 'other']]);
export function venueMatches(row: PnlBook, group: TradingGroup): boolean {
  const venues = [...group.bindings.filter(b => b.symbol === row.symbol).map(b => b.venue),
    ...(group.external && !group.issues.length && group.symbols.includes(row.symbol ?? '') ? [row.symbol!.split('_')[0]] : [])];
  return row.coin === row.symbol?.split('_').at(-1) && venues.some(venue => row.exchange_type === venue
    || row.exchange_type === 'CROSSEX' && row.coin === 'USDT' && ['GATE', 'BYBIT', 'OKX', 'BINANCE'].includes(venue));
}
export function positionKey(row: PnlBook): string | null {
  const separator = row.business_id.lastIndexOf('_');
  return separator > 0 && /^\d+$/.test(row.business_id.slice(separator + 1)) ? `${row.symbol}:${row.business_id.slice(0, separator)}` : null;
}
function sharedIds(rows: PnlBook[]): Set<string> {
  const ids = new Set(rows.filter(r => r.statement_type === 'INTEREST_ISOLATED' && !r.symbol).map(r => r.id));
  const conversions = new Map<string, PnlBook[]>();
  for (const r of rows.filter(r => r.statement_type === 'KRAKEN_CONVERSION' && !r.symbol && r.business_id)) conversions.set(r.business_id, [...(conversions.get(r.business_id) ?? []), r]);
  for (const pair of conversions.values()) {
    const usd = pair.find(r => r.coin === 'USD' && r.exchange_type === 'KRAKEN'), usdt = pair.find(r => r.coin === 'USDT' && r.exchange_type === 'CROSSEX');
    if (pair.length === 2 && usd && usdt && usd.create_time === usdt.create_time && decimal(usd.change)?.mul(decimal(usdt.change) ?? NaN).lt(0)) pair.forEach(r => ids.add(r.id));
  }
  return ids;
}
export interface TradingLedger {
  rows: Map<string, PnlBook[]>; late: Map<string, PnlBook[]>; unassigned: PnlBook[];
  value(row: PnlBook): PnlEntry; accountCosts: TaskPnlComponent;
}
export function tradingLedger(rows: PnlBook[], groups: TradingGroup[], fees: TransactionFeeStore, key: string): TradingLedger {
  const feeBooks = new Map(fees.book(key).map(r => [r.id, r]));
  const value = (r: PnlBook): PnlEntry => ({ id: r.id, kind: types.get(r.statement_type) ?? 'other', coin: r.coin, change: r.change,
    rate: (r.statement_type === 'TRADING_FEE' ? feeBooks.get(r.id)?.rate : null) ?? fees.rateAt(key, r.coin, Number(r.create_time)), conflict: r.conflict || !!feeBooks.get(r.id)?.conflict });
  const shared = sharedIds(rows), assigned = new Map<string, PnlBook[]>(), late = new Map<string, PnlBook[]>(), unassigned: PnlBook[] = [];
  const links = new Map<string, Set<string>>();
  for (const r of rows.filter(r => r.statement_type === 'FUNDING_FEE')) {
    const pk = positionKey(r); if (!pk) continue;
    const owners = links.get(pk) ?? new Set<string>();
    for (const g of groups) if (!g.executionOnly && g.symbols.includes(r.symbol ?? '') && Number(r.create_time) >= g.from && Number(r.create_time) <= g.to && venueMatches(r, g)) owners.add(g.id);
    links.set(pk, owners);
  }
  for (const r of rows.filter(r => !shared.has(r.id) && !['TRANSFER_IN', 'TRANSFER_OUT'].includes(r.statement_type))) {
    let owners: TradingGroup[];
    if (r.statement_type === 'FUNDING_FEE') {
      const candidates = positionKey(r) ? links.get(positionKey(r)!) : undefined;
      owners = candidates?.size === 1 ? groups.filter(g => candidates.has(g.id) && !g.issues.length && venueMatches(r, g) && Number(r.create_time) >= g.from) : [];
    } else owners = groups.filter(g => venueMatches(r, g) && g.bindings.some(b => b.symbol === r.symbol && b.order_id === r.business_id));
    if (owners.length !== 1) { unassigned.push(r); continue; }
    const g = owners[0], dest = r.statement_type === 'FUNDING_FEE' && Number(r.create_time) > g.to ? late : assigned;
    dest.set(g.id, [...(dest.get(g.id) ?? []), r]);
  }
  return { rows: assigned, late, unassigned, value, accountCosts: pnlComponent(rows.filter(r => shared.has(r.id)).map(value)) };
}
function expectedEntries(g: TradingGroup, fees: TransactionFeeStore, key: string, rows: PnlBook[], value: TradingLedger['value']): { entries: PnlEntry[]; estimated: boolean; issues: string[] } {
  const entries = rows.map(value), issues: string[] = []; let estimated = false;
  for (const b of g.bindings) {
    const trades = g.trades.filter(t => t.exchange_type === b.venue && t.order_id === b.order_id);
    for (const [type, kind] of [['TRANSACTION', 'price'], ['TRADING_FEE', 'fees']] as const) {
      const coins = type === 'TRANSACTION' ? [b.symbol!.split('_').at(-1)!] : [...new Set(trades.map(t => t.fee_coin))];
      for (const coin of coins) {
        const fills = trades.filter(t => type === 'TRANSACTION' || t.fee_coin === coin);
        const bills = rows.filter(r => r.statement_type === type && r.business_id === b.order_id && r.symbol === b.symbol && r.coin === coin);
        for (const positive of [true, false]) {
          const part = (v: string) => positive ? Decimal.max(0, v) : Decimal.min(0, v);
          const expected = fills.reduce((n, t) => n.plus(part(type === 'TRANSACTION' ? t.rpnl : new Decimal(t.fee).negated().toFixed())), new Decimal(0));
          const actual = bills.reduce((n, r) => n.plus(part(r.change)), new Decimal(0));
          if (type === 'TRANSACTION' && actual.abs().gt(expected.abs())) issues.push('price_evidence_conflict');
          if (expected.abs().gt(actual.abs())) {
            estimated = true;
            const valuedFills = fills.map(t => {
              const change = part(type === 'TRANSACTION' ? t.rpnl : new Decimal(t.fee).negated().toFixed());
              const rate = fees.rateAt(key, coin, Number(t.create_time));
              return change.isZero() ? change : rate === null ? new Decimal(NaN) : change.mul(rate);
            }).reduce((a, n) => a.plus(n), new Decimal(0));
            const valuedBills = bills.reduce((n, r) => { const e = value(r); return n.plus(e.rate === null ? NaN : part(r.change).mul(e.rate)); }, new Decimal(0));
            if (!coin || !valuedFills.isFinite() || !valuedBills.isFinite()) { issues.push('missing_historical_fx'); continue; }
            entries.push({ id: `provisional:${b.venue}:${b.order_id}:${type}:${coin}:${positive}`, kind, coin: 'USDT', change: valuedFills.minus(valuedBills).toFixed(), rate: '1', conflict: false });
          }
        }
      }
    }
  }
  return { entries, estimated, issues };
}
export function tradingCash(g: TradingGroup, ledger: TradingLedger, fees: TransactionFeeStore, key: string) {
  const rows = ledger.rows.get(g.id) ?? [], late = ledger.late.get(g.id) ?? [];
  const calculated = expectedEntries(g, fees, key, rows, ledger.value), issues = [...calculated.issues];
  if (rows.some(r => !types.has(r.statement_type))) issues.push('unclassified_ledger');
  if (ledger.unassigned.some(r => g.executionOnly ? r.statement_type !== 'FUNDING_FEE' && g.bindings.some(b => b.order_id === r.business_id && b.symbol === r.symbol)
    : Number(r.create_time) >= g.from && Number(r.create_time) <= g.to + 60000 && (!r.symbol || g.symbols.includes(r.symbol)))) issues.push('unallocated_trade_evidence');
  const subtotal = pnlComponent(calculated.entries), confirmed = pnlComponent(rows.map(ledger.value)), adjustment = pnlComponent(late.map(ledger.value));
  if (subtotal.amount === null || adjustment.amount === null) issues.push('invalid_or_unpriced_evidence');
  const error = late.reduce((sum, r) => { const e = ledger.value(r); return sum.plus(e.rate === null ? NaN : new Decimal(e.change).mul(e.rate).abs()); }, new Decimal('0.005'));
  const component = (kind: PnlEntry['kind']) => pnlComponent(rows.map(ledger.value).filter(r => r.kind === kind));
  return { confirmed: confirmed.amount, subtotal: subtotal.amount, adjustment: adjustment.amount ?? '0', estimated: calculated.estimated || late.length > 0,
    components: { price: component('price'), funding: component('funding'), fees: component('fees'), other: component('other') },
    provisionalCashflows: confirmed.amount !== null && subtotal.amount !== null ? new Decimal(subtotal.amount).minus(confirmed.amount).toFixed() : '0',
    provisional: calculated.estimated, error: late.length && error.isFinite() ? error.toFixed() : null, issues };
}
