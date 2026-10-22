import { z } from 'zod';
import { Decimal } from 'decimal.js';

const RECENT_USDT_USD = 'https://api.kraken.com/0/public/Trades?pair=USDTUSD&count=1';
const TradesSchema = z.object({ error: z.array(z.string()), result: z.object({
  USDTZUSD: z.array(z.tuple([z.string(), z.string(), z.number()]).rest(z.unknown())).min(1),
}) });

/** A fresh public USD-per-USDT trade is inverted; never assume fiat/stablecoin parity. */
export async function queryUsdValuation(fetchImplementation: typeof fetch, now: () => number, signal?: AbortSignal): Promise<string | null> {
  try {
    signal?.throwIfAborted();
    const response = await fetchImplementation(RECENT_USDT_USD, {
      headers: { Accept: 'application/json' }, redirect: 'error',
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(6000)]) : AbortSignal.timeout(6000),
    });
    if (!response.ok) return null;
    const parsed = TradesSchema.safeParse(await response.json());
    if (!parsed.success || parsed.data.error.length) return null;
    const [price, , seconds] = parsed.data.result.USDTZUSD.at(-1)!;
    const age = now() - seconds * 1000, usdPerUsdt = new Decimal(price);
    if (!usdPerUsdt.isFinite() || !usdPerUsdt.gt(0) || age < 0 || age > 90_000) return null;
    return new Decimal(1).div(usdPerUsdt).toString();
  } catch (error) {
    // A missing optional rate is surfaced by valueBalances as missing_fx, never zero/parity.
    if (signal?.aborted) throw error;
    return null;
  }
}
