import { Decimal } from 'decimal.js';
import { pairedFundingYield } from '@gate-crossex/domain';
import type { GateCredentials } from './credential-vault.js';
import type { GateCrossExAccount, GateCrossExPosition, GateCrossExRiskLimit, GateFeeRate, ReadOnlyCrossExGateway, TradingCrossExGateway } from './crossex-client.js';
import type { ManagedLeg } from './managed-position-model.js';
import { freshManagedQuote } from './managed-position-model.js';
import type { MarketSource } from './strategy-engine.js';
import { createAccountProjection, type AccountProjection } from './margin-account-projection.js';
import { BorrowingObservations, createApproximation, marginTolerance } from './margin-approximation.js';
import type { MarginRiskParameters } from './margin-risk-parameters.js';

export interface ReductionEvidence {
  initial: string; maintenance: string; initialRelease: string; maintenanceRelease: string; cost: string;
  cap: string; apr: string | null; firstLeg: 0 | 1; checkedAt: number;
  initialReleaseByLeg: [string, string]; maintenanceReleaseByLeg: [string, string];
  projection?: AccountProjection;
}
type Cache = { context: string; at: number; rules: GateCrossExRiskLimit[]; fees: GateFeeRate[]; rates: Record<string, string>; ratesAt: number };
/** Technical execution stress budget, not an account trigger or an exchange price guarantee. */
export const MARGIN_EXECUTION_STRESS_BPS = 100;
export const MARGIN_FX_STRESS_BPS = 100;
export const GATE_FUTURE_CLOSE_MARGIN_RATE = '0.00075';
export class MarginReductionEvidence {
  private cache: Cache | null = null;
  private readonly observations = new BorrowingObservations();
  private pending = false;
  private attemptedAt = 0;
  constructor(private readonly gateway: ReadOnlyCrossExGateway, private readonly markets: MarketSource,
    private readonly context: () => string, private readonly funding?: (symbol: string) => { rate8h: string; fetchedAt: number } | null,
    private readonly certificate?: { read(): MarginRiskParameters | null; subject(): { profileId: string; userId: string } }) {}
  refresh(credentials: GateCredentials, account: GateCrossExAccount, positions: GateCrossExPosition[]): void {
    const context = this.context();
    this.observations.observe(account, context, Date.now());
    if (this.pending || this.cache?.context === context && Date.now() - this.attemptedAt < 30000) return;
    this.pending = true; this.attemptedAt = Date.now();
    const symbols = [...new Set(positions.map(p => p.symbol))], g = this.gateway as Partial<TradingCrossExGateway>;
    const work = async () => {
      if (!g.queryFeeRates) return;
      const signal = AbortSignal.timeout(8000);
      const [rules, fees, rates] = await Promise.all([this.gateway.queryRiskLimits(symbols, signal), g.queryFeeRates(credentials),
        g.queryValuationRates?.([...new Set([...account.assets.map(a => a.coin), ...symbols.map(s => s.split('_').at(-1)!)])], signal).catch(() => null) ?? Promise.resolve(null)]);
      if (context === this.context() && !signal.aborted) this.cache = { context, at: this.attemptedAt, rules, fees, rates: rates ?? (this.cache?.context === context ? this.cache.rates : {}), ratesAt: rates ? this.attemptedAt : this.cache?.context === context ? this.cache.ratesAt : 0 };
    };
    void work().catch(() => { /* old evidence expires; an unavailable plan never authorizes a trade */ }).finally(() => { this.pending = false; });
  }
  valuation(): { rates: Record<string, string>; checkedAt: number } | null {
    return this.cache?.context === this.context() && this.cache.ratesAt > 0 && Date.now() - this.cache.ratesAt <= 60000
      ? { rates: this.cache.rates, checkedAt: this.cache.ratesAt } : null;
  }
  settledPositions(positions: GateCrossExPosition[], quantities: Record<string, string>): boolean {
    try {
      if (!this.cache || this.cache.context !== this.context() || Date.now() - this.cache.at > 60000) return false;
      return Object.entries(quantities).every(([symbol, quantity]) => {
        if (new Decimal(quantity).isZero()) return !positions.some(p => p.symbol === symbol && !new Decimal(p.position_qty).isZero());
        const p = positions.find(row => row.symbol === symbol), tiers = this.cache!.rules.find(r => r.symbol === symbol)?.tiers;
        if (!p || !tiers || p.margin_mode !== 'CROSS') return false;
        const value = new Decimal(p.mark_price).mul(quantity);
        const tier = tiers.find(t => value.gte(t.min_risk_limit_value) && value.lte(t.max_risk_limit_value));
      return !!tier && value.minus(p.position_value).abs().lte(marginTolerance(p.maintenance_margin))
          && value.mul(new Decimal(tier.maintenance_rate).plus(GATE_FUTURE_CLOSE_MARGIN_RATE)).minus(tier.quick_cal_amount).minus(p.maintenance_margin).abs().lte(marginTolerance(p.maintenance_margin))
          && value.mul(new Decimal(1).div(p.leverage).plus(GATE_FUTURE_CLOSE_MARGIN_RATE)).minus(p.initial_margin).abs().lte(marginTolerance(p.initial_margin));
      });
    } catch { return false; }
  }
  forGroup(account: GateCrossExAccount, positions: GateCrossExPosition[], legs: ManagedLeg[], cap: string): ReductionEvidence | null {
    const result = this.inspectGroup(account, positions, legs, cap);
    return result.ok ? result.evidence : null;
  }
  inspectGroup(account: GateCrossExAccount, positions: GateCrossExPosition[], legs: ManagedLeg[], cap: string):
    { ok: true; evidence: ReductionEvidence } | { ok: false; reason: string } {
    try {
      const cache = this.cache, now = Date.now();
      if (!cache || cache.context !== this.context() || now < cache.at || now - cache.at > 60000 || account.account_mode !== 'CROSS_EXCHANGE')
        throw new Error('margin_projection_market_evidence_unavailable');
      const rows = legs.map(l => positions.filter(p => p.symbol === l.symbol && !new Decimal(p.position_qty).isZero()));
      if (rows.length !== 2 || rows.some(r => r.length !== 1)) throw new Error('margin_projection_legs_invalid');
      const parameters = this.certificate?.read() ?? null;
      const parts = rows.map((r, i) => this.leg(account, r[0], legs[i], cap, cache, now));
      if (parts.some(p => !p)) throw new Error('margin_position_calibration_failed');
      const [a, b] = parts as [NonNullable<typeof parts[0]>, NonNullable<typeof parts[0]>];
      const yieldValue = pairedFundingYield([a.funding, b.funding], now);
      const useProjection = a.requiresProjection || b.requiresProjection || parameters?.fees.some(f => legs.some(l => l.symbol === f.symbol));
      const projection = useProjection && parameters ? createAccountProjection(account, [a.model, b.model], parameters, this.certificate!.subject(), now)
        : createApproximation(account, [a.model, b.model], this.observations.rates(account, this.context(), now), now);
      return { ok: true, evidence: { initial: a.initial.plus(b.initial).toString(), maintenance: a.maintenance.plus(b.maintenance).toString(),
        initialRelease: a.im.plus(b.im).toString(), maintenanceRelease: a.mm.plus(b.mm).toString(), cost: a.cost.plus(b.cost).toString(),
        initialReleaseByLeg: [a.im.toString(), b.im.toString()], maintenanceReleaseByLeg: [a.mm.toString(), b.mm.toString()],
        cap, apr: yieldValue?.aprPercent ?? null, firstLeg: b.pnl.lt(Decimal.min(0, a.pnl)) ? 1 : 0, checkedAt: now, ...(projection ? { projection } : {}) } };
    } catch (error) { return { ok: false, reason: error instanceof Error && /^margin_/.test(error.message) ? error.message : 'margin_projection_evidence_invalid' }; }
  }
  private leg(account: GateCrossExAccount, p: GateCrossExPosition, leg: ManagedLeg, cap: string, cache: Cache, now: number) {
    const quote = this.markets.market(p.symbol), [venue, , , coin] = p.symbol.split('_');
    if (!freshManagedQuote(quote, now) || p.margin_mode !== 'CROSS' || !['USDT', 'USDC', 'USD'].includes(coin)) return null;
    const observedFx = new Decimal(cache.rates[coin] ?? '1');
    if (coin !== 'USDT' && observedFx.minus(1).abs().gt('0.01') && now - cache.ratesAt > 60000) throw new Error('margin_fx_depeg_unverified');
    const fx = coin === 'USDT' || observedFx.isFinite() && observedFx.minus(1).abs().lte('0.01') ? new Decimal(1) : observedFx, mark = new Decimal(p.mark_price);
    const qty = new Decimal(p.position_qty).abs(), value = new Decimal(p.position_value), leverage = new Decimal(p.leverage);
    if (![fx, mark, qty, value, leverage].every(n => n.isFinite() && n.gt(0)) || value.minus(mark.mul(qty)).abs().gt(value.mul('0.00001'))) return null;
    if (![p.initial_margin, p.maintenance_margin, p.upnl].every(n => new Decimal(n).isFinite())
      || new Decimal(p.initial_margin).lte(0) || new Decimal(p.maintenance_margin).lt(0)) return null;
    const tiers = cache.rules.find(r => r.symbol === p.symbol)?.tiers;
    const tier = tiers?.find(t => value.gte(t.min_risk_limit_value) && value.lte(t.max_risk_limit_value));
    if (!tier || !tiers?.length) return null;
    const ordered = [...tiers].sort((a, b) => new Decimal(a.min_risk_limit_value).cmp(b.min_risk_limit_value));
    if (new Decimal(ordered[0].min_risk_limit_value).gt(0) || ordered.some((t, i) => i > 0 && (
      !new Decimal(t.min_risk_limit_value).eq(ordered[i - 1].max_risk_limit_value)
      || new Decimal(t.min_risk_limit_value).mul(t.maintenance_rate).minus(t.quick_cal_amount)
        .minus(new Decimal(t.min_risk_limit_value).mul(ordered[i - 1].maintenance_rate).minus(ordered[i - 1].quick_cal_amount)).abs().gt('0.000001')))) return null;
    const closeFee = new Decimal(GATE_FUTURE_CLOSE_MARGIN_RATE), expectedMM = value.mul(new Decimal(tier.maintenance_rate).plus(closeFee)).minus(tier.quick_cal_amount);
    const expectedIM = value.mul(new Decimal(1).div(leverage).plus(closeFee));
    if (expectedMM.minus(p.maintenance_margin).abs().gt(marginTolerance(p.maintenance_margin)) || expectedIM.minus(p.initial_margin).abs().gt(marginTolerance(p.initial_margin))) return null;
    const fees = cache.fees.find(f => f.exchange_type === venue);
    if (!fees) return null;
    const taker = new Decimal(fees.special_fee_list?.find(f => f.symbol === p.symbol)?.taker_fee_rate ?? fees.future_taker_fee);
    if (!taker.isFinite() || taker.lt(0)) return null;
    const execution = new Decimal(leg.side === 'BUY' ? quote!.bidPrice : quote!.askPrice);
    const slip = Decimal.max(0, leg.side === 'BUY' ? mark.minus(execution) : execution.minus(mark));
    const costNative = mark.mul(taker.plus(new Decimal(MARGIN_EXECUTION_STRESS_BPS).div(10000))).plus(slip);
    const buckets = account.assets.filter(a => a.coin === coin && (a.exchange_type === venue || coin === 'USDT' && a.exchange_type === 'CROSSEX'));
    if (buckets.length !== 1) throw new Error('margin_projection_pool_unverified');
    const requiresProjection = !new Decimal(buckets[0].liability).eq(0) || !new Decimal(buckets[0].equity).gt(costNative.mul(cap).mul(2));
    const rate = Decimal.min(...tiers.map(t => t.maintenance_rate));
    if (!rate.isFinite() || rate.lte(0)) return null;
    const fxStress = coin === 'USDT' ? new Decimal(0) : new Decimal(MARGIN_FX_STRESS_BPS).div(10000);
    const releaseFx = fx.mul(new Decimal(1).minus(fxStress)), costFx = fx.mul(new Decimal(1).plus(fxStress));
    const f = this.funding?.(p.symbol);
    return { requiresProjection, initial: new Decimal(p.initial_margin).mul(fx), maintenance: new Decimal(p.maintenance_margin).mul(fx),
      im: mark.mul(new Decimal(1).div(leverage).plus(closeFee)).mul(releaseFx), mm: mark.mul(rate.plus(closeFee)).mul(releaseFx),
      model: { symbol: p.symbol, pool: `${buckets[0].exchange_type}:${coin}`, quantity: qty.toString(), mark: mark.toString(), leverage: leverage.toString(),
        initial: p.initial_margin, maintenance: p.maintenance_margin, tiers, loss: Decimal.max(0, new Decimal(p.upnl).neg()).div(qty).toString(),
        fx: fx.toString(), closeSide: leg.side === 'BUY' ? 'SELL' as const : 'BUY' as const, fee: mark.mul(taker).toString(),
        slip: mark.mul(new Decimal(MARGIN_EXECUTION_STRESS_BPS).div(10000)).plus(slip).toString() },
      cost: costNative.mul(costFx), pnl: new Decimal(p.upnl).mul(fx), funding: { quantity: qty.mul(leg.side === 'BUY' ? 1 : -1).toString(),
        value: p.position_value, initialMargin: p.initial_margin, fx: fx.toString(), rate8h: f?.rate8h ?? 'NaN', fetchedAt: f?.fetchedAt ?? NaN } };
  }
}
