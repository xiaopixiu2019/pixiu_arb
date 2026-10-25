import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { Decimal } from 'decimal.js';
import { MarginPolicySchema, type MarginPolicy, type MarginMetrics, type MarginRiskEvent, type MarginHistory } from '@gate-crossex/shared-types';

export interface MarginIncident {
  id: string; at: number; policy: MarginPolicy; blocked: string | null;
  batch: { strategyId: string; before: string; target: string; at: number; id?: string; firstLeg?: 0 | 1 } | null;
  baselines: Record<string, string>;
  cause?: 'IMR' | 'MMR';
  completedBatches?: Record<string, number>;
  recovery?: { firstAt: number; confirmations: number } | null;
  settlement?: { remoteAfter: string; completedAt: number; quantities: Record<string, string>; batchId?: string; parametersId?: string;
    feeRules?: Array<{ symbol: string; pool: string; bookVenue?: string }>; approximate?: boolean;
    strategyId?: string; firstObservedAt?: number; verified?: boolean; counted?: boolean } | null;
  plan?: { target: string | null; quantity: string; apr: string | null; fallback: boolean; reason: string | null;
    parametersId?: string; parametersValidUntil?: number; feeRules?: Array<{ symbol: string; pool: string; bookVenue?: string }>;
    approximate?: boolean; costPerUnit?: string; feePerUnit?: string; firstImpact?: { cost: string; initial: string; maintenance: string }; executionLegs?: CostReservation['legs'] };
}
export interface CostReservation { batchId: string; amount: string; quantity: string; legs: Array<{ symbol: string; mark: string; side: 'BUY' | 'SELL'; feeRate: string; fx?: string }>;
  completedAt?: number; remoteAfter?: string; quantities?: Record<string, string>; originalAmount: string }
type Row = { policy_json: string; incident_json: string | null; entry_latched: number };
type Point = MarginHistory['points'][number];
const DAY = 86_400_000;
export class MarginRiskStore {
  constructor(private readonly db: Database.Database) {}
  /** Detect writes within a synchronous assessment; never a persisted authorization. */
  changeVersion(): bigint { return this.db.prepare('SELECT total_changes()').pluck().safeIntegers(true).get() as bigint; }
  transaction(work: () => void): void { this.db.transaction(work)(); }
  reserveCost(key: string, item: CostReservation, now: number): void {
    if (!new Decimal(item.amount).isFinite() || new Decimal(item.amount).lt(0)) throw new Error('margin_invalid_cost_reserve');
    this.db.prepare('INSERT INTO margin_cost_reservations VALUES (?, ?, ?, ?, ?, NULL)')
      .run(key, item.batchId, item.amount, JSON.stringify(item), now);
  }
  pendingCosts(key: string): CostReservation[] {
    return (this.db.prepare('SELECT amount,payload_json FROM margin_cost_reservations WHERE account_key=? AND settled_at IS NULL').all(key) as
      Array<{ amount: string; payload_json: string }>).map(r => ({ ...JSON.parse(r.payload_json), amount: r.amount }));
  }
  updateCost(key: string, item: CostReservation, settledAt?: number): void {
    this.db.prepare('UPDATE margin_cost_reservations SET amount=?, payload_json=?, settled_at=? WHERE account_key=? AND batch_id=? AND settled_at IS NULL')
      .run(settledAt === undefined ? item.amount : '0', JSON.stringify(item), settledAt ?? null, key, item.batchId);
  }
  reservedCost(key: string): string { return this.pendingCosts(key).reduce((s, r) => s.plus(r.amount), new Decimal(0)).toString(); }
  private row(key: string): Row {
    const existing = this.db.prepare('SELECT * FROM margin_risk_accounts WHERE account_key = ?').get(key) as Row | undefined;
    if (existing) return existing;
    this.db.prepare('INSERT OR IGNORE INTO margin_risk_accounts(account_key, policy_json) VALUES (?, ?)')
      .run(key, JSON.stringify(MarginPolicySchema.parse({})));
    return this.db.prepare('SELECT * FROM margin_risk_accounts WHERE account_key = ?').get(key) as Row;
  }
  policy(key: string): MarginPolicy { return MarginPolicySchema.parse(JSON.parse(this.row(key).policy_json)); }
  savePolicy(key: string, policy: MarginPolicy): void {
    const old = this.policy(key);
    if (policy.revision !== old.revision) throw new Error('margin_policy_conflict');
    this.db.prepare('UPDATE margin_risk_accounts SET policy_json = ? WHERE account_key = ?')
      .run(JSON.stringify({ ...policy, revision: old.revision + 1 }), key);
    this.event(key, 'policy_updated', 'Risk settings explicitly updated', old.revision + 1);
  }
  incident(key: string): MarginIncident | null {
    const raw = this.row(key).incident_json;
    return raw ? JSON.parse(raw) as MarginIncident : null;
  }
  saveIncident(key: string, incident: MarginIncident | null): void {
    this.row(key);
    this.db.prepare('UPDATE margin_risk_accounts SET incident_json = ? WHERE account_key = ?')
      .run(incident ? JSON.stringify(incident) : null, key);
  }
  startIncident(key: string, now: number): MarginIncident {
    const incident: MarginIncident = { id: randomUUID(), at: now, policy: this.policy(key), blocked: null, batch: null, baselines: {} };
    this.saveIncident(key, incident); this.latch(key, true);
    this.event(key, 'reduction_triggered', 'Margin threshold crossed; only explicitly authorized groups may reduce', incident.policy.revision, now);
    return incident;
  }
  latched(key: string): boolean { return this.row(key).entry_latched === 1; }
  latch(key: string, latched: boolean): void {
    this.row(key); this.db.prepare('UPDATE margin_risk_accounts SET entry_latched = ? WHERE account_key = ?').run(latched ? 1 : 0, key);
  }
  event(key: string, kind: string, detail: string, revision: number, now = Date.now()): void {
    const latest = this.db.prepare('SELECT metrics_json FROM margin_risk_samples WHERE account_key = ? ORDER BY sampled_at DESC LIMIT 1').get(key) as { metrics_json: string | null } | undefined;
    const policy = this.policy(key), effectivePolicy = this.incident(key)?.policy ?? policy;
    const evidence = { metrics: latest?.metrics_json ? JSON.parse(latest.metrics_json) as MarginMetrics : null, policy, effectivePolicy };
    this.db.prepare('INSERT INTO margin_risk_events(account_key, created_at, kind, detail, revision, evidence_json) VALUES (?, ?, ?, ?, ?, ?)')
      .run(key, now, kind, detail, revision, JSON.stringify(evidence));
  }
  events(key: string, before = Number.MAX_SAFE_INTEGER, since = 0, limit = 100): MarginRiskEvent[] {
    const rows = this.db.prepare('SELECT id, created_at AS at, kind, detail, revision, evidence_json FROM margin_risk_events WHERE account_key = ? AND id < ? AND created_at >= ? ORDER BY id DESC LIMIT ?')
      .all(key, before, since, Math.min(2000, limit)) as Array<MarginRiskEvent & { evidence_json: string | null }>;
    return rows.map(({ evidence_json, ...row }) => ({ ...row, evidence: evidence_json ? JSON.parse(evidence_json) as MarginRiskEvent['evidence'] : null }));
  }
  sample(key: string, at: number, metrics: MarginMetrics | null): void {
    const last = this.db.prepare('SELECT sampled_at AS at FROM margin_risk_samples WHERE account_key = ? ORDER BY sampled_at DESC LIMIT 1').get(key) as { at: number } | undefined;
    this.db.prepare('INSERT OR REPLACE INTO margin_risk_samples VALUES (?, ?, ?)').run(key, at, metrics ? JSON.stringify(metrics) : null);
    const minute = Math.floor(at / 60_000) * 60_000;
    const row = this.db.prepare('SELECT point_json FROM margin_risk_minutes WHERE account_key = ? AND minute_at = ?').get(key, minute) as { point_json: string } | undefined;
    const previous: Point | null = row ? JSON.parse(row.point_json) as Point : null;
    const point = samplePoint(at, metrics);
    const extremum = (a: string | null | undefined, b: string | null, min: boolean) =>
      a == null ? b : b == null ? a : (min ? Decimal.min(a, b) : Decimal.max(a, b)).toString();
    const combined: Point = { ...point, at: minute, valid: point.valid, lastSampleAt: at,
      gapBefore: previous?.gapBefore === true || (!previous && !!last && at - last.at > 5000),
      hasGap: !point.valid || previous?.hasGap === true || !!(previous?.lastSampleAt && at - previous.lastSampleAt > 5000),
      initialMin: extremum(previous?.initialMin, point.initialPct, true), initialMax: extremum(previous?.initialMax, point.initialPct, false),
      maintenanceMin: extremum(previous?.maintenanceMin, point.maintenancePct, true), maintenanceMax: extremum(previous?.maintenanceMax, point.maintenancePct, false) };
    this.db.prepare('INSERT OR REPLACE INTO margin_risk_minutes VALUES (?, ?, ?)').run(key, minute, JSON.stringify(combined));
  }
  history(key: string, hours: number, now = Date.now()): MarginHistory {
    const start = now - hours * 3_600_000;
    const rows = hours <= 1
      ? (this.db.prepare('SELECT sampled_at AS at, metrics_json AS value FROM margin_risk_samples WHERE account_key = ? AND sampled_at >= ? ORDER BY sampled_at LIMIT 3600').all(key, start) as Array<{ at: number; value: string | null }>)
        .map((r) => samplePoint(r.at, r.value ? JSON.parse(r.value) as MarginMetrics : null))
      : (this.db.prepare('SELECT point_json FROM margin_risk_minutes WHERE account_key = ? AND minute_at >= ? ORDER BY minute_at LIMIT 43201').all(key, start) as Array<{ point_json: string }>)
        .map((r) => JSON.parse(r.point_json) as Point);
    const earliest = this.db.prepare('SELECT MIN(minute_at) AS at FROM margin_risk_minutes WHERE account_key = ?').get(key) as { at: number | null };
    const stepMs = hours <= 1 ? 2000 : hours <= 24 ? 60000 : hours <= 168 ? 300000 : 1800000;
    return { points: stepMs <= 60000 ? rows : aggregatePoints(rows, stepMs), startedAt: earliest.at, stepMs };
  }
  prune(now = Date.now()): void {
    this.db.prepare('DELETE FROM margin_risk_samples WHERE sampled_at < ?').run(now - DAY);
    this.db.prepare('DELETE FROM margin_risk_minutes WHERE minute_at < ?').run(now - 30 * DAY);
  }
}
function aggregatePoints(points: Point[], stepMs: number): Point[] {
  const result = new Map<number, Point>();
  const extreme = (a: string | null, b: string | null, min: boolean) => a === null ? b : b === null ? a : (min ? Decimal.min(a, b) : Decimal.max(a, b)).toString();
  let previousAt = 0;
  for (const point of points) {
    const at = Math.floor(point.at / stepMs) * stepMs, old = result.get(at);
    result.set(at, { ...point, at, valid: point.valid,
      gapBefore: old?.gapBefore === true || (!old && (point.gapBefore || (previousAt > 0 && point.at - previousAt > 90000))),
      hasGap: point.hasGap || old?.hasGap === true || (!!old && (point.gapBefore || point.at - previousAt > 90000)),
      initialMin: extreme(old?.initialMin ?? null, point.initialMin, true), initialMax: extreme(old?.initialMax ?? null, point.initialMax, false),
      maintenanceMin: extreme(old?.maintenanceMin ?? null, point.maintenanceMin, true), maintenanceMax: extreme(old?.maintenanceMax ?? null, point.maintenanceMax, false) });
    previousAt = point.at;
  }
  return [...result.values()];
}
function samplePoint(at: number, m: MarginMetrics | null): Point {
  return { at, valid: m !== null, hasGap: m === null, gapBefore: false, initialPct: m?.initialPct ?? null, maintenancePct: m?.maintenancePct ?? null,
    initialMin: m?.initialPct ?? null, initialMax: m?.initialPct ?? null,
    maintenanceMin: m?.maintenancePct ?? null, maintenanceMax: m?.maintenancePct ?? null,
    marginBalance: m?.marginBalance ?? null, initialMargin: m?.initialMargin ?? null,
    maintenanceMargin: m?.maintenanceMargin ?? null, availableMargin: m?.availableMargin ?? null };
}
