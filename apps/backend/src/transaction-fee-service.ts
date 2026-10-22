import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { FeeDetail, FeeSummary } from '@gate-crossex/shared-types';
import { DEFAULT_CREDENTIAL_PROFILE, type CredentialVault, type GateCredentials } from './credential-vault.js';
import type { PortfolioOperationsCrossExGateway, ReadOnlyCrossExGateway } from './crossex-client.js';
import { readAllPages } from './performance-ledger.js';
import { TransactionFeeStore } from './transaction-fee-store.js';
import { emptyFeeSummary, feeDetail, feeSummary } from './transaction-fee-report.js';

interface Options { database: Database.Database; gateway: ReadOnlyCrossExGateway; vault: CredentialVault; profile(): string | null; context(): string; now?: () => number }
export class TransactionFeeService {
  private readonly store: TransactionFeeStore;
  private readonly now: () => number;
  private pending: Promise<void> | null = null;
  private controller: AbortController | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private key: string | null = null;
  private scope: string | null = null;
  private attemptScope: string | null = null;
  private attemptAt = 0;
  private failure = 'fee_collecting';
  private recheckIndex = 0;
  constructor(private readonly o: Options) { this.store = new TransactionFeeStore(o.database); this.now = o.now ?? Date.now; }
  start(): void {
    const tick = () => { if (!this.stopped) void this.refresh().finally(() => {
      if (!this.stopped) { this.timer = setTimeout(tick, 60_000 - this.now() % 60_000); this.timer.unref?.(); }
    }); };
    tick();
  }
  async stop(): Promise<void> { this.stopped = true; if (this.timer) clearTimeout(this.timer); this.controller?.abort(); await this.pending; }
  async refresh(): Promise<void> {
    if (this.pending) return this.pending;
    if (this.stopped) return;
    const scope = this.o.context(); this.attemptScope = scope; this.attemptAt = this.now(); this.controller = new AbortController();
    const signal = AbortSignal.any([this.controller.signal, AbortSignal.timeout(30_000)]);
    let abort!: () => void;
    const interrupted = new Promise<void>((_, reject) => { abort = () => reject(signal.reason); signal.addEventListener('abort', abort, { once: true }); });
    this.pending = Promise.race([this.capture(scope, signal), interrupted]).catch((error: unknown) => {
      if (scope === this.o.context()) { this.key = null; this.scope = null; this.failure = this.reason(error); }
    }).finally(() => { signal.removeEventListener('abort', abort); this.pending = null; this.controller = null; });
    return this.pending;
  }
  private async ensure(): Promise<boolean> {
    const scope = this.o.context();
    if (scope !== this.attemptScope || this.now() - this.attemptAt >= 30_000) await this.refresh();
    return scope === this.o.context() && this.scope === scope && this.key !== null;
  }
  async summary(): Promise<FeeSummary> { return await this.ensure() ? feeSummary(this.store, this.key!, this.now()) : emptyFeeSummary(this.o.profile(), this.failure); }
  async detail(taskId: string | null, page: number): Promise<FeeDetail | null> {
    return await this.ensure() ? feeDetail(this.store, this.key!, this.now(), taskId, page) : null;
  }
  private async capture(scope: string, signal: AbortSignal): Promise<void> {
    const profile = this.o.profile(), credentials = await this.o.vault.get(DEFAULT_CREDENTIAL_PROFILE);
    this.assert(scope, signal);
    if (!profile || !credentials) throw new Error('fee_account_unavailable');
    const account = await this.o.gateway.queryAccount(credentials, undefined, signal); this.assert(scope, signal);
    if (!account.user_id) throw new Error('fee_identity_unverified');
    const key = createHash('sha256').update(`${profile}:${account.user_id}`).digest('hex'), at = this.now();
    const epoch = this.store.begin(key, profile, at); this.key = key; this.scope = scope;
    const from = Math.max(epoch.started_at, epoch.covered_to - 60_000);
    await this.readBook(key, credentials, scope, from, at, signal);
    await this.readTrades(key, profile, credentials, scope, Math.max(epoch.started_at, epoch.trades_to - 60_000), at, signal);
    const recheck = this.store.recheckWindow(key, profile, this.recheckIndex++);
    if (recheck && recheck.from < from) {
      const to = Math.min(recheck.to, at);
      if (to >= recheck.from) { await this.readBook(key, credentials, scope, recheck.from, to, signal, false);
        await this.readTrades(key, profile, credentials, scope, recheck.from, to, signal, false); }
    }
  }
  private async readBook(key: string, credentials: GateCredentials, scope: string, from: number, to: number, signal: AbortSignal, advanceCoverage = true): Promise<void> {
    const gateway = this.o.gateway as ReadOnlyCrossExGateway & Partial<PortfolioOperationsCrossExGateway>;
    try {
      if (!gateway.queryAccountBook) throw new Error('fee_book_unavailable');
      const records = await readAllPages(async (page) => { this.assert(scope, signal); return gateway.queryAccountBook!(credentials, { from, to, page, limit: 200, statementType: 'TRADING_FEE' }, signal); });
      this.assert(scope, signal);
      if (records.some((r) => r.statement_type !== 'TRADING_FEE' || !Number.isSafeInteger(Number(r.create_time)) || Number(r.create_time) < from || Number(r.create_time) > to)) throw new Error('fee_range_unverified');
      let rates: Record<string, string> = { USDT: '1' };
      try { if (gateway.queryValuationRates && records.length) rates = await gateway.queryValuationRates([...new Set(records.map((r) => r.coin))], signal); }
      catch { this.assert(scope, signal); }
      this.assert(scope, signal); this.store.rates(key, this.now(), rates); this.store.saveBook(key, records, to, advanceCoverage);
    } catch (error) { this.assert(scope, signal); this.store.fail(key, 'book', this.reason(error)); }
  }
  private async readTrades(key: string, profile: string, credentials: GateCredentials, scope: string, from: number, to: number, signal: AbortSignal, advanceCoverage = true): Promise<void> {
    try {
      if (!this.o.gateway.queryFeeTrades) throw new Error('fee_trades_unavailable');
      const records = await readAllPages(async (page) => {
        this.assert(scope, signal);
        return (await this.o.gateway.queryFeeTrades!(credentials, { from, to, page, limit: 200 }, signal)).map((t) => ({ ...t, id: `${t.exchange_type}:${t.transaction_id}` }));
      });
      this.assert(scope, signal);
      if (records.some((t) => !Number.isSafeInteger(Number(t.create_time)) || Number(t.create_time) < from || Number(t.create_time) > to)) throw new Error('fee_range_unverified');
      this.store.saveTrades(key, profile, records.map(({ id: _id, ...t }) => { void _id; return t; }), to, advanceCoverage);
    } catch (error) { this.assert(scope, signal); this.store.fail(key, 'trade', this.reason(error)); }
  }
  private reason(error: unknown): string { return error instanceof Error && /^[a-z_]+$/.test(error.message) ? error.message : 'fee_data_unavailable'; }
  private assert(scope: string, signal: AbortSignal): void { signal.throwIfAborted(); if (this.stopped || scope !== this.o.context()) throw new Error('fee_account_changed'); }
}
