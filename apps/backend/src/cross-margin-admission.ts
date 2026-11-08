import { GateApiError, type ReadOnlyCrossExGateway } from './crossex-client.js';
import type { GateCredentials } from './credential-vault.js';

export interface AdmissionReadFailure {
  kind: 'authentication' | 'timeout' | 'cancelled' | 'rate_limit' | 'service_unavailable' | 'invalid_response' | 'network' | 'unknown';
  stage: string; symbol?: string; statusCode?: number;
}
/** Diagnostics only: never copy remote bodies, credentials or arbitrary exception messages. */
export function admissionReadFailure(error: unknown, stage: string, symbol?: string, signal?: AbortSignal): AdmissionReadFailure {
  let kind: AdmissionReadFailure['kind'] = 'unknown';
  if (error instanceof GateApiError) {
    if ([401, 403].includes(error.statusCode)) kind = 'authentication';
    else if (error.statusCode === 429) kind = 'rate_limit';
    else if (error.statusCode >= 500) kind = 'service_unavailable';
    else if (error.label === 'REQUEST_TIMEOUT') kind = 'timeout';
    else if (error.label === 'REQUEST_ABORTED') kind = signal?.reason instanceof Error && signal.reason.name === 'TimeoutError' ? 'timeout' : 'cancelled';
    else if (error.label.startsWith('INVALID_')) kind = 'invalid_response';
    else if (error.label === 'NETWORK_ERROR') kind = 'network';
  } else if (error instanceof Error) {
    if (error.name === 'TimeoutError') kind = 'timeout';
    else if (error.name === 'AbortError') kind = 'cancelled';
  }
  return { kind, stage, ...(symbol ? { symbol } : {}), ...(error instanceof GateApiError ? { statusCode: error.statusCode } : {}) };
}
export interface CrossMarginEvidence { symbol: string; supportCross: boolean | null; mode: 'CROSS' | 'ISOLATED' | null;
  checkedAt: number; reason: string | null; failure?: AdmissionReadFailure }
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
    } catch (error) { return { symbol, supportCross, mode: null, checkedAt: Date.now(), reason: 'cross_margin_mode_unknown',
      failure: admissionReadFailure(error, 'margin_mode', symbol, signal) }; }
  }));
}
