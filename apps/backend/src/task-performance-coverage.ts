import type Database from 'better-sqlite3';
export interface CoverageRange { from_at: number; to_at: number }
export function mergeCoverage(rows: readonly CoverageRange[]): CoverageRange[] {
  const ranges: CoverageRange[] = [];
  for (const row of rows) {
    const previous = ranges.at(-1);
    if (previous && row.from_at <= previous.to_at) ranges[ranges.length - 1] = { ...previous, to_at: Math.max(previous.to_at, row.to_at) };
    else ranges.push({ ...row });
  }
  return ranges;
}
/** Only first initialization or explicit evidence removal needs the retained raw intervals. */
export function coverageRanges(db: Database.Database, key: string): CoverageRange[] {
  const state = db.prepare('SELECT ready FROM task_pnl_coverage_state WHERE account_key=?').get(key) as { ready: number } | undefined;
  if (state?.ready === 0) db.transaction(() => {
    const raw = db.prepare('SELECT from_at,to_at FROM task_pnl_coverage WHERE account_key=? ORDER BY from_at').all(key) as CoverageRange[];
    db.prepare('DELETE FROM task_pnl_coverage_merged WHERE account_key=?').run(key);
    const insert = db.prepare('INSERT INTO task_pnl_coverage_merged VALUES (?,?,?)');
    for (const row of mergeCoverage(raw)) insert.run(key, row.from_at, row.to_at);
    db.prepare('UPDATE task_pnl_coverage_state SET ready=1 WHERE account_key=?').run(key);
  })();
  return db.prepare('SELECT from_at,to_at FROM task_pnl_coverage_merged WHERE account_key=? ORDER BY from_at').all(key) as CoverageRange[];
}
export function coveredThrough(ranges: readonly CoverageRange[], from: number): number {
  let at = from;
  for (const row of ranges) { if (row.from_at > at) break; at = Math.max(at, row.to_at); }
  return at;
}
