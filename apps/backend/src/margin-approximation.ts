import { Decimal } from 'decimal.js';
import type { GateCrossExAccount } from './crossex-client.js';
import { remainingMargin, type ProjectionLeg, type AccountProjection } from './margin-account-projection.js';

type Rates = Record<string, { initial: string; maintenance: string }>;
export type ApproximationLeg = ProjectionLeg & { loss: string; closeSide?: 'BUY' | 'SELL'; fx?: string };
const n = (v: string) => { const x = new Decimal(v); if (!x.isFinite()) throw new Error('margin_projection_invalid_number'); return x; };
export const marginTolerance = (value: string) => Decimal.max('0.01', n(value).abs().mul('0.005'));
export class BorrowingObservations {
  private context = '';
  private rows: Array<{ at: number; stamp: string; values: Rates }> = [];
  observe(account: GateCrossExAccount, context: string, at: number): void {
    if (context !== this.context) { this.rows = []; this.context = context; }
    if (this.rows.some(r => r.stamp === account.update_time)) return;
    const values: Rates = {};
    for (const a of account.assets) {
      try {
        const debt = n(a.liability), im = n(a.borrowing_initial_margin), mm = n(a.borrowing_maintenance_margin);
        if (debt.gte('0.01') && im.gt(0) && mm.gt(0)) values[`${a.exchange_type}:${a.coin}`] = {
          initial: im.div(debt).toString(), maintenance: mm.div(debt).toString() };
      } catch { /* A missing monetary field is rejected by the projection, never treated as zero. */ }
    }
    this.rows = [...this.rows.filter(r => at >= r.at && at - r.at <= 60000), { at, stamp: account.update_time, values }].slice(-3);
  }
  rates(account: GateCrossExAccount, context: string, at: number): Rates {
    if (context !== this.context || this.rows.length !== 3 || this.rows.some(r => at < r.at || at - r.at > 60000)) return {};
    const result: Rates = {};
    for (const a of account.assets) {
      const key = `${a.exchange_type}:${a.coin}`, values = this.rows.map(r => r.values[key]);
      if (values.every(Boolean)) result[key] = { initial: Decimal.max(...values.map(v => v.initial)).mul('1.25').toString(),
        maintenance: Decimal.max(...values.map(v => v.maintenance)).mul('1.25').toString() };
    }
    return result;
  }
}

export function createApproximation(account: GateCrossExAccount, legs: ApproximationLeg[], rates: Rates, now: number): AccountProjection {
  if (account.account_mode !== 'CROSS_EXCHANGE' || legs.length !== 2 || new Set(legs.map(l => l.symbol)).size !== 2)
    throw new Error('margin_projection_legs_invalid');
  if (legs.some(l => [l.quantity, l.mark, l.leverage, l.fx ?? '1'].some(v => n(v).lte(0)) ||
    [l.initial, l.maintenance, l.fee, l.slip, l.loss].some(v => n(v).lt(0)))) throw new Error('margin_projection_invalid_number');
  const assets = account.assets.filter(a => ['USDT', 'USDC', 'USD'].includes(a.coin));
  if (!assets.length || new Set(assets.map(a => `${a.exchange_type}:${a.coin}`)).size !== assets.length) throw new Error('margin_projection_pool_unverified');
  for (const a of assets) {
    for (const value of [a.equity, a.liability, a.available_balance, a.upnl, a.borrowing_initial_margin, a.borrowing_maintenance_margin]) n(value);
    if (n(a.liability).lt(0) || n(a.borrowing_initial_margin).lt(0) || n(a.borrowing_maintenance_margin).lt(0)) throw new Error('margin_projection_invalid_number');
  }
  const before = legs.map(l => remainingMargin(l, new Decimal(0)));
  if (before.some((v, i) => v.initial.minus(legs[i].initial).abs().gt(marginTolerance(legs[i].initial)) ||
    v.maintenance.minus(legs[i].maintenance).abs().gt(marginTolerance(legs[i].maintenance)))) throw new Error('margin_position_calibration_failed');
  const totals = legs.reduce((s, l) => ({ initial: s.initial.plus(n(l.initial).mul(l.fx ?? '1')), maintenance: s.maintenance.plus(n(l.maintenance).mul(l.fx ?? '1')) }), { initial: new Decimal(0), maintenance: new Decimal(0) });
  if (totals.initial.minus(account.initial_margin).gt(marginTolerance(account.initial_margin)) ||
    totals.maintenance.minus(account.maintenance_margin).gt(marginTolerance(account.maintenance_margin))) throw new Error('margin_projection_account_calibration_failed');
  const fee = legs.reduce((s, l) => s.plus(n(l.fee).mul(l.fx ?? '1')), new Decimal(0));
  const loss = legs.reduce((s, l) => s.plus(n(l.loss).mul(l.fx ?? '1')), new Decimal(0));
  const cost = legs.reduce((s, l) => s.plus(n(l.fee).plus(l.slip).mul(l.fx ?? '1')).plus(l.pool.endsWith(':USDT') ? 0 :
    n(l.loss).plus(l.fee).plus(n(l.initial).plus(l.maintenance).div(l.quantity)).mul('0.005')), new Decimal(0));
  if (fee.lt(0) || loss.lt(0) || cost.lt(0)) throw new Error('margin_projection_invalid_number');
  const evaluate = (q: [string, string]) => approximateState(account, assets, legs, before, rates, cost, loss, q);
  const checkpoints = (upper: string) => approximationPoints(legs, assets, cost.plus(loss), upper);
  return { approximate: true, costPerUnit: cost.toString(), feePerUnit: fee.mul('1.02').toString(),
    executionLegs: legs.map(l => ({ symbol: l.symbol, mark: l.mark, side: l.closeSide ?? 'SELL', feeRate: n(l.fee).div(l.mark).toString(), fx: l.fx ?? '1' })),
    evaluate, checkpoints, parametersId: 'approximate-v1', validUntil: now + 5000, feeRules: [],
    linearWithin: (upper, step) => {
      try {
        if (checkpoints(upper).some(q => n(q).gt(0) && n(q).lt(upper))) return false;
        const probe = Decimal.min(step, upper); if (probe.lte(0)) return false;
        const small = evaluate([probe.toString(), probe.toString()]), end = evaluate([upper, upper]), base = evaluate(['0', '0']);
        return (['equity', 'initial', 'maintenance'] as const).every(k => end[k].minus(base[k].plus(small[k].minus(base[k]).mul(upper).div(probe))).abs().lte('0.000001'));
      } catch { return false; }
    } };
}

function approximateState(account: GateCrossExAccount, assets: GateCrossExAccount['assets'], legs: ApproximationLeg[],
  before: Array<{ initial: Decimal; maintenance: Decimal }>, rates: Rates, cost: Decimal, loss: Decimal, quantities: [string, string]) {
  const q = quantities.map(n), reserved = Decimal.max(...q), debtBudget = cost.plus(loss).mul(reserved);
  const applicable = assets.filter(a => n(a.liability).gt(0) || n(a.available_balance).plus(a.upnl).lt(debtBudget));
  const rate = (field: 'initial' | 'maintenance') => Decimal.max(0, ...applicable.map(a => rates[`${a.exchange_type}:${a.coin}`]?.[field] ?? '1'));
  let initial = n(account.initial_margin).plus(debtBudget.mul(rate('initial')));
  let maintenance = n(account.maintenance_margin).plus(debtBudget.mul(rate('maintenance')));
  legs.forEach((l, i) => {
    const after = remainingMargin(l, q[i]), fx = l.fx ?? '1';
    initial = initial.minus(Decimal.min(l.initial, Decimal.max(0, before[i].initial.minus(after.initial))).mul(fx));
    maintenance = maintenance.minus(Decimal.min(l.maintenance, Decimal.max(0, before[i].maintenance.minus(after.maintenance))).mul(fx));
  });
  if (initial.lt(0) || maintenance.lt(0)) throw new Error('margin_projection_account_calibration_failed');
  return { equity: n(account.margin_balance).minus(cost.mul(reserved)), initial, maintenance,
    debts: Object.fromEntries(assets.map(a => [`${a.exchange_type}:${a.coin}`, a.liability])) };
}
function approximationPoints(legs: ApproximationLeg[], assets: GateCrossExAccount['assets'], cost: Decimal, upper: string): string[] {
  const points = [new Decimal(0), n(upper)];
  for (const l of legs) for (const t of l.tiers) for (const b of [t.min_risk_limit_value, t.max_risk_limit_value])
    points.push(n(l.quantity).minus(n(b).div(l.mark)));
  if (cost.gt(0)) for (const a of assets) if (n(a.liability).isZero()) {
    const boundary = n(a.available_balance).plus(a.upnl).div(cost);
    points.push(boundary, boundary.minus('0.000000000001'), boundary.plus('0.000000000001'));
  }
  return [...new Set(points.filter(p => p.gte(0) && p.lte(upper)).map(p => p.toString()))];
}
