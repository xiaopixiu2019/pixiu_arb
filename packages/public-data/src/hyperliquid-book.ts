import { z } from 'zod';
import { fundingBook } from './funding-book.js';

const positive = z.string().refine((value) => Number.isFinite(Number(value)) && Number(value) > 0);
const LevelSchema = z.object({ px: positive, sz: positive });
const BookSchema = z.object({ coin: z.string(), time: z.number(), levels: z.tuple([z.array(LevelSchema).max(20), z.array(LevelSchema).max(20)]) });

async function boundedPayload(response: Response): Promise<unknown> {
  const maximum = 100_000;
  if (Number(response.headers.get('content-length')) > maximum) {
    await response.body?.cancel(); throw new Error('REFERENCE_BOOK_TOO_LARGE');
  }
  if (!response.body) throw new Error('INVALID_REFERENCE_BOOK');
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let bytes = 0, text = '';
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > maximum) { await reader.cancel(); throw new Error('REFERENCE_BOOK_TOO_LARGE'); }
      text += decoder.decode(chunk.value, { stream: true });
    }
    return JSON.parse(text + decoder.decode());
  } finally { reader.releaseLock(); }
}

/** Public read only; the coin has already been resolved against native metadata. */
export async function readHyperliquidBook(fetcher: typeof fetch, coin: string, now: () => number) {
  const response = await fetcher('https://api.hyperliquid.xyz/info', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'l2Book', coin }), signal: AbortSignal.timeout(8_000), redirect: 'error',
  });
  if (!response.ok) throw new Error('REFERENCE_BOOK_UNAVAILABLE');
  const book = BookSchema.parse(await boundedPayload(response));
  const bid = book.levels[0][0];
  const ask = book.levels[1][0];
  if (book.coin !== coin || !bid || !ask || !(Number(bid.sz) > 0) || !(Number(ask.sz) > 0)) throw new Error('INVALID_REFERENCE_BOOK');
  const result = fundingBook(bid.px, ask.px, now(), book.time);
  if (!result.bidPrice || !result.askPrice) throw new Error('INVALID_REFERENCE_BOOK');
  return result;
}
