/** A UI default only: preserve decimal precision; existing venue validation remains authoritative. */
export function halfOrderQuantity(total: string): string {
  if (!/^\d+(?:\.\d+)?$/.test(total)) return '';
  const [whole, fraction = ''] = total.split('.');
  const digits = BigInt(`${whole}${fraction}`);
  if (digits === 0n) return '';
  const scale = fraction.length + 1;
  const half = (digits * 5n).toString().padStart(scale + 1, '0');
  return `${half.slice(0, -scale)}.${half.slice(-scale)}`.replace(/\.?0+$/, '');
}
