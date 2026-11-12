import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_MARGIN_POLICY } from '@gate-crossex/shared-types';
import { riskApi } from './risk-api.js';
afterEach(() => vi.unstubAllGlobals());
describe('risk requests stay bound to the displayed account', () => {
  it('calibrates risk time through the dedicated non-refreshing clock endpoint',async()=>{
    const fetcher=vi.fn<typeof fetch>(async()=>new Response(JSON.stringify({accountId:'A',serverAt:12345})));
    vi.stubGlobal('fetch',fetcher);const value=await riskApi.clock();
    expect(fetcher).toHaveBeenCalledWith('/api/risk/margin/clock',expect.objectContaining({signal:expect.any(AbortSignal)}));
    expect(value).toMatchObject({accountId:'A',serverAt:12345});expect(value.received).toBeGreaterThanOrEqual(value.sent);
  });
  it('does not PUT a draft when the preflight policy revision changed', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ accountId: 'A', policy: { ...DEFAULT_MARGIN_POLICY, revision: 2 }, csrfToken: 'synthetic' })));
    vi.stubGlobal('fetch', fetcher);
    await expect(riskApi.save(DEFAULT_MARGIN_POLICY, 'A')).rejects.toThrow('margin_policy_conflict');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('checks current frontend authority after the asynchronous token read and before PUT', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ accountId: 'A', policy: DEFAULT_MARGIN_POLICY, csrfToken: 'synthetic' })));
    vi.stubGlobal('fetch', fetcher);
    await expect(riskApi.save(DEFAULT_MARGIN_POLICY, 'A', () => { throw new Error('selection_changed'); })).rejects.toThrow('selection_changed');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
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
