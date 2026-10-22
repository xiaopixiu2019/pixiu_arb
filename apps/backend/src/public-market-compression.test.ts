import Fastify from 'fastify';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { acceptsGzip, compressPublicMarketResponse } from './public-market-compression.js';

describe('public market response compression', () => {
  it.each([[undefined, false], ['gzip', true], ['br, gzip;q=0.5', true], ['gzip;q=0, *;q=1', false],
    ['*;q=0.5', true], ['gzip;q=broken', false], ['gzip;q=1.1', false], ['GZIP; Q=1', true]] as const)('negotiates %s', (header, accepted) => {
    expect(acceptsGzip(header)).toBe(accepted);
  });
  it('preserves every public JSON byte, varies by encoding, and excludes credentials/account/write routes', async () => {
    const app = Fastify(); app.addHook('onSend', compressPublicMarketResponse);
    const data = { rows: Array.from({ length: 1000 }, (_, i) => ({ symbol: `GATE_FUTURE_TEST${i}_USDT`, rate: '0.00125' })) };
    for (const url of ['/api/markets/funding-overview', '/api/crossex/portfolio-snapshot', '/secure/credentials']) app.get(url, async () => data);
    app.post('/api/markets/funding-overview', async () => data);
    try {
      const plain = await app.inject('/api/markets/funding-overview');
      const compressed = await app.inject({ method: 'GET', url: '/api/markets/funding-overview?symbols=GATE_FUTURE_TEST1_USDT', headers: { 'accept-encoding': 'gzip' } });
      expect(compressed.headers['content-encoding']).toBe('gzip');
      expect(compressed.headers.vary).toContain('Accept-Encoding'); expect(plain.headers.vary).toContain('Accept-Encoding');
      expect(gunzipSync(compressed.rawPayload).equals(plain.rawPayload)).toBe(true);
      expect(compressed.rawPayload.byteLength).toBeLessThan(plain.rawPayload.byteLength / 5);
      const refused = await app.inject({ method: 'GET', url: '/api/markets/funding-overview', headers: { 'accept-encoding': 'gzip;q=0' } });
      expect(refused.headers['content-encoding']).toBeUndefined(); expect(refused.json()).toEqual(data);
      for (const url of ['/api/crossex/portfolio-snapshot', '/secure/credentials']) {
        const privateResponse = await app.inject({ method: 'GET', url, headers: { 'accept-encoding': 'gzip' } });
        expect(privateResponse.headers['content-encoding']).toBeUndefined();
      }
      expect((await app.inject({ method: 'POST', url: '/api/markets/funding-overview', headers: { 'accept-encoding': 'gzip' } })).headers['content-encoding']).toBeUndefined();
    } finally { await app.close(); }
  });
});
