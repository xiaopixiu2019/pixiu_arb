import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TaskPerformanceStore } from './task-performance-store.js';
import { fileURLToPath } from 'node:url';
import { openDatabase } from './database.js';
const databases: Database.Database[] = [];
function fixture() {
  const db = openDatabase(':memory:',fileURLToPath(new URL('../../../migrations/',import.meta.url))); databases.push(db);
  const insert = db.prepare('INSERT OR IGNORE INTO task_pnl_coverage VALUES (?,?,?)');
  const add = (key: string, from: number, to: number) => insert.run(key, from, to);
  return { db, add, store: new TaskPerformanceStore(db) };
}
afterEach(() => { vi.restoreAllMocks(); for (const db of databases.splice(0)) db.close(); });
describe('incrementally materialized coverage', () => {
  it('reads one merged row instead of 71000 retained intervals', () => {
    const { db, add, store } = fixture();
    db.transaction(() => { for (let i = 0; i < 71000; i++) add('a', i, i + 100); })();
    const queries = vi.spyOn(db, 'prepare'); const view = store.coverageSnapshot('a');
    for (let task = 0; task < 34; task++) expect(view.through('a', task)).toBe(71099);
    expect(queries.mock.calls.filter(([sql]) => sql.includes('SELECT from_at,to_at'))).toHaveLength(1);
    expect(queries.mock.calls.filter(([sql]) => /FROM task_pnl_coverage\b/.test(sql))).toHaveLength(0);
    expect(db.prepare('SELECT COUNT(*) n FROM task_pnl_coverage_merged').get()).toEqual({n:1});
  });
  it('preserves gaps, boundaries and account isolation, and refreshes on the next request', () => {
    const { add, store } = fixture(); add('a', 0, 10); add('a', 20, 30); add('b', 0, 100);
    const view = store.coverageSnapshot('a');
    expect([view.through('a', -1), view.through('a', 0), view.through('a', 15), view.through('a', 20)]).toEqual([-1, 10, 15, 30]);
    expect(() => view.through('b', 0)).toThrow('task_coverage_account_changed');
    expect(() => view.save('a', [], 10, 20)).toThrow('task_coverage_view_read_only');
    add('a', 10, 20); expect(view.through('a', 0)).toBe(10);
    expect(store.coverageSnapshot('a').through('a', 0)).toBe(30);
    expect(store.coverageSnapshot('b').through('b', 0)).toBe(100);
    expect(store.coverageSnapshot('missing').through('missing', 0)).toBe(0);
  });
  it('matches the original coverage algorithm for overlapping, nested and disjoint intervals', () => {
    const { db, add, store } = fixture(); let seed = 42;
    const random = () => ((seed = (Math.imul(1664525, seed) + 1013904223) >>> 0) / 4294967296);
    for (let sample = 0; sample < 100; sample++) {
      db.exec('DELETE FROM task_pnl_coverage');
      for (let i = 0; i < 50; i++) { const from = Math.floor(random() * 1000); add('a', from, from + Math.floor(random() * 80)); }
      const view = store.coverageSnapshot('a');
      const raw=db.prepare('SELECT from_at,to_at FROM task_pnl_coverage WHERE account_key=? ORDER BY from_at').all('a') as Array<{from_at:number;to_at:number}>;
      for (let from = -1; from < 1100; from += 11) {
        let at=from;for(const range of raw){if(range.from_at>at)break;at=Math.max(at,range.to_at);}
        expect(view.through('a', from)).toBe(at);
      }
    }
  });
});
