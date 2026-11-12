import { describe, expect, it, vi } from 'vitest';
import { readCrossMarginEvidence } from './cross-margin-admission.js';
import { GateApiError, GateCrossExClient, type ReadOnlyCrossExGateway } from './crossex-client.js';
const symbol = 'GATE_FUTURE_BTC_USDT', credentials = { apiKey: 'synthetic', apiSecret: 'synthetic' };
describe('cross margin capability and actual mode are separate', () => {
  it('gives the mode read its own bounded stage after a slow successful catalog', async () => {
    vi.useFakeTimers();
    try {
      const reads: Promise<unknown>[] = [];
      const gateway = { querySymbols: () => new Promise(resolve => setTimeout(() => resolve([{symbol,support_cross:'true'}]),3500)),
        queryPositionMarginMode: () => new Promise(resolve => setTimeout(() => resolve('CROSS'),600)) } as unknown as ReadOnlyCrossExGateway;
      const result = readCrossMarginEvidence(gateway,credentials,[symbol],undefined,{deadline:Date.now()+10000,track:r=>reads.push(...r)});
      await vi.advanceTimersByTimeAsync(4100);
      expect(await result).toMatchObject([{mode:'CROSS',reason:null}]); expect(reads).toHaveLength(2);
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });
  it('caps each stage by the remaining total deadline and retains ownership of uncancellable reads', async () => {
    vi.useFakeTimers();
    try {
      const reads: Promise<unknown>[] = []; let release!: () => void;
      const gateway = { querySymbols: () => new Promise(resolve => { release=()=>resolve([{symbol,support_cross:'true'}]); }),
        queryPositionMarginMode: vi.fn() } as unknown as ReadOnlyCrossExGateway;
      const result=readCrossMarginEvidence(gateway,credentials,[symbol],undefined,{deadline:Date.now()+2500,track:r=>reads.push(...r)})
        .then(()=>null,error=>error);
      await vi.advanceTimersByTimeAsync(2500); expect(await result).toMatchObject({name:'TimeoutError'});
      let settled=false; void Promise.allSettled(reads).then(()=>{settled=true;}); await Promise.resolve();
      expect(settled).toBe(false); expect(gateway.queryPositionMarginMode).not.toHaveBeenCalled();
      release(); await Promise.allSettled(reads); expect(settled).toBe(true); expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });
  it.each([['false', false, 'cross_margin_unsupported'], [undefined, null, 'cross_margin_capability_unknown'],
    ['bad', null, 'cross_margin_capability_unknown']])('fails closed for capability %s', async (support_cross, supportCross, reason) => {
    const mode = vi.fn(async () => 'CROSS');
    const gateway = { querySymbols: async () => [{ symbol, support_cross }], queryPositionMarginMode: mode } as unknown as ReadOnlyCrossExGateway;
    expect(await readCrossMarginEvidence(gateway, credentials, [symbol])).toMatchObject([{ supportCross, reason }]);
    expect(mode).not.toHaveBeenCalled();
  });
  it.each(['CROSS', 'ISOLATED'])('queries actual %s mode without a position or a write', async (mode) => {
    const gateway = { querySymbols: async () => [{ symbol, support_cross: 'true' }], queryPositionMarginMode: async () => mode } as unknown as ReadOnlyCrossExGateway;
    expect(await readCrossMarginEvidence(gateway, credentials, [symbol])).toMatchObject([{ mode, reason: mode === 'CROSS' ? null : 'cross_margin_mode_isolated' }]);
  });
  it('does not infer cross mode from failed reads', async () => {
    const gateway = { querySymbols: async () => [{ symbol, support_cross: 'true' }], queryPositionMarginMode: async () => { throw Error('offline'); } } as unknown as ReadOnlyCrossExGateway;
    expect(await readCrossMarginEvidence(gateway, credentials, [symbol])).toMatchObject([{ mode: null, reason: 'cross_margin_mode_unknown' }]);
  });
  it.each([
    [new GateApiError(403, 'FORBIDDEN'), 'authentication'],
    [new GateApiError(0, 'REQUEST_TIMEOUT'), 'timeout'],
    [new GateApiError(200, 'INVALID_MARGIN_MODE_RESPONSE'), 'invalid_response'],
    [new GateApiError(0, 'NETWORK_ERROR'), 'network'],
    [new Error('secret must never enter diagnostics'), 'unknown'],
  ])('preserves the bounded failure category without changing the rejection verdict: %s', async (error, kind) => {
    const gateway = { querySymbols: async () => [{ symbol, support_cross: 'true' }],
      queryPositionMarginMode: async () => { throw error; } } as unknown as ReadOnlyCrossExGateway;
    const evidence = await readCrossMarginEvidence(gateway, credentials, [symbol]);
    expect(evidence).toMatchObject([{ mode: null, reason: 'cross_margin_mode_unknown',
      failure: { kind, stage: 'margin_mode', symbol } }]);
    expect(JSON.stringify(evidence)).not.toContain('secret must never enter diagnostics');
  });
  it.each(['TimeoutError', 'AbortError'])('preserves %s through the real client REQUEST_ABORTED path', async name => {
    let dispatched!: () => void;
    const started = new Promise<void>(resolve => { dispatched = resolve; });
    const client = new GateCrossExClient(async (_url, options) => new Promise<Response>((_resolve, reject) => {
      options?.signal?.addEventListener('abort', () => reject(options.signal?.reason), { once: true });
      dispatched();
    }));
    const controller = new AbortController();
    const gateway = { querySymbols: async () => [{ symbol, support_cross: 'true' }],
      queryPositionMarginMode: client.queryPositionMarginMode.bind(client) } as unknown as ReadOnlyCrossExGateway;
    const reading = readCrossMarginEvidence(gateway, credentials, [symbol], controller.signal);
    await started; controller.abort(new DOMException('synthetic', name));
    expect(await reading).toMatchObject([{ reason: 'cross_margin_mode_unknown',
      failure: { kind: name === 'TimeoutError' ? 'timeout' : 'cancelled', stage: 'margin_mode', symbol } }]);
  });
});
