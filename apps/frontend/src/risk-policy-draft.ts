import { MarginPolicySchema, type MarginPolicy, type MarginSnapshot } from '@gate-crossex/shared-types';
import { riskEvidenceClock } from './risk-evidence-clock.js';

export const riskKinds = ['initial', 'maintenance'] as const;
export const riskLevels = ['warn', 'reduce', 'recover'] as const;
export const thresholdLabels = (zh: boolean) => zh ? ['预警并禁止增仓', '分批市价减仓', '停止减仓恢复值'] : ['Warn and block entry', 'Reduce with market orders', 'Recovery target'];
export type RiskKind = typeof riskKinds[number];
export type RiskLevel = typeof riskLevels[number];
export interface RiskPolicyDraft {
  revision: number; initial: Record<RiskLevel, string>; maintenance: Record<RiskLevel, string>;
  protectedGroupIds: string[]; notificationsEnabled: boolean; reminderMinutes: string;
}
export function policyDraft(policy: MarginPolicy): RiskPolicyDraft {
  const row = (kind: RiskKind) => ({ warn: String(policy[kind].warn), reduce: String(policy[kind].reduce), recover: String(policy[kind].recover) });
  return { ...policy, initial: row('initial'), maintenance: row('maintenance'), protectedGroupIds: [...policy.protectedGroupIds], reminderMinutes: String(policy.reminderMinutes) };
}
const number = (text: string) => text.trim() === '' ? NaN : Number(text);
export function draftPolicy(draft: RiskPolicyDraft): MarginPolicy | null {
  const row = (kind: RiskKind) => Object.fromEntries(riskLevels.map(key => [key, number(draft[kind][key])]));
  const parsed = MarginPolicySchema.safeParse({ ...draft, initial: row('initial'), maintenance: row('maintenance'), reminderMinutes: number(draft.reminderMinutes) });
  return parsed.success ? parsed.data : null;
}
export function policyContent(policy: MarginPolicy): string {
  return JSON.stringify([policy.initial, policy.maintenance, [...policy.protectedGroupIds].sort(), policy.notificationsEnabled, policy.reminderMinutes]);
}
export function samePolicy(a: MarginPolicy, b: MarginPolicy): boolean { return a.revision === b.revision && policyContent(a) === policyContent(b); }

export function olderRiskSnapshot(next: MarginSnapshot, current: MarginSnapshot, serverNow = riskEvidenceClock.now(current.accountId)): boolean {
  return next.policy.revision < current.policy.revision || next.policy.revision === current.policy.revision
    && (serverNow === null || (current.sampledAt ?? -Infinity) <= serverNow)
    && (next.sampledAt ?? -Infinity) < (current.sampledAt ?? -Infinity);
}

export function supersededRiskReply(next: MarginSnapshot, current: MarginSnapshot, before: MarginSnapshot | null): boolean {
  return olderRiskSnapshot(next, current) || current !== before && next.accountId === current.accountId
    && next.policy.revision === current.policy.revision && next.sampledAt === current.sampledAt;
}

/** Each venue risk unit is independent; the lowest IMR summary need not contain the lowest MMR. */
export function policyScenario(snapshot: MarginSnapshot, policy: MarginPolicy): 'unknown' | 'reduce' | 'warn' | 'clear' {
  const metrics = snapshot.units?.length ? snapshot.units.map(unit => unit.metrics) : [snapshot.metrics];
  let result: 'reduce' | 'warn' | 'clear' = 'clear';
  for (const metric of metrics) {
    if (!metric) return 'unknown';
    for (const kind of riskKinds) {
      const value = kind === 'initial' ? metric.initialPct : metric.maintenancePct;
      const required = kind === 'initial' ? metric.initialMargin : metric.maintenanceMargin;
      if (value === null && Number(required) === 0) continue;
      if (value === null || !Number.isFinite(Number(value))) return 'unknown';
      if (Number(value) < policy[kind].reduce) result = 'reduce';
      else if (Number(value) < policy[kind].warn && result === 'clear') result = 'warn';
    }
  }
  return result;
}

export function thresholdError(row: Record<RiskLevel, string>, key: RiskLevel, zh: boolean): string | null {
  const value = number(row[key]);
  if (!Number.isFinite(value) || value <= 100 || value > 1000000) return zh ? '请输入大于100且不超过1,000,000的数值。' : 'Enter a finite value above 100 and at most 1,000,000.';
  if ((key === 'reduce' || key === 'warn') && number(row.reduce) >= number(row.warn)) return zh ? '减仓值必须低于预警值。' : 'Reduction must be below warning.';
  if ((key === 'warn' || key === 'recover') && number(row.warn) >= number(row.recover)) return zh ? '预警值必须低于恢复目标。' : 'Warning must be below recovery.';
  return null;
}

export interface PolicyChange { key: string; before: string; after: string }
export function policyChanges(base: MarginPolicy, draft: RiskPolicyDraft): PolicyChange[] {
  const changes: PolicyChange[] = [];
  for (const kind of riskKinds) for (const key of riskLevels) {
    const raw = draft[kind][key], value = number(raw);
    if (value !== base[kind][key]) changes.push({ key: `${kind}.${key}`, before: `${base[kind][key]}%`, after: raw.trim() ? `${raw}%` : '—' });
  }
  for (const id of draft.protectedGroupIds.filter(id => !base.protectedGroupIds.includes(id))) changes.push({ key: `add:${id}`, before: '—', after: id });
  for (const id of base.protectedGroupIds.filter(id => !draft.protectedGroupIds.includes(id))) changes.push({ key: `remove:${id}`, before: id, after: '—' });
  if (base.notificationsEnabled !== draft.notificationsEnabled) changes.push({ key: 'notificationsEnabled', before: String(base.notificationsEnabled), after: String(draft.notificationsEnabled) });
  if (base.reminderMinutes !== number(draft.reminderMinutes)) changes.push({ key: 'reminderMinutes', before: String(base.reminderMinutes), after: draft.reminderMinutes || '—' });
  return changes;
}
