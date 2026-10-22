import { Decimal } from 'decimal.js';
import type { AccountProjection, ProjectedMargin } from './margin-account-projection.js';

export const Q = Decimal.clone({ precision: 200 });
export type GridRange = [Decimal, Decimal];
const LIMIT = 2048;

/** Bound model work, not the number of representable contract quantities. */
export function boundedProjection(model: AccountProjection): AccountProjection {
  const cache = new Map<string, ProjectedMargin | Error>();
  return { ...model, evaluate: quantities => {
    const key = quantities.map(q => new Q(q).toString()).join(':');
    let value = cache.get(key);
    if (!value) {
      if (cache.size >= LIMIT) throw new Error('margin_projection_search_limit');
      try {
        value = model.evaluate(quantities);
        if (![value.equity, value.initial, value.maintenance].every(n => n.isFinite())
          || value.initial.lt(0) || value.maintenance.lt(0)) throw new Error('margin_projection_evidence_invalid');
      } catch (error) { value = error instanceof Error ? error : new Error('margin_projection_evidence_invalid'); }
      cache.set(key, value);
    }
    if (value instanceof Error) throw value;
    return value;
  } };
}

export function projectionKnots(model: AccountProjection, upper: Decimal): Decimal[] {
  const raw = model.checkpoints(upper.toString());
  if (raw.length > LIMIT) throw new Error('margin_projection_search_limit');
  const points = raw.map(q => new Q(q));
  if (points.some(q => !q.isFinite() || q.lt(0) || q.gt(upper))) throw new Error('margin_projection_evidence_invalid');
  return [...new Set(['0', upper.toString(), ...points.map(q => q.toString())])].map(q => new Q(q)).sort((a, b) => a.cmp(b));
}

/** Keep exact breakpoints separate, including discontinuities. No global monotonicity assumption. */
export function quantityRanges(model: AccountProjection, upper: Decimal, step: Decimal, minimum: Decimal): GridRange[] {
  const points = projectionKnots(model, upper), ranges: GridRange[] = [], last = upper.div(step).floor();
  const add = (a: Decimal, b: Decimal) => { const lo = Q.max(a, minimum), hi = Q.min(b, last); if (lo.lte(hi)) ranges.push([lo, hi]); };
  points.forEach((point, i) => {
    const unit = point.div(step);
    if (unit.isInteger()) add(unit, unit);
    if (i + 1 < points.length) add(unit.floor().plus(1), points[i + 1].div(step).ceil().minus(1));
  });
  return ranges;
}

export function rangeStates(model: AccountProjection, range: GridRange, step: Decimal): [ProjectedMargin, ProjectedMargin] {
  const read = (n: Decimal) => model.evaluate([n.mul(step).toString(), n.mul(step).toString()]);
  const [lo, hi] = range, a = read(lo), b = read(hi), mid = lo.plus(hi).div(2).floor();
  if (mid.gt(lo) && mid.lt(hi)) {
    const c = read(mid), fraction = mid.minus(lo).div(hi.minus(lo));
    if ((['equity', 'initial', 'maintenance'] as const).some(k => new Q(a[k]).plus(new Q(b[k]).minus(a[k]).mul(fraction)).minus(c[k]).abs().gt('0.000001')))
      throw new Error('margin_projection_evidence_invalid');
  }
  return [a, b];
}

/** An unverified tail must not erase a smaller verified prefix. */
export function supportedRange(model: AccountProjection, range: GridRange, step: Decimal) {
  const read = (n: Decimal) => model.evaluate([n.mul(step).toString(), n.mul(step).toString()]);
  read(range[0]);
  let end = range[1];
  try { read(end); }
  catch {
    end = range[0].plus(safePrefixUnits(end.minus(range[0]), offset => {
      try { read(range[0].plus(offset)); return true; } catch { return false; }
    }));
  }
  const supported: GridRange = [range[0], end];
  return { range: supported, states: rangeStates(model, supported, step), complete: end.eq(range[1]) };
}

/** Intersect affine inequalities on one certified quantity interval, then round to legal units. */
export function feasibleUnits(range: GridRange, left: Decimal[], right: Decimal[], strict: boolean[] = []): GridRange | null {
  const [a, b] = range; let lo = a, hi = b;
  for (let i = 0; i < left.length; i++) {
    const slope = right[i].minus(left[i]);
    if (a.eq(b) || slope.isZero()) {
      if (strict[i] ? left[i].lte(0) : left[i].lt(0)) return null;
    } else {
      const root = a.minus(left[i].mul(b.minus(a)).div(slope));
      if (slope.gt(0)) lo = Q.max(lo, strict[i] ? root.floor().plus(1) : root.ceil());
      else hi = Q.min(hi, strict[i] ? root.ceil().minus(1) : root.floor());
    }
  }
  return lo.lte(hi) ? [lo, hi] : null;
}

/** Verify the computed boundary and its neighbour against the original model, never a rounded ratio. */
export function verifiedEdge(range: GridRange, candidate: Decimal, first: boolean, passes: (unit: Decimal) => boolean): Decimal | null {
  const direction = first ? 1 : -1;
  let unit = candidate, attempts = 0;
  const inside = (n: Decimal) => n.gte(range[0]) && n.lte(range[1]);
  while (inside(unit) && !passes(unit) && attempts++ < 4) unit = unit.plus(direction);
  if (!inside(unit)) return null;
  if (!passes(unit)) throw new Error('margin_projection_evidence_invalid');
  attempts = 0;
  while (inside(unit.minus(direction)) && passes(unit.minus(direction))) {
    if (++attempts > 4) throw new Error('margin_projection_evidence_invalid');
    unit = unit.minus(direction);
  }
  return unit;
}

/** Prefix safety is monotone: every intermediate first-leg fill must remain safe. */
export function safePrefixUnits(maximum: Decimal, passes: (unit: Decimal) => boolean): Decimal {
  if (maximum.isZero() || passes(maximum)) return maximum;
  let lo = new Q(0), hi = maximum.minus(1);
  for (let i = 0; lo.lt(hi); i++) {
    if (i >= 256) throw new Error('margin_projection_search_limit');
    const mid = lo.plus(hi).plus(1).div(2).floor();
    if (passes(mid)) lo = mid; else hi = mid.minus(1);
  }
  return lo;
}
