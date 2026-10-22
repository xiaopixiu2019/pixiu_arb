import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { AccountPerformance, PerformanceRange } from '@gate-crossex/shared-types';
import { DEFAULT_CREDENTIAL_PROFILE, type CredentialVault } from './credential-vault.js';
import type { ReadOnlyCrossExGateway, PortfolioOperationsCrossExGateway } from './crossex-client.js';
import { PerformanceStore } from './performance-store.js';
import { ledgerFlows, readAllPages } from './performance-ledger.js';
import { valueBalances, type PerformanceSample } from './performance-math.js';
import { emptyPerformance, performanceReport } from './performance-report.js';

interface Options {
  database: Database.Database; gateway: ReadOnlyCrossExGateway; vault: CredentialVault;
  profile(): string | null; context(): string; now?: () => number;
}
export class AccountPerformanceService {
  private readonly store: PerformanceStore;
  private readonly now: () => number;
  private key: string | null = null;
  private scope: string | null = null;
  private failure: string | null = null;
  private pending: Promise<void> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private controller: AbortController | null = null;
  private stopped = false;
  private attemptAt = 0;
  private attemptScope: string | null = null;
  constructor(private readonly o: Options) { this.store = new PerformanceStore(o.database); this.now = o.now ?? Date.now; }
  start(): void {
    const tick = () => {
      if (this.stopped) return;
      void this.refresh().finally(() => { if (!this.stopped) { this.timer = setTimeout(tick, 60_000 - this.now() % 60_000); this.timer.unref?.(); } });
    };
    tick();
  }
  async stop(): Promise<void> { this.stopped = true; if (this.timer) clearTimeout(this.timer); this.controller?.abort(); await this.pending; }
  async refresh(): Promise<void> {
    if (this.pending) return this.pending;
    if (this.stopped) return;
    const context = this.o.context();
    this.attemptAt = this.now(); this.attemptScope = context; this.controller = new AbortController();
    const signal = AbortSignal.any([this.controller.signal, AbortSignal.timeout(30_000)]);
    let abort!: () => void;
    const interrupted = new Promise<void>((_resolve, reject) => { abort = () => reject(signal.reason); signal.addEventListener('abort', abort, { once: true }); });
    this.pending = Promise.race([this.capture(context, signal), interrupted]).catch((error: unknown) => {
      if (context === this.o.context()) { this.key = null; this.scope = null; this.failure = error instanceof Error && /^[a-z_]+$/.test(error.message) ? error.message : 'account_unavailable'; }
    }).finally(() => { signal.removeEventListener('abort', abort); this.pending = null; this.controller = null; });
    return this.pending;
  }
  async read(range: PerformanceRange): Promise<AccountPerformance> {
    const context = this.o.context();
    if (this.attemptScope !== context || this.now() - this.attemptAt >= 30_000) await this.refresh();
    if (context !== this.o.context()) return emptyPerformance(this.o.profile(), 'account_changed');
    if (!this.key || this.scope !== context) return emptyPerformance(this.o.profile(), this.failure ?? 'waiting_for_baseline');
    const samples = this.store.samples(this.key), first = samples.find((s) => !s.reason && s.equity !== null);
    return performanceReport(this.o.profile()!, samples, this.store.flows(this.key), first ? this.store.coveredThrough(this.key, first.at) : 0,
      range, this.now(), this.failure ?? this.store.latestFailure(this.key));
  }
  private async capture(context: string, signal: AbortSignal): Promise<void> {
    const profile = this.o.profile(), credentials = await this.o.vault.get(DEFAULT_CREDENTIAL_PROFILE);
    this.assertContext(context, signal);
    if (!profile || !credentials) throw new Error('account_unavailable');
    const account = await this.o.gateway.queryAccount(credentials, undefined, signal);
    this.assertContext(context, signal);
    const capturedAt = this.now();
    if (!account.user_id) throw new Error('account_identity_missing');
    const key = createHash('sha256').update(`${profile}:${account.user_id}`).digest('hex');
    const assets = account.assets.map((a) => ({ venue: a.exchange_type, coin: a.coin, equity: a.equity, availableBalance: a.available_balance, liability: a.liability }));
    const rates = this.o.gateway.queryValuationRates ? await this.o.gateway.queryValuationRates([...new Set(assets.map((a) => a.coin))], signal) : { USDT: '1' };
    this.assertContext(context, signal);
    const values = account.account_mode === 'CROSS_EXCHANGE' ? valueBalances(assets, rates) : { equity: null, available: null, reason: 'account_coverage_missing' };
    const sample: PerformanceSample = { at: capturedAt, ...values, rates };
    this.scope = context; this.key = key; this.failure = null;
    const earlier = this.store.baseline(key);
    this.store.saveSample(key, sample, assets);
    const baseline = earlier ?? (sample.equity !== null && !sample.reason ? sample : null);
    if (!baseline || baseline.at === sample.at) { if (baseline) this.store.saveCoverage(key, sample.at, sample.at, null); return; }
    const from = this.store.coveredThrough(key, baseline.at);
    await this.captureLedger(key, context, credentials, from, sample, signal);
  }
  private async captureLedger(key: string, context: string, credentials: NonNullable<Awaited<ReturnType<CredentialVault['get']>>>, from: number, sample: PerformanceSample, signal: AbortSignal): Promise<void> {
    const gateway = this.o.gateway as ReadOnlyCrossExGateway & Partial<PortfolioOperationsCrossExGateway>;
    if (!gateway.queryAccountBook || !gateway.queryTransfers) { this.store.saveCoverage(key, from, sample.at, 'ledger_unavailable'); return; }
    try {
      const query = { from: Math.max(0, from - 86_400_000), to: sample.at, limit: 200 };
      const book = await readAllPages((page) => gateway.queryAccountBook!(credentials, { ...query, from: from - 60_000, page }, signal));
      const transfers = await readAllPages((page) => gateway.queryTransfers!(credentials, { ...query, page }, signal));
      this.assertContext(context, signal);
      if (book.some((row) => !Number.isSafeInteger(Number(row.create_time)) || Number(row.create_time) < from - 60_000 || Number(row.create_time) > sample.at)) throw new Error('ledger_range_unverified');
      const flows = ledgerFlows(book, transfers, from, sample.at, (coin, at) => {
        if (coin === 'USDT') return '1';
        return this.store.rateAt(key, coin, at);
      });
      this.store.saveCoverage(key, from, sample.at, flows.find((f) => f.reason)?.reason ?? null, flows);
    } catch (error) {
      this.assertContext(context, signal);
      const reason = error instanceof Error && /^[a-z_]+$/.test(error.message) ? error.message : 'ledger_unavailable';
      this.store.saveCoverage(key, from, sample.at, reason);
    }
  }
  private assertContext(context: string, signal: AbortSignal): void {
    signal.throwIfAborted();
    if (this.stopped || context !== this.o.context()) throw new Error('account_changed');
  }
}
