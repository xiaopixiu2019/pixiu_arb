import { describe,it,expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { TaskPerformance } from '@gate-crossex/shared-types';
import { TaskPerformanceCell } from './task-performance-cell.js';
const component={amount:'0',native:{},count:0};
const value:TaskPerformance={taskId:'s',amount:'6.4',status:'settled',checkedAt:1,currency:'USDT',reasons:[],native:{USD:'9.92',USDT:'-3.52'},
  price:{...component,amount:'0.48'},funding:{...component,amount:'7.26'},fees:{...component,amount:'-1.34'},other:component};
describe('task net result presentation',()=>{
  it('shows a dynamic estimate above five percent with its actual uncertainty and age',()=>{
    const trading={amount:'-0.16791',confirmed:'-0.15198',unrealized:'0',status:'estimated' as const,scope:'task' as const,groupId:'s',members:['s'],reasons:['late_funding_attribution_pending'],checkedAt:1000,ledgerThrough:1000,valuationAt:null,stale:false,adjustment:'-0.01593',maxError:'0.02093',maxErrorPct:'12.47'};
    const html=renderToStaticMarkup(<TaskPerformanceCell value={{...value,trading}} zh />);
    expect(html).toContain('≈ -0.17');expect(html).toContain('12.47%');expect(html).toContain('超过5%');expect(html).not.toContain('估算误差 ≤ 5%');
    const stale=renderToStaticMarkup(<TaskPerformanceCell value={{...value,trading}} zh stale />);expect(stale).toContain('更新延迟');expect(stale).toContain('≈ -0.17');
  });
  it('shows the bounded net estimate and discloses the included adjustment',()=>{
    const html=renderToStaticMarkup(<TaskPerformanceCell value={{...value,amount:'6.38638',status:'estimated',
      estimate:{adjustment:'-0.01656',maxError:'0.02156',maxErrorPct:'0.3376',tolerancePct:'5'}}} zh />);
    expect(html).toContain('≈ +6.39');expect(html).toContain('估算误差 ≤ 5%');
    expect(html).toContain('-0.01656');expect(html).toContain('0.3376%');expect(html).not.toContain('已核对结算');
  });
  it('uses the reconciled net total and exposes each component',()=>{
    const html=renderToStaticMarkup(<TaskPerformanceCell value={value} zh />);
    expect(html).toContain('+6.40');expect(html).toContain('实际资金费');expect(html).toContain('-1.34');expect(html).toContain('已核对结算');
  });
  it('does not display a partial amount as the final result',()=>{
    const html=renderToStaticMarkup(<TaskPerformanceCell value={{...value,amount:null,status:'pending',reasons:['missing_historical_fx']}} zh />);
    expect(html).not.toContain('+6.40');expect(html).toContain('历史汇率待核对');expect(html).toContain('待结算');
  });
  it('keeps retained nonflat holdings unsettled even in history',()=>{
    const html=renderToStaticMarkup(<TaskPerformanceCell value={{...value,amount:null,status:'open'}} zh />);
    expect(html).toContain('持仓未结算');expect(html).not.toContain('已核对结算');
  });
});
