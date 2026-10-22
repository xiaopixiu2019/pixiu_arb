import { describe, expect, it } from 'vitest';
import { readHyperliquidBook } from './hyperliquid-book.js';

describe('Hyperliquid reference book', () => {
  const now = 1_790_000_000_000;
  const payload = { coin: 'xyz:SKHYNIX', time: now, levels: [[{ px: '100', sz: '2' }], [{ px: '101', sz: '3' }]] };
  it('preserves the resolved HIP-3 coin and reads actual best quotes', async () => {
    let body: unknown;
    const fetcher = (async (_url, options) => {
      body = JSON.parse(String(options?.body));
      return Response.json(payload);
    }) as typeof fetch;
    expect(await readHyperliquidBook(fetcher, 'xyz:SKHYNIX', () => now)).toEqual({ bidPrice: '100', askPrice: '101', bookObservedAt: new Date(now).toISOString() });
    expect(body).toEqual({ type: 'l2Book', coin: 'xyz:SKHYNIX' });
  });
  it.each([
    { ...payload, coin: 'OTHER' }, { ...payload, time: now - 31_000 },
    { ...payload, levels: [[], [{ px: '101', sz: '3' }]] },
    { ...payload, levels: [[{ px: '102', sz: '2' }], [{ px: '101', sz: '3' }]] },
    { ...payload, levels: [[{ px: '100', sz: '0' }], [{ px: '101', sz: '3' }]] },
    { ...payload, levels: [[{ px: '100', sz: 'Infinity' }], [{ px: '101', sz: '3' }]] },
  ])('rejects wrong, stale, empty, crossed or non-executable books', async (invalid) => {
    await expect(readHyperliquidBook((async () => Response.json(invalid)) as typeof fetch, 'xyz:SKHYNIX', () => now)).rejects.toThrow();
  });
  it('checks exchange time against receipt time after a slow successful read', async () => {
    let clock = now;
    const fetcher = (async () => { clock += 6_000; return Response.json({ ...payload, time: clock }); }) as typeof fetch;
    const result = await readHyperliquidBook(fetcher, 'xyz:SKHYNIX', () => clock);
    expect(result.bookObservedAt).toBe(new Date(now + 6_000).toISOString());
  });
  it('rejects declared and streamed excessive bodies before parsing', async () => {
    for (const response of [new Response('{}', { headers: { 'content-length': '100001' } }), new Response(' '.repeat(100001))]) {
      await expect(readHyperliquidBook((async () => response) as typeof fetch, 'BTC', () => now)).rejects.toThrow('REFERENCE_BOOK_TOO_LARGE');
    }
  });
});
