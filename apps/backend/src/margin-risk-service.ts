import { marginReadFault } from './margin-read-fault.js';
import { PairedEntryAdmission } from './paired-entry-admission.js';
import type Database from 'better-sqlite3';
import { Decimal } from 'decimal.js';
import type { MarginSnapshot } from '@gate-crossex/shared-types';
import type { GateCredentials } from './credential-vault.js';
import type { GateCrossExPosition, ReadOnlyCrossExGateway, TradingCrossExGateway } from './crossex-client.js';
import { GateApiError } from './crossex-client.js';
import { managedLegs, type ManagedPositionManager } from './managed-position-manager.js';
import { readManagedState } from './managed-position-store.js';
import type { StrategyEngine, MarketSource } from './strategy-engine.js';
import { TradingRuntimeError, type TradingRuntime } from './trading-runtime.js';
import { MarginRiskMonitor } from './margin-risk-monitor.js';
import { MarginRiskStore } from './margin-risk-store.js';
import { freshManagedQuote, pairedQuantities } from './managed-position-model.js';
import { readCrossMarginEvidence } from './cross-margin-admission.js';
import { MarginReductionEvidence } from './margin-reduction-evidence.js';
import { commonQuantityStep, marginGroupPlanDetailed, reportedMarketCaps } from './margin-group-plan.js';
import { marginExecutionCapacity } from './margin-projection-plan.js';
import { marginParameterReader, marginParametersId, type MarginRiskParameters } from './margin-risk-parameters.js';
import { borrowingAccountCalibrated } from './margin-account-projection.js';
import { marginFeesSettled } from './margin-fee-settlement.js';
import { marginCostProof } from './margin-cost-proof.js';
import { marginTolerance } from './margin-approximation.js';

export interface MarginServiceOptions {
  db: Database.Database; gateway: ReadOnlyCrossExGateway; runtime: TradingRuntime; manager: ManagedPositionManager;
  engine: StrategyEngine; markets: MarketSource; context(): string; profile(): { id: string; label: string } | null;
  credentials(signal?: AbortSignal): Promise<GateCredentials | null>; live(): boolean;
  enforce: boolean;
  readFailure?(fields: Record<string, unknown>): void;
  dataDir?: string;
  parameters?: () => MarginRiskParameters | null;
  funding?(symbol: string): { rate8h: string; fetchedAt: number } | null;
}
export function createMarginRiskService(o: MarginServiceOptions): MarginRiskMonitor {
  const accountGateway = o.gateway.createStatisticsReader?.() ?? o.gateway;
  // Retain the physical work until it settles; an ignored abort must not multiply credential/HTTP calls.
  let accountRead: Promise<import('./margin-risk-monitor.js').MarginAccountRead> | null = null;
  let readStage = 'idle', readStartedAt = 0, readSequence = 0;
  let currentAccount: Awaited<ReturnType<ReadOnlyCrossExGateway['queryAccount']>> | null = null;
  const readParameters = o.parameters ?? (o.dataDir ? marginParameterReader(o.dataDir) : () => null);
  const evidence = new MarginReductionEvidence(o.gateway.createStatisticsReader?.() ?? o.gateway, o.markets, o.context, o.funding);
  const failures = new Map<string, string>();
  let positions: GateCrossExPosition[] = [], positionsAt = 0, accountMode = '', accountContext = '';
  let positionContext = '';
  let positionRead: Promise<void> | null = null;
  let remoteOpenOrders = -1;
  const refreshPositions = (credentials: GateCredentials, context: string): void => {
    if (positionRead) return;
    const request = o.gateway.queryManagedState
      ? o.gateway.queryManagedState(credentials, AbortSignal.timeout(4000)) : o.gateway.queryPortfolio(credentials, AbortSignal.timeout(4000));
    positionRead = request.then((result) => {
      if (context === o.context()) { positions = result.positions; remoteOpenOrders = result.openOrders.length; positionsAt = Date.now(); positionContext = context; }
    }).catch(() => { if (context === o.context()) positionsAt = 0; }).finally(() => { positionRead = null; });
  };
  const store = new MarginRiskStore(o.db);
  const groups = (): MarginSnapshot['groups'] => o.runtime.listStrategies().filter((s) => s.config.management && s.accountProfileId === o.profile()?.id)
    .filter((s) => s.management?.phase !== 'TRANSFERRED').map((s) => {
      const state = readManagedState(o.db, s.id), legs = managedLegs(s.config);
      const modeKnown = positionContext === o.context() && Date.now() - positionsAt < 5000 && legs.every((l) => positions.find((p) => p.symbol === l.symbol)?.margin_mode === 'CROSS');
      const eligible = accountMode === 'CROSS_EXCHANGE' && s.status === 'RUNNING' && (!!state && ['MONITORING', 'EXITING', 'BALANCING'].includes(state.phase) || !!state?.marginBatch)
        && state?.stopIntent !== 'KEEP' && !state?.protectionIncident && modeKnown;
      const readiness = eligible && currentAccount ? groupReadiness(o.db, evidence, o.markets, currentAccount, s, positions)
        : { status: 'unknown' as const, reason: 'position_margin_mode_unverified', maxBatchQuantity: null, checkedAt: Date.now() };
      return { id: state?.groupId ?? s.id, strategyId: s.id, asset: s.config.asset, phase: state?.phase ?? s.status,
        eligible, authorized: false, reason: eligible ? null : !modeKnown ? 'position_margin_mode_unverified' : 'group_not_monitoring', readiness };
    });
  const monitor = new MarginRiskMonitor(store, {
    onStop: () => o.runtime.stopPairedEntries(),
    context: o.context, live: o.live, groups,
    onReadFault: (fields) => o.readFailure?.({ ...fields, stage: readStage, startedAt: readStartedAt, endedAt: Date.now(), context: accountContext, elapsedMs: Date.now() - readStartedAt, requestId: readSequence }),
    valuation: () => { const value = evidence.valuation(); return value ? { ...value, profileId: o.profile()?.id ?? null } : null; },
    proposal: (record, facts, metrics, policy) => {
      if (!currentAccount) { failures.set(record.id, 'margin_account_unavailable'); return null; }
      const result = marginGroupPlanDetailed(o.db, evidence, o.markets, { ...currentAccount, margin_balance: metrics.marginBalance }, record, facts, metrics, policy);
      if (!result.ok) { failures.set(record.id, result.reason); return null; }
      failures.delete(record.id); return result.plan;
    },
    proposalFailure: id => failures.get(id) ?? null,
    costProof: item => currentAccount?.user_id && o.profile() ? marginCostProof(o.db, item, o.profile()!.id, currentAccount.user_id) : null,
    onUnexplainedCost: () => o.manager.failAll('margin_execution_cost_exceeded'),
    parametersId: () => {
      const p = readParameters();
      return p && p.profileId === o.profile()?.id && p.userId === currentAccount?.user_id && p.checkedAt <= Date.now() && p.validUntil > Date.now()
        ? marginParametersId(p) : null;
    },
    modes: async (symbols) => {
      const context = o.context(), credentials = await o.credentials();
      if (!credentials) throw new Error('margin_account_not_configured');
      const items = await readCrossMarginEvidence(o.gateway, credentials, symbols, AbortSignal.timeout(4000));
      if (context !== o.context()) throw new Error('margin_account_changed');
      return { profileId: o.profile()?.id ?? null, items };
    },
    settlementReady: (quantities, proof) => {
      if (positionContext !== o.context() || Date.now() - positionsAt > 5000 || !currentAccount) return false;
      if (proof?.parametersId && !proof.approximate) {
        const p = readParameters(), profile = o.profile()?.id, user = currentAccount.user_id;
        if (!p || !profile || !user || !proof.batchId || !proof.feeRules) return false;
        const keys = new Set(proof.feeRules.map(f => f.pool));
        for (const symbol of Object.keys(quantities)) {
          const [venue, , , coin] = symbol.split('_');
          const pools = currentAccount.assets.filter(a => a.coin === coin && (a.exchange_type === venue || coin === 'USDT' && a.exchange_type === 'CROSSEX'));
          if (pools.length !== 1) return false; keys.add(`${pools[0].exchange_type}:${coin}`);
        }
        if (!borrowingAccountCalibrated(currentAccount, p, { profileId: profile, userId: user }, Date.now(), [...keys]) ||
          !marginFeesSettled(o.db, profile, user, proof.batchId, { fees: proof.feeRules })) return false;
      }
      if (!currentAccount.assets.length && [currentAccount.margin_balance, currentAccount.initial_margin, currentAccount.maintenance_margin].some(v => !new Decimal(v).isZero())) return false;
      if (!evidence.settledPositions(positions, quantities)) return false;
      if (Object.entries(quantities).some(([symbol, quantity]) => {
        const rows = positions.filter(p => p.symbol === symbol && !new Decimal(p.position_qty).isZero());
        return rows.length > 1 || !new Decimal(rows[0]?.position_qty ?? '0').abs().eq(quantity);
      })) return false;
      return currentAccount.assets.every(asset => {
        const owned = positions.filter(p => p.symbol.endsWith(`_${asset.coin}`)
          && (asset.exchange_type === 'CROSSEX' || p.symbol.startsWith(`${asset.exchange_type}_`)));
        return owned.reduce((n, p) => n.plus(p.maintenance_margin), new Decimal(0)).minus(asset.futures_maintenance_margin).abs().lte(marginTolerance(asset.futures_maintenance_margin));
      });
    },
    reviewReady: () => {
      if (positionContext !== o.context() || Date.now() - positionsAt > 5000 || remoteOpenOrders !== 0 || o.runtime.listOpenOrders().length) return false;
      try {
        return o.runtime.listStrategies().filter((s) => s.accountProfileId === o.profile()?.id && s.config.management && !['TRANSFERRED', 'COMPLETED'].includes(s.management?.phase ?? ''))
          .every((s) => { const state = readManagedState(o.db, s.id), q = pairedQuantities(positions, managedLegs(s.config));
            return !state?.marginBatch && !state?.positionSettlementSince && !state?.protectionIncident && new Decimal(q[0]).eq(q[1]); });
      } catch { return false; }
    },
    uncovered: () => {
      if (positionContext !== o.context()) return [];
      const symbols = new Set(o.runtime.listStrategies().filter((s) => s.accountProfileId === o.profile()?.id && s.status === 'RUNNING' && s.config.management)
        .flatMap((s) => managedLegs(s.config).map((l) => l.symbol)));
      return positions.filter((p) => !new Decimal(p.position_qty).isZero() && !symbols.has(p.symbol)).map((p) => p.symbol);
    },
    account: (signal) => {
      if (accountRead) return Promise.reject(new Error('margin_read_pending'));
      const context = o.context(), profile = o.profile();
      readStartedAt = Date.now(); readSequence++; readStage = 'credentials';
      const valid = () => { signal.throwIfAborted(); if (context !== o.context()) throw new Error('margin_account_changed'); };
      accountRead = (async () => {
        const credentials = await o.credentials(signal); valid();
        if (!credentials || !profile) throw new Error('margin_account_not_configured');
        readStage = 'account';
        const result = await readAccountUnits(accountGateway, credentials, signal); valid();
        const account = result.account;
        if (accountContext === context && currentAccount && (currentAccount.user_id !== account.user_id || currentAccount.account_mode !== account.account_mode)) throw new Error('margin_account_identity_changed');
        accountMode = account.account_mode; currentAccount = account; accountContext = context;
        refreshPositions(credentials, context);
        if (positionContext === context) evidence.refresh(credentials, account, positions);
        return { profileId: profile.id, label: profile.label, userId: account.user_id ?? '', ...result };
      })().finally(() => { accountRead = null; });
      return accountRead;
    },
  });
  o.manager.setMarginMonitor(monitor);
  const paired = o.enforce ? new PairedEntryAdmission(o, monitor, () => currentAccount?.user_id ?? null) : null;
  if (paired) o.runtime.setPairedEntry(paired);
  o.manager.setMarginFacts((facts) => {
    positions = facts.positions; remoteOpenOrders = facts.openOrders.length; positionsAt = Date.now(); positionContext = o.context();
    paired?.observe(facts.positions, facts.openOrders);
  });
  const admission = createMarginAdmission(o, monitor, paired);
  if (o.enforce) o.runtime.setMarginAdmission(admission, (initial, maintenance, venue) => {
    try { monitor.assertEntry(initial, maintenance, venue); }
    catch (error) { throw new TradingRuntimeError(error instanceof Error ? error.message : 'margin_estimate_unavailable', 409); }
  });
  let stopping = false;
  monitor.subscribe((s) => {
    if (s.fresh) paired?.refreshActive();
    if (!s.entryBlocked || !o.live() || stopping) return;
    if (!s.fresh) {
      if (!o.runtime.listStrategies().some(r => r.config.management && r.status === 'RUNNING')) return;
      if (monitor.readFailureRequiresReview()) o.manager.failAll(s.reason ?? 'margin_account_verification_failed');
      else o.manager.holdForMarginRead();
      return;
    }
    if (!o.runtime.listOpenOrders().some((order) => !order.reduceOnly) && !o.runtime.listStrategies().some((r) => r.management?.phase === 'OPENING' && r.status === 'RUNNING')) return;
    stopping = true;
    void o.engine.haltForMarginRisk().catch(() => o.manager.failAll('margin_entry_cancellation_unconfirmed')).finally(() => { stopping = false; });
  });
  return monitor;
}

async function readAccountUnits(gateway: ReadOnlyCrossExGateway, credentials: GateCredentials, signal: AbortSignal) {
  try {
    const account = await gateway.queryAccount(credentials, undefined, signal);
    if (account.account_mode === 'CROSS_EXCHANGE') return { account };
  } catch (error) { if (!(error instanceof GateApiError) || ![400, 422].includes(error.statusCode)) throw error; }
  const venues = ['BINANCE', 'OKX', 'GATE', 'BYBIT', 'KRAKEN', 'HYPERLIQUID', 'DERIBIT'];
  const reads = await Promise.allSettled(venues.map((venue) => gateway.queryAccount(credentials, venue, signal)));
  signal.throwIfAborted();
  const units = reads.flatMap((r) => r.status === 'fulfilled' && r.value.account_mode === 'ISOLATED_EXCHANGE' ? [r.value] : []);
  if (!units.length && reads.every(r => r.status === 'rejected' && !marginReadFault(r.reason).fatal)) throw new Error('margin_read_pending');
  if (!units.length || units.some((u) => u.user_id !== units[0].user_id)) throw new Error('margin_account_identity_unavailable');
  const unavailableUnits = venues.filter((venue) => !units.some((u) => u.exchange_type === venue));
  const fatalUnavailableUnits = reads.some(r => r.status === 'rejected' && marginReadFault(r.reason).fatal
    || r.status === 'fulfilled' && r.value.account_mode !== 'ISOLATED_EXCHANGE');
  return { account: units[0], units, unavailableUnits, fatalUnavailableUnits };
}

function createMarginAdmission(o: MarginServiceOptions, monitor: MarginRiskMonitor, paired: PairedEntryAdmission | null) {
  let tail: Promise<unknown> = Promise.resolve();
  const reservations: Array<{ at: number; initial: Decimal; maintenance: Decimal; orderSequence: number; venue: string }> = [];
  paired?.setOrdinaryReservations(() => reservations);
  return (input: { symbol: string; quantity: string; price?: string }, checkOnly = false): Promise<void | (() => void)> => {
    const work = tail.then(async () => {
      try {
        const context = o.context(), venue = input.symbol.split('_')[0];
        await monitor.refresh(); monitor.assertEntry('0', '0', venue);
        const snapshot = monitor.snapshot();
        const unit = snapshot.metrics?.accountMode === 'CROSS_EXCHANGE' ? snapshot.metrics : snapshot.units?.find((u) => u.exchangeType === venue)?.metrics;
        const lastFill = o.db.prepare('SELECT MAX(updated_at) AS at FROM execution_orders WHERE CAST(executed_quantity AS REAL) > 0').get() as { at: string | null };
        if (lastFill.at && !(Number(unit?.remoteUpdatedAt) >= Date.parse(lastFill.at))) throw new Error('margin_account_settlement_pending');
        const credentials = await o.credentials();
        const gateway = o.gateway as Partial<TradingCrossExGateway>;
        if (!credentials || !gateway.queryLeverages) throw new Error('margin_estimate_unavailable');
        const market = o.markets.market(input.symbol);
        if (!freshManagedQuote(market, Date.now()) && !input.price) throw new Error('margin_quote_unavailable');
        const price = Decimal.max(input.price ?? '0', market?.askPrice ?? '0');
        const [leverages, limits] = await Promise.all([gateway.queryLeverages(credentials, [input.symbol]), o.gateway.queryRiskLimits([input.symbol])]);
        const leverage = new Decimal(leverages[input.symbol] ?? '0');
        if (!leverage.isFinite() || leverage.lte(0) || price.lte(0)) throw new Error('margin_estimate_unavailable');
        const tiers = limits.find((l) => l.symbol === input.symbol)?.tiers;
        if (!tiers?.length) throw new Error('margin_estimate_unavailable');
        const notional = price.mul(input.quantity), fee = notional.mul('0.0015');
        const initial = notional.div(leverage).plus(fee.mul(2)).mul('1.10');
        const maintenance = notional.mul(Decimal.max(...tiers.map((t) => t.maintenance_rate))).plus(fee.mul(2));
        if (input.symbol.includes('_FUTURE_')) {
          const cross = (await readCrossMarginEvidence(o.gateway, credentials, [input.symbol], AbortSignal.timeout(4000)))[0];
          if (cross.reason) throw new Error(cross.reason);
        }
        if (context !== o.context()) throw new Error('margin_account_changed');
        const open = o.runtime.listOpenOrders().filter((order) => !order.reduceOnly);
        const sampleAt = monitor.snapshot().sampledAt ?? 0;
        // Retain all unresolved reservations. Release only after terminal evidence plus a later account read.
        if (!open.length) {
          const lastOrder = o.db.prepare('SELECT MAX(updated_at) AS at FROM execution_orders').get() as { at: string | null };
          const settledAt = lastOrder.at ? Date.parse(lastOrder.at) : 0;
          if (sampleAt > settledAt && Number(monitor.snapshot().metrics?.remoteUpdatedAt ?? '0') >= settledAt) for (let i = reservations.length - 1; i >= 0; i -= 1)
            if (reservations[i].at < sampleAt && reservations[i].orderSequence < totalOrders(o.db)) reservations.splice(i, 1);
        }
        const scoped = reservations.filter((r) => snapshot.metrics?.accountMode === 'CROSS_EXCHANGE' || r.venue === venue);
        monitor.assertEntry(scoped.reduce((sum, r) => sum.plus(r.initial), initial).toString(),
          scoped.reduce((sum, r) => sum.plus(r.maintenance), maintenance).toString(), venue);
        paired?.assertFunds(undefined, undefined, initial, maintenance, venue);
        if (!checkOnly) {
          const reservation = { at: Date.now(), initial, maintenance, orderSequence: totalOrders(o.db), venue };
          reservations.push(reservation);
          paired?.commitOrdinaryAdmission(venue);
          return () => { const index = reservations.indexOf(reservation); if (index >= 0) reservations.splice(index, 1); };
        }
      } catch (error) { throw new TradingRuntimeError(error instanceof Error && /^(margin_|cross_margin_|paired_entry_)/.test(error.message) ? error.message : 'margin_estimate_unavailable', 409); }
    });
    tail = work.catch(() => undefined); return work;
  };
}
function totalOrders(db: Database.Database): number { return (db.prepare('SELECT COUNT(*) AS n FROM execution_orders').get() as { n: number }).n; }

function groupReadiness(db: Database.Database, evidence: MarginReductionEvidence, markets: MarketSource,
  account: NonNullable<Parameters<MarginReductionEvidence['forGroup']>[0]>, record: ReturnType<TradingRuntime['listStrategies']>[number], positions: GateCrossExPosition[]) {
  const checkedAt = Date.now();
  try {
    const legs = managedLegs(record.config), quantity = pairedQuantities(positions, legs);
    if (!new Decimal(quantity[0]).eq(quantity[1]) || !record.config.management) throw new Error('margin_projection_legs_invalid');
    const rules = legs.map(l => db.prepare('SELECT lot_size,min_size,min_notional,max_market_size FROM crossex_instruments WHERE symbol=?').get(l.symbol)) as
      Array<{ lot_size: string; min_size: string; min_notional: string | null; max_market_size: string | null }>;
    const marketCaps = reportedMarketCaps(rules);
    const step = commonQuantityStep(rules[0].lot_size, rules[1].lot_size);
    let cap = Decimal.min(quantity[0], record.config.management.perOrderQuantity, ...marketCaps)
      .div(step).floor().mul(step);
    if (cap.lte(0) || legs.some((l, i) => cap.lt(rules[i].min_size) || rules[i].min_notional &&
      cap.mul(markets.market(l.symbol)?.bidPrice ?? '0').lt(rules[i].min_notional!))) throw new Error('margin_no_legal_quantity');
    const inspected = evidence.inspectGroup(account, positions, legs, cap.toFixed());
    if (!inspected.ok) throw new Error(inspected.reason);
    if (inspected.evidence.projection) {
      cap = new Decimal(marginExecutionCapacity(inspected.evidence.projection, { marginBalance: account.margin_balance,
        initialMargin: account.initial_margin, maintenanceMargin: account.maintenance_margin }, cap.toFixed(), step));
      if (cap.lte(0) || legs.some((l, i) => cap.lt(rules[i].min_size) || rules[i].min_notional &&
        cap.mul(markets.market(l.symbol)?.bidPrice ?? '0').lt(rules[i].min_notional!))) throw new Error('margin_no_legal_quantity');
    }
    return { status: 'ready' as const, reason: null, maxBatchQuantity: cap.toFixed(), approximate: !!inspected.evidence.projection?.approximate, checkedAt };
  } catch (error) {
    return { status: 'blocked' as const, reason: error instanceof Error && /^margin_/.test(error.message) ? error.message : 'margin_projection_evidence_invalid', maxBatchQuantity: null, checkedAt };
  }
}
