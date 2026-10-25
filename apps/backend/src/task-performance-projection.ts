import { createHash } from 'node:crypto';
import { setImmediate as yieldTurn } from 'node:timers/promises';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { TaskPnlComponentSchema, type TaskPerformanceSummary } from '@gate-crossex/shared-types';
import { TransactionFeeStore } from './transaction-fee-store.js';
import type { FeeEpoch } from './transaction-fee-model.js';
import { coverageRanges, type CoverageRange } from './task-performance-coverage.js';
import { projectionGroups, affectedProjection, relatedScope, type GroupScope, type PnlChange } from './task-performance-projection-scope.js';
import { buildProjection } from './task-performance-projection-build.js';
import { GroupStageSchema, PoolStageSchema, poolTotals, type GroupStage, type PoolStage, type ProjectionWork } from './task-performance-projection-model.js';
import { renderLegacy } from './task-performance-legacy-stage.js';
import { renderTrading } from './task-performance-trading-stage.js';
import type { TradingValuation } from './task-trading-report.js';
import { watchFinancialEvidence } from './task-performance-watch.js';

interface Meta { sequence: number; version: number; checkedAt: number; ranges: CoverageRange[]; epoch: FeeEpoch; totals: ReturnType<typeof poolTotals>; taskOrder:string[] }
const epochSchema = z.object({ account_key: z.string(), profile_id: z.string(), started_at: z.number(), covered_to: z.number(),
  checked_at: z.number().nullable(), book_reason: z.string().nullable(), trade_reason: z.string().nullable(), trades_to: z.number() });
const metaSchema = z.object({ ranges: z.array(z.object({ from_at: z.number(), to_at: z.number() })), epoch: epochSchema,taskOrder:z.array(z.string()),
  totals:z.object({unallocated:TaskPnlComponentSchema,accountCosts:TaskPnlComponentSchema,unresolvedCashflows:TaskPnlComponentSchema}) });
const workSchema = z.object({ groups: z.array(GroupStageSchema), pools: z.array(PoolStageSchema),
  dependencies: z.array(z.object({ coin: z.string(), at: z.number(), rate: z.string().nullable() })) });
interface WorkScope { scope: ReturnType<typeof relatedScope>; targets: GroupScope[]; pools: string[] }
interface PreparedWork { groups:Array<{id:string;payload:string}>;pools:Array<{symbol:string;payload:string}>;dependencies:ProjectionWork['dependencies'] }

/** Durable display projection. Readers never compute history or advance its cursor. */
export class TaskPerformanceProjection {
  private meta: Meta | null = null;
  private groups = new Map<string, GroupStage>();
  private pools = new Map<string, PoolStage>();
  readonly statistics = { historyGroups: 0, historyBatches: 0, resumedBatches: 0, cleanupDeferred:0 };
  constructor(private readonly db: Database.Database, readonly key: string, readonly profile: string,
    private readonly yieldControl: () => Promise<unknown> = yieldTurn, private readonly readOnlyView = false) { watchFinancialEvidence(db,key,profile); this.reload(); }
  reload(): void { this.db.transaction(() => this.load())(); }
  private load(): void {
    const row = this.db.prepare('SELECT processed_sequence,version,checked_at,meta_json FROM task_pnl_projection WHERE account_key=? AND profile_id=?')
      .get(this.key, this.profile) as { processed_sequence: number; version: number; checked_at: number; meta_json: string } | undefined;
    if (!row) { this.meta=null;this.groups.clear();this.pools.clear();return; }
    try {
      const meta = metaSchema.parse(JSON.parse(row.meta_json));
      const groups = this.db.prepare('SELECT group_id,payload FROM task_pnl_group_cache WHERE account_key=?').all(this.key) as Array<{ group_id: string; payload: string }>;
      const pools = this.readOnlyView ? [] : this.db.prepare('SELECT symbol,payload FROM task_pnl_pool_cache WHERE account_key=?').all(this.key) as Array<{ symbol: string; payload: string }>;
      this.groups = new Map(groups.map(r => [r.group_id, GroupStageSchema.parse(JSON.parse(r.payload))]));
      this.pools = new Map(pools.map(r => [r.symbol, PoolStageSchema.parse(JSON.parse(r.payload))]));
      this.meta = { sequence: row.processed_sequence, version: row.version, checkedAt: row.checked_at, ...meta };
    } catch { this.meta = null; this.groups.clear(); this.pools.clear(); } // Invalid display state requires canonical reconstruction.
  }
  private versionState(): {sequence:number;published:number|null} {
    const row = this.db.prepare(`SELECT (SELECT processed_sequence FROM task_pnl_projection WHERE account_key=? AND profile_id=?) AS published,
      MAX(sequence) AS sequence FROM (
      SELECT MAX(sequence) AS sequence FROM task_pnl_changes WHERE account_key=?
      UNION ALL SELECT MAX(sequence) FROM task_pnl_changes WHERE profile_id=?
      UNION ALL SELECT MAX(sequence) FROM task_pnl_changes INDEXED BY task_pnl_changes_unscoped WHERE account_key IS NULL AND profile_id IS NULL)`)
      .get(this.key,this.profile,this.key, this.profile) as { sequence: number | null;published:number|null };
    return {sequence:row.sequence??0,published:row.published};
  }
  private latest():number{return this.versionState().sequence;}
  pending(): boolean {
    if(!this.meta)return true;
    const version=this.versionState();return version.published!==this.meta.sequence||version.sequence>this.meta.sequence;
  }
  private changes(sequence: number): PnlChange[] {
    return this.db.prepare(`SELECT sequence,kind,ref,payload FROM task_pnl_changes WHERE sequence>? AND sequence<=?
      AND (account_key=? OR profile_id=? OR (account_key IS NULL AND profile_id IS NULL)) ORDER BY sequence`)
      .all(this.meta?.sequence ?? 0, sequence, this.key, this.profile) as PnlChange[];
  }
  private plan(all: GroupScope[], changes: PnlChange[], epoch: FeeEpoch): WorkScope[] {
    const old = [...this.groups.values()].map(g => g.group);
    const affected = affectedProjection(this.db, this.key, changes, all, old);
    if (!this.meta || epoch.started_at !== this.meta.epoch.started_at) {
      all.forEach(g => affected.groups.add(g.id));
      const rows = this.db.prepare(`SELECT DISTINCT COALESCE(json_extract(CASE WHEN json_valid(payload) THEN payload ELSE '{}' END,'$.symbol'),'') AS symbol FROM task_pnl_book WHERE account_key=?`)
        .all(this.key) as Array<{ symbol: string }>;
      rows.forEach(r => affected.symbols.add(r.symbol)); affected.symbols.add('');
    }
    const remaining = all.filter(g => affected.groups.has(g.id)), work: WorkScope[] = [];
    while (remaining.length) {
      const scope = relatedScope(all, [remaining[0].id]);
      const targets = remaining.filter(g => g.taskIds.some(id => scope.taskIds.includes(id)));
      const pools = [...scope.symbols]; if (affected.symbols.has('')) pools.push('');
      work.push({ scope, targets, pools }); pools.forEach(s => affected.symbols.delete(s));
      for (const target of targets) remaining.splice(remaining.indexOf(target), 1);
    }
    while (affected.symbols.size) {
      const symbol = affected.symbols.values().next().value!;
      const scope = relatedScope(all, [], symbol ? [symbol] : []), pools = symbol ? scope.symbols : [''];
      work.push({ scope, targets: [], pools }); pools.forEach(s => affected.symbols.delete(s));
    }
    return work;
  }
  async update(now: number, valid: () => boolean = () => true): Promise<boolean> {
    if(this.readOnlyView)throw new Error('task_projection_read_only');
    const sequence = this.latest(); if (this.meta && sequence <= this.meta.sequence) {this.prune();return false;}
    const epoch = new TransactionFeeStore(this.db).epoch(this.key); if (!epoch || epoch.profile_id !== this.profile) return false;
    const all = projectionGroups(this.db, this.key, this.profile), ranges = coverageRanges(this.db, this.key);
    const plan = this.plan(all, this.meta ? this.changes(sequence) : [], epoch), results: ProjectionWork[] = [];
    this.db.prepare('DELETE FROM task_pnl_projection_work WHERE account_key=? AND source_sequence<>?').run(this.key, sequence);
    for (const work of plan) {
      if (!valid()) throw new Error('task_projection_interrupted');
      if (this.latest() !== sequence) return false;
      results.push(this.compute(work, sequence, now));
      await this.yieldControl();
    }
    if (!valid()) throw new Error('task_projection_interrupted');
    if (this.latest() !== sequence) return false;
    return this.publish(results, all, { sequence, version: (this.meta?.version ?? 0) + 1, checkedAt: now, ranges, epoch,
      totals: this.meta?.totals ?? poolTotals([]),taskOrder:new TransactionFeeStore(this.db).reportTasks(this.profile).map(t=>t.id) });
  }
  private compute(work: WorkScope, sequence: number, now: number): ProjectionWork {
    const workKey = createHash('sha256').update(JSON.stringify(work)).digest('hex');
    const row = this.db.prepare('SELECT payload FROM task_pnl_projection_work WHERE account_key=? AND source_sequence=? AND work_key=?')
      .get(this.key, sequence, workKey) as { payload: string } | undefined;
    if (row) {
      try { const result = workSchema.parse(JSON.parse(row.payload)); this.statistics.resumedBatches++; return result; }
      catch { /* Invalid uncommitted work is recomputed, never published. */ }
    }
    const result = this.db.transaction(() => buildProjection(this.db, this.key, this.profile, now, work.scope, work.targets, work.pools))();
    workSchema.parse(result);
    this.db.prepare('INSERT OR REPLACE INTO task_pnl_projection_work VALUES (?,?,?,?)').run(this.key, sequence, workKey, JSON.stringify(result));
    this.statistics.historyBatches++; this.statistics.historyGroups += result.groups.length;
    return result;
  }
  private publish(results: ProjectionWork[], all: GroupScope[], meta: Meta): boolean {
    const groups = new Map(this.groups), pools = new Map(this.pools), live = new Set(all.map(g => g.id));
    for (const id of groups.keys()) if (!live.has(id)) groups.delete(id);
    for (const result of results) { result.groups.forEach(g => groups.set(g.group.id, g)); result.pools.forEach(p => pools.set(p.symbol, p)); }
    const published = { ...meta, totals: results.some(r => r.pools.length) ? poolTotals([...pools.values()]) : meta.totals };
    // Serialize potentially large display pools before acquiring the database writer lock.
    const prepared=results.map(r=>({groups:r.groups.map(g=>({id:g.group.id,payload:JSON.stringify(g)})),
      pools:r.pools.map(p=>({symbol:p.symbol,payload:JSON.stringify(p)})),dependencies:r.dependencies}));
    const metadata=JSON.stringify({ranges:meta.ranges,epoch:meta.epoch,totals:published.totals,taskOrder:meta.taskOrder});
    const committed=this.db.transaction(() => {
      if(this.latest()!==meta.sequence)return false;
      for (const id of this.groups.keys()) if (!live.has(id)) {
        this.db.prepare('DELETE FROM task_pnl_group_cache WHERE account_key=? AND group_id=?').run(this.key, id);
        this.db.prepare("DELETE FROM task_pnl_dependencies WHERE account_key=? AND target_kind='group' AND target_id=?").run(this.key, id);
      }
      for (const result of prepared) this.saveResult(result);
      this.db.prepare(`INSERT INTO task_pnl_projection VALUES (?,?,?,?,?,?) ON CONFLICT(account_key) DO UPDATE SET
        profile_id=excluded.profile_id,processed_sequence=excluded.processed_sequence,version=excluded.version,checked_at=excluded.checked_at,meta_json=excluded.meta_json`)
        .run(this.key, this.profile, meta.sequence, meta.version, meta.checkedAt, metadata);
      this.db.prepare('DELETE FROM task_pnl_projection_work WHERE account_key=? AND source_sequence<=?').run(this.key, meta.sequence);
      return true;
    }).immediate();
    if(!committed)return false;
    this.meta = published; this.groups = groups; this.pools = pools;
    this.prune();
    return true;
  }
  /** Retire only acknowledged notices, in bounded batches. Canonical evidence is never removed. */
  private prune():void {
    if(!this.meta)return;
    try {
      this.db.prepare(`DELETE FROM task_pnl_changes WHERE sequence IN (
        SELECT c.sequence FROM task_pnl_changes c WHERE c.sequence<=? AND (c.account_key=? OR c.profile_id=? OR (c.account_key IS NULL AND c.profile_id IS NULL))
        AND EXISTS(SELECT 1 FROM task_pnl_projection p WHERE c.account_key=p.account_key OR c.profile_id=p.profile_id OR (c.account_key IS NULL AND c.profile_id IS NULL))
        AND NOT EXISTS(SELECT 1 FROM task_pnl_projection p WHERE p.processed_sequence<c.sequence AND
          (c.account_key=p.account_key OR c.profile_id=p.profile_id OR (c.account_key IS NULL AND c.profile_id IS NULL))) LIMIT 200)`)
        .run(this.meta.sequence,this.key,this.profile);
    }catch(error){
      if(error&&typeof error==='object'&&'code' in error&&['SQLITE_BUSY','SQLITE_BUSY_SNAPSHOT','SQLITE_LOCKED'].includes(String(error.code)))this.statistics.cleanupDeferred++;
      else throw error;
    }
  }
  private saveResult(result: PreparedWork): void {
    const saveDependencies = (kind: string, id: string) => {
      this.db.prepare('DELETE FROM task_pnl_dependencies WHERE account_key=? AND target_kind=? AND target_id=?').run(this.key, kind, id);
      const insert = this.db.prepare('INSERT OR IGNORE INTO task_pnl_dependencies VALUES (?,?,?,?,?,?)');
      for (const d of result.dependencies) insert.run(this.key, kind, id, d.coin, d.at, d.rate);
    };
    for (const g of result.groups) {
      this.db.prepare('INSERT OR REPLACE INTO task_pnl_group_cache VALUES (?,?,?)').run(this.key, g.id, g.payload); saveDependencies('group', g.id);
    }
    for (const p of result.pools) {
      this.db.prepare('INSERT OR REPLACE INTO task_pnl_pool_cache VALUES (?,?,?)').run(this.key, p.symbol, p.payload); saveDependencies('pool', p.symbol);
    }
  }
  summary(now: number, failure: string | null, valuation?: TradingValuation): TaskPerformanceSummary | null {
    if (!this.meta) return null;
    const pending = this.pending(), reason = failure ?? (pending ? 'task_recalculating' : null);
    const fees = new TransactionFeeStore(this.db), tasks = [...this.groups.values()].flatMap(group => {
      const trading = renderTrading(group.trading, this.meta!.ranges, fees, this.key, this.profile, now, valuation);
      return group.legacy.map(stage => {
        const task = renderLegacy(stage, this.meta!.ranges, this.meta!.epoch, now, reason), result = trading[task.taskId];
        return { ...task, trading: pending && result.status !== 'transferred'
          ? { ...result, status: 'partial' as const, stale: true, reasons: [...new Set([...result.reasons, 'task_recalculating'])] } : result };
      });
    });
    const order=new Map(this.meta.taskOrder.map((id,i)=>[id,i]));tasks.sort((a,b)=>(order.get(a.taskId)??Infinity)-(order.get(b.taskId)??Infinity));
    return { profileId: this.profile, checkedAt: this.meta.checkedAt, stale: !!reason, reason, tasks,
      ...this.meta.totals };
  }
}
