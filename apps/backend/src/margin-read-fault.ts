import { GateApiError } from './crossex-client.js';

/** Unknown/identity/contract failures require review, not ordinary automatic read recovery. */
export function marginReadFault(error: unknown): { reason: string; fatal: boolean } {
  if (error instanceof GateApiError) {
    const transient = error.statusCode === 429 || error.statusCode >= 500
      || ![401, 403].includes(error.statusCode) && ['NETWORK_ERROR', 'REQUEST_TIMEOUT', 'REQUEST_ABORTED'].includes(error.label);
    return { reason: transient ? 'margin_read_unavailable' : 'margin_account_verification_failed', fatal: !transient };
  }
  const reason = error instanceof Error ? error.message : '';
  if (['margin_read_timeout', 'margin_read_pending', 'margin_data_stale'].includes(reason)) return { reason, fatal: false };
  return { reason: reason.startsWith('margin_') ? reason : 'margin_account_verification_failed', fatal: true };
}
