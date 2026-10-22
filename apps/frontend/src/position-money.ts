import { Decimal } from 'decimal.js';
export function convertedTotal(rows: readonly {quote:string}[], amount:(row: typeof rows[number], index:number)=>number|null,
  rates:Record<string,string>|undefined):number|null {
  let sum=new Decimal(0);
  for(let i=0;i<rows.length;i++){
    const value=amount(rows[i],i),raw=rows[i].quote==='USDT'?'1':rates?.[rows[i].quote];
    if(value===null||!Number.isFinite(value)||raw===undefined)return null;
    try {const rate=new Decimal(raw);if(!rate.isFinite()||rate.lte(0))return null;sum=sum.plus(new Decimal(value).mul(rate));}
    catch {return null;}
  }
  const total=Number(sum);
  return Number.isFinite(total)?total:null;
}
