import { canonicalMarketAsset } from '@gate-crossex/shared-types';

const PREMIUM_PAIR_ASSETS = new Set(['SKHY', 'SKHYNIX']);

export function canonicalPositionAsset(asset: string, venue: string): string {
  return canonicalMarketAsset(venue, 'FUTURE', asset);
}

/** SKHY (ADR) and SKHYNIX (local listing) form one premium-strategy position group. */
export function positionGroupKey(asset: string, venue: string): string {
  const canonicalAsset = canonicalPositionAsset(asset, venue);
  return PREMIUM_PAIR_ASSETS.has(canonicalAsset) ? 'SKHY-SKHYNIX' : canonicalAsset;
}

export function positionGroupLabel(assets: readonly string[]): string {
  const uniqueAssets = new Set(assets);
  return uniqueAssets.has('SKHY') && uniqueAssets.has('SKHYNIX')
    ? 'SKHY / SKHYNIX'
    : assets[0] ?? '';
}
