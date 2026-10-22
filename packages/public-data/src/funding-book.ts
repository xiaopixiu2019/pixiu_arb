/** Only explicit two-sided best quotes qualify; last/mark/impact prices never do. */
export function fundingBook(bidValue: unknown, askValue: unknown, now: number, sourceTime?: unknown): {
  bidPrice?: string; askPrice?: string; bookObservedAt?: string;
} {
  const numeric = (value: unknown) => typeof value === 'number' || (typeof value === 'string' && value.trim() !== '')
    ? Number(value) : NaN;
  const bid = numeric(bidValue);
  const ask = numeric(askValue);
  if (!Number.isFinite(bid) || !Number.isFinite(ask) || bid <= 0 || ask <= 0 || bid > ask) return {};
  if (sourceTime !== undefined) {
    const time = numeric(sourceTime);
    if (!Number.isFinite(time) || now - time > 30_000 || time - now > 5_000) return {};
  }
  return { bidPrice: String(bid), askPrice: String(ask), bookObservedAt: new Date(now).toISOString() };
}
