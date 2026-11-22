import { Decimal } from 'decimal.js';
import type { PnlBook } from './task-performance-store.js';

/** Use only the exact same-time Kraken USD conversion that offsets a funding bill. */
export function krakenConversionRateResolver(rows: PnlBook[]): (row: PnlBook) => string | null {
  const groups = new Map<string, PnlBook[]>();
  for (const row of rows.filter(r => r.statement_type === 'KRAKEN_CONVERSION' && !r.symbol && r.business_id))
    groups.set(row.business_id, [...(groups.get(row.business_id) ?? []), row]);
  const conversionRates = new Map<string, string>(), fundingRates = new Map<string, string | null>();
  for (const pair of groups.values()) {
    if (pair.length !== 2 || pair.some(r => r.conflict)) continue;
    const usd = pair.find(r => r.coin === 'USD' && r.exchange_type === 'KRAKEN');
    const usdt = pair.find(r => r.coin === 'USDT' && r.exchange_type === 'CROSSEX');
    if (!usd || !usdt || usd.create_time !== usdt.create_time) continue;
    try {
      const usdChange = new Decimal(usd.change), usdtChange = new Decimal(usdt.change);
      if (!usdChange.isFinite() || usdChange.isZero() || !usdtChange.isFinite() || usdChange.mul(usdtChange).gte(0)) continue;
      const rate = usdtChange.div(usdChange).abs().toFixed(), key = `${usd.create_time}:${usdChange.negated().toFixed()}`;
      conversionRates.set(usd.id, rate); fundingRates.set(key, fundingRates.has(key) ? null : rate);
    } catch { /* Invalid financial evidence remains unavailable. */ }
  }
  return row => {
    if (row.conflict || row.coin !== 'USD' || row.exchange_type !== 'KRAKEN') return null;
    if (row.statement_type === 'KRAKEN_CONVERSION') return conversionRates.get(row.id) ?? null;
    if (row.statement_type !== 'FUNDING_FEE') return null;
    try { return fundingRates.get(`${row.create_time}:${new Decimal(row.change).toFixed()}`) ?? null; }
    catch { return null; }
  };
}

export function krakenConversionRate(row: PnlBook, rows: PnlBook[]): string | null {
  return krakenConversionRateResolver(rows)(row);
}
