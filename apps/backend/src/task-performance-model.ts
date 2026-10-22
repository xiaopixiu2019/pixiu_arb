import { Decimal } from 'decimal.js';
import type { TaskPerformance, TaskPnlComponent } from '@gate-crossex/shared-types';
export type PnlKind = 'price' | 'funding' | 'fees' | 'other';
export interface PnlEntry { id: string; kind: PnlKind; change: string; coin: string; rate: string | null; conflict: boolean }
export function pnlComponent(entries: PnlEntry[]): TaskPnlComponent {
  const native: Record<string, string> = {}; let total = new Decimal(0), valid = true;
  for (const e of entries) {
    try {
      const change = new Decimal(e.change), rate = e.rate === null ? null : new Decimal(e.rate);
      if (!change.isFinite() || e.conflict) { valid = false; continue; }
      native[e.coin] = new Decimal(native[e.coin] ?? 0).plus(change).toFixed();
      if (!rate?.isFinite() || !rate.gt(0)) valid = false;
      else total = total.plus(change.mul(rate));
    } catch { valid = false; }
  }
  return { amount: valid ? total.toFixed() : null, native, count: entries.length };
}
export function taskPnl(taskId: string, rows: PnlEntry[], issues: string[], closed: boolean, checkedAt: number | null): TaskPerformance {
  const unique = new Map<string, PnlEntry>(), reasons = new Set(issues);
  for (const r of rows) {
    const old = unique.get(r.id);
    if (old && JSON.stringify(old) !== JSON.stringify(r)) reasons.add('conflicting_evidence');
    else unique.set(r.id, r);
    if (r.conflict) reasons.add('conflicting_evidence');
    if (r.rate === null) reasons.add('missing_historical_fx');
  }
  const entries = [...unique.values()], total = pnlComponent(entries);
  if (total.amount === null && !reasons.size) reasons.add('invalid_evidence');
  const component=(kind:PnlKind):TaskPnlComponent=>{
    const selected=entries.filter(e=>e.kind===kind),value=pnlComponent(selected);
    return !selected.length && (reasons.size>0 || !closed)?{...value,amount:null}:value;
  };
  return { taskId, currency: 'USDT', amount: closed && !reasons.size ? total.amount : null,
    status: !closed ? 'open' : reasons.size ? 'pending' : 'settled', reasons: [...reasons], checkedAt, native: total.native,
    price: component('price'), funding: component('funding'), fees: component('fees'), other: component('other') };
}
