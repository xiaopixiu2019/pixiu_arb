import type Database from 'better-sqlite3';
import type { GateAccountBookRecord } from './crossex-client.js';
import { strictDecimal } from './transaction-fee-model.js';
import type { FinancialReadScope } from './transaction-fee-store.js';
import { coverageRanges } from './task-performance-coverage.js';
export interface PnlBook extends GateAccountBookRecord { conflict: boolean }
interface CoverageRange { from_at: number; to_at: number }
export class TaskPerformanceStore {
  constructor(readonly db: Database.Database, private readonly coverage?: { key: string; ranges: readonly CoverageRange[] }, readonly scope?: FinancialReadScope) {}
  /** One synchronous report request owns this view; never retain it across requests or accounts. */
  coverageSnapshot(key: string): TaskPerformanceStore {
    const ranges: CoverageRange[] = [];
    for (const row of this.coverageRows(key)) {
      const previous = ranges.at(-1);
      if (previous && row.from_at <= previous.to_at) ranges[ranges.length - 1] = { ...previous, to_at: Math.max(previous.to_at, row.to_at) };
      else ranges.push({ ...row });
    }
    return new TaskPerformanceStore(this.db, { key, ranges }, this.scope);
  }
  private coverageRows(key: string): readonly CoverageRange[] {
    if (this.coverage) {
      if (key !== this.coverage.key) throw new Error('task_coverage_account_changed');
      return this.coverage.ranges;
    }
    return coverageRanges(this.db, key);
  }
  save(key: string, rows: GateAccountBookRecord[], from: number, to: number, complete = true): void {
    if (this.coverage) throw new Error('task_coverage_view_read_only');
    for (const r of rows) {
      strictDecimal(r.change);
      if (!r.id || !/^[A-Z0-9]{1,20}$/.test(r.coin) || !Number.isSafeInteger(Number(r.create_time))
        || Number(r.create_time) < from || Number(r.create_time) > to) throw new Error('task_ledger_range_invalid');
    }
    this.db.transaction(() => {
      const read=this.db.prepare('SELECT payload FROM task_pnl_book WHERE account_key=? AND id=?');
      const conflict=this.db.prepare('UPDATE task_pnl_book SET conflict=1 WHERE account_key=? AND id=? AND conflict=0');
      const insert=this.db.prepare('INSERT OR IGNORE INTO task_pnl_book VALUES (?,?,?,?,0)');
      for (const r of rows) {
        const payload = JSON.stringify(Object.fromEntries(Object.entries(r).sort(([a], [b]) => a.localeCompare(b))));
        const old = read.get(key,r.id) as {payload:string}|undefined;
        if(old){if(old.payload!==payload)conflict.run(key,r.id);continue;}
        insert.run(key,r.id,Number(r.create_time),payload);
      }
      if (complete) this.db.prepare('INSERT OR IGNORE INTO task_pnl_coverage VALUES (?,?,?)').run(key,from,to);
    })();
  }
  rows(key: string): PnlBook[] {
    return (this.db.prepare(`SELECT payload,conflict FROM task_pnl_book WHERE account_key=? ${this.scope ? `AND
      (COALESCE(json_extract(CASE WHEN json_valid(payload) THEN payload ELSE '{}' END,'$.symbol'),'')='' OR json_extract(CASE WHEN json_valid(payload) THEN payload ELSE '{}' END,'$.symbol') IN (SELECT value FROM json_each(?)))` : ''} ORDER BY at,id`)
      .all(...(this.scope ? [key, JSON.stringify(this.scope.symbols)] : [key])) as {payload:string;conflict:number}[])
      .map(r => ({...JSON.parse(r.payload) as GateAccountBookRecord, conflict: !!r.conflict}));
  }
  through(key: string, from: number): number {
    let at = from;
    for (const r of this.coverageRows(key)) {
      if (r.from_at > at) break;
      at = Math.max(at,r.to_at);
    }
    return at;
  }
  /** Collection can conservatively revisit history while the worker initializes merged coverage. */
  knownThrough(key: string, from: number): number {
    const row = this.db.prepare(`SELECT m.to_at FROM task_pnl_coverage_merged m JOIN task_pnl_coverage_state s USING(account_key)
      WHERE m.account_key=? AND s.ready=1 AND m.from_at<=? ORDER BY m.from_at DESC LIMIT 1`).get(key,from) as {to_at:number}|undefined;
    return Math.max(from,row?.to_at??from);
  }
}
