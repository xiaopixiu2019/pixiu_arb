import type Database from 'better-sqlite3';
import type { PerformanceSample, PerformanceFlow } from './performance-math.js';
import type { ValuedFlow } from './performance-ledger.js';

interface SampleRow { at: number; equity: string | null; available: string | null; reason: string | null; rates_json: string }
export class PerformanceStore {
  constructor(private readonly db: Database.Database) {}
  samples(key: string): PerformanceSample[] {
    return (this.db.prepare('SELECT at, equity, available, reason, rates_json FROM performance_samples WHERE account_key = ? ORDER BY at').all(key) as SampleRow[])
      .map(({ rates_json, ...s }) => ({ ...s, rates: JSON.parse(rates_json) as Record<string, string> }));
  }
  baseline(key: string): PerformanceSample | null {
    const row = this.db.prepare('SELECT at, equity, available, reason, rates_json FROM performance_samples WHERE account_key = ? AND equity IS NOT NULL AND reason IS NULL ORDER BY at LIMIT 1').get(key) as SampleRow | undefined;
    if (!row) return null;
    const { rates_json, ...sample } = row; return { ...sample, rates: JSON.parse(rates_json) as Record<string, string> };
  }
  rateAt(key: string, coin: string, at: number): string | null {
    const rows = this.db.prepare('SELECT at, rates_json FROM performance_samples WHERE account_key = ? AND at BETWEEN ? AND ? ORDER BY ABS(at - ?)').all(key, at - 90_000, at + 90_000, at) as Array<{ at: number; rates_json: string }>;
    for (const row of rows) { const rates = JSON.parse(row.rates_json) as Record<string, string>; if (rates[coin]) return rates[coin]; }
    return null;
  }
  saveSample(key: string, sample: PerformanceSample, balances: unknown): void {
    this.db.prepare('INSERT OR REPLACE INTO performance_samples VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(key, sample.at, sample.equity, sample.available, sample.reason, JSON.stringify(sample.rates), JSON.stringify(balances));
  }
  flows(key: string): PerformanceFlow[] {
    return this.db.prepare('SELECT at, amount, reason FROM performance_flows WHERE account_key = ? ORDER BY at').all(key) as PerformanceFlow[];
  }
  saveCoverage(key: string, from: number, to: number, reason: string | null, flows: ValuedFlow[] = []): void {
    this.db.transaction(() => {
      for (const f of flows) this.db.prepare('INSERT OR REPLACE INTO performance_flows VALUES (?, ?, ?, ?, ?, ?)')
        .run(key, f.id, f.at, f.amount, f.reason, JSON.stringify(f.evidence));
      this.db.prepare('INSERT OR REPLACE INTO performance_coverage VALUES (?, ?, ?, ?)').run(key, from, to, reason);
    })();
  }
  coveredThrough(key: string, from: number): number {
    const ranges = this.db.prepare('SELECT from_at, to_at FROM performance_coverage WHERE account_key = ? AND reason IS NULL ORDER BY from_at').all(key) as Array<{ from_at: number; to_at: number }>;
    let cursor = from;
    for (const range of ranges) { if (range.from_at > cursor) break; cursor = Math.max(cursor, range.to_at); }
    return cursor;
  }
  latestFailure(key: string): string | null {
    return (this.db.prepare('SELECT reason FROM performance_coverage WHERE account_key = ? ORDER BY to_at DESC LIMIT 1').get(key) as { reason: string | null } | undefined)?.reason ?? null;
  }
}
