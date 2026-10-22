/** CrossEx tick + Hyperliquid's five significant digits (integer prices are exempt). */
type PriceErrorCode = 'hyperliquid_price_rules_unavailable' | 'hyperliquid_limit_price_invalid';
export class HyperliquidPriceError extends Error {
  constructor(readonly code: PriceErrorCode) { super(code); this.name = 'HyperliquidPriceError'; }
}
export const isHyperliquidFuture = (symbol: string): boolean => symbol.startsWith('HYPERLIQUID_FUTURE_');

function decimal(value: string | null | undefined, code: PriceErrorCode) {
  if (typeof value !== 'string' || value.length > 128 || !/^\d+(?:\.\d+)?$/.test(value)) throw new HyperliquidPriceError(code);
  const [whole, fraction = ''] = value.split('.');
  const units = BigInt(whole + fraction);
  if (units <= 0n) throw new HyperliquidPriceError(code);
  return { units, scale: fraction.length };
}
const power = (n: number): bigint => 10n ** BigInt(n);
function values(price: string, tick: string | null | undefined) {
  const step = decimal(tick, 'hyperliquid_price_rules_unavailable');
  const value = decimal(price, 'hyperliquid_limit_price_invalid');
  const scale = Math.max(value.scale, step.scale);
  return { price: value.units * power(scale - value.scale), tick: step.units * power(scale - step.scale), scale };
}
function lcm(a: bigint, b: bigint): bigint {
  let x = a, y = b;
  while (y) { const remainder = x % y; x = y; y = remainder; }
  return a / x * b;
}
function plain(value: bigint, scale: number): string {
  const text = value.toString().padStart(scale + 1, '0');
  if (!scale) return text;
  const fraction = text.slice(-scale).replace(/0+$/, '');
  return text.slice(0, -scale) + (fraction ? `.${fraction}` : '');
}

export function assertHyperliquidLimitPrice(price: string, tick: string | null | undefined): void {
  const v = values(price, tick);
  const integer = v.price % power(v.scale) === 0n;
  if (v.price % v.tick !== 0n || !integer && v.price.toString().replace(/0+$/, '').length > 5) {
    throw new HyperliquidPriceError('hyperliquid_limit_price_invalid');
  }
}

/** Nearest legal positive price without crossing the caller's BUY ceiling / SELL floor. */
export function hyperliquidLimitPrice(price: string, tick: string | null | undefined, side: 'BUY' | 'SELL'): string {
  const v = values(price, tick);
  let best: bigint | null = null;
  // Below 10^4 each decade has its own significant-digit grid. Above it, only
  // integers qualify, including the explicitly allowed integers with >5 digits.
  for (let exponent = -v.scale; exponent <= 4; exponent += 1) {
    const low = power(v.scale + exponent);
    const high = exponent === 4 ? null : power(v.scale + exponent + 1) - 1n;
    const step = lcm(v.tick, power(Math.max(0, v.scale + Math.min(0, exponent - 4))));
    const bound = side === 'BUY' ? high !== null && v.price > high ? high : v.price : v.price < low ? low : v.price;
    const candidate = (side === 'BUY' ? bound / step : (bound + step - 1n) / step) * step;
    if (candidate < low || high !== null && candidate > high) continue;
    if (best === null || (side === 'BUY' ? candidate > best : candidate < best)) best = candidate;
  }
  if (best === null) throw new HyperliquidPriceError('hyperliquid_limit_price_invalid');
  const result = plain(best, v.scale);
  assertHyperliquidLimitPrice(result, tick);
  return result;
}
