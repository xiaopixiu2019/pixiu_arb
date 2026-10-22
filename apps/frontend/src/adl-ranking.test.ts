import { describe, expect, it } from 'vitest';
import { adlRiskTone, crossExAdlLightLevel, exchangeAdlLightLevel } from './adl-ranking.js';

describe('ADL light normalization', () => {
  it('normalizes each documented venue scale so more lights consistently means higher risk', () => {
    expect(exchangeAdlLightLevel('BINANCE', '0')).toBe(1);
    expect(exchangeAdlLightLevel('BINANCE', '4')).toBe(5);
    expect(exchangeAdlLightLevel('OKX', '5')).toBe(5);
    expect(exchangeAdlLightLevel('BYBIT', '0')).toBe(0);
    expect(exchangeAdlLightLevel('GATE', '1')).toBe(5);
    expect(exchangeAdlLightLevel('GATE', '5')).toBe(1);
    expect(exchangeAdlLightLevel('KRAKEN', '20')).toBe(5);
    expect(exchangeAdlLightLevel('KRAKEN', '100')).toBe(1);
  });

  it('rejects undocumented venue scales and malformed CrossEx ranks', () => {
    expect(exchangeAdlLightLevel('HYPERLIQUID', '4')).toBeNull();
    expect(exchangeAdlLightLevel('BINANCE', '5')).toBeNull();
    expect(crossExAdlLightLevel('5')).toBe(5);
    expect(crossExAdlLightLevel('0')).toBeNull();
    expect(crossExAdlLightLevel('not-a-rank')).toBeNull();
  });

  it('colors low risk green, middle risk yellow, and high risk red', () => {
    expect(adlRiskTone(0)).toBe('safe');
    expect(adlRiskTone(2)).toBe('safe');
    expect(adlRiskTone(3)).toBe('caution');
    expect(adlRiskTone(4)).toBe('danger');
    expect(adlRiskTone(5)).toBe('danger');
    expect(adlRiskTone(null)).toBe('unavailable');
  });
});
