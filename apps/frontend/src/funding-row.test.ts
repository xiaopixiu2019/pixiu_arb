import { describe, expect, it } from 'vitest';
import { fundingOpenInterest, retainFundingRows, type FundingPairRow } from './funding-row.js';

const row: FundingPairRow = {
  asset: 'BTC',
  name: 'Bitcoin',
  icon: 'B',
  assetClass: 'CRYPTO_BLUE_CHIP',
  rates: [null, null, null],
  rates8h: [null, null, null],
  intervalHours: [null, null, null],
  symbols: [null, null, null],
  listed: [true, true, true],
  oiValues: [12_000_000, null, 6_000_000],
  oi: 18_000_000,
  avgOi: 9_000_000,
  oiVenues: 2,
};

describe('funding open-interest scope', () => {
  it('uses only selected exchanges that report positive OI', () => {
    expect(fundingOpenInterest(row, [{ index: 0 }, { index: 1 }])).toEqual({
      oi: 12_000_000,
      avgOi: 12_000_000,
      oiVenues: 1,
    });
  });

  it('returns zero metrics when selected exchanges report no OI', () => {
    expect(fundingOpenInterest(row, [{ index: 1 }])).toEqual({ oi: 0, avgOi: 0, oiVenues: 0 });
  });
});

describe('applied ranking membership', () => {
  it('retains rank and membership through OI threshold crossings while taking live values', () => {
    const second = { ...row, asset: 'ETH' };
    const updated = { ...row, avgOi: 1, rates: [0.2, null, null] };
    const newAsset = { ...row, asset: 'SOL' };
    const result = retainFundingRows([row, second], [newAsset, second, updated]);
    expect(result.map((item) => item.asset)).toEqual(['BTC', 'ETH']);
    expect(result[0]).toBe(updated);
    expect(row.avgOi).toBe(9_000_000);
  });

  it('clears every actionable or financial field when an applied asset disappears', () => {
    const removed = { ...row, rates: [1, 2, 3], rates8h: [1, 2, 3], symbols: ['old', 'old', 'old'] };
    const [placeholder] = retainFundingRows([removed], []);
    expect(placeholder.asset).toBe('BTC');
    expect(placeholder.rates).toEqual([null, null, null]);
    expect(placeholder.rates8h).toEqual([null, null, null]);
    expect(placeholder.symbols).toEqual([null, null, null]);
    expect(placeholder.listed).toEqual([false, false, false]);
    expect(placeholder.oiValues).toEqual([null, null, null]);
    expect(placeholder.oiVenues).toBe(0);
    expect(placeholder.referenceQuotes).toEqual([]);
    expect(placeholder.priceSnapshot).toBeUndefined();
  });
});
