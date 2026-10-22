import type { LiveMarket } from './market-hub.js';
import type { NativeQuote } from './native-market-data.js';
import { quoteUnavailableReason } from './quote-recovery.js';

export interface QuoteHealth {
  primaryAt: string | null; primaryAvailable: boolean;
  crossExAt: string | null; crossExReason: string | null;
  nativeAt: string | null; nativeReason: string | null;
}

/** Source-local watermarks; neither replay nor another source can clear an invalidation. */
export class QuoteSourceSelector {
  private readonly native = new Map<string, NativeQuote>();
  private readonly invalidAfter = new Map<string, number>();
  private readonly usingNative = new Set<string>();
  private readonly crossSamples = new Map<string, { at: number; count: number }>();
  private readonly primary = new Map<string, { at: number; received: number }>();
  private readonly probed = new Map<string, number>();
  clear(): void { this.native.clear(); this.invalidAfter.clear(); this.usingNative.clear(); this.crossSamples.clear(); this.primary.clear(); this.probed.clear(); }
  delete(symbol: string): void { this.native.delete(symbol); this.invalidAfter.delete(symbol); this.usingNative.delete(symbol); this.crossSamples.delete(symbol); this.primary.delete(symbol); this.probed.delete(symbol); }
  markPrimarySubscription(symbols: string[]): void { for (const symbol of symbols) this.probed.set(symbol, Date.now()); }
  missingPrimary(symbols: string[], now: number): string[] {
    return symbols.filter(symbol => {
      const sample = this.primary.get(symbol);
      return (!sample || now - sample.at > 15000 || sample.received - sample.at > 3000) && now - (this.probed.get(symbol) ?? 0) >= 5000;
    });
  }
  observeCross(symbol: string, at: number, received: number, primary: boolean): void {
    if (at > received + 2000 || received - at > 3000) return;
    if (primary && at >= (this.primary.get(symbol)?.at ?? 0)) this.primary.set(symbol, { at, received });
    const sample = this.crossSamples.get(symbol);
    if (!sample || at > sample.at) this.crossSamples.set(symbol, { at, count: sample && received - sample.at <= 15000 ? sample.count + 1 : 1 });
  }
  invalidate(symbol: string, sourceAt: number): void {
    if (!Number.isFinite(sourceAt) || sourceAt > Date.now() + 2000 || sourceAt < (this.native.get(symbol)?.sourceAt ?? 0)) return;
    this.invalidAfter.set(symbol, Math.max(this.invalidAfter.get(symbol) ?? 0, sourceAt));
  }
  revoke(symbol: string): void { this.invalidate(symbol, Math.max(Date.now(), this.native.get(symbol)?.sourceAt ?? 0)); }
  accept(quote: NativeQuote): void {
    if (!Number.isFinite(quote.sourceAt) || quote.validUntil <= Date.now() || quote.sourceAt <= (this.invalidAfter.get(quote.symbol) ?? Number.NEGATIVE_INFINITY)) return;
    const previous = this.native.get(quote.symbol);
    if (previous && quote.sourceAt <= previous.sourceAt) {
      if (quote.sourceAt === previous.sourceAt && ['bidPrice', 'askPrice', 'bidSize', 'askSize'].some(key =>
        Number(quote[key as 'bidPrice']) !== Number(previous[key as 'bidPrice']))) this.invalidate(quote.symbol, quote.sourceAt);
      return;
    }
    this.invalidAfter.delete(quote.symbol); this.native.set(quote.symbol, quote);
  }
  select(current: LiveMarket): LiveMarket {
    const symbol = current.symbol, now = Date.now(), native = this.native.get(symbol);
    const candidate: LiveMarket | null = !native || (this.invalidAfter.get(symbol) ?? Number.NEGATIVE_INFINITY) >= native.sourceAt ? null
      : { ...current, bidPrice: native.bidPrice, askPrice: native.askPrice, bidSize: native.bidSize, askSize: native.askSize,
        source: 'native_venue', nativeSymbol: native.nativeSymbol, nativeValidUntil: native.validUntil,
        updatedAt: new Date(native.sourceAt).toISOString(), receivedAt: new Date(native.receivedAt).toISOString() };
    const nativeReason = candidate ? quoteUnavailableReason(candidate) : native ? 'native_invalidated' : 'awaiting_native_quote';
    const crossExReason = quoteUnavailableReason(current), primary = this.primary.get(symbol);
    const quoteHealth: QuoteHealth = { primaryAt: primary ? new Date(primary.at).toISOString() : null,
      primaryAvailable: !!primary && now - primary.at <= 15000 && primary.received - primary.at <= 3000,
      crossExAt: current.source === 'demo_seed' ? null : current.updatedAt, crossExReason,
      nativeAt: native ? new Date(native.sourceAt).toISOString() : null, nativeReason };
    if (crossExReason === null && (nativeReason !== null || !this.usingNative.has(symbol) || (this.crossSamples.get(symbol)?.count ?? 0) >= 2)) {
      this.usingNative.delete(symbol); return { ...current, quoteHealth };
    }
    if (candidate && nativeReason === null) {
      if (!this.usingNative.has(symbol)) this.crossSamples.delete(symbol);
      this.usingNative.add(symbol); return { ...candidate, quoteHealth };
    }
    return { ...current, quoteHealth };
  }
}
