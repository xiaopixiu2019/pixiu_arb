import type { ReadOnlyCrossExGateway } from './crossex-client.js';
import type { GateCredentials } from './credential-vault.js';

export interface CrossMarginEvidence { symbol: string; supportCross: boolean | null; mode: 'CROSS' | 'ISOLATED' | null; checkedAt: number; reason: string | null }
/** Account-bound reads also work before any position exists. No mode writes or probe orders. */
export async function readCrossMarginEvidence(gateway: ReadOnlyCrossExGateway, credentials: GateCredentials,
  symbols: string[], signal?: AbortSignal): Promise<CrossMarginEvidence[]> {
  const catalog = await gateway.querySymbols();
  signal?.throwIfAborted();
  return Promise.all(symbols.map(async (symbol) => {
    const capability = catalog.find(row => row.symbol === symbol)?.support_cross;
    const supportCross = capability === 'true' ? true : capability === 'false' ? false : null;
    if (supportCross !== true) return { symbol, supportCross, mode: null, checkedAt: Date.now(),
      reason: supportCross === false ? 'cross_margin_unsupported' : 'cross_margin_capability_unknown' };
    try {
      const mode = await gateway.queryPositionMarginMode?.(credentials, symbol, signal);
      signal?.throwIfAborted();
      return { symbol, supportCross, mode: mode ?? null, checkedAt: Date.now(),
        reason: mode === 'CROSS' ? null : mode === 'ISOLATED' ? 'cross_margin_mode_isolated' : 'cross_margin_mode_unknown' };
    } catch { return { symbol, supportCross, mode: null, checkedAt: Date.now(), reason: 'cross_margin_mode_unknown' }; }
  }));
}
