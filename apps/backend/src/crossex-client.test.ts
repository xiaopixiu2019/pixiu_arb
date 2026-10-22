import { describe, expect, it, vi } from 'vitest';
import { GateApiError, GateCrossExClient, signGateRequest, type AuthenticatedRequestTiming } from './crossex-client.js';
import { marginReadFault } from './margin-read-fault.js';

describe('Gate APIv4 signing', () => {
  it('aborts a stalled response body and releases its stream reader', async () => {
    const cancelled = vi.fn(); const stream = new ReadableStream({ cancel: cancelled });
    const fetched = vi.fn(async () => new Response(stream));
    const timings: AuthenticatedRequestTiming[] = [];
    const client = new GateCrossExClient(fetched as typeof fetch, Date.now, undefined, 0, timing => timings.push(timing));
    const controller = new AbortController();
    const pending = client.queryPositions({ apiKey: 'synthetic', apiSecret: 'synthetic' }, controller.signal);
    const checked = expect(pending).rejects.toMatchObject({ label: 'REQUEST_ABORTED', context: { phase: 'body' } });
    await vi.waitFor(() => expect(stream.locked).toBe(true)); controller.abort(); await checked;
    expect(cancelled).toHaveBeenCalledTimes(1);
    expect(timings).toEqual(expect.arrayContaining([expect.objectContaining({ phase: 'body', statusCode: 200, failed: true })]));
    expect(timings[0].requestId).toBe(timings.at(-1)?.requestId);
    expect(marginReadFault(new GateApiError(200, 'NETWORK_ERROR', undefined, { endpoint: '/crossex/accounts', phase: 'body' })).fatal).toBe(false);
  });
  it('cancels the sibling managed read and retains the first HTTP error', async () => {
    const fetched = vi.fn(async () => new Response('<html>unavailable</html>', { status: 500 }));
    const client = new GateCrossExClient(fetched as typeof fetch, Date.now, undefined, 1000);
    await expect(client.queryManagedState({ apiKey: 'synthetic', apiSecret: 'synthetic' }, new AbortController().signal))
      .rejects.toMatchObject({ statusCode: 500 });
    expect(fetched).toHaveBeenCalledTimes(1);
  });
  it('removes an aborted queued read immediately without sending it', async () => {
    vi.useFakeTimers();
    try {
      const fetchMock = vi.fn(async () => new Response('[]'));
      const client = new GateCrossExClient(fetchMock as typeof fetch, Date.now, undefined, 1000);
      const credentials = { apiKey: 'synthetic', apiSecret: 'synthetic' };
      await client.queryPositions(credentials);
      const controller = new AbortController(); let settled = false;
      const pending = client.queryPositions(credentials, controller.signal).catch(error => { settled = true; return error; });
      controller.abort(); await vi.advanceTimersByTimeAsync(1);
      expect(settled).toBe(true); expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(await pending).toMatchObject({ label: 'REQUEST_ABORTED' });
    } finally { await vi.runAllTimersAsync(); vi.useRealTimers(); }
  });
  it('reselects urgent cancellation ahead of a read waiting for queue spacing', async () => {
    vi.useFakeTimers();
    try {
      const paths: string[] = [];
      const client = new GateCrossExClient(async url => {
        const path = new URL(String(url)).pathname; paths.push(path);
        return new Response(path.includes('/orders/') ? JSON.stringify({ order_id: 'owned', text: '' }) : '[]');
      }, Date.now, undefined, 1000);
      const credentials = { apiKey: 'synthetic', apiSecret: 'synthetic' };
      await client.queryPositions(credentials);
      const read = client.queryPositions(credentials);
      const cancel = client.cancelOrder(credentials, 'owned');
      await vi.advanceTimersByTimeAsync(2001); await Promise.all([read, cancel]);
      expect(paths[1]).toBe('/api/v4/crossex/orders/owned');
    } finally { await vi.runAllTimersAsync(); vi.useRealTimers(); }
  });
  it('keeps scheduled statistics independent from the foreground authenticated queue', async () => {
    let release!: () => void, calls = 0;
    const paused = new Promise<void>((resolve) => { release = resolve; });
    const fetchMock = vi.fn(async () => {
      calls += 1; if (calls === 1) await paused;
      return new Response(JSON.stringify({ available_margin: '100', margin_balance: '100', initial_margin: '0', maintenance_margin: '0', initial_margin_rate: '0', maintenance_margin_rate: '0', position_mode: 'SINGLE', account_mode: 'CROSS_EXCHANGE', exchange_type: 'CROSSEX', update_time: '1783689000000', assets: [] }));
    });
    const client = new GateCrossExClient(fetchMock as typeof fetch, Date.now, undefined, 0), credentials = { apiKey: 'synthetic', apiSecret: 'synthetic' };
    const foreground = client.queryAccount(credentials);
    await vi.waitFor(() => expect(calls).toBe(1));
    try { await expect(client.createStatisticsReader().queryAccount(credentials)).resolves.toMatchObject({ margin_balance: '100' }); }
    finally { release(); await foreground; }
    expect(calls).toBe(2);
  });
  it('uses public observed prices without credentials or assumed stablecoin parity', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe('https://api.gateio.ws/api/v4/spot/tickers');
      expect(new Headers(init?.headers).has('KEY')).toBe(false);
      return new Response(JSON.stringify([{ currency_pair: 'USDC_USDT', last: '0.997' }]));
    });
    const client = new GateCrossExClient(fetchMock as typeof fetch);
    expect(await client.queryValuationRates(['USDT'])).toEqual({ USDT: '1' });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await client.queryValuationRates(['USDC'])).toEqual({ USDT: '1', USDC: '0.997' });
  });

  it.each(['http', 'network', 'schema'])('keeps USD valuation independent of Gate %s failures', async (failure) => {
    const now = Date.now();
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(new Headers(init?.headers).has('KEY')).toBe(false);
      if (String(url).includes('api.kraken.com')) return Response.json({ error: [], result: { USDTZUSD: [['0.8', '1', now / 1000, 'b']] } });
      if (failure === 'network') throw new Error('offline');
      return failure === 'http' ? new Response('', { status: 500 }) : Response.json({ invalid: true });
    });
    expect(await new GateCrossExClient(fetchMock as typeof fetch, () => now).queryValuationRates(['USD', 'USDC'])).toEqual({ USDT: '1', USD: '1.25' });
  });

  it('uses the documented method, path, query, payload hash, and timestamp order', () => {
    expect(signGateRequest({
      method: 'GET',
      requestPath: '/api/v4/crossex/accounts',
      queryString: '',
      body: '',
      timestamp: '1700000000',
      secret: 'test-secret',
    })).toBe('7d6704962cf24815f78524d46ef07834d5fd5359af08ed4ed100273517d1932cd4d233335ce49c1c30abcd12ded2d8e993c0ccd93718cd68a2b0011d66a8bc04');
  });

  it('sends only a signed read-only account request to the documented production endpoint', async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(init?.method).toBe('GET');
      expect(init?.body).toBeUndefined();
      const headers = new Headers(init?.headers);
      expect(headers.get('KEY')).toBe('test-api-key');
      expect(headers.get('Timestamp')).toBe('1700000000');
      expect(headers.get('SIGN')).toMatch(/^[a-f0-9]{128}$/);
      expect(headers.get('X-Gate-Channel-Id')).toBeNull();
      return new Response(JSON.stringify({
        available_margin: '100',
        margin_balance: '100',
        initial_margin: '0',
        maintenance_margin: '0',
        initial_margin_rate: '0',
        maintenance_margin_rate: '0',
        position_mode: 'SINGLE',
        account_mode: 'CROSS_EXCHANGE',
        exchange_type: 'CROSSEX',
        update_time: '1783689000000',
        assets: [],
      }), { status: 200 });
    });
    const client = new GateCrossExClient(fetchMock as typeof fetch, () => 1_700_000_000_000);
    const account = await client.queryAccount({ apiKey: 'test-api-key', apiSecret: 'test-secret' });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.gateio.ws/api/v4/crossex/accounts',
      expect.objectContaining({ method: 'GET' }),
    );
    expect(account.account_mode).toBe('CROSS_EXCHANGE');
  });

  it('signs the required exchange_type query for an isolated account', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe('https://api.gateio.ws/api/v4/crossex/accounts?exchange_type=DERIBIT');
      expect(new Headers(init?.headers).get('SIGN')).toMatch(/^[a-f0-9]{128}$/);
      return new Response(JSON.stringify({
        available_margin: '250', margin_balance: '300', initial_margin: '50', maintenance_margin: '20',
        initial_margin_rate: '6', maintenance_margin_rate: '15', position_mode: 'SINGLE',
        account_mode: 'ISOLATED_EXCHANGE', exchange_type: 'DERIBIT', update_time: '1783689000000', assets: [],
      }), { status: 200 });
    });
    const client = new GateCrossExClient(fetchMock as typeof fetch, () => 1_700_000_000_000, undefined, 0);

    await expect(client.queryAccount(
      { apiKey: 'test-api-key', apiSecret: 'test-secret' },
      'deribit',
    )).resolves.toMatchObject({ account_mode: 'ISOLATED_EXCHANGE', exchange_type: 'DERIBIT' });
  });

  it('queries exact Gate Spot available balances with the same signed credentials', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe('https://api.gateio.ws/api/v4/spot/accounts');
      const headers = new Headers(init?.headers);
      expect(headers.get('KEY')).toBe('test-api-key');
      expect(headers.get('SIGN')).toMatch(/^[a-f0-9]{128}$/);
      return new Response(JSON.stringify([{ currency: 'USDC', available: '42.50000001', locked: '0' }]));
    });
    const client = new GateCrossExClient(fetchMock as typeof fetch, () => 1_700_000_000_000, undefined, 0);

    await expect(client.querySpotAccounts({ apiKey: 'test-api-key', apiSecret: 'test-secret' })).resolves.toEqual([
      { currency: 'USDC', available: '42.50000001', locked: '0' },
    ]);
  });

  it('surfaces only the documented Gate error label', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      label: 'INVALID_SIGNATURE',
      message: 'sensitive upstream detail',
    }), { status: 401 }));
    const client = new GateCrossExClient(fetchMock as typeof fetch, () => 1_700_000_000_000);

    await expect(client.queryAccount({ apiKey: 'test-api-key', apiSecret: 'test-secret' }))
      .rejects.toEqual(new GateApiError(401, 'INVALID_SIGNATURE', undefined, { endpoint: '/crossex/accounts', phase: 'decode' }));
  });

  it('signs and sends only the documented CrossEx order create and cancel routes', async () => {
    const calls: Array<{ url: string; method: string; body: string | null; sign: string | null; channel: string | null }> = [];
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      calls.push({ url: String(url), method: init?.method ?? '', body: init?.body ? String(init.body) : null, sign: headers.get('SIGN'), channel: headers.get('X-Gate-Channel-Id') });
      return new Response(JSON.stringify({ order_id: '123456', text: 'gct-order-1' }), { status: 200 });
    });
    const client = new GateCrossExClient(fetchMock as typeof fetch, () => 1_700_000_000_000);
    const credentials = { apiKey: 'test-api-key', apiSecret: 'test-secret' };
    await client.createOrder(credentials, { text: 'gct-order-1', symbol: 'OKX_FUTURE_BTC_USDT', side: 'BUY',
      type: 'LIMIT', time_in_force: 'POC', qty: '0.01', price: '62000', reduce_only: 'false', position_side: 'NONE' });
    await client.cancelOrder(credentials, '123456');

    expect(calls).toEqual([
      expect.objectContaining({ url: 'https://api.gateio.ws/api/v4/crossex/orders', method: 'POST', body: expect.stringContaining('OKX_FUTURE_BTC_USDT'), sign: expect.stringMatching(/^[a-f0-9]{128}$/), channel: 'xiaopixiu' }),
      expect.objectContaining({ url: 'https://api.gateio.ws/api/v4/crossex/orders/123456', method: 'DELETE', body: null, sign: expect.stringMatching(/^[a-f0-9]{128}$/), channel: null }),
    ]);
  });

  it('isolates malformed optional liquidation fields from core REST positions', async () => {
    const position = { position_id: 'p1', symbol: 'BYBIT_FUTURE_BTC_USDT', position_side: 'LONG', initial_margin: '10', maintenance_margin: '2', position_qty: '1', position_value: '100', upnl: '0', upnl_rate: '0', entry_price: '100', mark_price: '100', leverage: '3', max_leverage: '20', risk_limit: '1', fee: '0', funding_fee: '0', funding_time: '0', create_time: '0', update_time: '0', closed_pnl: '0', liq_price: 80 };
    const fetchMock = vi.fn(async () => Response.json([position]));
    expect(await new GateCrossExClient(fetchMock as typeof fetch).queryPositions({ apiKey: 'synthetic', apiSecret: 'synthetic' })).toEqual([{ ...position, liq_price: null }]);
  });

  it('enriches the five portfolio reads with the documented per-symbol ADL ranks', async () => {
    const account = {
      available_margin: '100', margin_balance: '100', initial_margin: '0', maintenance_margin: '0',
      initial_margin_rate: '0', maintenance_margin_rate: '0', position_mode: 'SINGLE',
      account_mode: 'CROSS_EXCHANGE', exchange_type: 'CROSSEX', update_time: '1783689000000', assets: [],
    };
    const position = {
      position_id: 'p1', symbol: 'BINANCE_FUTURE_BTC_USDT', position_side: 'LONG', initial_margin: '10',
      maintenance_margin: '2', position_qty: '0.01', position_value: '640', upnl: '2', upnl_rate: '0.01',
      entry_price: '63000', mark_price: '64000', leverage: '3', max_leverage: '20', risk_limit: '1',
      fee: '0.1', funding_fee: '0', funding_time: '0', create_time: '1783600000000',
      update_time: '1783689000000', closed_pnl: '0',
    };
    const order = {
      order_id: 'o1', client_order_id: 'c1', state: 'OPEN', symbol: 'OKX_FUTURE_BTC_USDT', side: 'SELL',
      type: 'LIMIT', attribute: 'COMMON', exchange_type: 'OKX', business_type: 'FUTURE', qty: '0.01',
      quote_qty: '0', price: '65000', time_in_force: 'GTC', executed_qty: '0', executed_amount: '0',
      executed_avg_price: '0', fee_coin: 'USDT', fee: '0', reduce_only: 'false', leverage: '3', reason: '',
      last_executed_qty: '0', last_executed_price: '0', last_executed_amount: '0', position_side: 'NONE',
      create_time: '1783600000000', update_time: '1783600000000',
    };
    const trade = {
      transaction_id: 't1', order_id: 'o0', text: 'c0', symbol: 'BINANCE_FUTURE_BTC_USDT',
      exchange_type: 'BINANCE', business_type: 'FUTURE', side: 'BUY', qty: '0.01', price: '63000',
      fee: '0.1', fee_coin: 'USDT', fee_rate: '0.0005', match_role: 'TAKER', rpnl: '0',
      position_mode: 'BOTH', position_side: 'LONG', create_time: '1783600000000',
    };
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(init?.method).toBe('GET');
      expect(init?.body).toBeUndefined();
      const headers = new Headers(init?.headers);
      expect(headers.get('KEY')).toBe('test-api-key');
      expect(headers.get('SIGN')).toMatch(/^[a-f0-9]{128}$/);
      const value = String(url);
      if (value.endsWith('/crossex/accounts')) return new Response(JSON.stringify(account));
      if (value.endsWith('/crossex/positions')) return new Response(JSON.stringify([position]));
      if (value.endsWith('/crossex/adl_rank?symbol=BINANCE_FUTURE_BTC_USDT')) return new Response(JSON.stringify({
        user_id: 'user-1', symbol: 'BINANCE_FUTURE_BTC_USDT',
        crossex_adl_rank: '4', exchange_adl_rank: '3',
      }));
      if (value.endsWith('/crossex/margin_positions')) return new Response('[]');
      if (value.endsWith('/crossex/open_orders')) return new Response(JSON.stringify([order]));
      if (value.endsWith('/crossex/history_trades?page=1&limit=100')) return new Response(JSON.stringify([trade]));
      return new Response('{}', { status: 404 });
    });
    const client = new GateCrossExClient(fetchMock as typeof fetch, () => 1_700_000_000_000);

    const portfolio = await client.queryPortfolio({ apiKey: 'test-api-key', apiSecret: 'test-secret' });

    expect(fetchMock).toHaveBeenCalledTimes(6);
    expect(portfolio.positions[0]?.position_id).toBe('p1');
    expect(portfolio.adlRanks).toEqual([expect.objectContaining({
      symbol: 'BINANCE_FUTURE_BTC_USDT', crossex_adl_rank: '4', exchange_adl_rank: '3',
    })]);
    expect(portfolio.openOrders[0]?.client_order_id).toBe('c1');
    expect(portfolio.recentTrades[0]?.transaction_id).toBe('t1');
  });

  it('also accepts an array-shaped ADL response', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify([{
      user_id: 'user-1', symbol: 'OKX_FUTURE_BTC_USDT',
      crossex_adl_rank: '2', exchange_adl_rank: '1',
    }])));
    const client = new GateCrossExClient(fetchMock as typeof fetch, () => 1_700_000_000_000, undefined, 0);

    await expect(client.queryAdlRanks(
      { apiKey: 'test-api-key', apiSecret: 'test-secret' },
      ['OKX_FUTURE_BTC_USDT'],
    )).resolves.toEqual([expect.objectContaining({
      symbol: 'OKX_FUTURE_BTC_USDT', crossex_adl_rank: '2', exchange_adl_rank: '1',
    })]);
  });

  it('keeps the portfolio usable when supplemental ADL data is unavailable', async () => {
    const account = {
      available_margin: '100', margin_balance: '100', initial_margin: '0', maintenance_margin: '0',
      initial_margin_rate: '0', maintenance_margin_rate: '0', position_mode: 'SINGLE',
      account_mode: 'CROSS_EXCHANGE', exchange_type: 'CROSSEX', update_time: '1783689000000', assets: [],
    };
    const position = {
      position_id: 'p1', symbol: 'OKX_FUTURE_BTC_USDT', position_side: 'LONG', initial_margin: '10',
      maintenance_margin: '2', position_qty: '0.01', position_value: '640', upnl: '2', upnl_rate: '0.01',
      entry_price: '63000', mark_price: '64000', leverage: '3', max_leverage: '20', risk_limit: '1',
      fee: '0.1', funding_fee: '0', funding_time: '0', create_time: '1783600000000',
      update_time: '1783689000000', closed_pnl: '0',
    };
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const value = String(url);
      if (value.endsWith('/crossex/accounts')) return new Response(JSON.stringify(account));
      if (value.endsWith('/crossex/positions')) return new Response(JSON.stringify([position]));
      if (value.includes('/crossex/adl_rank?')) return new Response(JSON.stringify({ label: 'ADL_UNAVAILABLE' }), { status: 503 });
      return new Response('[]');
    });
    const client = new GateCrossExClient(fetchMock as typeof fetch, () => 1_700_000_000_000, undefined, 0);

    await expect(client.queryPortfolio({ apiKey: 'test-api-key', apiSecret: 'test-secret' }))
      .resolves.toMatchObject({ positions: [position], adlRanks: [] });
  });

  it('stops supplemental ADL enrichment after the first rate limit', async () => {
    const fetchMock = vi.fn(async () => new Response(
      JSON.stringify({ label: 'RATE_LIMITED' }),
      { status: 429, headers: { 'Retry-After': '30' } },
    ));
    const client = new GateCrossExClient(fetchMock as typeof fetch, () => 1_700_000_000_000, undefined, 0);

    await expect(client.queryAdlRanks(
      { apiKey: 'test-api-key', apiSecret: 'test-secret' },
      ['BINANCE_FUTURE_BTC_USDT', 'OKX_FUTURE_BTC_USDT', 'BYBIT_FUTURE_BTC_USDT'],
    )).resolves.toEqual([]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('validates nullable fields from the public CrossEx symbol catalog', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify([{
      symbol: 'GATE_FUTURE_BTC_USDT', exchange_type: 'GATE', business_type: 'FUTURE', state: 'live',
      min_size: '0.0001', min_notional: null, lot_size: '0.0001', tick_size: '0.1',
      max_num_orders: '50', max_market_size: null, max_limit_size: '1200', contract_size: null,
      liquidation_fee: '0.005', default_leverage: '5', delist_time: '0',
    }]), { status: 200 }));
    const client = new GateCrossExClient(fetchMock as typeof fetch);

    const symbols = await client.querySymbols();

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.gateio.ws/api/v4/crossex/rule/symbols',
      expect.objectContaining({ method: 'GET' }),
    );
    expect(symbols[0]).toMatchObject({ symbol: 'GATE_FUTURE_BTC_USDT', min_notional: null });
  });

  it('queries a single order by id or client text with the documented GET route', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(init?.method).toBe('GET');
      expect(String(url)).toBe('https://api.gateio.ws/api/v4/crossex/orders/gct-abc_1');
      return new Response(JSON.stringify({
        order_id: '2048522992198912', text: 'gct-abc_1', state: 'FILLED', symbol: 'BINANCE_FUTURE_BTC_USDT',
        side: 'BUY', type: 'MARKET', attribute: 'COMMON', exchange_type: 'BINANCE', business_type: 'FUTURE',
        qty: '0.01', quote_qty: '0', price: '0', time_in_force: 'IOC', executed_qty: '0.01',
        executed_amount: '640', executed_avg_price: '64000', fee_coin: 'USDT', fee: '0.32',
        reduce_only: 'false', leverage: '3', reason: '', last_executed_qty: '0.01',
        last_executed_price: '64000', last_executed_amount: '640', position_side: 'NONE',
        create_time: '1783600000000', update_time: '1783600001000',
      }), { status: 200 });
    });
    const client = new GateCrossExClient(fetchMock as typeof fetch, () => 1_700_000_000_000);

    const order = await client.queryOrder({ apiKey: 'test-api-key', apiSecret: 'test-secret' }, 'gct-abc_1');

    expect(order.state).toBe('FILLED');
    expect(order.executed_qty).toBe('0.01');
    await expect(client.queryOrder({ apiKey: 'k', apiSecret: 's' }, 'bad id!'))
      .rejects.toEqual(new GateApiError(0, 'INVALID_ORDER_ID'));
  });

  it('queries and updates leverage through the documented CrossEx routes', async () => {
    const calls: Array<{ url: string; method: string; body: string | null; channel: string | null }> = [];
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      calls.push({
        url: String(url),
        method: init?.method ?? '',
        body: init?.body ? String(init.body) : null,
        channel: headers.get('X-Gate-Channel-Id'),
      });
      if (init?.method === 'GET') return new Response(JSON.stringify({ BINANCE_FUTURE_BTC_USDT: '5' }));
      return new Response(JSON.stringify({ symbol: 'BINANCE_FUTURE_BTC_USDT', leverage: '10' }), { status: 202 });
    });
    const client = new GateCrossExClient(fetchMock as typeof fetch, () => 1_700_000_000_000);
    const credentials = { apiKey: 'test-api-key', apiSecret: 'test-secret' };

    const current = await client.queryLeverages(credentials, ['BINANCE_FUTURE_BTC_USDT']);
    const updated = await client.setLeverage(credentials, 'BINANCE_FUTURE_BTC_USDT', '10');

    expect(current.BINANCE_FUTURE_BTC_USDT).toBe('5');
    expect(updated).toEqual({ symbol: 'BINANCE_FUTURE_BTC_USDT', leverage: '10' });
    expect(calls).toEqual([
      {
        url: 'https://api.gateio.ws/api/v4/crossex/positions/leverage?symbols=BINANCE_FUTURE_BTC_USDT',
        method: 'GET',
        body: null,
        channel: null,
      },
      {
        url: 'https://api.gateio.ws/api/v4/crossex/positions/leverage',
        method: 'POST',
        body: '{"symbol":"BINANCE_FUTURE_BTC_USDT","leverage":"10"}',
        channel: null,
      },
    ]);
  });

  it('serializes authenticated workflows so independent callers cannot burst Gate', async () => {
    let releaseFirst: (() => void) | undefined;
    const firstBlocked = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let active = 0;
    let maxActive = 0;
    let calls = 0;
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      calls += 1;
      active += 1;
      maxActive = Math.max(maxActive, active);
      if (calls === 1) await firstBlocked;
      active -= 1;
      if (String(url).endsWith('/crossex/accounts')) {
        return new Response(JSON.stringify({
          available_margin: '100', margin_balance: '100', initial_margin: '0', maintenance_margin: '0',
          initial_margin_rate: '0', maintenance_margin_rate: '0', position_mode: 'SINGLE',
          account_mode: 'CROSS_EXCHANGE', exchange_type: 'CROSSEX', update_time: '1783689000000', assets: [],
        }));
      }
      return new Response(JSON.stringify({ BINANCE_FUTURE_BTC_USDT: '5' }));
    });
    const client = new GateCrossExClient(fetchMock as typeof fetch, () => 1_700_000_000_000, undefined, 0);
    const credentials = { apiKey: 'test-api-key', apiSecret: 'test-secret' };

    const account = client.queryAccount(credentials);
    const leverage = client.queryLeverages(credentials, ['BINANCE_FUTURE_BTC_USDT']);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    releaseFirst?.();
    await Promise.all([account, leverage]);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(maxActive).toBe(1);
  });

  it('runs urgent order cancellation ahead of queued portfolio reads', async () => {
    let releaseFirst: (() => void) | undefined;
    const firstBlocked = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const calls: string[] = [];
    const account = {
      available_margin: '100', margin_balance: '100', initial_margin: '0', maintenance_margin: '0',
      initial_margin_rate: '0', maintenance_margin_rate: '0', position_mode: 'SINGLE',
      account_mode: 'CROSS_EXCHANGE', exchange_type: 'CROSSEX', update_time: '1783689000000', assets: [],
    };
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const path = new URL(String(url)).pathname;
      calls.push(path);
      if (calls.length === 1) await firstBlocked;
      if (path.endsWith('/accounts')) return new Response(JSON.stringify(account));
      if (path.endsWith('/orders/cancel-me')) {
        return new Response(JSON.stringify({ order_id: 'cancel-me', text: 'gct-cancel-me' }));
      }
      return new Response('[]');
    });
    const client = new GateCrossExClient(fetchMock as typeof fetch, () => 1_700_000_000_000, undefined, 0);
    const credentials = { apiKey: 'test-api-key', apiSecret: 'test-secret' };

    const portfolio = client.queryPortfolio(credentials);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const cancellation = client.cancelOrder(credentials, 'cancel-me');
    releaseFirst?.();
    await Promise.all([portfolio, cancellation]);

    expect(calls.slice(0, 2)).toEqual([
      '/api/v4/crossex/accounts',
      '/api/v4/crossex/orders/cancel-me',
    ]);
  });
  it('prioritizes managed account facts over queued UI portfolio reads and records sanitized timing', async () => {
    let releaseFirst: (() => void) | undefined;
    const firstBlocked = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const calls: string[] = [], timings: Array<{ endpoint: string; priority: string; queueMs: number }> = [];
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const path = new URL(String(url)).pathname;
      calls.push(path);
      if (calls.length === 1) await firstBlocked;
      if (path.endsWith('/accounts')) return new Response(JSON.stringify({
        available_margin: '100', margin_balance: '100', initial_margin: '0', maintenance_margin: '0',
        initial_margin_rate: '0', maintenance_margin_rate: '0', position_mode: 'SINGLE',
        account_mode: 'CROSS_EXCHANGE', exchange_type: 'CROSSEX', update_time: '1783689000000', assets: [],
      }));
      return new Response('[]');
    });
    const client = new GateCrossExClient(fetchMock as typeof fetch, () => 1_700_000_000_000, undefined, 0,
      (timing) => timings.push(timing));
    const credentials = { apiKey: 'test-api-key', apiSecret: 'test-secret' };
    const portfolio = client.queryPortfolio(credentials);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const managed = client.queryManagedState(credentials, new AbortController().signal);
    releaseFirst?.(); await Promise.all([portfolio, managed]);
    expect(calls.slice(0, 3)).toEqual(['/api/v4/crossex/accounts',
      '/api/v4/crossex/positions', '/api/v4/crossex/open_orders']);
    expect(timings.filter((timing) => timing.priority === 'high')).toHaveLength(2);
    expect(timings.every((timing) => timing.queueMs >= 0)).toBe(true);
  });

  it('stops reading an oversized authenticated response stream at the byte limit', async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(600_000));
        controller.enqueue(new Uint8Array(600_000));
      },
      cancel() {
        cancelled = true;
      },
    });
    const client = new GateCrossExClient(
      vi.fn(async () => new Response(stream, { status: 200 })) as typeof fetch,
      () => 1_700_000_000_000,
      undefined,
      0,
    );

    await expect(client.queryAccount({ apiKey: 'test-api-key', apiSecret: 'test-secret' }))
      .rejects.toEqual(new GateApiError(200, 'RESPONSE_TOO_LARGE', undefined, { endpoint: '/crossex/accounts', phase: 'body' }));
    expect(cancelled).toBe(true);
  });

  it('validates authenticated per-venue fee rates', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      expect(String(url)).toBe('https://api.gateio.ws/api/v4/crossex/fee');
      return new Response(JSON.stringify([
        { exchange_type: 'BINANCE', spot_maker_fee: '0.0001', spot_taker_fee: '0.00025', future_maker_fee: '0.00006', future_taker_fee: '0.00022', special_fee_list: [{ symbol: 'BINANCE_FUTURE_BTC_USDT', maker_fee_rate: '0.00001', taker_fee_rate: '0.00002' }] },
        { exchange_type: 'KRAKEN', spot_maker_fee: '0.0001', spot_taker_fee: '0.00025', future_maker_fee: '0.00006', future_taker_fee: '0.00022' },
      ]), { status: 200 });
    });
    const client = new GateCrossExClient(fetchMock as typeof fetch, () => 1_700_000_000_000);

    const fees = await client.queryFeeRates({ apiKey: 'test-api-key', apiSecret: 'test-secret' });

    expect(fees).toHaveLength(2);
    expect(fees[0]?.special_fee_list).toEqual([{ symbol: 'BINANCE_FUTURE_BTC_USDT', maker_fee_rate: '0.00001', taker_fee_rate: '0.00002' }]);
    expect(fees[1]).toMatchObject({ exchange_type: 'KRAKEN', future_taker_fee: '0.00022' });
  });

  it('validates public risk tiers and encodes the requested symbol list', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify([{
      symbol: 'BINANCE_FUTURE_BTC_USDT',
      tiers: [{
        min_risk_limit_value: '0', max_risk_limit_value: '3000000', quick_cal_amount: '0',
        leverage_max: '20', maintenance_rate: '0.0065', tier: '1',
      }],
    }]), { status: 200 }));
    const client = new GateCrossExClient(fetchMock as typeof fetch);

    const limits = await client.queryRiskLimits(['BINANCE_FUTURE_BTC_USDT']);

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.gateio.ws/api/v4/crossex/rule/risk_limits?symbols=BINANCE_FUTURE_BTC_USDT',
      expect.objectContaining({ method: 'GET' }),
    );
    expect(limits[0]?.tiers[0]?.quick_cal_amount).toBe('0');
  });

  it('uses the documented CrossEx transfer, history, currency, and account-book routes', async () => {
    const calls: Array<{ url: string; method: string; body: string | null; channel: string | null }> = [];
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const value = String(url);
      const headers = new Headers(init?.headers);
      calls.push({
        url: value,
        method: init?.method ?? '',
        body: init?.body ? String(init.body) : null,
        channel: headers.get('X-Gate-Channel-Id'),
      });
      if (value.endsWith('/crossex/transfers/coin')) return new Response(JSON.stringify([
        { coin: 'USDT', min_trans_amount: '0.00000001', est_fee: '0', precision: 8, is_disabled: 0 },
      ]));
      if (init?.method === 'POST') return new Response(JSON.stringify({ tx_id: 'tx-1', text: 'portfolio_1' }));
      if (value.includes('/crossex/transfers?')) return new Response(JSON.stringify([{
        id: 'tx-1', text: 'portfolio_1', from_account_type: 'SPOT', to_account_type: 'CROSSEX', coin: 'USDT',
        amount: '25', actual_receive: '25', status: 'SUCCESS', fail_reason: null,
        create_time: 1783689000000, update_time: 1783689001000,
      }]));
      if (value.includes('/crossex/account_book?')) return new Response(JSON.stringify([{
        id: 'book-1', business_id: 'tx-1', statement_type: 'TRANSFER_IN', exchange_type: 'GATE', coin: 'USDT',
        symbol: null, change: '25', balance: '125', create_time: '1783689001000',
      }]));
      return new Response('{}', { status: 404 });
    });
    const client = new GateCrossExClient(fetchMock as typeof fetch, () => 1_700_000_000_000, undefined, 0);
    const credentials = { apiKey: 'test-api-key', apiSecret: 'test-secret' };

    const coins = await client.queryTransferCoins();
    const transfer = await client.createTransfer(credentials, {
      coin: 'USDT', amount: '25', from: 'SPOT', to: 'CROSSEX', text: 'portfolio_1',
    });
    const history = await client.queryTransfers(credentials, { coin: 'USDT', limit: 50 });
    const book = await client.queryAccountBook(credentials, { coin: 'USDT', limit: 50 });
    const fundingFees = await client.queryAccountBook(credentials, {
      coin: 'USDT', limit: 50, statementType: 'FUNDING_FEE',
    });

    expect(coins[0]).toMatchObject({ coin: 'USDT', min_trans_amount: '0.00000001', est_fee: '0', precision: 8 });
    expect(transfer).toEqual({ tx_id: 'tx-1', text: 'portfolio_1' });
    expect(history[0]).toMatchObject({ id: 'tx-1', status: 'SUCCESS' });
    expect(book[0]).toMatchObject({ id: 'book-1', statement_type: 'TRANSFER_IN' });
    expect(fundingFees[0]).toMatchObject({ id: 'book-1' });
    expect(calls).toEqual([
      { url: 'https://api.gateio.ws/api/v4/crossex/transfers/coin', method: 'GET', body: null, channel: null },
      { url: 'https://api.gateio.ws/api/v4/crossex/transfers', method: 'POST', body: '{"coin":"USDT","amount":"25","from":"SPOT","to":"CROSSEX","text":"portfolio_1"}', channel: null },
      { url: 'https://api.gateio.ws/api/v4/crossex/transfers?coin=USDT&page=1&limit=50', method: 'GET', body: null, channel: null },
      { url: 'https://api.gateio.ws/api/v4/crossex/account_book?coin=USDT&page=1&limit=50', method: 'GET', body: null, channel: null },
      { url: 'https://api.gateio.ws/api/v4/crossex/account_book?coin=USDT&statement_type=FUNDING_FEE&page=1&limit=50', method: 'GET', body: null, channel: null },
    ]);
  });
});
