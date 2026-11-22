import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { openDatabase } from './database.js';
import type { PnlBook } from './task-performance-store.js';
import { krakenConversionRate } from './task-performance-conversion-rate.js';
import { TransactionFeeStore } from './transaction-fee-store.js';
import { tradingLedger } from './task-trading-ledger.js';

const row = (id: string, change: string, coin: string, type: string, businessId: string, at = '100'): PnlBook => ({
  id, change, coin, statement_type: type, business_id: businessId, create_time: at, balance: '0', conflict: false,
  exchange_type: coin === 'USD' ? 'KRAKEN' : 'CROSSEX', symbol: type === 'FUNDING_FEE' ? 'KRAKEN_FUTURE_XMR_USD' : '',
});

describe('exact Kraken conversion rate evidence', () => {
  it('values a same-time funding debit from its exact opposite USD conversion leg', () => {
    const funding = row('funding', '-0.29734873', 'USD', 'FUNDING_FEE', 'position_1');
    const usd = row('usd', '0.29734873', 'USD', 'KRAKEN_CONVERSION', 'conversion');
    const usdt = row('usdt', '-0.29793567', 'USDT', 'KRAKEN_CONVERSION', 'conversion');
    expect(krakenConversionRate(funding, [funding, usd, usdt])).toBe('1.0019739112388339442');
    expect(krakenConversionRate(usd, [funding, usd, usdt])).toBe('1.0019739112388339442');
  });
  it('rejects unmatched, same-direction, cross-time, or ambiguous conversion evidence', () => {
    const funding = row('funding', '-0.4', 'USD', 'FUNDING_FEE', 'position_1');
    const valid = [row('usd', '0.4', 'USD', 'KRAKEN_CONVERSION', 'a'), row('usdt', '-0.401', 'USDT', 'KRAKEN_CONVERSION', 'a')];
    expect(krakenConversionRate(funding, [funding, valid[0], {...valid[1], change:'0.401'}])).toBeNull();
    expect(krakenConversionRate(funding, [funding, valid[0], {...valid[1], create_time:'101'}])).toBeNull();
    expect(krakenConversionRate(funding, [funding, ...valid, row('usd-2','0.4','USD','KRAKEN_CONVERSION','b'),row('usdt-2','-0.402','USDT','KRAKEN_CONVERSION','b')])).toBeNull();
    expect(krakenConversionRate({...funding, change:'-0.3'}, [funding, ...valid])).toBeNull();
  });
  it('supplies the exact fallback to task cashflows and nets the paired account conversion', () => {
    const db = openDatabase(':memory:', fileURLToPath(new URL('../../../migrations/', import.meta.url)));
    try {
      const funding = row('funding', '-0.29734873', 'USD', 'FUNDING_FEE', 'position_1');
      const rows = [funding, row('usd', '0.29734873', 'USD', 'KRAKEN_CONVERSION', 'conversion'),
        row('usdt', '-0.29793567', 'USDT', 'KRAKEN_CONVERSION', 'conversion')];
      const ledger = tradingLedger(rows, [], new TransactionFeeStore(db), 'account');
      expect(ledger.value(funding).rate).toBe('1.0019739112388339442');
      expect(Math.abs(Number(ledger.accountCosts.amount))).toBeLessThan(1e-18);
    } finally { db.close(); }
  });
});
