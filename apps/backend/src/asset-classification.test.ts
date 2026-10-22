import { describe, expect, it, vi } from 'vitest';
import type { MarketCatalogVenue } from '@gate-crossex/shared-types';
import {
  BUNDLED_MARKET_CAP_SNAPSHOT,
  CoinGeckoMarketCapProvider,
  classifyFundingAsset,
  type CryptoMarketCapSnapshot,
} from './asset-classification.js';

function venue(venueName = 'GATE'): MarketCatalogVenue {
  return { venue: venueName, symbol: `${venueName}_FUTURE_TEST_USDT`, quote: 'USDT' };
}

function coinGeckoRows(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    id: `coin-${index + 1}`,
    symbol: `c${index + 1}`,
    name: `Coin ${index + 1}`,
    market_cap_rank: index + 1,
  }));
}

describe('funding asset classification', () => {
  const topSymbols = new Set(['BTC', 'ETH', 'SOL']);
  const knownCryptoSymbols = new Set([...topSymbols, 'PEPE', 'QNT']);

  it('classifies equities, ETFs, equity indexes, and Korean listings as stock', () => {
    expect(classifyFundingAsset('AAPL', [venue()], topSymbols)).toBe('STOCK');
    expect(classifyFundingAsset('EWY', [venue('HYPERLIQUID')], topSymbols)).toBe('STOCK');
    expect(classifyFundingAsset('SP500', [venue('HYPERLIQUID')], topSymbols)).toBe('STOCK');
    expect(classifyFundingAsset('SKHYNIX', [venue()], topSymbols)).toBe('STOCK');
  });

  it('gives stock identity precedence over crypto symbol matching', () => {
    expect(classifyFundingAsset('COIN', [venue()], new Set(['COIN']))).toBe('STOCK');
    expect(classifyFundingAsset('QNT', [venue('HYPERLIQUID')], new Set(['QNT']), knownCryptoSymbols)).toBe('STOCK');
    expect(classifyFundingAsset('QNT', [venue('BINANCE')], new Set(['QNT']), knownCryptoSymbols)).toBe('CRYPTO_BLUE_CHIP');
  });

  it('separates top-ranked crypto, altcoins, other markets, and invalid identities', () => {
    expect(classifyFundingAsset('SOL', [venue()], topSymbols, knownCryptoSymbols)).toBe('CRYPTO_BLUE_CHIP');
    expect(classifyFundingAsset('PEPE', [venue()], topSymbols, knownCryptoSymbols)).toBe('CRYPTO_ALTCOIN');
    expect(classifyFundingAsset('GOLD', [venue()], topSymbols, knownCryptoSymbols)).toBe('OTHER');
    expect(classifyFundingAsset('UNKNOWN', [venue()], topSymbols, knownCryptoSymbols)).toBe('UNCLASSIFIED');
    expect(classifyFundingAsset('bad-symbol', [venue()], topSymbols, knownCryptoSymbols)).toBe('UNCLASSIFIED');
  });
});

describe('CoinGecko market-cap provider', () => {
  it('excludes CoinGecko stablecoin-category projects before taking the first 20', async () => {
    const rows = coinGeckoRows(50);
    rows[2] = { ...rows[2], id: 'stable-three', symbol: 'usd3', name: 'USD Three' };
    rows[5] = { ...rows[5], id: 'stable-six', symbol: 'usd6', name: 'USD Six' };
    const fetchMock = vi.fn((input: string | URL | Request) => {
      const url = new URL(String(input));
      const payload = url.searchParams.get('category') === 'stablecoins'
        ? [{ malformed: true }, rows[2], rows[5]]
        : rows;
      return Promise.resolve(new Response(JSON.stringify(payload), { status: 200 }));
    });
    const provider = new CoinGeckoMarketCapProvider(fetchMock as typeof fetch, () => 1_800_000_000_000);

    const result = await provider.load();

    expect(result.status).toBe('fresh');
    expect(result.snapshot.assets).toHaveLength(20);
    expect(result.snapshot.assets.map((asset) => asset.id)).not.toEqual(expect.arrayContaining(['stable-three', 'stable-six']));
    expect(result.snapshot.assets.slice(0, 4).map((asset) => asset.id)).toEqual(['coin-1', 'coin-2', 'coin-4', 'coin-5']);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('reuses a successful result until the four-hour refresh boundary', async () => {
    let clock = 1_800_000_000_000;
    const rows = coinGeckoRows(50);
    const fetchMock = vi.fn((input: string | URL | Request) => {
      const url = new URL(String(input));
      const payload = url.searchParams.get('category') === 'stablecoins'
        ? [{ ...rows[49], id: 'stablecoin', symbol: 'usd', name: 'Stablecoin' }]
        : rows;
      return Promise.resolve(new Response(JSON.stringify(payload), { status: 200 }));
    });
    const provider = new CoinGeckoMarketCapProvider(fetchMock as typeof fetch, () => clock);
    await provider.load();
    clock += 4 * 60 * 60_000 - 1;

    await provider.load();

    expect(fetchMock).toHaveBeenCalledTimes(3);
    clock += 1;
    await provider.load();
    expect(fetchMock).toHaveBeenCalledTimes(6);
  });

  it('falls back to the persisted last-good ranking when refresh fails', async () => {
    const stored: CryptoMarketCapSnapshot = {
      ...BUNDLED_MARKET_CAP_SNAPSHOT,
      fetchedAt: '2026-01-01T00:00:00.000Z',
    };
    const provider = new CoinGeckoMarketCapProvider(
      vi.fn(() => Promise.resolve(new Response('', { status: 429 }))) as typeof fetch,
      () => Date.parse('2026-09-05T08:00:00.000Z'),
      { store: { read: () => stored, write: () => undefined } },
    );

    const result = await provider.load();

    expect(result).toEqual({ snapshot: stored, status: 'stale' });
  });
});
