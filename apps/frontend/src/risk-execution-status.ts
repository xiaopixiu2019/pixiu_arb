import type { MarginSnapshot } from '@gate-crossex/shared-types';
export interface RiskExecutionTask { id: string; status: string; management?: { phase: string; reason?: string | null } | null }

/** Display-only execution evidence; never changes the margin verdict or resume authority. */
export function riskExecutionStatus(snapshot: MarginSnapshot | null, fresh: boolean, tasks: readonly RiskExecutionTask[] = []) {
  if (!fresh || !snapshot) return { state: 'unavailable' as const, paused: [], locked: true };
  const taskById = new Map(tasks.map(t => [t.id, t]));
  const paused = snapshot.groups.filter(g => ['RISK_PAUSED', 'PAUSED'].includes(g.phase)).map(g => {
    const task = taskById.get(g.strategyId);
    const reason = task?.status === 'PAUSED' && task.management?.phase === g.phase ? task.management.reason ?? null : null;
    return { id: g.strategyId, asset: g.asset, reason };
  });
  return { state: paused.length ? 'paused' as const : !snapshot.liveEnabled ? 'locked' as const : 'enabled' as const,
    paused, locked: !snapshot.liveEnabled };
}
