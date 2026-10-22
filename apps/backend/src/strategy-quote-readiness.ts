import { quoteUnavailableReason } from './quote-recovery.js';
import type { LiveMarket } from './market-hub.js';
import { TradingRuntimeError } from './trading-runtime.js';

interface QuoteSource {
  market(symbol: string): LiveMarket | null;
  connectionState(): string;
  watchQuotes(symbols: string[]): () => void;
  requestQuoteRefresh?(symbols: string[]): void;
}

/** Wait only for authentic, timely executable quotes; never turn display fallbacks into orders. */
export async function waitForStrategyQuotes(source: QuoteSource, symbols: string[], live: () => boolean,
  timeoutMs = 8_000): Promise<void> {
  const release = source.watchQuotes(symbols);
  const deadline = Date.now() + timeoutMs;
  const requested = new Set<string>();
  try {
    for (;;) {
      if (!live()) throw new TradingRuntimeError('live_trading_locked', 403);
      const missing = symbols.filter(symbol => {
        const market = source.market(symbol);
        return !market || quoteUnavailableReason(market) !== null
          || market.source !== 'native_venue' && source.connectionState() !== 'healthy';
      });
      if (missing.length === 0) return;
      if (source.connectionState() === 'healthy' && source.requestQuoteRefresh) {
        const refresh = missing.filter(symbol => !requested.has(symbol));
        if (refresh.length > 0) {
          source.requestQuoteRefresh(refresh);
          for (const symbol of refresh) requested.add(symbol);
        }
      }
      if (Date.now() >= deadline) throw new TradingRuntimeError('strategy_market_data_unavailable', 409, missing[0]);
      await new Promise(resolve => setTimeout(resolve, Math.min(100, deadline - Date.now())));
    }
  } finally { release(); }
}
