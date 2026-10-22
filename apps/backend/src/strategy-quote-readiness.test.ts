import { afterEach, describe, expect, it, vi } from 'vitest';
import { waitForStrategyQuotes } from './strategy-quote-readiness.js';
import type { LiveMarket } from './market-hub.js';

afterEach(() => vi.useRealTimers());
function fixture() {
  const markets = new Map<string, LiveMarket>();
  const release = vi.fn(); const watchQuotes = vi.fn(() => release);
  const source = { market: (s: string) => markets.get(s) ?? null, connectionState: () => 'healthy', watchQuotes };
  const fresh = (symbol: string) => markets.set(symbol, { symbol, bidPrice: '95', askPrice: '96',
    updatedAt: new Date().toISOString(), receivedAt: new Date().toISOString(), source: 'gate_crossex_websocket' } as LiveMarket);
  return { source, markets, release, watchQuotes, fresh };
}
describe('manual strategy quote preparation', () => {
  it('pins both legs until their first real quotes arrive', async () => {
    vi.useFakeTimers(); const f = fixture(); let finished = false;
    const pending = waitForStrategyQuotes(f.source, ['left', 'right'], () => true).then(() => { finished = true; });
    f.fresh('left'); await vi.advanceTimersByTimeAsync(100); expect(finished).toBe(false);
    f.fresh('right'); await vi.advanceTimersByTimeAsync(100); await pending;
    expect(f.watchQuotes).toHaveBeenCalledWith(['left', 'right']); expect(f.release).toHaveBeenCalledTimes(1);
  });
  it('rejects missing, stale or seed quotes after a bounded wait and names the leg', async () => {
    vi.useFakeTimers(); const f = fixture(); f.fresh('left'); f.fresh('right');
    f.markets.set('right', { ...f.markets.get('right')!, source: 'demo_seed' });
    const result = expect(waitForStrategyQuotes(f.source, ['left', 'right'], () => true, 300))
      .rejects.toMatchObject({ code: 'strategy_market_data_unavailable', label: 'right' });
    await vi.advanceTimersByTimeAsync(301); await result; expect(f.release).toHaveBeenCalledTimes(1);
  });
  it('cancels preparation when the user locks trading', async () => {
    vi.useFakeTimers(); const f = fixture(); let live = true;
    const result = expect(waitForStrategyQuotes(f.source, ['left'], () => live)).rejects.toMatchObject({ code: 'live_trading_locked' });
    live = false; await vi.advanceTimersByTimeAsync(100); await result; expect(f.release).toHaveBeenCalledTimes(1);
  });
  it('requests only one quote replay for the selected legs while waiting', async () => {
    vi.useFakeTimers(); const f = fixture();
    const requestQuoteRefresh = vi.fn();
    const pending = waitForStrategyQuotes({ ...f.source, requestQuoteRefresh }, ['left', 'right'], () => true);
    await vi.advanceTimersByTimeAsync(500);
    expect(requestQuoteRefresh).toHaveBeenCalledExactlyOnceWith(['left', 'right']);
    f.fresh('left'); f.fresh('right'); await vi.advanceTimersByTimeAsync(100); await pending;
    expect(f.release).toHaveBeenCalledTimes(1);
  });
  it('refreshes only an unavailable leg and leaves a valid leg untouched', async () => {
    vi.useFakeTimers(); const f = fixture(); f.fresh('left');
    const requestQuoteRefresh = vi.fn();
    const pending = waitForStrategyQuotes({ ...f.source, requestQuoteRefresh }, ['left', 'right'], () => true);
    await vi.advanceTimersByTimeAsync(300);
    expect(requestQuoteRefresh).toHaveBeenCalledExactlyOnceWith(['right']);
    f.fresh('right'); await vi.advanceTimersByTimeAsync(100); await pending;
  });
  it('waits for a healthy connection before consuming the quote replay attempt', async () => {
    vi.useFakeTimers(); const f = fixture(); let connected = false;
    const requestQuoteRefresh = vi.fn();
    const pending = waitForStrategyQuotes({ ...f.source, connectionState: () => connected ? 'healthy' : 'reconnecting', requestQuoteRefresh }, ['left'], () => true);
    await vi.advanceTimersByTimeAsync(200); expect(requestQuoteRefresh).not.toHaveBeenCalled();
    connected = true; await vi.advanceTimersByTimeAsync(100); expect(requestQuoteRefresh).toHaveBeenCalledExactlyOnceWith(['left']);
    f.fresh('left'); await vi.advanceTimersByTimeAsync(100); await pending;
  });
});
