import { describe, expect, it } from 'vitest';
import { maximumTransferAmount } from './transfer-amount.js';
import { transferAccountsFor, transferFeeForRoute } from './transfer-rules.js';
import { marginRatePercent } from './portfolio-metrics.js';

describe('portfolio margin rates', () => {
  it('converts Gate account ratios to displayed percentages', () => {
    expect(marginRatePercent('2.4')).toBe(240);
    expect(marginRatePercent('1')).toBe(100);
    expect(marginRatePercent('')).toBeNull();
    expect(marginRatePercent('-1')).toBeNull();
  });
});

describe('maximumTransferAmount', () => {
  it('preserves whole amounts and truncates fractional excess without rounding above the balance', () => {
    expect(maximumTransferAmount('100', 8)).toBe('100');
    expect(maximumTransferAmount('4.856863219', 8)).toBe('4.85686321');
    expect(maximumTransferAmount('4.85000000', 8)).toBe('4.85');
  });

  it('does not offer an amount that becomes zero at the supported precision', () => {
    expect(maximumTransferAmount('0.000000009', 8)).toBeNull();
    expect(maximumTransferAmount('not-a-balance', 8)).toBeNull();
  });
});

describe('transferAccountsFor', () => {
  it('offers every documented explicit venue for USDC while excluding generic CrossEx and Kraken', () => {
    expect(transferAccountsFor('USDC', 'CROSS_EXCHANGE')).toEqual([
      'SPOT',
      'CROSSEX_BINANCE',
      'CROSSEX_OKX',
      'CROSSEX_GATE',
      'CROSSEX_BYBIT',
      'CROSSEX_HYPERLIQUID',
      'CROSSEX_DERIBIT',
    ]);
  });

  it('keeps unsupported venue/currency combinations out of the selectors', () => {
    expect(transferAccountsFor('BTC', 'ISOLATED_EXCHANGE')).not.toContain('CROSSEX_KRAKEN');
    expect(transferAccountsFor('BTC', 'ISOLATED_EXCHANGE')).not.toContain('CROSSEX_HYPERLIQUID');
    expect(transferAccountsFor('USDT', 'CROSS_EXCHANGE')).toEqual(['SPOT', 'CROSSEX']);
  });
});

describe('transferFeeForRoute', () => {
  it('uses the venue-specific USDC withdrawal fees when Gate Spot is the destination', () => {
    expect(transferFeeForRoute('USDC', 'CROSSEX_BINANCE', 'SPOT', '99')).toBe('0.6');
    expect(transferFeeForRoute('USDC', 'CROSSEX_OKX', 'SPOT', '99')).toBe('0.17');
    expect(transferFeeForRoute('USDC', 'CROSSEX_BYBIT', 'SPOT', '99')).toBe('0.8');
    expect(transferFeeForRoute('USDC', 'CROSSEX_GATE', 'SPOT', '99')).toBe('0.999');
    expect(transferFeeForRoute('USDC', 'CROSSEX_HYPERLIQUID', 'SPOT', '99')).toBe('1');
    expect(transferFeeForRoute('USDC', 'CROSSEX_DERIBIT', 'SPOT', '99')).toBe('5');
  });

  it('keeps the Gate API estimate for other assets and transfer directions', () => {
    expect(transferFeeForRoute('USDC', 'SPOT', 'CROSSEX_BINANCE', '0.25')).toBe('0.25');
    expect(transferFeeForRoute('USDT', 'CROSSEX_BINANCE', 'SPOT', '0.4')).toBe('0.4');
  });
});
