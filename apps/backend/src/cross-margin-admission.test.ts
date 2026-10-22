import { describe, expect, it, vi } from 'vitest';
import { readCrossMarginEvidence } from './cross-margin-admission.js';
import type { ReadOnlyCrossExGateway } from './crossex-client.js';
const symbol = 'GATE_FUTURE_BTC_USDT', credentials = { apiKey: 'synthetic', apiSecret: 'synthetic' };
describe('cross margin capability and actual mode are separate', () => {
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
});
