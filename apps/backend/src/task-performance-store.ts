import type Database from 'better-sqlite3';
import type { GateAccountBookRecord } from './crossex-client.js';
import { strictDecimal } from './transaction-fee-model.js';
export interface PnlBook extends GateAccountBookRecord { conflict: boolean }
export class TaskPerformanceStore {
  constructor(readonly db: Database.Database) {}
  save(key: string, rows: GateAccountBookRecord[], from: number, to: number): void {
    for (const r of rows) {
      strictDecimal(r.change);
      if (!r.id || !/^[A-Z0-9]{1,20}$/.test(r.coin) || !Number.isSafeInteger(Number(r.create_time))
        || Number(r.create_time) < from || Number(r.create_time) > to) throw new Error('task_ledger_range_invalid');
    }
    this.db.transaction(() => {
      for (const r of rows) {
        const payload = JSON.stringify(Object.fromEntries(Object.entries(r).sort(([a], [b]) => a.localeCompare(b))));
        const old = this.db.prepare('SELECT payload FROM task_pnl_book WHERE account_key=? AND id=?').get(key,r.id) as {payload:string}|undefined;
        if (old && old.payload !== payload) this.db.prepare('UPDATE task_pnl_book SET conflict=1 WHERE account_key=? AND id=?').run(key,r.id);
        else this.db.prepare('INSERT OR IGNORE INTO task_pnl_book VALUES (?,?,?,?,0)').run(key,r.id,Number(r.create_time),payload);
      }
      this.db.prepare('INSERT OR IGNORE INTO task_pnl_coverage VALUES (?,?,?)').run(key,from,to);
    })();
  }
  rows(key: string): PnlBook[] {
    return (this.db.prepare('SELECT payload,conflict FROM task_pnl_book WHERE account_key=? ORDER BY at,id').all(key) as {payload:string;conflict:number}[])
      .map(r => ({...JSON.parse(r.payload) as GateAccountBookRecord, conflict: !!r.conflict}));
  }
  through(key: string, from: number): number {
    let at = from;
    for (const r of this.db.prepare('SELECT from_at,to_at FROM task_pnl_coverage WHERE account_key=? ORDER BY from_at').all(key) as {from_at:number;to_at:number}[]) {
      if (r.from_at > at) break;
      at = Math.max(at,r.to_at);
    }
    return at;
  }
}
