import { Decimal } from 'decimal.js';
import type { MarginSnapshot } from '@gate-crossex/shared-types';
export interface MarginVersionEvidence { accountId: string; units: Record<string, string> }
export function mergeMarginVersions(a: MarginVersionEvidence | null, b: MarginVersionEvidence): MarginVersionEvidence {
  if (a && a.accountId !== b.accountId) throw new Error('margin_account_identity_changed');
  const units = { ...a?.units };
  for (const [key,value] of Object.entries(b.units)) {
    if (!/^\d+$/.test(value)) throw new Error('margin_account_version_invalid');
    units[key] = units[key] === undefined ? value : Decimal.max(units[key],value).toFixed();
  }
  return {accountId:b.accountId, units};
}
export function snapshotVersions(s: MarginSnapshot): MarginVersionEvidence | null {
  if (!s.accountId || !s.fresh || !s.units?.length || s.units.some(u=>!u.metrics)) return null;
  return mergeMarginVersions(null,{accountId:s.accountId,units:Object.fromEntries(s.units.map(u=>[u.exchangeType,u.metrics!.remoteUpdatedAt]))});
}
export function versionsAdvance(floor: MarginVersionEvidence, current: MarginVersionEvidence, strict: boolean): boolean {
  if (floor.accountId !== current.accountId) throw new Error('margin_account_identity_changed');
  return Object.entries(floor.units).every(([key,value]) => current.units[key] !== undefined
    && (strict ? new Decimal(current.units[key]).gt(value) : new Decimal(current.units[key]).gte(value)));
}
export class MarginVersionRegression extends Error {
  constructor(readonly exchangeType: string, readonly previousVersion: string, readonly candidateVersion: string) {
    super('margin_account_version_regressed');
  }
}
