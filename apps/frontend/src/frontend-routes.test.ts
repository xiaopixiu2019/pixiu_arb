import { describe, expect, it } from 'vitest';
import { frontendPath, frontendRoute, type FrontendRoute } from './frontend-routes.js';

describe('frontend routes', () => {
  it('redirects the retired page to the canonical asset view', () => {
    expect(frontendPath(frontendRoute('/position-management')!)).toBe('/portfolio');
  });
  const routes: FrontendRoute[] = [
    { workspace: 'Trade' },
    { workspace: 'Strategy', strategyKind: 'position' },
    { workspace: 'Strategy', strategyKind: 'auto' },
    { workspace: 'Strategy', strategyKind: 'premium' },
    { workspace: 'Strategy', strategyKind: 'boros' },
    { workspace: 'Funding Rates', asset: null },
    { workspace: 'Funding Rates', asset: 'BTC' },
    { workspace: 'Portfolio' },
    { workspace: 'Risk Management' },
    { workspace: 'Trading Fees' },
  ];

  it.each(routes)('round-trips $workspace pages through the URL', (route) => {
    expect(frontendRoute(frontendPath(route))).toEqual(route);
  });

  it('accepts trailing slashes and normalizes funding assets', () => {
    expect(frontendRoute('/portfolio/')).toEqual({ workspace: 'Portfolio' });
    expect(frontendRoute('/funding-rates/eth/')).toEqual({ workspace: 'Funding Rates', asset: 'ETH' });
  });

  it('does not claim unknown or backend paths', () => {
    expect(frontendRoute('/unknown')).toBeNull();
    expect(frontendRoute('/api/system/discovery')).toBeNull();
    expect(frontendRoute('/funding-rates/not%2Fan%2Fasset')).toBeNull();
  });
});
