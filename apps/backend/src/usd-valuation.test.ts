import { describe, expect, it, vi } from 'vitest';
import { queryUsdValuation } from './usd-valuation.js';

describe('observed USD/USDT valuation', () => {
  const now = 1_790_921_800_000;
  const payload = (price = '0.8', seconds = now / 1000) => ({ error: [], result: { USDTZUSD: [[price, '3', seconds, 'b', 'm', '', 1]], last: 'sample' } });
  it('inverts a fresh exact pair and sends no private credentials', async () => {
    const fetchMock = vi.fn(async (url, init) => {
      expect(url).toBe('https://api.kraken.com/0/public/Trades?pair=USDTUSD&count=1');
      expect([...new Headers(init?.headers).keys()]).toEqual(['accept']);
      expect(init.redirect).toBe('error');
      return Response.json(payload());
    });
    expect(await queryUsdValuation(fetchMock as typeof fetch, () => now)).toBe('1.25');
  });
  it.each(['0', '-1', 'Infinity', 'NaN', 'bad'])('rejects invalid quote %s', async (price) => {
    expect(await queryUsdValuation(vi.fn(async () => Response.json(payload(price))), () => now)).toBeNull();
  });
  it('rejects stale/future/wrong-pair/error quotes and propagates explicit cancellation', async () => {
    for (const data of [payload('1', now / 1000 - 91), payload('1', now / 1000 + 1), { error: ['bad'], result: payload().result }, { error: [], result: { OTHER: payload().result.USDTZUSD } }]) {
      expect(await queryUsdValuation(vi.fn(async () => Response.json(data)), () => now)).toBeNull();
    }
    const controller = new AbortController(); controller.abort();
    await expect(queryUsdValuation(vi.fn(async () => { throw new Error('aborted'); }), () => now, controller.signal)).rejects.toThrow('aborted');
  });
});
