import { z } from 'zod';
import { Decimal } from 'decimal.js';
import type { LiveMarket } from './market-hub.js';

const TickerSchema = z.object({ channel: z.literal('ticker'), event: z.literal('update'), result: z.object({
  s: z.string(), lp: z.string(), bp: z.string(), bs: z.string(), ap: z.string(), as: z.string(),
  o: z.string().nullable(), h: z.string().nullable(), l: z.string().nullable(), v: z.string().nullable(),
  q: z.string().nullable().optional(), ts: z.number().finite(),
}) });
const Level = z.tuple([z.string(), z.string()]);
const BookSchema = z.object({ channel: z.enum(['order_book_1', 'order_book_5']), event: z.literal('update'),
  result: z.object({ s: z.string(), ts: z.number().finite(), a: z.array(Level).min(1), b: z.array(Level).min(1) }) });

/** Full snapshots only. Incremental books need sequence reconciliation and are not a BBO fallback. */
export function recoveryBookChannel(symbol: string): 'order_book_1' | 'order_book_5' | null {
  const venue = symbol.split('_')[0];
  if (venue === 'BYBIT') return 'order_book_1';
  if (['BINANCE', 'GATE', 'OKX', 'HYPERLIQUID', 'DERIBIT', 'LIGHTER'].includes(venue)) return 'order_book_5';
  return null;
}

export function parseExecutableQuote(payload: unknown) {
  const ticker = TickerSchema.safeParse(payload);
  if (ticker.success) return { ...ticker.data.result, channel: 'ticker' as const };
  const book = BookSchema.safeParse(payload);
  if (!book.success || book.data.channel !== recoveryBookChannel(book.data.result.s)) return null;
  const value = book.data.result;
  // Reject invalid/empty sides, crossed books and unsorted snapshots, not just an invalid first level.
  const positive = (n: string) => Number.isFinite(Number(n)) && Number(n) > 0;
  const validSide = (levels: string[][], direction: number) => levels.every(([p, q], i) => positive(p) && positive(q)
    && (i === 0 || direction * (Number(p) - Number(levels[i - 1][0])) > 0));
  if (!validSide(value.a, 1) || !validSide(value.b, -1) || Number(value.b[0][0]) > Number(value.a[0][0])) return null;
  return { s: value.s, ts: value.ts, bp: value.b[0][0], bs: value.b[0][1], ap: value.a[0][0], as: value.a[0][1],
    channel: book.data.channel, lp: undefined, o: undefined, h: undefined, l: undefined, v: undefined, q: undefined };
}

export function quoteStatistics(value: NonNullable<ReturnType<typeof parseExecutableQuote>>, current: LiveMarket) {
  const previous = (field: 'lastPrice' | 'open24h' | 'high24h' | 'low24h' | 'volume24h' | 'quoteVolume24h') =>
    current.source === 'demo_seed' ? '0' : current[field];
  return { ...(current.source === 'demo_seed' && !current.openInterestUpdatedAt ? { openInterest: '0', openInterestValue: '0' } : {}),
    ...(current.source === 'demo_seed' && !current.fundingUpdatedAt ? { fundingRate: '', nextFundingAt: '' } : {}),
    lastPrice: value.lp ?? previous('lastPrice'), open24h: value.o ?? previous('open24h'),
    high24h: value.h ?? previous('high24h'), low24h: value.l ?? previous('low24h'),
    volume24h: value.v ?? previous('volume24h'), quoteVolume24h: value.q ?? previous('quoteVolume24h'),
    tickerUpdatedAt: value.channel === 'ticker' ? new Date(value.ts).toISOString() : current.tickerUpdatedAt };
}

export function sameQuote(value: NonNullable<ReturnType<typeof parseExecutableQuote>>, current: LiveMarket): boolean {
  try { return new Decimal(value.bp).eq(current.bidPrice) && new Decimal(value.ap).eq(current.askPrice)
    && new Decimal(value.bs).eq(current.bidSize) && new Decimal(value.as).eq(current.askSize); }
  catch { return false; }
}
