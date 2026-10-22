import { describe, expect, it } from 'vitest';
import { GateCrossExClient } from './crossex-client.js';

const credentials = { apiKey: 'synthetic', apiSecret: 'synthetic' };
const order = { symbol: 'DERIBIT_FUTURE_HYPE_USDC', side: 'BUY' as const, type: 'MARKET' as const,
  time_in_force: 'IOC' as const, qty: '1', reduce_only: 'false' as const, text: 'synthetic-order' };
describe('actual CrossEx dispatch boundary', () => {
  it('lets a failed write reach the caller risk guard before dispatching a queued write', async () => {
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; }); let calls = 0, allowed = true;
    const client = new GateCrossExClient(async () => {
      calls++;
      if (calls === 1) { await held; throw new Error('synthetic response lost'); }
      return new Response(JSON.stringify({ order_id: 'synthetic-2', text: order.text }));
    }, Date.now, 'https://synthetic.invalid/api/v4', 0);
    const first = client.createOrder(credentials, order).catch(error => { allowed = false; throw error; });
    const firstFailure = expect(first).rejects.toThrow();
    const second = client.createOrder(credentials, order, () => { if (!allowed) throw new Error('unknown_previous_write'); });
    const secondBlocked = expect(second).rejects.toThrow('unknown_previous_write');
    release(); await Promise.all([firstFailure, secondBlocked]); expect(calls).toBe(1);
  });
  it('checks revoked authority after a queued write reaches dispatch, without sending or retrying it', async () => {
    let release!: () => void; const held = new Promise<void>(r => { release = r; }); let calls = 0, allowed = true;
    const client = new GateCrossExClient(async () => {
      calls++; if (calls === 1) await held;
      return new Response(JSON.stringify({ order_id: 'synthetic', text: order.text }));
    }, Date.now, 'https://synthetic.invalid/api/v4', 0);
    const first = client.createOrder(credentials, order);
    const second = client.createOrder(credentials, order, () => { if (!allowed) throw new Error('authority_revoked'); });
    const rejected = expect(second).rejects.toThrow('authority_revoked');
    allowed = false; release(); await first; await rejected; expect(calls).toBe(1);
  });
  it('also revalidates queued cancellation at actual dispatch', async () => {
    let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; }); const methods: string[] = [];
    const client = new GateCrossExClient(async (_input, init) => {
      methods.push(init!.method!); await held;
      return new Response(JSON.stringify({ order_id: 'synthetic', text: order.text }));
    }, Date.now, 'https://synthetic.invalid/api/v4', 0);
    const first = client.createOrder(credentials, order);
    const cancellation = client.cancelOrder(credentials, 'original', () => { throw new Error('cancel_authority_revoked'); });
    const rejected = expect(cancellation).rejects.toThrow('cancel_authority_revoked');
    release(); await first; await rejected; expect(methods).toEqual(['POST']);
  });
  it('keeps writes serial through response-body verification rather than releasing on headers', async () => {
    let body!: ReadableStreamDefaultController<Uint8Array>; let calls = 0;
    const client = new GateCrossExClient(async () => {
      calls++;
      return calls === 1 ? new Response(new ReadableStream<Uint8Array>({ start(c) { body = c; } }))
        : new Response(JSON.stringify({ order_id: 'synthetic-2', text: order.text }));
    }, Date.now, 'https://synthetic.invalid/api/v4', 0);
    const first = client.createOrder(credentials, order), second = client.createOrder(credentials, order);
    await new Promise(r => setTimeout(r, 20)); expect(calls).toBe(1);
    body.enqueue(new TextEncoder().encode(JSON.stringify({ order_id: 'synthetic-1', text: order.text }))); body.close();
    await Promise.all([first, second]); expect(calls).toBe(2);
  });
  it('does not put the hedge behind an in-flight leverage read', async () => {
    let release!: () => void;
    const held = new Promise<void>(r => { release = r; }); const calls: string[] = [];
    const client = new GateCrossExClient(async input => {
      const path = new URL(String(input)).pathname; calls.push(path);
      if (path.endsWith('/leverage')) { await held; return new Response(JSON.stringify({ [order.symbol]: '25' })); }
      return new Response(JSON.stringify({ order_id: 'synthetic', text: order.text }));
    }, Date.now, 'https://synthetic.invalid/api/v4', 0);
    const read = client.queryLeverages(credentials, [order.symbol]);
    await new Promise(r => setTimeout(r, 5));
    const hedge = client.createOrder(credentials, order);
    try {
      await new Promise(r => setTimeout(r, 30));
      expect(calls).toContain('/api/v4/crossex/orders');
    } finally { release(); await Promise.all([read, hedge]); }
  });
});
