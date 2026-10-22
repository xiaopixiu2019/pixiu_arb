import { createHash, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { TaskPerformanceSummary } from '@gate-crossex/shared-types';
import { DEFAULT_CREDENTIAL_PROFILE, type CredentialVault, type GateCredentials } from './credential-vault.js';
import type { GateCrossExPosition, ReadOnlyCrossExGateway, PortfolioOperationsCrossExGateway } from './crossex-client.js';
import { readAllPages } from './performance-ledger.js';
import { TransactionFeeStore } from './transaction-fee-store.js';
import { TaskPerformanceStore } from './task-performance-store.js';
import { taskPerformanceReport } from './task-performance-report.js';
import { taskTradingReport, type TradingValuation } from './task-trading-report.js';
import { TaskPerformanceCache, retainTradingResults } from './task-performance-cache.js';
import { decimal } from './task-trading-groups.js';
interface Options {
  database: Database.Database; gateway: ReadOnlyCrossExGateway; vault: CredentialVault;
  profile(): string | null; context(): string; now?: () => number; valuation?(): TradingValuation | undefined;
}
const HOUR = 3600000;
function denied(error: unknown): boolean {
  return !!error && typeof error === 'object' && ([401, 403].includes(Number('statusCode' in error ? error.statusCode : 'status' in error ? error.status : 0)));
}
export function financialPositions(profileId: string, at: number, positions: GateCrossExPosition[]): TradingValuation {
  return { profileId, at, positions: positions.map(p => ({ symbol: p.symbol, unrealizedPnl: p.upnl,
    quantity: p.position_side === 'SHORT' ? decimal(p.position_qty)?.abs().negated().toFixed() ?? ''
      : p.position_side === 'LONG' ? decimal(p.position_qty)?.abs().toFixed() ?? '' : p.position_qty })) };
}
export class TaskPerformanceService {
  private readonly store: TaskPerformanceStore;
  private readonly cache: TaskPerformanceCache;
  private readonly now: () => number;
  private readonly boot = randomUUID();
  private pending: Promise<void> | null = null;
  private physicalCapture: Promise<void> | null = null;
  private controller: AbortController | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private key: string | null = null;
  private scope: string | null = null;
  private attemptedScope: string | null = null;
  private attemptedAt = 0;
  private failure: string | null = 'task_collecting';
  private recheck = 0;
  private previous: TaskPerformanceSummary | null = null;
  private valuation?: TradingValuation;
  private valuationPending: Promise<void> | null = null;
  private physicalValuation: Promise<void> | null = null;
  private valuationController: AbortController | null = null;
  private valuationAttemptAt = -Infinity;
  constructor(private readonly o: Options) {
    this.store = new TaskPerformanceStore(o.database); this.cache = new TaskPerformanceCache(o.database); this.now = o.now ?? Date.now;
  }
  start(): void {
    const tick = () => { if (!this.stopped) void this.refresh().finally(() => {
      if (!this.stopped) { this.timer = setTimeout(tick, 60000); this.timer.unref?.(); }
    }); }; tick();
  }
  async stop(): Promise<void> {
    this.stopped = true; if (this.timer) clearTimeout(this.timer); this.controller?.abort(); this.valuationController?.abort();
    await Promise.all([this.pending, this.valuationPending]);
  }
  private assert(scope: string, signal: AbortSignal): void {
    signal.throwIfAborted(); if (this.stopped || scope !== this.o.context()) throw new Error('account_changed');
  }
  private invalidate(): void { this.key = null; this.scope = null; this.previous = null; this.valuation = undefined; }
  async refresh(): Promise<void> {
    if (this.pending) return this.pending; if (this.stopped || this.physicalCapture) return;
    const scope = this.o.context(); if (this.scope !== scope) this.invalidate();
    this.attemptedScope = scope; this.attemptedAt = this.now(); this.controller = new AbortController();
    const signal = AbortSignal.any([this.controller.signal, AbortSignal.timeout(30000)]);
    let abort!: () => void;
    const interrupted = new Promise<void>((_, reject) => { abort = () => reject(signal.reason); signal.addEventListener('abort', abort, { once: true }); });
    const physical = this.capture(scope, signal).finally(() => { if (this.physicalCapture === physical) this.physicalCapture = null; });
    this.physicalCapture = physical;
    this.pending = Promise.race([physical, interrupted]).catch((error: unknown) => {
      if (scope !== this.o.context()) return;
      this.failure = 'task_data_unavailable';
      if (denied(error)) this.invalidate();
    }).finally(() => { signal.removeEventListener('abort', abort); this.pending = null; this.controller = null; });
    return this.pending;
  }
  async summary(): Promise<TaskPerformanceSummary> {
    const scope = this.o.context(); if (this.scope !== scope) this.invalidate();
    if (!this.stopped && (scope !== this.attemptedScope || this.now() - this.attemptedAt >= 60000)) void this.refresh();
    const contextToken = createHash('sha256').update(`${this.boot}:${scope}:${this.key ?? 'unverified'}`).digest('hex');
    if (!this.key || this.scope !== scope) return { profileId: this.o.profile(), contextToken, checkedAt: null, reason: this.failure,
      stale: true, tasks: [], unallocated: { amount: null, native: {}, count: 0 } };
    const supplied = this.o.valuation?.();
    if (supplied?.profileId === this.o.profile() && supplied!.at > (this.valuation?.at ?? 0)) this.valuation = supplied;
    try {
      const report = taskPerformanceReport(this.store, this.key, this.o.profile()!, this.now(), this.failure);
      const trading = taskTradingReport(this.store, this.key, this.o.profile()!, this.now(), this.valuation);
      if (Object.values(trading.results).some(t => t.valuationAt !== null || t.reasons.includes('valuation_pending'))) this.scheduleValuation(scope);
      const next = retainTradingResults({ ...report, contextToken, stale: this.failure !== null, accountCosts: trading.accountCosts, unresolvedCashflows: trading.unresolvedCashflows,
        tasks: report.tasks.map(t => ({ ...t, trading: trading.results[t.taskId] })) }, this.previous);
      this.previous = next; this.cache.save(this.key, this.o.profile()!, next); return next;
    } catch {
      return this.previous ? { ...this.previous, contextToken, stale: true, reason: 'task_data_unavailable' }
        : { profileId: this.o.profile(), contextToken, checkedAt: null, stale: true, reason: 'task_data_unavailable', tasks: [], unallocated: { amount: null, native: {}, count: 0 } };
    }
  }
  private async capture(scope: string, signal: AbortSignal): Promise<void> {
    const profile = this.o.profile(), credentials = await this.o.vault.get(DEFAULT_CREDENTIAL_PROFILE); this.assert(scope, signal);
    if (!profile || !credentials) throw new Error('account_unavailable');
    const account = await this.o.gateway.queryAccount(credentials, undefined, signal); this.assert(scope, signal);
    if (!account.user_id) throw new Error('identity_unverified');
    const key = createHash('sha256').update(`${profile}:${account.user_id}`).digest('hex');
    if (key !== this.key) { this.previous = this.cache.read(key, profile); this.valuation = undefined; }
    this.key = key; this.scope = scope;
    const fees = new TransactionFeeStore(this.o.database), epoch = fees.epoch(key);
    if (!epoch) { this.failure = 'task_collecting'; return; }
    const at = this.now(), earliest = Math.max(epoch.started_at, Math.min(at, ...fees.tasks(profile).map(t => Date.parse(t.created_at)).filter(Number.isFinite)));
    const through = this.store.through(key, earliest);
    const historical = through < at - HOUR ? through : earliest + (this.recheck++ % Math.max(1, Math.ceil((at - earliest) / (24 * HOUR)))) * 24 * HOUR;
    const windows = [{ from: Math.max(earliest, at - HOUR), to: at }, { from: Math.max(earliest, historical - 60000), to: Math.min(at, historical + 24 * HOUR) }];
    let failed = false;
    for (const window of windows) {
      try { await this.captureWindow(credentials, key, scope, window, signal); }
      catch (error) { this.assert(scope, signal); if (denied(error)) throw error; failed = true; }
    }
    this.assert(scope, signal); this.failure = failed ? 'task_data_unavailable' : null;
  }
  private async captureWindow(credentials: GateCredentials, key: string, scope: string, window: { from: number; to: number }, signal: AbortSignal): Promise<void> {
    const gateway = this.o.gateway as ReadOnlyCrossExGateway & Partial<PortfolioOperationsCrossExGateway>;
    if (!gateway.queryAccountBook) throw new Error('ledger_unavailable');
    const read = async (w: typeof window) => ({ window: w, records: await readAllPages(page => {
      this.assert(scope, signal); return gateway.queryAccountBook!(credentials, { ...w, page, limit: 200 }, signal);
    }) });
    const captured = await read(window).catch(error => {
      if (error instanceof Error && error.message === 'ledger_pagination_incomplete' && window.to - window.from > 6 * HOUR) return read({ ...window, to: window.from + 6 * HOUR });
      throw error;
    });
    this.assert(scope, signal);
    if (gateway.queryValuationRates) {
      try {
        const rates = await gateway.queryValuationRates([...new Set(captured.records.map(r => r.coin))], signal); this.assert(scope, signal);
        new TransactionFeeStore(this.o.database).rates(key, this.now(), rates);
      } catch { this.assert(scope, signal); }
    }
    this.store.save(key, captured.records, captured.window.from, captured.window.to);
  }
  private scheduleValuation(scope: string): void {
    if (this.stopped || this.valuationPending || this.physicalValuation || this.now() - this.valuationAttemptAt < 5000 || this.valuation && this.now() - this.valuation.at < 5000) return;
    if (!this.o.gateway.queryPositions) return;
    this.valuationAttemptAt = this.now(); this.valuationController = new AbortController();
    const signal = AbortSignal.any([this.valuationController.signal, AbortSignal.timeout(4000)]);
    let abort!: () => void;
    const interrupted = new Promise<void>((_, reject) => { abort = () => reject(signal.reason); signal.addEventListener('abort', abort, { once: true }); });
    const physical = this.captureValuation(scope, signal).finally(() => { if (this.physicalValuation === physical) this.physicalValuation = null; });
    this.physicalValuation = physical;
    this.valuationPending = Promise.race([physical, interrupted])
      .catch((error: unknown) => { if (scope === this.o.context() && denied(error)) this.invalidate(); })
      .finally(() => { signal.removeEventListener('abort', abort); this.valuationPending = null; this.valuationController = null; });
  }
  private async captureValuation(scope: string, signal: AbortSignal): Promise<void> {
    const profile = this.o.profile(), key = this.key, credentials = await this.o.vault.get(DEFAULT_CREDENTIAL_PROFILE); this.assert(scope, signal);
    if (!profile || !key || !credentials) return;
    const positions = await this.o.gateway.queryPositions(credentials, signal); this.assert(scope, signal);
    const at = this.now();
    if (this.o.gateway.queryValuationRates) {
      const rates = await this.o.gateway.queryValuationRates([...new Set(positions.map(p => p.symbol.split('_').at(-1)!))], signal); this.assert(scope, signal);
      if (key !== this.key) return;
      new TransactionFeeStore(this.o.database).rates(key, this.now(), rates);
    }
    if (key === this.key) this.valuation = financialPositions(profile, at, positions);
  }
}
