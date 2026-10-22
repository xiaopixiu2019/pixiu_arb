import { Decimal as BaseDecimal } from 'decimal.js';
import type { GateCrossExAccount, GateCrossExRiskLimit } from './crossex-client.js';
import { MarginRiskParametersSchema, marginParametersId, type MarginRiskParameters } from './margin-risk-parameters.js';
type Decimal = BaseDecimal;
const Decimal = BaseDecimal.clone({ precision: 200 });

export interface ProjectionLeg {
  symbol: string; pool: string; quantity: string; mark: string; leverage: string; initial: string; maintenance: string;
  fee: string; slip: string; tiers: GateCrossExRiskLimit['tiers'];
}
export interface ProjectedMargin { equity: Decimal; initial: Decimal; maintenance: Decimal; debts: Record<string, string> }
type Pool = MarginRiskParameters['pools'][number];
const number = (v: string): Decimal => { const n = new Decimal(v); if (!n.isFinite()) throw new Error('margin_projection_invalid_number'); return n; };
const approx = (a: Decimal, b: Decimal) => a.minus(b).abs().lte('0.000001');
function validateRanges(rows: Array<{ min: string; max: string }>): void {
  rows.forEach((t, i) => {
    if (number(t.max).lte(t.min) || i && !number(t.min).eq(rows[i - 1].max)) throw new Error('margin_projection_rules_invalid');
  });
}
function borrowing(pool: Pool, debt: Decimal) {
  if (debt.isZero()) return { initial: new Decimal(0), maintenance: new Decimal(0) };
  const t = pool.debtTiers.find((r, i) => debt.gte(r.min) && (debt.lt(r.max) || i === pool.debtTiers.length - 1 && debt.eq(r.max)));
  if (!t) throw new Error('margin_borrowing_range_unverified');
  const initial = debt.mul(t.initialRate).plus(t.initialOffset), maintenance = debt.mul(t.maintenanceRate).plus(t.maintenanceOffset);
  if (initial.lt(0) || maintenance.lt(0)) throw new Error('margin_projection_rules_invalid');
  return { initial, maintenance };
}
export function borrowingAccountCalibrated(account: GateCrossExAccount, raw: MarginRiskParameters,
  subject: { profileId: string; userId: string }, now: number, keys?: string[]): boolean {
  try {
    const p = MarginRiskParametersSchema.parse(raw);
    if (p.profileId !== subject.profileId || p.userId !== subject.userId || p.userId !== account.user_id ||
      p.checkedAt > now || p.validUntil <= now || account.account_mode !== 'CROSS_EXCHANGE') return false;
    validatePools(account, new Map(p.pools.map(pool => [pool.key, pool])), keys ?? p.pools.map(pool => pool.key));
    return true;
  } catch { return false; }
}
function collateral(pool: Pool, equity: Decimal): Decimal {
  if (equity.lte(0)) return equity;
  const t = pool.collateralTiers.find((r, i) => equity.gte(r.min) && (equity.lt(r.max) || i === pool.collateralTiers.length - 1 && equity.eq(r.max)));
  if (!t) throw new Error('margin_collateral_range_unverified');
  const value = equity.mul(t.rate).plus(t.offset);
  if (value.lt(0) || value.gt(equity)) throw new Error('margin_projection_rules_invalid');
  return value;
}
export function remainingMargin(leg: ProjectionLeg, quantity: Decimal) {
  const remaining = number(leg.quantity).minus(quantity), value = remaining.mul(leg.mark);
  if (remaining.lt(0) || quantity.lt(0)) throw new Error('margin_projection_quantity_invalid');
  if (remaining.isZero()) return { initial: new Decimal(0), maintenance: new Decimal(0) };
  const tier = leg.tiers.find(t => value.gte(t.min_risk_limit_value) && value.lte(t.max_risk_limit_value));
  if (!tier) throw new Error('margin_projection_position_tier_missing');
  const initial = value.mul(new Decimal(1).div(leg.leverage).plus('0.00075'));
  const maintenance = value.mul(new Decimal(tier.maintenance_rate).plus('0.00075')).minus(tier.quick_cal_amount);
  if (!initial.isFinite() || !maintenance.isFinite() || initial.lt(0) || maintenance.lt(0)) throw new Error('margin_projection_position_tier_invalid');
  return { initial, maintenance };
}

export function createAccountProjection(account: GateCrossExAccount, legs: ProjectionLeg[], raw: MarginRiskParameters,
  subject: { profileId: string; userId: string }, now: number) {
  const p = MarginRiskParametersSchema.parse(raw);
  if (p.profileId !== subject.profileId || p.userId !== subject.userId || p.userId !== account.user_id || account.account_mode !== 'CROSS_EXCHANGE')
    throw new Error('margin_projection_account_mismatch');
  if (now < p.checkedAt || now >= p.validUntil) throw new Error('margin_projection_parameters_expired');
  if (legs.length !== 2 || new Set(legs.map(l => l.symbol)).size !== 2) throw new Error('margin_projection_legs_invalid');
  const pools = new Map(p.pools.map(pool => [pool.key, pool]));
  const budgets = bindBudgets(legs, p, pools);
  const assets = validatePools(account, pools, [...new Set([...budgets.keys(), ...legs.map(l => l.pool)])]);
  const knownInitial = legs.reduce((n, l) => n.plus(number(l.initial).mul(pools.get(l.pool)!.fxLow)), new Decimal(0))
    .plus([...assets].reduce((n, [key, a]) => n.plus(number(a.borrowing_initial_margin).mul(pools.get(key)!.fxLow)), new Decimal(0)));
  const knownMaintenance = legs.reduce((n, l) => n.plus(number(l.maintenance).mul(pools.get(l.pool)!.fxLow)), new Decimal(0))
    .plus([...assets].reduce((n, [key, a]) => n.plus(number(a.borrowing_maintenance_margin).mul(pools.get(key)!.fxLow)), new Decimal(0)));
  if (knownInitial.minus(account.initial_margin).gt('0.000001') || knownMaintenance.minus(account.maintenance_margin).gt('0.000001'))
    throw new Error('margin_projection_account_calibration_failed');
  const evaluate = (q: [string, string]) => evaluateAccount(account, legs, pools, budgets, assets, q);
  return { evaluate, parametersId: marginParametersId(p), validUntil: p.validUntil, feeRules: p.fees.filter(f => legs.some(l => l.symbol === f.symbol)),
    checkpoints: (upper: string) => checkpoints(legs, pools, budgets, assets, number(upper)),
    linearWithin: (upper: string, step: string) => {
      try {
        const limit = number(upper), probe = Decimal.min(step, limit);
        if (probe.lte(0) || checkpoints(legs, pools, budgets, assets, limit, false).some(x => number(x).gt(0) && number(x).lt(limit))) return false;
        return ([[probe.toFixed(), probe.toFixed()], [probe.toFixed(), '0'], ['0', probe.toFixed()]] as [string, string][]).every(q => {
          const small = evaluate(q), end = evaluate(q.map(x => number(x).isZero() ? '0' : limit.toFixed()) as [string, string]);
          return (['equity', 'initial', 'maintenance'] as const).every(k => {
            const base = number(k === 'equity' ? account.margin_balance : k === 'initial' ? account.initial_margin : account.maintenance_margin);
            return approx(end[k], base.plus(small[k].minus(base).mul(limit).div(probe)));
          });
        });
      } catch { return false; }
    } };
}

function bindBudgets(legs: ProjectionLeg[], p: MarginRiskParameters, pools: Map<string, Pool>) {
  const budgets = new Map<string, Decimal>();
  const add = (key: string, cost: Decimal) => budgets.set(key, (budgets.get(key) ?? new Decimal(0)).plus(cost));
  for (const l of legs) {
    const settlement = pools.get(l.pool), feeKey = p.fees.find(f => f.symbol === l.symbol)?.pool, fee = feeKey ? pools.get(feeKey) : null;
    if (!settlement || !fee || !feeKey) throw new Error('margin_projection_pool_unverified');
    if ([l.fee, l.slip].some(v => number(v).lt(0)) || [l.quantity, l.mark, l.leverage].some(v => number(v).lte(0))) throw new Error('margin_projection_invalid_number');
    add(l.pool, number(l.slip)); add(feeKey, number(l.fee).mul(settlement.fxHigh).div(fee.fxLow));
    const before = remainingMargin(l, new Decimal(0));
    if (!approx(before.initial, number(l.initial)) || !approx(before.maintenance, number(l.maintenance))) throw new Error('margin_position_calibration_failed');
  }
  return budgets;
}

function evaluateAccount(account: GateCrossExAccount, legs: ProjectionLeg[], pools: Map<string, Pool>, budgets: Map<string, Decimal>,
  assets: Map<string, GateCrossExAccount['assets'][number]>, quantities: [string, string]): ProjectedMargin {
    const q = quantities.map(number), budgetQuantity = Decimal.max(...q);
    let equity = number(account.margin_balance), initial = number(account.initial_margin), maintenance = number(account.maintenance_margin);
    const debts: Record<string, string> = {};
    for (const [key, a] of assets) {
      const pool = pools.get(key)!, cost = (budgets.get(key) ?? new Decimal(0)).mul(budgetQuantity);
      const d = Decimal.max(0, number(a.available_balance).plus(a.upnl).minus(cost).neg());
      const before = borrowing(pool, number(a.liability)), after = borrowing(pool, d); debts[key] = d.toString();
      equity = equity.plus(Decimal.min(0, collateral(pool, number(a.equity).minus(cost)).minus(collateral(pool, number(a.equity)))).mul(pool.fxHigh));
      initial = initial.plus(Decimal.max(0, after.initial.minus(before.initial)).mul(pool.fxHigh));
      maintenance = maintenance.plus(Decimal.max(0, after.maintenance.minus(before.maintenance)).mul(pool.fxHigh));
    }
    legs.forEach((leg, i) => {
      const after = remainingMargin(leg, q[i]), fx = pools.get(leg.pool)!.fxLow;
      const im = number(leg.initial).minus(after.initial), mm = number(leg.maintenance).minus(after.maintenance);
      if (im.lt(0) || mm.lt(0)) throw new Error('margin_projection_release_invalid');
      initial = initial.minus(im.mul(fx)); maintenance = maintenance.minus(mm.mul(fx));
    });
    if (initial.lt(0) || maintenance.lt(0)) throw new Error('margin_projection_account_calibration_failed');
    return { equity, initial, maintenance, debts };
}

function validatePools(account: GateCrossExAccount, pools: Map<string, Pool>, keys: string[]) {
  const result = new Map<string, GateCrossExAccount['assets'][number]>();
  for (const key of keys) {
    const pool = pools.get(key)!;
    if (number(pool.fxLow).gt(pool.fxHigh) || key.endsWith(':USDT') && (!number(pool.fxLow).eq(1) || !number(pool.fxHigh).eq(1))) throw new Error('margin_projection_valuation_invalid');
    validateRanges(pool.debtTiers); validateRanges(pool.collateralTiers);
    const rows = account.assets.filter(a => `${a.exchange_type}:${a.coin}` === key);
    if (rows.length !== 1) throw new Error('margin_projection_pool_unverified');
    const a = rows[0], debt = Decimal.max(0, number(a.available_balance).plus(a.upnl).neg());
    if (!approx(debt, number(a.liability))) throw new Error('margin_borrowing_calibration_failed');
    const observed = borrowing(pool, debt);
    if (!approx(observed.initial, number(a.borrowing_initial_margin)) || !approx(observed.maintenance, number(a.borrowing_maintenance_margin)))
      throw new Error('margin_borrowing_calibration_failed');
    collateral(pool, number(a.equity)); result.set(key, a);
  }
  return result;
}
function checkpoints(legs: ProjectionLeg[], pools: Map<string, Pool>, budgets: Map<string, Decimal>,
  assets: Map<string, GateCrossExAccount['assets'][number]>, upper: Decimal, sides = true): string[] {
  const values = [new Decimal(0), upper];
  for (const l of legs) for (const t of l.tiers) for (const v of [t.min_risk_limit_value, t.max_risk_limit_value]) values.push(number(l.quantity).minus(number(v).div(l.mark)));
  for (const [key, a] of assets) {
    const cost = budgets.get(key) ?? new Decimal(0); if (cost.isZero()) continue;
    const pool = pools.get(key)!, available = number(a.available_balance).plus(a.upnl), equity = number(a.equity);
    values.push(available.div(cost), equity.div(cost));
    for (const t of pool.debtTiers) for (const bound of [t.min, t.max]) values.push(available.plus(bound).div(cost));
    for (const t of pool.collateralTiers) for (const bound of [t.min, t.max]) values.push(equity.minus(bound).div(cost));
  }
  // Both sides of discontinuous debt/discount tiers are checked; never round an order to these probes.
  const epsilon = new Decimal('0.000000000001');
  return [...new Set(values.flatMap(v => sides ? [v, v.minus(epsilon), v.plus(epsilon)] : [v])
    .filter(v => v.gte(0) && v.lte(upper)).map(v => v.toString()))];
}
export type AccountProjection = ReturnType<typeof createAccountProjection> & { approximate?: boolean; costPerUnit?: string; feePerUnit?: string;
  executionLegs?: Array<{ symbol: string; mark: string; side: 'BUY' | 'SELL'; feeRate: string; fx?: string }> };
