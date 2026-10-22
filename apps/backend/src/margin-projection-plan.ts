import { Decimal } from 'decimal.js';
import type { MarginMetrics, MarginPolicy } from '@gate-crossex/shared-types';
import type { AccountProjection, ProjectedMargin } from './margin-account-projection.js';
import { Q, boundedProjection, projectionKnots, quantityRanges, rangeStates, supportedRange, feasibleUnits, verifiedEdge, safePrefixUnits } from './margin-projection-search.js';

type Anchor = Pick<MarginMetrics, 'marginBalance' | 'initialMargin' | 'maintenanceMargin'>;
function firstImpact(model: AccountProjection, before: MarginMetrics, quantity: string, first: 0 | 1) {
  const next = model.evaluate(first ? ['0', quantity] : [quantity, '0']);
  return { cost: new Decimal(before.marginBalance).minus(next.equity).toString(),
    initial: next.initial.minus(before.initialMargin).toString(), maintenance: next.maintenance.minus(before.maintenanceMargin).toString() };
}
const recovered = (s: ProjectedMargin, p: MarginPolicy) => s.equity.gte(s.initial.mul(p.initial.recover).div(100))
  && s.equity.gte(s.maintenance.mul(p.maintenance.recover).div(100));
function safe(before: Anchor, after: ProjectedMargin): boolean {
  return [before.initialMargin, before.maintenanceMargin].every((req, i) => {
    const oldGap = new Decimal(req).minus(before.marginBalance), newGap = (i ? after.maintenance : after.initial).minus(after.equity);
    return oldGap.lt(0) ? newGap.lte(0) : newGap.lt(oldGap);
  });
}
function improved(before: MarginMetrics, after: ProjectedMargin, policy: MarginPolicy): boolean {
  return [before.initialMargin, before.maintenanceMargin].every((req, i) => {
    const next = i ? after.maintenance : after.initial;
    const recovery = new Decimal(i ? policy.maintenance.recover : policy.initial.recover).div(100);
    if (new Decimal(before.marginBalance).gte(new Decimal(req).mul(recovery))) return after.equity.gte(next.mul(recovery));
    return new Decimal(req).isZero() ? next.isZero() : after.equity.mul(req).gte(new Decimal(before.marginBalance).mul(next));
  }) && [before.initialMargin, before.maintenanceMargin].some((req, i) =>
    after.equity.mul(req).gt(new Decimal(before.marginBalance).mul(i ? after.maintenance : after.initial)));
}
function firstLegSafe(model: AccountProjection, before: Anchor, q: string, index: 0 | 1): boolean {
  try {
    return projectionKnots(model, new Q(q)).every(point => {
      if (new Decimal(point).isZero()) return true;
      const quantities: [string, string] = index ? ['0', point.toString()] : [point.toString(), '0'];
      return safe(before, model.evaluate(quantities));
    });
  } catch { return false; }
}
/** Preview is executable capacity, not a recommendation to sell that amount. */
export function marginExecutionCapacity(raw: AccountProjection, before: Anchor, cap: string, stepSize: string): string {
  const model = boundedProjection(raw), step = new Q(stepSize), upper = new Q(cap);
  if (![step, upper].every(q => q.isFinite() && q.gt(0))) throw new Error('margin_no_legal_quantity');
  const maximum = upper.div(step).floor();
  const caps = ([0, 1] as const).map(i => safePrefixUnits(maximum, n => firstLegSafe(model, before, n.mul(step).toString(), i)));
  const paired = safePrefixUnits(Q.max(...caps), n => {
    try { return projectionKnots(model, n.mul(step)).every(q => { model.evaluate([q.toString(), q.toString()]); return true; }); }
    catch { return false; }
  });
  return paired.mul(step).toFixed();
}
const recoveryGaps = (s: ProjectedMargin, policy: MarginPolicy) => [
  new Q(s.equity).minus(new Q(s.initial).mul(policy.initial.recover).div(100)),
  new Q(s.equity).minus(new Q(s.maintenance).mul(policy.maintenance.recover).div(100)),
];
function improvementGaps(before: MarginMetrics, after: ProjectedMargin, policy: MarginPolicy) {
  const progress = [before.initialMargin, before.maintenanceMargin].map((r, i) =>
    new Q(after.equity).mul(r).minus(new Q(before.marginBalance).mul(i ? after.maintenance : after.initial)));
  const bounds = [before.initialMargin, before.maintenanceMargin].map((r, i) => {
    const next = i ? after.maintenance : after.initial, recovery = new Q(i ? policy.maintenance.recover : policy.initial.recover).div(100);
    return new Q(before.marginBalance).gte(new Q(r).mul(recovery)) ? new Q(after.equity).minus(new Q(next).mul(recovery))
      : new Q(r).isZero() ? new Q(next).neg() : progress[i];
  });
  return { bounds, progress };
}
function recoveryTarget(model: AccountProjection, policy: MarginPolicy, total: Decimal, step: Decimal, minimum: Decimal) {
  let known = new Q(0);
  for (const original of quantityRanges(model, total, step, minimum)) {
    try {
      const supported = supportedRange(model, original, step), range = supported.range;
      const [a, b] = supported.states, window = feasibleUnits(range, recoveryGaps(a, policy), recoveryGaps(b, policy));
      if (window) {
        const unit = verifiedEdge(range, window[0], true, n => recovered(model.evaluate([n.mul(step).toString(), n.mul(step).toString()]), policy));
        if (unit) return { target: unit.mul(step).toFixed(), known: total, complete: true };
      }
      known = range[1].mul(step);
      if (!supported.complete) return { target: null, known, complete: false };
    } catch { return { target: null, known, complete: false }; }
  }
  return { target: null, known, complete: true };
}
function bestImprovement(model: AccountProjection, before: MarginMetrics, policy: MarginPolicy, upper: Decimal, step: Decimal, minimum: Decimal) {
  let best: Decimal | null = null;
  for (const range of quantityRanges(model, upper, step, minimum)) {
    const [a, b] = rangeStates(model, range, step), left = improvementGaps(before, a, policy), right = improvementGaps(before, b, policy);
    for (const index of [0, 1]) {
      const window = feasibleUnits(range, [...left.bounds, left.progress[index]], [...right.bounds, right.progress[index]], [false, false, true]);
      if (!window) continue;
      const unit = verifiedEdge(range, window[1], false, n => improved(before, model.evaluate([n.mul(step).toString(), n.mul(step).toString()]), policy));
      if (unit && (!best || unit.gt(best))) best = unit;
    }
  }
  return best?.mul(step) ?? null;
}
export function planAccountReduction(raw: AccountProjection, before: MarginMetrics, policy: MarginPolicy,
  quantities: { quantity: string; cap: string; step: string; minimum: string }, preference: 0 | 1) {
  const step = new Q(quantities.step), total = new Q(quantities.quantity), rawMinimum = new Q(quantities.minimum), rawCap = new Q(quantities.cap);
  if (![step, total, rawMinimum, rawCap].every(q => q.isFinite() && q.gt(0))) throw new Error('margin_no_legal_quantity');
  const cap = Q.min(rawCap, total).div(step).floor(), minimum = rawMinimum.div(step).ceil();
  if (cap.lt(minimum)) throw new Error('margin_no_legal_quantity');
  const model = boundedProjection(raw), anchor = model.evaluate(['0', '0']);
  if (anchor.equity.minus(before.marginBalance).abs().gt('0.000001') || anchor.initial.minus(before.initialMargin).abs().gt('0.000001') ||
    anchor.maintenance.minus(before.maintenanceMargin).abs().gt('0.000001')) throw new Error('margin_projection_account_changed');
  if (recovered(anchor, policy)) throw new Error('margin_reduction_not_needed');
  const safeCaps = ([0, 1] as const).map(i => safePrefixUnits(cap, n => firstLegSafe(model, before, n.mul(step).toString(), i)));
  const target = recoveryTarget(model, policy, total, step, minimum);
  const upper = Q.min(Q.max(...safeCaps).mul(step), target.target ?? (target.complete ? total : target.known));
  const quantity = bestImprovement(model, before, policy, upper, step, minimum);
  if (!quantity) throw new Error('margin_projection_no_safe_improvement');
  const firstLeg = ([preference, preference ? 0 : 1] as const).find(i => quantity.lte(safeCaps[i].mul(step)) && firstLegSafe(model, before, quantity.toString(), i));
  if (firstLeg === undefined) throw new Error('margin_projection_no_safe_improvement');
  const q = quantity.toFixed(), projected = model.evaluate([q, q]);
  return { status: target.target ? 'target_known' as const : target.complete ? 'group_insufficient' as const : 'bounded_batch_only' as const,
    target: target.target, quantity: q, firstLeg, firstImpact: firstImpact(model, before, q, firstLeg),
    estimatedEquity: projected.equity.toString(), estimatedInitial: projected.initial.toString(), estimatedMaintenance: projected.maintenance.toString(),
    parametersId: model.parametersId, parametersValidUntil: model.validUntil, feeRules: model.feeRules,
    approximate: model.approximate, costPerUnit: model.costPerUnit, feePerUnit: model.feePerUnit, executionLegs: model.executionLegs };
}
