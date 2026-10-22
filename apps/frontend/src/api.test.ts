import type { TradingSnapshot } from '@gate-crossex/shared-types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError, connectTerminalStream } from './api.js';
import { positionFundingRefreshDelay } from './use-position-funding-overview.js';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('local API request coordination', () => {
  it('keeps reference-quote throttling out of account reads and trading controls', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async (path: string) => path.startsWith('/api/markets/reference-quotes')
      ? Response.json({ error: 'too_many_requests' }, { status: 429, headers: { 'Retry-After': '60' } })
      : Response.json({ mode: 'live', orders: [], positions: [], fills: [], balances: [] } satisfies TradingSnapshot));
    vi.stubGlobal('fetch', fetchMock);
    await expect(api.referenceQuotes(['GATE_FUTURE_BTC_USDT'])).rejects.toMatchObject({ code: 'reference_quotes_rate_limited', retryAfterMs: 60_000 });
    await expect(api.tradingSnapshot()).resolves.toMatchObject({ mode: 'live' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it('projects funding reads by canonicalized symbols while retaining the cold-read deadline', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    const payload = { assets: [], venueStatus: [], classification: { source: 'COINGECKO', marketCapLimit: 20,
      status: 'fresh', fetchedAt: '2026-09-29T00:00:00Z' }, fetchedAt: '2026-09-29T00:00:00Z', cacheStatus: 'fresh' };
    const fetchMock = vi.fn(async (_path: string) => { void _path; return new Response(JSON.stringify(payload)); }); vi.stubGlobal('fetch', fetchMock);
    await api.fundingOverview(['OKX_FUTURE_BTC_USDT', 'GATE_FUTURE_BTC_USDT', 'OKX_FUTURE_BTC_USDT']);
    const url = new URL(String(fetchMock.mock.calls[0]?.[0]), 'http://localhost');
    expect(url.searchParams.get('symbols')).toBe('GATE_FUTURE_BTC_USDT,OKX_FUTURE_BTC_USDT');
    expect(timeout).toHaveBeenCalledWith(60_000);
    await api.fundingOverview(Array.from({ length: 101 }, (_, i) => `GATE_FUTURE_ASSET${i}_USDT`));
    expect(fetchMock.mock.calls[1]?.[0]).toBe('/api/markets/funding-overview');
  });
  it('isolates consumer-owned cancellation of concurrent history reads', async () => {
    const pending: Array<{ signal: AbortSignal; resolve: (value: Response) => void }> = [];
    vi.stubGlobal('fetch', vi.fn((_path: string, init: RequestInit) => new Promise<Response>((resolve, reject) => {
      const signal = init.signal!;
      signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
      pending.push({ signal, resolve });
    })));
    const a = new AbortController(), b = new AbortController();
    const first = api.fundingHistorySeries(['GATE_FUTURE_BTC_USDT'], 30, a.signal);
    const rejected = expect(first).rejects.toMatchObject({ code: 'request_cancelled' });
    const second = api.fundingHistorySeries(['GATE_FUTURE_BTC_USDT'], 30, b.signal);
    await vi.waitFor(() => expect(pending).toHaveLength(2)); a.abort(); await rejected;
    expect(pending[1].signal.aborted).toBe(false);
    pending[1].resolve(new Response(JSON.stringify({ entries: [], from: 0, to: 1, fetchedAt: '2026-09-29T00:00:00Z' })));
    await expect(second).resolves.toMatchObject({ entries: [] });
  });
  it('coalesces concurrent reads of the same execution snapshot', async () => {
    let release: ((response: Response) => void) | undefined;
    const response = new Promise<Response>((resolve) => { release = resolve; });
    const fetchMock = vi.fn(() => response);
    vi.stubGlobal('fetch', fetchMock);

    const first = api.tradingSnapshot();
    const second = api.tradingSnapshot();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    release?.(new Response(JSON.stringify({
      mode: 'live', orders: [], positions: [], fills: [], balances: [],
    })));
    await expect(Promise.all([first, second])).resolves.toEqual([
      { mode: 'live', orders: [], positions: [], fills: [], balances: [] },
      { mode: 'live', orders: [], positions: [], fills: [], balances: [] },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('preserves the upstream Gate label when a leverage update is rejected', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      error: 'strategy_leverage_rejected',
      label: 'INVALID_LEVERAGE',
    }), { status: 400 })));

    await expect(api.startStrategy({} as never)).rejects.toEqual(expect.objectContaining({
      status: 400,
      code: 'strategy_leverage_rejected',
      label: 'INVALID_LEVERAGE',
      message: 'strategy leverage rejected (INVALID_LEVERAGE)',
    }));
  });

  it('sends explicit intents for in-app account switching, renaming, and deletion', async () => {
    const connection = {
      configured: true,
      storage: 'env_file',
      label: 'Primary account',
      lastVerifiedAt: '2026-08-12T16:00:00.000Z',
      secureEntryPath: '/secure/credentials',
      readOnly: true,
      activeProfileId: 'gate-crossex-default',
      profiles: [{
        id: 'gate-crossex-default', label: 'Primary account', storage: 'env_file',
        lastVerifiedAt: '2026-08-12T16:00:00.000Z', active: true,
      }],
    };
    const fetchMock = vi.fn(async (_path: string, _init?: RequestInit) => {
      void _path;
      void _init;
      return new Response(JSON.stringify(connection));
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(api.switchAccount('gate-crossex-default', true)).resolves.toMatchObject({ label: 'Primary account' });
    await expect(api.renameAccount('gate-crossex-default', 'Main trading')).resolves.toMatchObject({ label: 'Primary account' });
    await expect(api.deleteAccount('gate-crossex-default')).resolves.toMatchObject({ label: 'Primary account' });

    const switchCall = fetchMock.mock.calls[0];
    const renameCall = fetchMock.mock.calls[1];
    const deleteCall = fetchMock.mock.calls[2];
    expect(switchCall?.[0]).toBe('/api/onboarding/accounts/gate-crossex-default/activate');
    expect(switchCall?.[1]?.method).toBe('POST');
    expect(new Headers(switchCall?.[1]?.headers).get('x-gct-credential-intent')).toBe('switch-account');
    expect(switchCall?.[1]?.body).toBe('{"confirmPauseRunningStrategies":true}');
    expect(renameCall?.[0]).toBe('/api/onboarding/accounts/gate-crossex-default');
    expect(renameCall?.[1]?.method).toBe('PATCH');
    expect(new Headers(renameCall?.[1]?.headers).get('x-gct-credential-intent')).toBe('rename-account');
    expect(renameCall?.[1]?.body).toBe('{"label":"Main trading"}');
    expect(deleteCall?.[0]).toBe('/api/onboarding/accounts/gate-crossex-default');
    expect(deleteCall?.[1]?.method).toBe('DELETE');
    expect(new Headers(deleteCall?.[1]?.headers).get('x-gct-credential-intent')).toBe('delete-account');
  });

  it('sends explicit live-trading intent when resuming a strategy', async () => {
    const strategy = {
      id: 'PAIR-RESUME01', kind: 'position', status: 'RUNNING',
      accountProfileId: 'gate-crossex-default', accountLabel: 'Gate CrossEx',
      config: {
        kind: 'position', asset: 'BTC', leftVenue: 'BINANCE', rightVenue: 'OKX',
        leftSide: 'SELL', rightSide: 'BUY', entryBps: '10', totalAmount: '0.1',
        perOrderQuantity: '0.1', reduceOnly: false, executionMethod: 'TAKER_TAKER',
      },
      progress: 0, filledQuantity: '0', filledLeft: '0', filledRight: '0', openPosition: '0',
      realizedPnl: '0', createdAt: '2026-08-14T00:00:00.000Z',
      updatedAt: '2026-08-14T00:01:00.000Z', stoppedAt: null,
    };
    const fetchMock = vi.fn(async (_path: string, _init?: RequestInit) => {
      void _path;
      void _init;
      return new Response(JSON.stringify(strategy));
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(api.resumeStrategy(strategy.id)).resolves.toMatchObject({ id: strategy.id, status: 'RUNNING' });
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/strategies/PAIR-RESUME01/resume');
    const init = fetchMock.mock.calls[0]?.[1];
    expect(init?.method).toBe('POST');
    expect(new Headers(init?.headers).get('x-gct-trading-intent')).toBe('resume-strategy');
    await api.resumeStrategy(strategy.id, 'OPENING');
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({ expectedAction: 'OPENING' });
  });

  it('rejects a successful response that violates the shared runtime contract', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      mode: 'live',
      orders: 'not-an-array',
    }))));

    await expect(api.tradingSnapshot()).rejects.toEqual(new ApiError(200, 'invalid_backend_response'));
  });

  it('validates fixed-rate opportunities from the local Boros proxy', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      strategies: [{
        id: 'ETH-2-1790294400-OKX-Hyperliquid',
        longMarket: {
          marketId: 185, address: '0x6bb121533f78d8d0c8a847b0ab399e0399966563', tokenId: 2,
          name: 'ETHUSDT', assetSymbol: 'ETH', maturity: 1790294400, state: 'Normal',
          impliedApr: 0.0225, maxLeverage: 2.1, maxPerpLeverage: 100, ammId: 0, platformName: 'OKX',
        },
        shortMarket: {
          marketId: 102, address: '0xd035309b604d6e252d29ce1d61e9a1e0a0553918', tokenId: 2,
          name: 'ETHUSDC', assetSymbol: 'ETH', maturity: 1790294400, state: 'Normal',
          impliedApr: 0.0628, maxLeverage: 2.1, maxPerpLeverage: 25, ammId: 1020, platformName: 'Hyperliquid',
        },
        daysToMaturity: 50, impliedAprSpread: 0.0403, maxPerpLeverage: 10, aprTimesMaxLeverage: 0.1487,
      }],
      totalCount: 1,
      fetchedAt: '2026-08-06T10:00:00.000Z',
      cacheStatus: 'fresh',
      source: 'boros_open_api',
    }))));

    await expect(api.borosStrategies()).resolves.toMatchObject({
      strategies: [{ id: 'ETH-2-1790294400-OKX-Hyperliquid' }],
      source: 'boros_open_api',
    });
  });

  it('turns an expired request deadline into an actionable timeout error', async () => {
    const timeout = AbortSignal.abort();
    vi.spyOn(AbortSignal, 'timeout').mockReturnValue(timeout);
    vi.stubGlobal('fetch', vi.fn(async (_path: string, init?: RequestInit) => {
      if (init?.signal?.aborted) throw new DOMException('aborted', 'AbortError');
      return new Response('{}');
    }));

    await expect(api.tradingSnapshot()).rejects.toEqual(new ApiError(0, 'request_timeout'));
  });

  it('allows the large instrument catalog longer than the default read deadline', async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ items: [] }))));

    await expect(api.instruments()).resolves.toEqual({ items: [] });
    expect(timeoutSpy).toHaveBeenCalledWith(45_000);
  });

  it('allows a 38-second multi-venue funding overview cold aggregation to finish', async () => {
    vi.useFakeTimers();
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout').mockImplementation((milliseconds) => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(), milliseconds);
      return controller.signal;
    });
    vi.stubGlobal('fetch', vi.fn((_path: string, init?: RequestInit) => new Promise<Response>((resolve, reject) => {
      const timer = setTimeout(() => resolve(new Response(JSON.stringify({
        assets: [], venueStatus: [],
        classification: {
          source: 'COINGECKO', marketCapLimit: 20, status: 'fresh',
          fetchedAt: '2026-09-07T00:00:00.000Z',
        },
        fetchedAt: '2026-09-07T00:00:00.000Z', cacheStatus: 'fresh',
      }))), 38_000);
      init?.signal?.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(new DOMException('aborted', 'AbortError'));
      }, { once: true });
    })));

    const pending = api.fundingOverview();
    await vi.advanceTimersByTimeAsync(38_000);
    await expect(pending).resolves.toMatchObject({ cacheStatus: 'fresh' });
    expect(timeoutSpy).toHaveBeenCalledWith(60_000);
  });

  it('keeps a 30-second funding cadence without overlapping a slow read', () => {
    expect(positionFundingRefreshDelay(1_000, 11_000)).toBe(20_000);
    expect(positionFundingRefreshDelay(1_000, 41_000)).toBe(0);
  });

  it('uses explicit intents and shared contracts for portfolio funding operations', async () => {
    const fetchMock = vi.fn(async (path: string, init?: RequestInit) => {
      if (path === '/api/crossex/transfer-coins') return new Response(JSON.stringify({
        items: [{ coin: 'USDT', minimumAmount: '1', estimatedFee: '0', precision: 6, disabled: false }],
        fetchedAt: '2026-08-01T00:00:00.000Z', cacheStatus: 'fresh',
      }));
      if (path === '/api/crossex/transfer-balances') return new Response(JSON.stringify({
        items: [{ account: 'SPOT', coin: 'USDT', available: '25.125' }],
        fetchedAt: '2026-08-01T00:00:00.000Z',
      }));
      if (path.startsWith('/api/crossex/portfolio-activity?')) return new Response(JSON.stringify({
        transfers: [], accountBook: [], fundingFees: [], fetchedAt: '2026-08-01T00:00:00.000Z',
      }));
      if (path === '/api/crossex/transfers' && init?.method === 'POST') return new Response(JSON.stringify({
        transactionId: 'tx-1', text: 'portfolio_1',
      }));
      return new Response('{}', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(api.transferCoins()).resolves.toMatchObject({ items: [{ coin: 'USDT', precision: 6 }] });
    await expect(api.transferBalances()).resolves.toMatchObject({ items: [{ account: 'SPOT', available: '25.125' }] });
    await expect(api.portfolioActivity('USDT')).resolves.toMatchObject({ transfers: [], accountBook: [], fundingFees: [] });
    await expect(api.transferFunds({
      coin: 'USDT', amount: '25', from: 'SPOT', to: 'CROSSEX', text: 'portfolio_1',
    })).resolves.toEqual({ transactionId: 'tx-1', text: 'portfolio_1' });

    const activityInit = fetchMock.mock.calls.find(([path]) => String(path).startsWith('/api/crossex/portfolio-activity?'))?.[1];
    const balancesInit = fetchMock.mock.calls.find(([path]) => path === '/api/crossex/transfer-balances')?.[1];
    const transferInit = fetchMock.mock.calls.find(([path]) => path === '/api/crossex/transfers')?.[1];
    expect(new Headers(activityInit?.headers).get('x-gct-read-intent')).toBe('portfolio-activity');
    expect(new Headers(balancesInit?.headers).get('x-gct-read-intent')).toBe('transfer-balances');
    expect(new Headers(transferInit?.headers).get('x-gct-trading-intent')).toBe('transfer-funds');
    expect(transferInit?.body).toBe('{"coin":"USDT","amount":"25","from":"SPOT","to":"CROSSEX","text":"portfolio_1"}');
  });

  it('requests one validated SQLite snapshot for global funding rankings', async () => {
    const fetchedAt = '2026-08-02T00:00:00.000Z';
    const fetchMock = vi.fn(async (_path: string, _init?: RequestInit) => {
      void _path;
      void _init;
      return new Response(JSON.stringify({
        entries: [{
          symbol: 'BINANCE_FUTURE_BTC_USDT', status: 'ok', rate24h: '0.001', rate7d: '0.002',
          rate30d: '0.003', settlementCount30d: 90, oldestFundingAt: fetchedAt,
          newestFundingAt: fetchedAt, fetchedAt,
        }],
        fetchedAt,
      }));
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(api.fundingRankings(['BINANCE_FUTURE_BTC_USDT'], 30)).resolves.toMatchObject({
      entries: [{ symbol: 'BINANCE_FUTURE_BTC_USDT', rate30d: '0.003' }],
    });
    const init = fetchMock.mock.calls[0]?.[1];
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/markets/funding-rankings');
    expect(new Headers(init?.headers).get('x-gct-read-intent')).toBe('funding-history');
    expect(init?.body).toBe('{"symbols":["BINANCE_FUTURE_BTC_USDT"],"durationDays":30}');
  });

  it('ignores malformed websocket messages and delivers only validated stream events', () => {
    type Listener = (event: { data?: unknown }) => void;
    class FakeWebSocket {
      static readonly OPEN = 1;
      static readonly CLOSED = 3;
      static latest: FakeWebSocket | null = null;
      readyState = FakeWebSocket.OPEN;
      readonly sent: string[] = [];
      private readonly listeners = new Map<string, Listener[]>();
      constructor(readonly url: string) { FakeWebSocket.latest = this; }
      addEventListener(type: string, listener: Listener) {
        this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
      }
      send(data: string) { this.sent.push(data); }
      close() {
        this.readyState = FakeWebSocket.CLOSED;
        for (const listener of this.listeners.get('close') ?? []) listener({});
      }
      emit(type: string, event: { data?: unknown } = {}) {
        for (const listener of this.listeners.get(type) ?? []) listener(event);
      }
    }
    vi.stubGlobal('window', { location: { protocol: 'http:', host: '127.0.0.1:17840' } });
    vi.stubGlobal('WebSocket', FakeWebSocket);
    const messages: unknown[] = [];
    const handle = connectTerminalStream((message) => messages.push(message), () => undefined);
    const socket = FakeWebSocket.latest;
    socket?.emit('open');
    socket?.emit('message', { data: JSON.stringify({ type: 'market.update', payload: { symbol: 42 } }) });
    socket?.emit('message', { data: JSON.stringify({ type: 'mode.update', payload: { mode: 'readonly' } }) });
    handle.watchQuotes(['OKX_FUTURE_ETH_USDT', 'GATE_FUTURE_ETH_USDT']);
    handle.watchKlines([
      { symbol: 'GATE_FUTURE_SKHYNIX_USDT', interval: '5m' },
      { symbol: 'GATE_FUTURE_SKHY_USDT', interval: '5m' },
      { symbol: 'GATE_FUTURE_SKHYNIX_USDT', interval: '5m' },
    ]);
    handle.watchMarket('GATE_FUTURE_BTC_USDT', '1m');

    expect(messages).toEqual([{ type: 'mode.update', payload: { mode: 'readonly' } }]);
    expect(socket?.sent.map((message) => JSON.parse(message))).toEqual([
      { type: 'watch.quotes', symbols: [] },
      { type: 'watch.quotes', symbols: ['GATE_FUTURE_ETH_USDT', 'OKX_FUTURE_ETH_USDT'] },
      { type: 'watch.klines', watches: [
        { symbol: 'GATE_FUTURE_SKHY_USDT', interval: '5m' },
        { symbol: 'GATE_FUTURE_SKHYNIX_USDT', interval: '5m' },
      ] },
      { type: 'watch.market', symbol: 'GATE_FUTURE_BTC_USDT', interval: '1m' },
    ]);
    handle.close();
  });
});
