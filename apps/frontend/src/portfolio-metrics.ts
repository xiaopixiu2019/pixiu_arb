export function marginRatePercent(value: string | null | undefined): number | null {
  if (value === null || value === undefined || value.trim() === '') return null;
  const ratio = Number(value);
  return Number.isFinite(ratio) && ratio >= 0 ? ratio * 100 : null;
}
