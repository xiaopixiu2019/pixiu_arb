import { z } from 'zod';

export const ReferenceSymbolSchema = z.string().max(120).regex(/^(GATE|BINANCE|OKX|BYBIT|KRAKEN|HYPERLIQUID|DERIBIT)_FUTURE_[A-Z0-9]+_(USDT|USDC|USD)$/);
export const ReferenceQuoteSchema = z.object({
  symbol: ReferenceSymbolSchema,
  status: z.enum(['ok', 'unavailable']),
  bidPrice: z.string().nullable().optional(),
  askPrice: z.string().nullable().optional(),
  bookObservedAt: z.iso.datetime().nullable().optional(),
  fetchedAt: z.iso.datetime(),
  reason: z.enum(['missing_book', 'venue_unavailable', 'unknown_contract', 'unsupported', 'busy', 'timeout']).optional(),
});
export type ReferenceQuote = z.infer<typeof ReferenceQuoteSchema>;
export const ReferenceQuotesResponseSchema = z.object({ entries: z.array(ReferenceQuoteSchema).max(100), fetchedAt: z.iso.datetime() });
export type ReferenceQuotesResponse = z.infer<typeof ReferenceQuotesResponseSchema>;
