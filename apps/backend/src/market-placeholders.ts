import type { LiveMarket, MarketDefinition } from './market-hub.js';

const seedPrices: Record<string, number> = {
  BTC: 118420.8, ETH: 3862.14, SOL: 189.42, XRP: 3.0831, DOGE: 0.2394,
  SUI: 3.74, PEPE: 0.0000124, AAVE: 318.2, LINK: 24.16, ARB: 0.824,
};

function symbolOf(venue: LiveMarket['venue'], asset: string): string {
  const quote = (venue === 'KRAKEN' ? 'USD' : venue === 'HYPERLIQUID' || venue === 'DERIBIT' ? 'USDC' : 'USDT');
  return `${venue}_FUTURE_${asset}_${quote}`;
}

/** Placeholder for a dynamically registered market; every field is overwritten by the first ticker push. */
export function pendingMarket(definition: MarketDefinition): LiveMarket {
  const now = new Date().toISOString();
  return {
    symbol: definition.symbol, venue: definition.venue, asset: definition.asset,
    lastPrice: '0', bidPrice: '0', bidSize: '0', askPrice: '0', askSize: '0',
    open24h: '0', high24h: '0', low24h: '0', volume24h: '0', quoteVolume24h: '0',
    fundingRate: '0', nextFundingAt: new Date(Date.now() + 8 * 60 * 60_000).toISOString(),
    openInterest: '0', openInterestValue: '0', receivedAt: now, updatedAt: now, source: 'demo_seed',
  };
}

export function seedMarket(venue: LiveMarket['venue'], asset: string, venueIndex: number, assetIndex: number): LiveMarket {
  const mid = seedPrices[asset] ?? 1;
  const venueOffset = (venueIndex - 3) * mid * 0.000018;
  const last = mid + venueOffset;
  const spread = Math.max(last * 0.000002, 0.0000001);
  const funding = ((assetIndex % 4) - 1.2 + venueIndex * 0.17) * 0.000012;
  const oiValue = Math.max(1_000_000, 4_820_000_000 / (assetIndex + 1) / (venueIndex + 1));
  const now = new Date().toISOString();
  return {
    symbol: symbolOf(venue, asset), venue, asset, lastPrice: String(last), bidPrice: String(last - spread),
    bidSize: '0', askPrice: String(last + spread), askSize: '0', open24h: String(last * 0.98),
    high24h: String(last * 1.02), low24h: String(last * 0.96), volume24h: '0', quoteVolume24h: String(oiValue * 0.72),
    fundingRate: String(funding), nextFundingAt: new Date(Date.now() + 8 * 60 * 60_000).toISOString(),
    openInterest: '0', openInterestValue: String(oiValue), receivedAt: now, updatedAt: now, source: 'demo_seed',
  };
}
