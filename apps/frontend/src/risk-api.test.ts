import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_MARGIN_POLICY } from '@gate-crossex/shared-types';
import { riskApi } from './risk-api.js';
afterEach(() => vi.unstubAllGlobals());
describe('risk requests stay bound to the displayed account', () => {
  it('never clears a different account lock after another window switches the active account', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ accountId: 'B', policy: DEFAULT_MARGIN_POLICY, csrfToken: 'synthetic' })));
    vi.stubGlobal('fetch', fetcher);
    await expect(riskApi.resume('A')).rejects.toThrow('margin_account_changed');
    expect(fetcher).toHaveBeenCalledTimes(1); expect(fetcher.mock.calls[0]?.[0]).toBe('/api/risk/margin/policy');
  });
  it('rejects events that belong to another account', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ accountId: 'B', events: [], hasMore: false }))));
    await expect(riskApi.events('A')).rejects.toThrow('margin_account_changed');
  });
});
