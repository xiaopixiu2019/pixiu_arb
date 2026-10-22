import { TaskPerformanceSummarySchema, type TaskPerformanceSummary } from '@gate-crossex/shared-types';
import type Database from 'better-sqlite3';
export class TaskPerformanceCache {
  private readonly saved = new Map<string, string>();
  constructor(private readonly db: Database.Database) {}
  read(key: string, profile: string): TaskPerformanceSummary | null {
    const row = this.db.prepare('SELECT payload FROM task_performance_cache WHERE account_key=? AND profile_id=?').get(key, profile) as { payload: string } | undefined;
    if (!row) return null;
    try { const parsed = TaskPerformanceSummarySchema.safeParse(JSON.parse(row.payload)); return parsed.success ? parsed.data : null; }
    catch { return null; } // Malformed display caches are recomputed from immutable bills.
  }
  save(key: string, profile: string, report: TaskPerformanceSummary): void {
    const signature = JSON.stringify([profile, report.reason, report.stale, report.accountCosts, report.unresolvedCashflows,
      report.tasks.map(task => ({ ...task, checkedAt: null }))]);
    if (this.saved.get(key) === signature) return;
    this.db.prepare(`INSERT INTO task_performance_cache VALUES (?,?,?,?) ON CONFLICT(account_key) DO UPDATE SET
      profile_id=excluded.profile_id,checked_at=excluded.checked_at,payload=excluded.payload`).run(key, profile, report.checkedAt ?? 0, JSON.stringify(report));
    this.saved.set(key, signature);
  }
}
export function retainTradingResults(next: TaskPerformanceSummary, previous: TaskPerformanceSummary | null): TaskPerformanceSummary {
  if (!previous || next.profileId !== previous.profileId) return next;
  return { ...next, tasks: next.tasks.map(task => {
    const value = task.trading, old = previous.tasks.find(t => t.taskId === task.taskId)?.trading;
    if (!value || value.amount !== null || value.status === 'transferred' || old?.amount == null || value.groupId !== old.groupId
      || [...value.members].sort().join(':') !== [...old.members].sort().join(':')) return task;
    return { ...task, trading: { ...old, status: 'partial' as const, stale: true, reasons: [...new Set([...value.reasons, 'last_confirmed_value'])] } };
  }) };
}
