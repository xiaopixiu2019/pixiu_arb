import type Database from 'better-sqlite3';
import { Decimal } from 'decimal.js';
import type { MarginMetrics, MarginPolicy } from '@gate-crossex/shared-types';
import type { GateCrossExAccount, GateCrossExPosition } from './crossex-client.js';
import { managedLegs } from './managed-position-manager.js';
import { pairedQuantities } from './managed-position-model.js';
import { managedOrderSizeIssue } from './managed-position-validation.js';
import type { MarginReductionEvidence, ReductionEvidence } from './margin-reduction-evidence.js';
import { planMarginReduction } from './margin-reduction-plan.js';
import type { StrategyRecord } from './trading-runtime.js';
import type { MarketSource } from './strategy-engine.js';
import { planAccountReduction } from './margin-projection-plan.js';
import { Q, safePrefixUnits } from './margin-projection-search.js';

/** Null is an unreported venue cap, not a reason to discard the other finite batch bounds. */
export function reportedMarketCaps(rules: Array<{ max_market_size: string | null } | undefined>): Decimal[] {
  return rules.flatMap(rule => {
    if (!rule) throw new Error('margin_quantity_rules_unavailable');
    if (rule.max_market_size === null) return [];
    let maximum: Decimal;
    try { maximum = new Decimal(rule.max_market_size); }
    catch (error) { throw new Error('margin_quantity_rule_invalid', { cause: error }); }
    if (!maximum.isFinite() || maximum.lte(0)) throw new Error('margin_quantity_rule_invalid');
    return [maximum];
  });
}

export function commonQuantityStep(left: string, right: string): string {
  const a = new Decimal(left), b = new Decimal(right);
  if (!a.isFinite() || !b.isFinite() || a.lte(0) || b.lte(0)) throw new Error('margin_quantity_rule_invalid');
  const factor = new Decimal(10).pow(Math.max(a.decimalPlaces(), b.decimalPlaces()));
  const x = BigInt(a.mul(factor).toFixed(0)), y = BigInt(b.mul(factor).toFixed(0));
  let m = x, n = y;
  while (n) { const r = m % n; m = n; n = r; }
  return new Decimal((x / m * y).toString()).div(factor).toString();
}
export function marginGroupPlan(db: Database.Database, evidence: MarginReductionEvidence, markets: MarketSource,
  account: GateCrossExAccount, record: StrategyRecord, positions: GateCrossExPosition[], metrics: MarginMetrics, policy: MarginPolicy) {
  const result = marginGroupPlanDetailed(db, evidence, markets, account, record, positions, metrics, policy);
  return result.ok ? result.plan : null;
}
function legacySafe(facts: ReductionEvidence, metrics: MarginMetrics, quantity: string, leg: 0 | 1): boolean {
  return [[metrics.initialMargin, facts.initialReleaseByLeg[leg]], [metrics.maintenanceMargin, facts.maintenanceReleaseByLeg[leg]]]
    .every(([requirement, release]) => {
      const before = new Q(requirement).minus(metrics.marginBalance), after = before.minus(new Q(release).minus(facts.cost).mul(quantity));
      return before.lt(0) ? after.lte(0) : after.lt(before);
    });
}
function legacyPlan(facts: ReductionEvidence, metrics: MarginMetrics, policy: MarginPolicy,
  quantity: string, cap: string, step: string, minimum: string) {
  const caps = ([0, 1] as const).map(i => safePrefixUnits(new Q(cap).div(step).floor(), units => legacySafe(facts, metrics, units.mul(step).toString(), i)).mul(step));
  const plan = planMarginReduction({ equity: metrics.marginBalance, initial: metrics.initialMargin, maintenance: metrics.maintenanceMargin,
    initialRecovery: policy.initial.recover, maintenanceRecovery: policy.maintenance.recover, quantity, cap: Q.max(...caps).toFixed(), step, minimum,
    initialRelease: facts.initialRelease, maintenanceRelease: facts.maintenanceRelease, cost: facts.cost });
  if (!plan) throw new Error('margin_no_executable_plan');
  const firstLeg = ([facts.firstLeg, facts.firstLeg ? 0 : 1] as const).find(i => legacySafe(facts, metrics, plan.quantity, i));
  if (firstLeg === undefined) throw new Error('margin_projection_no_safe_improvement');
  return { ...plan, firstLeg };
}
export function marginGroupPlanDetailed(db: Database.Database, evidence: MarginReductionEvidence, markets: MarketSource,
  account: GateCrossExAccount, record: StrategyRecord, positions: GateCrossExPosition[], metrics: MarginMetrics, policy: MarginPolicy) {
  try {
    const legs = managedLegs(record.config), quantities = pairedQuantities(positions, legs);
    if (!new Decimal(quantities[0]).eq(quantities[1]) || !record.config.management) throw new Error('margin_projection_legs_invalid');
    const rules = legs.map(l => db.prepare('SELECT lot_size,min_size,min_notional,tick_size,max_market_size FROM crossex_instruments WHERE symbol = ?').get(l.symbol)) as
      Array<{ lot_size: string; min_size: string; min_notional: string | null; tick_size: string; max_market_size: string | null }>;
    const cap = Decimal.min(quantities[0], record.config.management.perOrderQuantity, ...reportedMarketCaps(rules)).toString();
    const step = commonQuantityStep(rules[0].lot_size, rules[1].lot_size);
    const minimum = Decimal.max(...rules.map((r, i) => Decimal.max(r.min_size,
      r.min_notional ? new Decimal(r.min_notional).div(markets.market(legs[i].symbol)?.bidPrice ?? '0') : '0'))).toString();
    const inspected = evidence.inspectGroup(account, positions, legs, cap);
    if (!inspected.ok) return inspected;
    const facts = inspected.evidence;
    const plan = facts.projection ? planAccountReduction(facts.projection, metrics, policy, { quantity: quantities[0], cap, step, minimum }, facts.firstLeg)
      : legacyPlan(facts, metrics, policy, quantities[0], cap, step, minimum);
    if (legs.some((l, i) => managedOrderSizeIssue(l, new Decimal(plan.quantity), rules[i], markets.market(l.symbol), Date.now())))
      throw new Error('margin_no_legal_quantity');
    return { ok: true as const, plan: { ...plan, apr: facts.apr, initial: facts.initial, maintenance: facts.maintenance } };
  } catch (error) { return { ok: false as const, reason: error instanceof Error && /^margin_/.test(error.message) ? error.message : 'margin_projection_evidence_invalid' }; }
}
