import { describe,it,expect } from 'vitest';
import { versionsAdvance,mergeMarginVersions,snapshotVersions } from './margin-version.js';
import type { MarginSnapshot } from '@gate-crossex/shared-types';
describe('account-scoped recovery version evidence',()=>{
  const floor={accountId:'account',units:{BINANCE:'100',GATE:'200'}};
  it('requires each unit to advance regardless of worst-ratio unit ordering',()=>{
    expect(versionsAdvance(floor,{accountId:'account',units:{GATE:'201',BINANCE:'100'}},true)).toBe(false);
    expect(versionsAdvance(floor,{accountId:'account',units:{GATE:'201',BINANCE:'101'}},true)).toBe(true);
    expect(versionsAdvance(floor,{accountId:'account',units:{BINANCE:'999'}},true)).toBe(false);
  });
  it('keeps the largest accepted unit version and rejects cross-account comparison',()=>{
    expect(mergeMarginVersions(floor,{accountId:'account',units:{BINANCE:'99',GATE:'201'}})).toEqual({accountId:'account',units:{BINANCE:'100',GATE:'201'}});
    expect(()=>versionsAdvance(floor,{accountId:'other',units:floor.units},true)).toThrow('margin_account_identity_changed');
    expect(()=>mergeMarginVersions(null,{accountId:'account',units:{GATE:'unknown'}})).toThrow('margin_account_version_invalid');
  });
  it('never treats a missing unit or stale sample as recovery evidence',()=>{
    expect(snapshotVersions({accountId:'account',fresh:false} as MarginSnapshot)).toBeNull();
    expect(snapshotVersions({accountId:'account',fresh:true,units:[{exchangeType:'GATE',metrics:null}]} as MarginSnapshot)).toBeNull();
  });
});
