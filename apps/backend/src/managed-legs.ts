import type { CreateStrategyInput } from './trading-runtime.js';
import type { ManagedLeg } from './managed-position-model.js';
import { nativeMarketAsset } from './market-asset-aliases.js';
export function managedLegs(config: CreateStrategyInput): [ManagedLeg, ManagedLeg] {
  const symbol = (venue: string, asset: string) => `${venue}_FUTURE_${nativeMarketAsset(venue, 'FUTURE', asset)}_${venue === 'KRAKEN' ? 'USD' : ['DERIBIT', 'HYPERLIQUID'].includes(venue) ? 'USDC' : 'USDT'}`;
  return [{ symbol: symbol(config.leftVenue, config.asset), side: config.leftSide },
    { symbol: symbol(config.rightVenue, config.kind === 'premium' ? config.hedgeAsset ?? config.asset : config.asset), side: config.rightSide }];
}
