import { Decimal } from 'decimal.js';

/** All amounts use one verified valuation currency. Release rates are conservative bounds. */
export interface ReductionInput {
  equity: string; initial: string; maintenance: string; initialRecovery: number; maintenanceRecovery: number;
  quantity: string; cap: string; step: string; minimum: string;
  initialRelease: string; maintenanceRelease: string; cost: string;
}
export interface ReductionPlan {
  status: 'target_known' | 'group_insufficient'; target: string | null; quantity: string;
  estimatedEquity: string; estimatedInitial: string; estimatedMaintenance: string;
}
const number = (raw: string): Decimal => {
  if (!/^-?\d+(\.\d+)?$/.test(raw)) throw new Error('margin_invalid_number');
  return new Decimal(raw);
};

/** Solve both coverage inequalities, including an upper bound when cost exceeds IM release. */
export function planMarginReduction(input: ReductionInput): ReductionPlan | null {
  try {
    const e = number(input.equity), q = number(input.quantity), step = number(input.step);
    const cost = number(input.cost), minimum = number(input.minimum), cap = Decimal.min(number(input.cap), q);
    if (step.lte(0) || minimum.lte(0) || q.lte(0) || cap.lte(0) || cost.lt(0)) return null;
    let need = new Decimal(0), maximum = q;
    for (const [raw, releaseRaw, recovery] of [[input.initial, input.initialRelease, input.initialRecovery],
      [input.maintenance, input.maintenanceRelease, input.maintenanceRecovery]] as const) {
      if (!Number.isFinite(recovery) || recovery <= 100) return null;
      const requirement = number(raw), release = number(releaseRaw), r = new Decimal(recovery).div(100);
      if (requirement.lt(0) || release.lt(0)) return null;
      const deficit = r.mul(requirement).minus(e), improvement = r.mul(release).minus(cost);
      if (deficit.gt(0)) {
        if (improvement.lte(0)) return null;
        need = Decimal.max(need, deficit.div(improvement));
      } else if (improvement.lt(0)) maximum = Decimal.min(maximum, deficit.div(improvement));
      if (release.gt(0)) maximum = Decimal.min(maximum, requirement.div(release));
    }
    if (need.lte(0)) return null;
    const target = Decimal.max(need, minimum).div(step).ceil().mul(step);
    if (maximum.lt(q) && target.gt(maximum)) return null;
    const quantity = Decimal.min(Decimal.max(target, minimum.div(step).ceil().mul(step)), Decimal.min(maximum, cap).div(step).floor().mul(step));
    if (quantity.lt(minimum) || quantity.lte(0) || quantity.gt(cap) || quantity.gt(maximum)) return null;
    return { status: target.gt(q) ? 'group_insufficient' : 'target_known', target: target.gt(q) ? null : target.toFixed(),
      quantity: quantity.toFixed(), estimatedEquity: e.minus(cost.mul(quantity)).toString(),
      estimatedInitial: number(input.initial).minus(number(input.initialRelease).mul(quantity)).toString(),
      estimatedMaintenance: number(input.maintenance).minus(number(input.maintenanceRelease).mul(quantity)).toString() };
  } catch { return null; }
}

export interface MarginCandidate { id: string; apr: string | null; initial: string; maintenance: string }
export function rankMarginCandidates<T extends MarginCandidate>(rows: T[], cause: 'IMR' | 'MMR'): T[] {
  return [...rows].sort((a, b) => {
    if (cause === 'IMR') return new Decimal(b.initial).cmp(a.initial) || a.id.localeCompare(b.id);
    if (a.apr === null || b.apr === null) return a.apr === null && b.apr === null
      ? new Decimal(b.maintenance).cmp(a.maintenance) || a.id.localeCompare(b.id) : a.apr === null ? 1 : -1;
    return new Decimal(a.apr).cmp(b.apr) || a.id.localeCompare(b.id);
  });
}
