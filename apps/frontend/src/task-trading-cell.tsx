import type { TaskTradingResult } from '@gate-crossex/shared-types';
const money = (v: string | null) => v === null ? '—' : Number(v).toLocaleString('en-US', { maximumFractionDigits: 8 });
const messages: Record<string, string> = {
  valuation_pending: '持仓或汇率正在同步', history_incomplete: '账单覆盖尚未补齐', transfer_unverified: '接管链待核对',
  adopted_basis_unverified: '接管前成本待核对', fill_coverage_incomplete: '成交正在核对', ownership_unverified: '持仓归属待核对',
  late_funding_attribution_pending: '含迟到资金费归属估算', provisional_trade_cashflows: '成交预估，等待正式账单',
  invalid_or_unpriced_evidence: '账单或历史汇率待核对', unallocated_trade_evidence: '存在未核实的任务账务',
  settlement_pending: '清仓后账单继续核对', last_confirmed_value: '保留上次可信结果', order_reconciliation_pending: '订单正在核对',
  funding_not_booked: '截至覆盖时点未见部分资金费账单，后续继续核对',
};
export function TaskTradingCell({ value, zh, stale = false }: { value: TaskTradingResult; zh: boolean; stale?: boolean }) {
  if (value.status === 'transferred') return <div className="strategy-realized-pnl"><strong>{zh ? '已并入后续任务' : 'Transferred'}</strong><small>{value.transferredTo}</small></div>;
  const delayed = stale || value.stale, approximate = value.status === 'estimated', crossesZero = value.amount !== null && value.maxError !== null && Math.abs(Number(value.amount)) <= Number(value.maxError);
  const label = delayed ? zh ? '上次结果 · 更新延迟' : 'Last value · delayed'
    : value.status === 'confirmed' ? zh ? '交易账单已核对' : 'Trading bills reconciled'
      : approximate ? zh ? '动态估算' : 'Estimated' : zh ? '部分证据待核对' : 'Evidence pending';
  return <div className={`strategy-realized-pnl ${value.amount !== null && !crossesZero ? Number(value.amount) >= 0 ? 'positive' : 'negative' : ''}`}>
    <strong>{value.amount === null ? '—' : `${approximate || delayed ? '≈ ' : ''}${Number(value.amount) >= 0 ? '+' : ''}${Number(value.amount).toFixed(2)}`}</strong>
    <small>{zh ? '交易净盈亏 · USDT' : 'Trading net PnL · USDT'}</small><small role="status">{label}</small>
    <small>{value.scope === 'group' ? zh ? '本持仓组 · 含接管旧仓' : 'Whole position group' : value.scope === 'since_adoption' ? zh ? '自接管以来' : 'Since adoption' : value.scope === 'execution' ? zh ? '本次平仓执行' : 'This closing execution' : ''}</small>
    {value.checkedAt !== null && <small>{zh ? '数据时间 ' : 'As of '}{new Date(value.checkedAt).toLocaleString(zh ? 'zh-CN' : 'en-US')}</small>}
    <details><summary>{zh ? '收益明细' : 'PnL details'}</summary>
      {value.ledgerThrough!==null && <small>{zh?'账单覆盖至 ':'Ledger through '}{new Date(value.ledgerThrough).toLocaleString(zh?'zh-CN':'en-US')}</small>}
      {value.valuationAt!==null && <small>{zh?'持仓估值时间 ':'Position valuation at '}{new Date(value.valuationAt).toLocaleString(zh?'zh-CN':'en-US')}</small>}
      <div>{zh ? '交易现金流小计' : 'Trading cashflows'}: {money(value.confirmed)} USDT</div>
      {value.components && (['price','funding','fees','other'] as const).map((key,i)=><small key={key}>{(zh?['已入账价格盈亏','已入账资金费','已入账交易费用','其他直接账务']:['Booked price PnL','Booked funding','Booked fees','Other booked cashflows'])[i]}: {money(value.components![key].amount)} USDT
        {' · '}{Object.entries(value.components![key].native).map(([coin,v])=>`${money(v)} ${coin}`).join(' / ')}</small>)}
      <div>{zh ? '成交预估补差（已计入）' : 'Provisional fill difference (included)'}: {money(value.provisionalCashflows ?? '0')} USDT</div>
      <div>{zh ? '剩余持仓浮盈亏' : 'Unrealized PnL'}: {money(value.unrealized)} USDT</div>
      {value.scope==='since_adoption' && <div>{zh?'接管前浮盈亏基线（扣除）':'Pre-adoption PnL baseline (subtracted)'}: {money(value.adoptionBaseline ?? null)} USDT</div>}
      <div>{zh ? '已知待归属调整（已计入）' : 'Attribution adjustment (included)'}: {money(value.adjustment)} USDT</div>
      {value.maxError !== null && <small>{zh ? '已知归属及舍入差额上界' : 'Known attribution / rounding bound'}: {money(value.maxError)} USDT{value.maxErrorPct !== null ? ` (${money(value.maxErrorPct)}%)` : ''}</small>}
      {(crossesZero || Number(value.maxErrorPct) > 5) && <small>{crossesZero ? zh ? '差额范围跨零，盈亏方向待核对' : 'Range crosses zero' : zh ? '已知差额超过5%，金额保留供核对' : 'Known uncertainty exceeds 5%'}</small>}
      <small>{zh ? '已含交易费用；账户公共成本另列。估算上界不含未知未来账单或市场估值误差。' : 'Includes trading fees; shared account costs are separate. Bounds exclude unknown future bills and valuation uncertainty.'}</small>
      {value.reasons.map(r => <small key={r}>{zh ? messages[r] ?? '财务证据待核对' : r.replaceAll('_', ' ')}</small>)}
    </details>
  </div>;
}
