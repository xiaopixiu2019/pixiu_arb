import type { TaskPerformance } from '@gate-crossex/shared-types';
import './task-performance.css';
import { TaskTradingCell } from './task-trading-cell.js';
const reasons: Record<string,string>={history_incomplete:'历史账单尚未补齐',missing_historical_fx:'历史汇率待核对',ownership_unverified:'任务归属待核对',
  adopted_basis_unverified:'接管旧仓成本待核对',transferred_basis_unverified:'交接成本待核对',conflicting_evidence:'账务证据冲突',
  fee_evidence_pending:'手续费证据待核对',price_evidence_pending:'成交盈亏账单待核对',funding_evidence_pending:'资金费结算待核对',
  unallocated_account_cost:'存在未归属账务或账户成本',settlement_pending:'等待结算账单',fill_coverage_incomplete:'成交覆盖不完整',
  task_data_unavailable:'账务读取失败',unclassified_ledger:'存在待分类账务',late_funding_attribution_pending:'迟到资金费归属待核对',invalid_trade_evidence:'成交数据格式异常'};
const money=(v:string|null)=>v===null?'—':Number(v).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:8});
export function TaskPerformanceCell({value,zh,stale=false}:{value:TaskPerformance|undefined;zh:boolean;stale?:boolean}) {
  if(value?.trading)return <TaskTradingCell value={value.trading} zh={zh} stale={stale} />;
  const estimated=value?.status==='estimated' && !!value.estimate;
  const final=(value?.status==='settled' || estimated) && value?.amount!==null;
  return <div className={`strategy-realized-pnl ${final?Number(value.amount)>=0?'positive':'negative':''}`}>
    <strong>{final?`${estimated?'≈ ':''}${Number(value.amount)>=0?'+':''}${Number(value.amount).toFixed(2)}`:'—'}</strong><small>{zh?'任务净盈亏 · USDT':'Task net PnL · USDT'}</small>
    <small>{estimated?(zh?'估算误差 ≤ 5%':'Estimated error ≤ 5%'):final?(zh?'已核对结算':'Reconciled'):value?.status==='open'?(zh?'持仓未结算':'Position unsettled'):(zh?'待结算 / 待核对':'Settlement / evidence pending')}</small>
    {value && <details><summary>{zh?'收益明细':'PnL details'}</summary>
      {value.status!=='settled' && <small>{zh?'以下为已确认分项小计；缺失显示 —，不代表零。':'Confirmed component subtotals; — means missing evidence, not zero.'}</small>}
      {(['price','funding','fees','other'] as const).map((key,i)=><div key={key}>{(zh?['价格盈亏','实际资金费','交易费用净变动','其他账务']:['Price PnL','Funding cashflows','Trading fee net cashflows','Other cashflows'])[i]}: {money(value[key].amount)} USDT
        <small>{Object.entries(value[key].native).map(([coin,v])=>`${money(v)} ${coin}`).join(' / ')}</small></div>)}
      <small>{zh?'费用负数为支出，正数为返还；已含在净额中。':'Negative fees are charges, positive fees refunds; included once in net PnL.'}</small>
      {estimated && value.estimate && <div>{zh?'已知待归属调整':'Known attribution adjustment'}: {money(value.estimate.adjustment)} USDT
        <small>{zh?'已计入净额；归属及显示误差上界':'Included in net; attribution and rounding error bound'}: {money(value.estimate.maxErrorPct)}%</small></div>}
      {estimated && <small>{zh?'以下归属差额已计入上述估算及误差范围。':'The attribution items below are included in the estimate and error bound.'}</small>}
      {value.reasons.map(r=><small key={r}>{zh?reasons[r]??'证据待核对':r.replaceAll('_',' ')}</small>)}
    </details>}
  </div>;
}
