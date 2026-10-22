import { describe,it,expect } from 'vitest';
import { convertedTotal } from './position-money.js';
describe('complete currency-aware position sums',()=>{
  const rows=[{quote:'USD'},{quote:'USDT'}];
  it('converts both legs instead of treating USD as USDT',()=>expect(convertedTotal(rows,()=>10,{USD:'1.2'})).toBe(22));
  it('blocks incomplete legs and missing FX including zero-valued unverified legs',()=>{
    expect(convertedTotal(rows,()=>10,undefined)).toBeNull();
    expect(convertedTotal(rows,(_,i)=>i?null:10,{USD:'1.2'})).toBeNull();
  });
  it('keeps zero and negative amounts without adding FX to quantities',()=>expect(convertedTotal(rows,(_,i)=>i?0:-10,{USD:'1.2'})).toBe(-12));
});
